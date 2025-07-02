import OpenAI from "openai";
import fetch from "node-fetch";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req, res) {
  console.log("✅ 收到請求 method:", req.method);
  console.log("📥 req.body：", req.body);

  if (req.method !== "POST") return res.status(405).send("Only POST allowed");

  const event = req.body?.events?.[0];
  const messageType = event?.message?.type;
  const userText = event?.message?.text;
  const replyToken = event?.replyToken;

  console.log("📩 接收到 LINE event：", event);
  console.log("📨 messageType:", messageType);
  console.log("📝 userText:", userText);
  console.log("🔁 replyToken:", replyToken);

  if (messageType !== "text" || !userText || !replyToken) {
    console.log("❌ 非文字訊息或缺資料，略過");
    return res.status(200).send("Ignored");
  }

  // 🔍 分類用 GPT
  let result = {};
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: "你是分類助手，請根據使用者詢問的內容，輸出 JSON 格式 { category, params }。category 僅能為：cars、company、address、contact。"
        },
        { role: "user", content: userText }
      ]
    });

    console.log("🧠 GPT 回傳內容：", completion.choices[0].message.content);
    result = JSON.parse(completion.choices[0].message.content);
  } catch (e) {
    console.error("❌ GPT 分類錯誤：", e.message);
    await replyToLine(replyToken, "很抱歉，目前無法理解您的問題，我們會請專人協助您！");
    return res.status(200).send("Error handled");
  }

  const { category, params } = result;
  const tableMap = {
    cars: "cars",
    company: "company_profile",
    address: "company_info",
    contact: "contact_info"
  };
  const table = tableMap[category?.toLowerCase()];

  console.log("📦 分類結果：", category, "| 對應資料表：", table);

  let replyText = "";

  if (!table) {
    replyText = "亞鈺汽車AI智能客服您好，感謝您的詢問，目前您的問題需要專人回覆您，請稍後馬上有人為您服務！😄";
    console.log("⚠️ category 無對應資料表，進入 fallback");
  } else {
    const query = Object.entries(params || {})
      .map(([k, v]) => `${k}=eq.${encodeURIComponent(v)}`)
      .join("&");

    const url = `${process.env.SUPABASE_URL}/rest/v1/${table}?select=*&${query}`;
    console.log("🌐 查詢 URL：", url);

    const resp = await fetch(url, {
      headers: {
        apikey: process.env.SUPABASE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_KEY}`,
        "Content-Type": "application/json"
      }
    });

    let data;
    try {
      data = await resp.json();
      console.log("🔍 Supabase 回傳資料：", data);
    } catch (e) {
      console.error("❌ 回傳 JSON 錯誤：", e.message);
      data = null;
    }

    if (Array.isArray(data) && data.length > 0) {
      if (category === "cars") {
        replyText = `我們目前有 ${data.length} 台符合條件的車輛。`;
      } else if (category === "address") {
        replyText = `我們的地址是：${data[0]?.地址 || "查無地址"}`;
      } else {
        replyText = JSON.stringify(data[0], null, 2);
      }
    } else {
      replyText = "目前查無相關資料，您也可以留下聯絡方式由專人協助您。";
    }
  }

  await replyToLine(replyToken, replyText);
  return res.status(200).json({ status: "ok" });
}

async function replyToLine(replyToken, text) {
  const url = "https://api.line.me/v2/bot/message/reply";
  const body = {
    replyToken,
    messages: [{ type: "text", text }]
  };

  const headers = {
    Authorization: `Bearer ${process.env.LINE_TOKEN}`,
    "Content-Type": "application/json"
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    const result = await res.text();
    console.log("📤 LINE 回覆結果：", result);
  } catch (err) {
    console.error("❌ LINE 回覆錯誤：", err);
  }
}
