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
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed", message: "僅允許 POST 請求" });
    }

    const body = req.body;
    const event = body.events?.[0];
    const userText = event?.message?.text?.trim();
    const replyToken = event?.replyToken;
    const userId = event?.source?.userId;

    if (!userText || !replyToken || !userId) {
      return res.status(400).json({ error: "無效請求", message: "缺少必要欄位" });
    }

    // 驗證環境變數
    if (!process.env.OPENAI_API_KEY || !process.env.SUPABASE_URL || !process.env.SUPABASE_KEY || !process.env.LINE_TOKEN) {
      console.error("缺少環境變數");
      await replyToLine(replyToken, "系統發生錯誤，請稍後再試！");
      return res.status(500).json({ error: "伺服器配置錯誤" });
    }

    const contextMessages = memory[userId]?.map(text => ({ role: "user", content: text })) || [];
    const gpt = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `你是亞鈺汽車的客服助手，請分析使用者訊息並返回以下 JSON 結構：
{
  "category": "cars" | "company" | "other",
  "params": { ... },
  "followup": "..."
}

**資料表結構**：
- 表格名稱：CARS
- 欄位：物件編號, 廠牌, 車款, 車型, 年式, 年份, 變速系統, 車門數, 驅動方式, 引擎燃料, 乘客數, 排氣量, 顏色, 安全性配備, 舒適性配備, 首次領牌時間, 行駛里程, 車身號碼, 引擎號碼, 外匯車資料, 車輛售價, 車輛賣點, 車輛副標題, 賣家保證, 特色說明, 影片看車, 物件圖片, 聯絡人, 行動電話, 賞車地址, line, 檢測機構, 查定編號, 認證書

**規則**：
1. 若問題與車輛相關，category 設為 "cars"，params 包含對應欄位的查詢條件（如：廠牌、車款、年份、車輛售價等），數值欄位（如車輛售價、年份、行駛里程）可使用範圍查詢（gte、lte、eq）。
2. 若問題與公司資訊相關（如地址、保固、營業時間），category 設為 "company"，params 包含相關關鍵字。
3. 若無法判斷，category 設為 "other"，params 為空，followup 設為 "請詢問與亞鈺汽車相關的問題，謝謝！"。
4. 確保 params 中的鍵名與資料表欄位完全一致，數值欄位（如車輛售價、年份）應為對應格式（如 { "車輛售價": { "lte": 1000000 } }）。
5. followup 為建議的回覆訊息，保持簡潔且符合客服語氣。`
        },
        ...contextMessages,
        { role: "user", content: userText }
      ],
      temperature: 0.7,
      max_tokens: 500
    });

    let result;
    try {
      const content = gpt.choices[0].message.content.trim().replace(/^```json\n?|\n?```$/g, "");
      result = JSON.parse(content);
      if (!result.category || !result.params || !result.followup) {
        throw new Error("無效的 JSON 結構");
      }
    } catch (e) {
      console.error("GPT JSON 解析錯誤:", e.message);
      await replyToLine(replyToken, "不好意思，請再試一次，我們會請專人協助您！");
      return res.status(200).json({ status: "GPT JSON 解析錯誤" });
    }

    const { category, params, followup } = result;
    const currentBrand = params?.廠牌;
    const lastParams = topicMemory[userId] || {};
    const lastBrand = lastParams.廠牌;

    if (currentBrand && currentBrand !== lastBrand) {
      memory[userId] = [userText];
      topicMemory[userId] = { ...params };
    } else {
      memory[userId] = [...(memory[userId] || []), userText].slice(-5); // 限制記憶為最近 5 條訊息
      topicMemory[userId] = { ...lastParams, ...params };
    }

    if (category === "other") {
      await replyToLine(replyToken, followup || "請詢問與亞鈺汽車相關的問題，謝謝！");
      return res.status(200).json({ status: "無關訊息" });
    }

    let data = [];
    const tables = category === "cars" ? ["CARS"] : ["company"];
    const validColumns = [
      "物件編號", "廠牌", "車款", "車型", "年式", "年份", "變速系統", "車門數", "驅動方式", 
      "引擎燃料", "乘客數", "排氣量", "顏色", "安全性配備", "舒適性配備", "首次領牌時間", 
      "行駛里程", "車身號碼", "引擎號碼", "外匯車資料", "車輛售價", "車輛賣點", "車輛副標題", 
      "賣家保證", "特色說明", "影片看車", "物件圖片", "聯絡人", "行動電話", "賞車地址", 
      "line", "檢測機構", "查定編號", "認證書"
    ];

    for (const table of tables) {
      const query = Object.entries(params || {})
        .filter(([key, _]) => validColumns.includes(key)) // 確保鍵名有效
        .filter(([_, value]) => value !== undefined && value !== null)
        .map(([key, value]) => {
          if (typeof value === "object") {
            if (value.gte !== undefined) return `${key}=gte.${encodeURIComponent(parsePrice(value.gte))}`;
            if (value.lte !== undefined) return `${key}=lte.${encodeURIComponent(parsePrice(value.lte))}`;
            if (value.eq !== undefined) return `${key}=eq.${encodeURIComponent(parsePrice(value.eq))}`;
          }
          return `${key}=ilike.${encodeURIComponent(`%${value}%`)}`;
        })
        .join("&");

      if (!query) {
        console.log("無有效查詢參數，跳過查詢");
        continue;
      }

      const url = `${process.env.SUPABASE_URL}/rest/v1/${table}?select=*&${query}`;
      console.log("🚀 查詢 Supabase URL:", url);

      try {
        const resp = await fetch(url, {
          headers: {
            apikey: process.env.SUPABASE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_KEY}`,
            "Content-Type": "application/json"
          }
        });

        if (!resp.ok) {
          console.error(`Supabase 錯誤: ${resp.status} ${resp.statusText}`);
          continue;
        }

        const rawText = await resp.text();
        try {
          data = JSON.parse(rawText);
        } catch (e) {
          console.error("⚠️ Supabase 回傳非 JSON：", rawText);
          continue;
        }

        if (Array.isArray(data) && data.length > 0) break;
      } catch (e) {
        console.error(`Supabase 查詢錯誤 (${table}):`, e.message);
      }
    }

    let replyText = "";
    if (Array.isArray(data) && data.length > 0) {
      const prompt = `請用繁體中文、客服語氣、字數不超過250字，直接回答使用者查詢條件為 ${JSON.stringify(params)}，以下是結果：\n${JSON.stringify(data, null, 2)}。請重點突出車輛的廠牌、車款、年份、車輛售價及特色說明，並提供聯絡人與行動電話資訊。`;
      const chatReply = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { 
            role: "system", 
            content: "你是亞鈺汽車的50年資深客服專員，請用自然、貼近人心的口吻回覆客戶問題，重點突出車輛資訊（廠牌、車款、年份、售價、特色），並提供聯絡資訊，字數不超過250字。" 
          },
          { role: "user", content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 250
      });
      replyText = chatReply.choices[0].message.content.trim();
    } else {
      replyText = "目前查無符合條件的車輛資料，您可以提供更多條件（如廠牌、價格範圍）或聯繫我們進一步確認！";
    }

    await replyToLine(replyToken, replyText);
    return res.status(200).json({ status: "ok", reply: replyText });
  } catch (error) {
    console.error("❌ webhook 錯誤：", error);
    await replyToLine(req.body.events?.[0]?.replyToken, "系統發生錯誤，請稍後再試！");
    return res.status(500).json({ error: "內部伺服器錯誤", message: error.message });
  }
}

async function replyToLine(replyToken, text) {
  if (!replyToken || !text) return;

  try {
    const response = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.LINE_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        replyToken,
        messages: [{ type: "text", text: text.slice(0, 2000) }] // LINE 訊息長度限制 2000 字
      })
    });

    if (!response.ok) {
      console.error(`LINE API 錯誤: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    console.error("LINE 回覆錯誤:", error.message);
  }
}
