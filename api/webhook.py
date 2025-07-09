import os
import json
from flask import Flask, request
from dotenv import load_dotenv
from linebot.v3.messaging import Configuration, ApiClient, MessagingApi, ReplyMessageRequest, TextMessage
from supabase import create_client
import openai

# 載入環境變數
load_dotenv()
config = Configuration(access_token=os.getenv("LINE_CHANNEL_ACCESS_TOKEN"))
line_bot_api = MessagingApi(ApiClient(config))
openai.api_key = os.getenv("OPENAI_API_KEY")
supabase = create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_SERVICE_ROLE_KEY"))

app = Flask(__name__)

# 你的資料表/欄位設計
TABLES = {
    "cars": ["廠牌", "車型", "年式", "保固內容", "五日鑑賞", "車輛售價", "里程"],
    "company": ["公司名稱", "地址", "營業時間", "聯絡電話"]
}

def gpt_parse_question(user_text):
    prompt = f"""
你有兩個表單：
1. cars（欄位：{"、".join(TABLES['cars'])}）
2. company（欄位：{"、".join(TABLES['company'])}）
請判斷這句話屬於哪個表單的哪個欄位？查什麼關鍵字？如果用戶問 BMW 有幾台，請加上 "action": "count"。
僅回傳JSON: 例 {{"table": "cars", "field": "廠牌", "keyword": "BMW", "action": "count"}}
原始問題：「{user_text}」
    """
    result = openai.ChatCompletion.create(
        model="gpt-3.5-turbo",
        messages=[{"role": "system", "content": prompt}]
    ).choices[0].message.content
    try:
        return json.loads(result)
    except:
        return {}

def query_supabase(parse):
    table, field, keyword, action = parse.get('table'), parse.get('field'), parse.get('keyword'), parse.get('action')
    if not table or not field or not keyword:
        return ""
    if action == "count":
        res = supabase.table(table).select(field, count="exact").ilike(field, f"%{keyword}%").execute()
        cnt = res.count or 0
        return f"{keyword} 共有 {cnt} 台！"
    else:
        res = supabase.table(table).select("*").ilike(field, f"%{keyword}%").limit(1).execute()
        if res.data:
            value = res.data[0].get(field, "")
            return f"{field}：{value}"
        return "查無資料"

@app.route("/api/webhook", methods=["POST"])
def callback():
    body = request.get_json()
    events = body.get("events", [])
    for event in events:
        if event.get("type") == "message" and event["message"].get("type") == "text":
            user_text = event["message"]["text"]
            reply_token = event["replyToken"]
            parse = gpt_parse_question(user_text)
            reply = query_supabase(parse) or "感謝您的詢問，請詢問亞鈺汽車相關問題，我們很高興為您服務！😄"
            line_bot_api.reply_message(
                ReplyMessageRequest(
                    reply_token=reply_token,
                    messages=[TextMessage(text=reply)]
                )
            )
    return "OK"

if __name__ == "__main__":
    app.run(port=3000)
