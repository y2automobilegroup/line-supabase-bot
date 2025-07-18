import OpenAI from "openai";
import fetch from "node-fetch";
import { Pinecone } from "@pinecone-database/pinecone";


const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY,
  environment: process.env.PINECONE_ENVIRONMENT
});

const memory = {};
const topicMemory = {};

const parsePrice = val => {
  if (typeof val !== "string") return val;
  const chineseNumMap = {
    "零": 0, "一": 1, "二": 2, "兩": 2, "三": 3, "四": 4,
    "五": 5, "六": 6, "七": 7, "八": 8, "九": 9
  };
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
  const cleaned = val.replace(/[元台幣\s]/g, "").trim();
  if (cleaned.includes("萬")) {
    const numericPart = cleaned.replace("萬", "").trim();
    if (!isNaN(Number(numericPart))) {
      return Math.round(parseFloat(numericPart) * 10000);
    }
    return parseChineseNumber(numericPart) * 10000;
  }
  return isNaN(Number(cleaned)) ? val : Number(cleaned);
};

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).end("Only POST allowed");

    const body = req.body;
    const event = body.events?.[0];
    const userText = event?.message?.text;
    const replyToken = event?.replyToken;
    const userId = event?.source?.userId;

    if (!userText || !replyToken) return res.status(200).send("Invalid message");

    const contextMessages = memory[userId]?.map(text => ({ role: "user", content: text })) || [];
    const gpt = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `你是亞鈺汽車的客服助手，請用以下 JSON 結構分析使用者訊息，並只回傳該 JSON：\n{
  "category": "cars" | "company" | "other",
  "params": { ... },
  "followup": "..."
}`
        },
        ...contextMessages,
        { role: "user", content: userText }
      ]
    });

    let result;
    try {
      result = JSON.parse(gpt.choices[0].message.content.trim().replace(/^```json\n?|\n?```$/g, ""));
    } catch (e) {
      await replyToLine(replyToken, "不好意思，請再試一次，我們會請專人協助您！");
      return res.status(200).send("GPT JSON parse error");
    }

    const { category, params, followup } = result;
    const currentBrand = params?.廠牌;
    const lastParams = topicMemory[userId] || {};
    const lastBrand = lastParams.廠牌;

    if (currentBrand && currentBrand !== lastBrand) {
      memory[userId] = [userText];
      topicMemory[userId] = { ...params };
    } else {
      memory[userId] = [...(memory[userId] || []), userText];
      topicMemory[userId] = { ...lastParams, ...params };
    }

    let data = [];
    let replyText = "";

    // Step 1: try Pinecone (semantic search for company and cars)
    const queryVector = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: userText
    });

    const vector = queryVector.data[0].embedding;

    const index = pinecone.index(process.env.PINECONE_INDEX);
    const pineconeQuery = await index.query({
      vector,
      topK: 5,
      includeMetadata: true
    });

    const matches = pineconeQuery.matches || [];
    if (matches.length > 0) {
      const context = matches.map(m => m.metadata.text).join("\n\n");
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: "你是亞鈺汽車的客服專員，請根據以下資料回覆使用者問題。" },
          { role: "user", content: `使用者問題：${userText}\n\n資料如下：\n${context}` }
        ]
      });
      replyText = response.choices[0].message.content.trim();
    } else {
      // Step 2: fallback Supabase if Pinecone 無結果
      if (category === "cars") {
        const query = Object.entries(params || {})
          .map(([key, value]) => {
            if (typeof value === "object") {
              if (value.gte !== undefined) return `${key}=gte.${parsePrice(value.gte)}`;
              if (value.lte !== undefined) return `${key}=lte.${parsePrice(value.lte)}`;
              if (value.eq !== undefined) return `${key}=eq.${parsePrice(value.eq)}`;
            }
            return `${key}=ilike.%${value}%`;
          }).join("&");

        const url = `${process.env.SUPABASE_URL}/rest/v1/cars?select=*&${query}`;
        const resp = await fetch(url, {
          headers: {
            apikey: process.env.SUPABASE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_KEY}`
          }
        });
        try {
          data = await resp.json();
        } catch (e) {}
      }

      if (Array.isArray(data) && data.length > 0) {
        const prompt = `請用繁體中文、客服語氣、字數不超過250字，直接回答使用者查詢條件為 ${JSON.stringify(params)}，以下是結果：\n${JSON.stringify(data)}`;
        const chatReply = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            { role: "system", content: "你是亞鈺汽車的客服專員，請根據以下內容精準回覆客戶問題：" },
            { role: "user", content: prompt }
          ]
        });
        replyText = chatReply.choices[0].message.content.trim();
      } else {
        replyText = "目前查無符合條件的資料，您還有其他問題嗎？";
      }
    }

    await replyToLine(replyToken, replyText);
    res.status(200).json({ status: "ok" });
  } catch (error) {
    console.error("❌ webhook 錯誤：", error);
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
