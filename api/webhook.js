import OpenAI from "openai";
import fetch from "node-fetch";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const memory = {};
const topicMemory = {};

const parsePrice = val => {
  if (typeof val !== "string") return val;

  const chineseNumMap = {
    "零": 0, "一": 1, "二": 2, "兩": 2, "三": 3, "四": 4,
    "五": 5, "六": 6, "七": 7, "八": 8, "九": 9
  };

  const chineseUnitMap = {
    "十": 10,
    "百": 100,
    "千": 1000,
    "萬": 10000
  };

  const parseChineseNumber = str => {
    let total = 0;
    let unit = 1;
    let num = 0;

    for (let i = str.length - 1; i >= 0; i--) {
      const char = str[i];
      if (chineseUnitMap[char]) {
        unit = chineseUnitMap[char];
        if (num === 0) num = 1;
        total += num * unit;
        num = 0;
        unit = 1;
      } else if (chineseNumMap[char] !== undefined) {
        num = chineseNumMap[char];
      } else if (!isNaN(Number(char))) {
        num = Number(char);
      }
    }
    total += num;
    return total;
  };

  if (val.includes("萬")) {
    let cleaned = val.replace("元", "").replace("台幣", "").trim();
    const numericPart = cleaned.replace("萬", "").trim();
    if (!isNaN(Number(numericPart))) {
      return Math.round(parseFloat(numericPart) * 10000);
    }
    return parseChineseNumber(cleaned) * 10000;
  }

  return isNaN(Number(val)) ? val : Number(val);
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
          content: `你是亞鈺汽車的客服助手，請用以下 JSON 結構分析使用者訊息，並只回傳該 JSON：
{
  "category": "cars" | "company" | "address" | "contact" | "other",
  "params": { ... },
  "followup": "..."
}

規則如下：
1. category 為 cars 時，params 會包含車輛查詢條件（如：物件編號、廠牌、車型、年式、年份、變速系統、車門數、驅動方式、引擎燃料、乘客數、排氣量、顏色、安全性配備、舒適性配備、首次領牌時間、行駛里程、車身號碼、引擎號碼、外匯車資料、車輛售價、車輛賣點、車輛副標題、賣家保證、特色說明、影片看車、物件圖片、聯絡人、行動電話、賞車地址、line、檢測機構、查定編號、認證書。）
2. 若是延續性提問（例如「還有幾台」、「哪幾款」），請使用之前的條件。
3. 若換了品牌（如 BMW → Toyota），則清除前次條件，開啟新查詢。
4. 數值條件請用 gte / lte / eq，例如：{ "年份": { "gte": 2020 } }
5. 若無法判斷，請回傳 { "category": "other", "params": {}, "followup": "請詢問亞鈺汽車相關問題，謝謝！" }`
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
          if (value.gte !== undefined) return `${key}=gte.${parsePrice(value.gte)}`;
          if (value.lte !== undefined) return `${key}=lte.${parsePrice(value.lte)}`;
          if (value.eq !== undefined) return `${key}=eq.${parsePrice(value.eq)}`;
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
      const prompt = `請用繁體中文、客服語氣、字數不超過250字，如果是詢問數量，直接給數量，直接回答使用者查詢條件為 ${JSON.stringify(params)}，以下是結果：\n${JSON.stringify(data)}`;
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
