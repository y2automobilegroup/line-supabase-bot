// webhook.js
import OpenAI from "openai";
import fetch from "node-fetch";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const memory = {}; // 對話記憶

// 中文數字轉換器
const parsePrice = val => {
  if (typeof val !== "string") return val;
  const chineseNumMap = { "零": 0, "一": 1, "二": 2, "兩": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
  const chineseUnitMap = { "十": 10, "百": 100, "千": 1000, "萬": 10000 };
  const parseChineseNumber = str => {
    let total = 0, unit = 1, num = 0;
    for (let i = str.length - 1; i >= 0; i--) {
      const char = str[i];
      if (chineseUnitMap[char]) {
        unit = chineseUnitMap[char];
        if (num === 0) num = 1;
        total += num * unit;
        num = 0; unit = 1;
      } else if (chineseNumMap[char] !== undefined) {
        num = chineseNumMap[char];
      } else if (!isNaN(Number(char))) {
        num = Number(char);
      }
    }
    total += num;
    return total;
  };
  const cleaned = val.replace(/[元台幣\\s]/g, "").trim();
  if (cleaned.includes("萬")) {
    const numericPart = cleaned.replace("萬", "").trim();
    if (!isNaN(Number(numericPart))) {
      return Math.round(parseFloat(numericPart) * 10000);
    }
    return parseChineseNumber(numericPart) * 10000;
  }
  return isNaN(Number(cleaned)) ? val : Number(cleaned);
};

async function querySupabase(params = {}) {
  const query = Object.entries(params).map(([key, value]) => {
    if (typeof value === "object") {
      if (value.gte !== undefined) return `${key}=gte.${parsePrice(value.gte)}`;
      if (value.lte !== undefined) return `${key}=lte.${parsePrice(value.lte)}`;
      if (value.eq !== undefined) return `${key}=eq.${parsePrice(value.eq)}`;
    }
    return `${key}=ilike.%${value}%`;
  }).join("&");

  const url = `${process.env.SUPABASE_URL}/rest/v1/cars?select=*&${query}`;
  console.log("🚀 查詢 Supabase URL:", url);

  const resp = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_KEY}`
    }
  });

  const contentType = resp.headers.get("content-type");
  if (!contentType || !contentType.includes("application/json")) {
    const raw = await resp.text();
    console.error("⚠️ Supabase 回傳非 JSON：", raw);
    return [];
  }

  return await resp.json();
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

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).end("Only POST allowed");

    const event = req.body.events?.[0];
    const userText = event?.message?.text;
    const replyToken = event?.replyToken;
    const userId = event?.source?.userId;

    if (!userText || !replyToken) return res.status(200).send("Invalid message");

    // 分析使用者語句，轉為萬用查詢條件
    const gpt = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `請將使用者的文字轉換為查詢條件的 JSON 格式如下：\n{
  "params": { key: value, ... },
  "followup": "可選的補充說明"
}`
        },
        { role: "user", content: userText }
      ]
    });

    let result;
    try {
      result = JSON.parse(gpt.choices[0].message.content.trim().replace(/^```json\n?|\n?```$/g, ""));
    } catch (e) {
      await replyToLine(replyToken, "抱歉，我沒聽懂您的需求，請稍後再試。");
      return res.status(200).send("GPT JSON parse error");
    }

    const params = result.params || {};
    const data = await querySupabase(params);

    if (data.length === 0) {
      await replyToLine(replyToken, "目前查無符合的車輛，您還有其他想了解的嗎？");
      return res.status(200).json({ status: "no result" });
    }

    const replyPrompt = `你是亞鈺汽車的客服人員，以下是使用者詢問的條件 ${JSON.stringify(params)}，我們查到如下車輛：${JSON.stringify(data)}，請以自然口語、親切語氣回答他，並建議可私訊了解更多。`

    const replyGPT = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "你是亞鈺汽車的客服專員，幫忙回覆客戶詢問車輛條件的內容。" },
        { role: "user", content: replyPrompt }
      ]
    });

    const replyText = replyGPT.choices[0].message.content.trim();
    await replyToLine(replyToken, replyText);
    res.status(200).json({ status: "ok" });
  } catch (err) {
    console.error("❌ webhook 錯誤：", err);
    res.status(200).send("error handled");
  }
}
