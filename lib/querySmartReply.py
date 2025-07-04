
import os, uuid, json
from flask import Flask, request
from dotenv import load_dotenv
from collections import defaultdict, deque

# LINE SDK
from linebot.v3.messaging import MessagingApi, Configuration, ApiClient, ReplyMessageRequest, TextMessage
from linebot.v3.webhook import WebhookParser
from linebot.v3.webhooks import MessageEvent, TextMessageContent

# OpenAI & Supabase
from openai import OpenAI
from supabase import create_client, Client

# ─────────────────────────────────────────────
# 初始化
# ─────────────────────────────────────────────
load_dotenv()

openai_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

# Supabase client
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
SUPABASE_TABLE_CARS = os.getenv("SUPABASE_TABLE_CARS", "cars")
SUPABASE_TABLE_COMPANY = os.getenv("SUPABASE_TABLE_COMPANY", "company")
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

configuration = Configuration(access_token=os.getenv("LINE_CHANNEL_ACCESS_TOKEN"))
parser = WebhookParser(os.getenv("LINE_CHANNEL_SECRET"))

app = Flask(__name__)

# 對話記憶 & 人工客服模式
user_memory = defaultdict(lambda: deque(maxlen=10))
manual_mode = set()

# ─────────────────────────────────────────────
# 共用工具
# ─────────────────────────────────────────────
def embed_text(text: str) -> list:
    """Call OpenAI embeddings"""
    emb = openai_client.embeddings.create(
        model="text-embedding-3-small",
        input=[text]
    )
    return emb.data[0].embedding


def query_pgvector(table: str, query_vec: list, limit: int = 5):
    """Call Postgres function match_vectors for pgvector ANN"""
    return supabase.rpc(
        "match_vectors",  # 需在資料庫先建立 function
        {"tbl": table, "query_vec": query_vec, "match_limit": limit}
    ).execute().data or []


# ─────────────────────────────────────────────
# LINE Webhook
# ─────────────────────────────────────────────
@app.route("/callback", methods=["POST"])
def callback():
    signature = request.headers.get("x-line-signature")
    body = request.get_data(as_text=True)

    try:
        events = parser.parse(body, signature)
    except Exception:
        return "Invalid signature", 400

    with ApiClient(configuration) as api_client:
        line_bot_api = MessagingApi(api_client)

        for event in events:
            if isinstance(event, MessageEvent) and isinstance(event.message, TextMessageContent):
                user_id = event.source.user_id
                query = event.message.text.strip()
                user_memory[user_id].append({ "role": "user", "content": query })

                # 人工客服切換
                if query == "人工客服您好":
                    manual_mode.add(user_id)
                    return "OK", 200
                if query == "人工客服結束":
                    manual_mode.discard(user_id)
                    return "OK", 200
                if user_id in manual_mode:
                    return "OK", 200

                # 向量化問題
                q_vec = embed_text(query)

                # 先查 cars
                car_rows = query_pgvector(SUPABASE_TABLE_CARS, q_vec, limit=5)
                context_blocks = []
                if car_rows:
                    for r in car_rows:
                        context_blocks.append(
                            f"{r.get('廠牌','')} {r.get('車款','')} {r.get('年式','')} "
                            f"售價：{r.get('車輛售價','N/A')}"
                        )

                # 再查 company (FAQ / policy / about)
                company_rows = query_pgvector(SUPABASE_TABLE_COMPANY, q_vec, limit=5)
                if company_rows:
                    context_blocks += [r.get('content','') for r in company_rows]

                if not context_blocks:
                    fallback = "亞鈺智能客服您好：感謝您的詢問，目前您的問題需要專人回覆您，請稍後馬上有人為您服務！😄"
                    line_bot_api.reply_message(ReplyMessageRequest(
                        reply_token=event.reply_token,
                        messages=[TextMessage(text=fallback)]
                    ))
                    return "OK", 200

                context = "\n".join(context_blocks[-10:])  # 限制長度

                # GPT 回覆
                messages = list(user_memory[user_id])
                system_prompt = { "role": "system", "content": "你是亞鈺汽車客服…" }
                user_prompt = { "role": "user", "content": f"參考資料：\n{context}\n\n問題：{query}" }
                completion = openai_client.chat.completions.create(
                    model="gpt-4o",
                    messages=[system_prompt] + messages + [user_prompt]
                )
                answer = completion.choices[0].message.content.strip()
                if not answer.startswith("亞鈺智能客服您好："):
                    answer = "亞鈺智能客服您好：" + answer

                user_memory[user_id].append({ "role": "assistant", "content": answer })
                line_bot_api.reply_message(ReplyMessageRequest(
                    reply_token=event.reply_token,
                    messages=[TextMessage(text=answer)]
                ))
    return "OK", 200


@app.route("/")
def home():
    return "Supabase‑only LINE GPT Bot Ready"


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000)
