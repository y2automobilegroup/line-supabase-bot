
import os
import uuid
from flask import Flask, request
from dotenv import load_dotenv
from collections import defaultdict, deque

# LINE
from linebot.v3.messaging import MessagingApi, Configuration, ApiClient, ReplyMessageRequest, TextMessage
from linebot.v3.webhook import WebhookParser
from linebot.v3.webhooks import MessageEvent, TextMessageContent

# OpenAI & Pinecone
from openai import OpenAI
from pinecone import Pinecone

# Supabase
from supabase import create_client, Client

# ─────────────────────────────────────────────
# 初始化
# ─────────────────────────────────────────────
load_dotenv()

openai_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

pc = Pinecone(api_key=os.getenv("PINECONE_API_KEY"))
index = pc.Index(os.getenv("PINECONE_INDEX"))

configuration = Configuration(access_token=os.getenv("LINE_CHANNEL_ACCESS_TOKEN"))
parser = WebhookParser(os.getenv("LINE_CHANNEL_SECRET"))

# Supabase client
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
SUPABASE_TABLE = os.getenv("SUPABASE_TABLE", "cars")   # 預設 cars
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

app = Flask(__name__)

# 記憶對話 & 人工客服模式
user_memory = defaultdict(lambda: deque(maxlen=10))
manual_mode = set()  # 存放進入人工客服模式的 user_id

# ─────────────────────────────────────────────
# 共用小工具
# ─────────────────────────────────────────────
def embed_text(text: str) -> list:
    embedding = openai_client.embeddings.create(
        model="text-embedding-3-small",
        input=[text]
    )
    return embedding.data[0].embedding


def search_supabase(query: str, limit: int = 5) -> list:
    filter_cols = [
        "廠牌", "車款", "車型", "年式", "年份", "顏色",
        "車輛賣點", "車輛副標題", "安全性配備", "舒適性配備"
    ]
    or_filters = ",".join([f"{col}.ilike.*{query}*" for col in filter_cols])
    response = (
        supabase
        .table(SUPABASE_TABLE)
        .select("*")
        .or_(or_filters)
        .limit(limit)
        .execute()
    )
    return response.data or []


def format_car_record(rec: dict) -> str:
    return (
        f"{rec.get('廠牌', '')} {rec.get('車款', '')} {rec.get('車型', '')} "
        f"{rec.get('年式', '')} — {rec.get('年份', '')}年式，"
        f"顏色：{rec.get('顏色', '未標示')}，"
        f"里程：{rec.get('行駛里程', '未標示')}，"
        f"售價：{rec.get('車輛售價', '洽詢')}，"
        f"聯絡人：{rec.get('聯絡人', 'N/A')}（{rec.get('行動電話', '電話不公開')}）"
    ).strip()


# ─────────────────────────────────────────────
# LINE Webhook
# ─────────────────────────────────────────────
@app.route("/callback", methods=["POST"])
def callback():
    signature = request.headers.get("x-line-signature")
    body = request.get_data(as_text=True)

    try:
        events = parser.parse(body, signature)
    except Exception as e:
        print("[WebhookParser] Error:", e)
        return "Invalid signature", 400

    with ApiClient(configuration) as api_client:
        line_bot_api = MessagingApi(api_client)

        for event in events:
            if isinstance(event, MessageEvent) and isinstance(event.message, TextMessageContent):
                user_id = event.source.user_id
                query = event.message.text.strip()

                user_memory[user_id].append({"role": "user", "content": query})

                # 切換人工客服模式
                if query == "人工客服您好":
                    manual_mode.add(user_id)
                    print(f"[人工模式 ON] {user_id}")
                    return "OK", 200

                if query == "人工客服結束":
                    manual_mode.discard(user_id)
                    print(f"[人工模式 OFF] {user_id}")
                    return "OK", 200

                if user_id in manual_mode:
                    print(f"[靜默] {user_id} 人工客服中，跳過 GPT 回覆")
                    return "OK", 200

                # 1) Pinecone 搜尋
                vector = embed_text(query)
                res = index.query(vector=vector, top_k=5, include_metadata=True)
                matches = [m for m in res["matches"] if m["score"] >= 0.2]

                context = ""
                data_source = "pinecone"

                if matches:
                    context = "\n".join([m["metadata"]["text"] for m in matches])
                else:
                    # 2) Supabase fallback
                    records = search_supabase(query, limit=5)
                    if records:
                        context_lines = [format_car_record(r) for r in records]
                        context = "\n".join(context_lines)
                        data_source = "supabase"
                    else:
                        fallback = "亞鈺智能客服您好：感謝您的詢問，目前您的問題需要專人回覆您，請稍後馬上有人為您服務！😄"
                        user_memory[user_id].append({"role": "assistant", "content": fallback})
                        line_bot_api.reply_message(ReplyMessageRequest(
                            reply_token=event.reply_token,
                            messages=[TextMessage(text=fallback)]
                        ))
                        return "OK", 200

                memory_messages = list(user_memory[user_id])
                memory_messages.append({"role": "user", "content": query})

                system_prompt = {
                    "role": "system",
                    "content": (
                        "你是亞鈺汽車的50年資深客服專員，擅長拆解並解答問題。\n"
                        "請先閱讀參考資料（若有）再回答；若內容不足，請先提出需要進一步資訊的問題。\n"
                        "若詢問與亞鈺汽車無關，請回覆：感謝您的詢問，請詢問亞鈺汽車相關問題，我們很高興為您服務！😄"
                    )
                }
                user_prompt = {
                    "role": "user",
                    "content": f"【資料來源：{data_source}】\n參考資料：\n{context}\n\n問題：{query}"
                }

                chat_completion = openai_client.chat.completions.create(
                    model="gpt-4o",
                    messages=[system_prompt] + memory_messages + [user_prompt]
                )
                answer = chat_completion.choices[0].message.content.strip()
                if not answer.startswith("亞鈺智能客服您好："):
                    answer = "亞鈺智能客服您好：" + answer

                user_memory[user_id].append({"role": "assistant", "content": answer})
                line_bot_api.reply_message(ReplyMessageRequest(
                    reply_token=event.reply_token,
                    messages=[TextMessage(text=answer)]
                ))

    return "OK", 200


@app.route("/")
def home():
    return "LINE GPT Bot Ready"


@app.route("/upload", methods=["POST"])
def upload_text():
    data = request.get_json()
    text = data.get("text", "").strip()
    if not text:
        return {"error": "Missing text"}, 400

    embedding = embed_text(text)
    doc_id = "web-" + str(uuid.uuid4())[:8]

    index.upsert([
        {"id": doc_id, "values": embedding, "metadata": {"text": text}}
    ])
    return {"message": "✅ 上傳成功", "id": doc_id}


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000)
