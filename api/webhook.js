
import OpenAI from "openai";
import fetch from "node-fetch";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const memory = {};
const topicMemory = {};

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
        total += num * unit; num = 0; unit = 1;
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
    if (!isNaN(Number(numericPart))) return Math.round(parseFloat(numericPart) * 10000);
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
        { role: "system", content: \`你是亞鈺汽車的客服助手，請用以下 JSON 結構分析使用者訊息，並只回傳該 JSON：{"category": "cars" | "company" | "other","params": { ... },"followup": "..."} 規則如下：1. category 為 cars 時，params 會包含車輛查詢條件；2. category 為 company 時，params 為使用者問的關鍵字；3. 無法判斷時請回傳 {"category": "other","params": {},"followup": "請詢問亞鈺汽車相關問題，謝謝！"}\` },
        ...contextMessages,
        { role: "user", content: userText }
      ]
    });

    let result;
    try {
      result = JSON.parse(gpt.choices[0].message.content.trim().replace(/^\\`\\`\\`json\n?|\n?\\`\\`\\`$/g, ""));
    } catch {
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

    if (category === "other") {
      await replyToLine(replyToken, followup || "請詢問亞鈺汽車相關問題，謝謝！");
      return res.status(200).send("Irrelevant message");
    }

    const table = category === "cars" ? "cars" : "company";
    const query = Object.entries(params || {}).map(([key, value]) => {
      if (typeof value === "object") {
        if (value.gte !== undefined) return \`\${key}=gte.\${parsePrice(value.gte)}\`;
        if (value.lte !== undefined) return \`\${key}=lte.\${parsePrice(value.lte)}\`;
        if (value.eq !== undefined) return \`\${key}=eq.\${parsePrice(value.eq)}\`;
      }
      return \`\${key}=ilike.%\${value}%\`;
    }).join("&");

    const url = \`\${process.env.SUPABASE_URL}/rest/v1/\${table}?select=*&\${query}\`;
    const resp = await fetch(url, { headers: { apikey: process.env.SUPABASE_KEY, Authorization: \`Bearer \${process.env.SUPABASE_KEY}\` } });
    const rawText = await resp.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      await replyToLine(replyToken, "目前資料查詢異常，我們會請專人協助您！");
      return res.status(200).send("Supabase 非 JSON 錯誤");
    }

    let replyText = "";
    if (Array.isArray(data) && data.length > 0) {
      const prompt = \`請用繁體中文、客服語氣、字數不超過250字，直接回答使用者查詢條件為 \${JSON.stringify(params)}，以下是結果：\n\${JSON.stringify(data)}\`;
      const chatReply = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: "你是亞鈺汽車的50年資深客服專員，請用自然、貼近人心的口吻根據資料回覆客戶問題，整體不要超過250字。" },
          { role: "user", content: prompt }
        ]
      });
      replyText = chatReply.choices[0].message.content.trim();
    } else {
      replyText = "目前查無符合條件的資料，您還有其他問題嗎？";
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
      Authorization: \`Bearer \${process.env.LINE_TOKEN}\`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] })
  });
}
