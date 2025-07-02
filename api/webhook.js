import OpenAI from "openai";
import fetch from "node-fetch";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const memory = {};
const topicMemory = {};

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
          content: `你是分類助手，請根據使用者詢問的內容，永遠只輸出 JSON 格式：
{ "category": "...", "params": { ... }, "followup": "..." }
- category 僅能為：cars、company、address、contact 四選一。
- params 依照語意比對以下欄位，如：廠牌、年份、顏色等。
- 數值請用 gte / lte / eq，例如：{"年份": {"gte": 2020}}
- 無關問題請回傳：{"category":"other","params":{},"followup":"請詢問亞鈺汽車相關問題，謝謝！"}`
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
if (category === "cars" && (!params || Object.keys(params).length === 0)) {
  Object.assign(params, topicMemory[userId] || {});
}
    const currentBrand = params?.廠牌;
    const lastBrand = topicMemory[userId]?.廠牌;
    if (currentBrand && lastBrand && currentBrand !== lastBrand) {
      memory[userId] = [];
      topicMemory[userId] = {};
    }

    memory[userId] = [...(memory[userId] || []), userText];
    if (Object.keys(params || {}).length > 0) {
      memory[userId].push(JSON.stringify(params));
      topicMemory[userId] = { ...topicMemory[userId], ...params };
    }

    if (category === "other") {
      await replyToLine(replyToken, followup || "請詢問亞鈺汽車相關問題，謝謝！");
      return res.status(200).send("Irrelevant message");
    }

    const tableMap = {
      cars: "cars",
      company: "company_profile",
      address: "company_info",
      contact: "contact_info"
    };
    const table = tableMap[category?.toLowerCase?.()];
    if (!table) {
      await replyToLine(replyToken, "我們會請專人儘快回覆您！");
      return res.status(200).send("Unknown category");
    }

    const query = Object.entries(params || {})
      .map(([key, value]) => {
        if (typeof value === "object") {
          if (value.gte !== undefined) return `${key}=gte.${value.gte}`;
          if (value.lte !== undefined) return `${key}=lte.${value.lte}`;
          if (value.eq !== undefined) return `${key}=eq.${value.eq}`;
        }
        return `${key}=ilike.${value}`;
      })
      .join("&");

    const url = `${process.env.SUPABASE_URL}/rest/v1/${table}?select=*&${query}`;
    console.log("🚀 查詢 Supabase URL:", url);
    const resp = await fetch(url, {
      headers: {
        apikey: process.env.SUPABASE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_KEY}`
      }
    });

    const rawText = await resp.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      console.error("⚠️ Supabase 回傳非 JSON：", rawText);
      await replyToLine(replyToken, "目前資料查詢異常，我們會請專人協助您！");
      return res.status(200).send("Supabase 非 JSON 錯誤");
    }

    let replyText = "";
    if (Array.isArray(data) && data.length > 0) {
  const prompt = `以下是使用者的提問：「${userText}」
你可以參考以下資料：\n${JSON.stringify(data)}

請直接根據提問與資料，給出一段不超過250字的回答。`;
      const chatReply = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: "你是亞鈺汽車的50年資深客服專員，擅長解決問題且擅長思考拆解問題，請先透過參考資料判斷並解析問題點，只詢問參考資料需要的問題，不要問不相關參考資料的問題，如果詢問內容不在參考資料內，請先判斷這句話是什麼類型的問題，然後針對參考資料內的資料做反問問題，最後問到需要的答案，請用最積極與充滿溫度的方式回答，若參考資料與問題無關，比如他是來聊天的，請回覆罐頭訊息：\"感謝您的詢問，請詢問亞鈺汽車相關問題，我們很高興為您服務！😄\"，整體字數不要超過250個字，請針對問題直接回答答案" },
          { role: "user", content: prompt }
        ]
      });
      replyText = chatReply.choices[0].message.content.trim();
    } else {
      replyText = "目前查無符合條件的車輛，您還有其他需求嗎？";
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
