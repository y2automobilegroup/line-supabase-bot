import OpenAI from "openai";
import fetch from "node-fetch";

// ✅ 初始化 OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req, res) {
  console.log("✅ 收到請求 method:", req.method);
  console.log("📥 req.body：", req.body);

  if (req.method !== "POST") return res.status(405).end("Only POST allowed");

  const event = req.body.events?.[0];
  const messageType = event?.message?.type;
  const userText = event?.message?.text;
  const replyToken = event?.replyToken;

  console.log("📩 接收到 LINE event：", event);
  console.log("📨 messageType:", messageType);
  console.log("📝 userText:", userText);
  console.log("🔁 replyToken:", replyToken);

  if (messageType !== "text" || !userText || !replyToken) {
    console.log("❌ 非文字訊息或缺資料，略過");
    return res.status(200).send("Non-text message ignored");
  }

  let gptResult;
  try {
    const gpt = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content:
            "你是分類助手，請根據使用者詢問的內容，輸出 JSON 格式 { category, params }。category 僅能為：cars、company、address、contact。",
        },
        { role: "user", content: userText },
      ],
    });
    gptResult = JSON.parse(gpt.choices[0].message.content);
    console.log("🧠 GPT 回傳內容：", gptResult);
  } catch (error) {
    console.error("❌ GPT 分類錯誤：", error.message);
    await replyToLine(replyToken, "抱歉，目前無法理解您的問題，我們會請專人回覆您！");
    return res.status(200).send("GPT classification error");
  }

  const { category, params } = gptResult;
  const normalizedCategory = category.toLowerCase().replace(/s$/, ""); // e.g., "cars" → "car"

  const tableMap = {
    car: "cars",
    company: "company_profile",
    address: "company_info",
    contact: "contact_info",
  };
  const table = tableMap[normalizedCategory];

  console.log("📦 分類結果：", category, "| 對應資料表：", table);

  let replyText = "";

  if (!table) {
    replyText = "亞鈺客服您好，我們會請專人儘快回覆您！😊";
    console.log("⚠️ category 無對應資料表，進入 fallback");
  } else {
    // Supabase 查詢
    const query = Object.entries(params)
      .map(([key, value]) => `${key}=eq.${encodeURIComponent(value)}`)
      .join("&");

    const supabaseUrl = `${process.env.SUPABASE_URL}/rest/v1/${table}?select=*&${query}`;
    console.log("🌐 查詢 URL：", supabaseUrl);

    const response = await fetch(supabaseUrl, {
      headers: {
        apikey: process.env.SUPABASE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_KEY}`,
      },
    });

    // 有時候會回傳 HTML 錯誤頁，先確認格式
    const contentType = response.headers.get("content-type");
    if (!contentType.includes("application/json")) {
      console.error("❌ Supabase 回傳非 JSON：", await response.text());
      await replyToLine(replyToken, "資料查詢錯誤，我們會請專人聯繫您！");
      return res.status(200).send("Supabase returned non-JSON");
    }

    const data = await response.json();
    console.log("🔍 Supabase 回傳資料：", data);

    if (Array.isArray(data) && data.length > 0) {
      if (normalizedCategory === "car") {
        const count = data.length;
        replyText = `我們目前有 ${count} 台 ${params.brand} 的車，歡迎預約賞車！`;
      } else if (normalizedCategory === "address") {
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
}

// ✅ 傳送回覆訊息給 LINE 使用者
async function replyToLine(replyToken, text) {
  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.LINE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });

  const resJson = await response.json();
  console.log("📤 LINE 回覆結果：", resJson);
}
