import OpenAI from "openai";
import fetch from "node-fetch";

const openai = new OpenAI({ apiKey: process.env.OPENAI_KEY });

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).end("Only POST allowed");

    const body = req.body;
    const event = body.events?.[0];
    const messageType = event?.message?.type;
    const userText = event?.message?.text;
    const replyToken = event?.replyToken;
console.log("📩 接收到 LINE event：", JSON.stringify(event, null, 2));
console.log("📨 messageType:", messageType);
console.log("📝 userText:", userText);
console.log("🔁 replyToken:", replyToken);
    if (messageType !== "text" || !userText || !replyToken) {
      console.log("❌ 非文字訊息或缺資料，略過");
      return res.status(200).send("Non-text message ignored");
    }

    const gpt = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: "你是分類助手，請根據使用者詢問的內容，輸出 JSON 格式 { category, params }。category 僅能為以下四種之一：cars、company、address、contact。請不要輸出其他類別名稱。" },
        { role: "user", content: userText }
      ]
    });

    console.log("🧠 GPT 回傳內容：", gpt.choices[0].message.content);

    let result;
    try {
      result = JSON.parse(gpt.choices[0].message.content);
    } catch (e) {
      console.log("❌ GPT 回傳格式錯誤，無法解析 JSON：", e.message);
      await replyToLine(replyToken, "不好意思，我目前無法理解您的問題，我們會請專人聯繫您！");
      return res.status(200).send("GPT JSON parse error");
    }

    const { category, params } = result;
    const tableMap = {
      auto: "cars",
      company: "company_profile",
      address: "company_info",
      contact: "contact_info"
    };

    const table = tableMap[category];
    console.log("📦 分類結果：", category, "| 對應資料表：", table);
    let replyText = "";

    if (!table) {
      replyText = "亞鈺客服您好，我們會請專人儘快回覆您！😊";
      console.log("⚠️ category 無對應資料表，進入 fallback");
    } else {
      const query = new URLSearchParams(params).toString();
      const resp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?select=*&${query}`, {
        headers: {
          apikey: process.env.SUPABASE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_KEY}`
        }
      });

      const data = await resp.json();
      console.log("🔍 Supabase 回傳資料：", data);

      if (data.length > 0) {
        if (category === "car") {
          const car = data[0];
          replyText = `推薦車款：${car.品牌} ${car.車型}，${car.年份} 年，售價 ${car.車價} 萬元`;
        } else if (category === "address") {
          replyText = `我們的地址是：${data[0].地址}`;
        } else {
          replyText = JSON.stringify(data[0], null, 2);
        }
      } else {
        replyText = "抱歉，目前查無相關資料。";
      }
    }

    await replyToLine(replyToken, replyText);
    res.status(200).json({ status: "ok" });
  } catch (error) {
    console.error("❌ webhook 執行錯誤：", error);
    res.status(200).send("error handled");
  }
}

async function replyToLine(replyToken, text) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.LINE_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }]
    })
  });
}
