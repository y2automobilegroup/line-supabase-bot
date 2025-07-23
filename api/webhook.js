import OpenAI from "openai";
import fetch from "node-fetch";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const memory = {};
const topicMemory = {};

// 改進的價格解析函式
const parsePrice = (val) => {
  if (val === null || val === undefined) return null;
  if (typeof val === "number") return val;

  // 處理中文數字
  if (typeof val === "string") {
    const chineseNumMap = {
      零: 0,
      一: 1,
      二: 2,
      兩: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9,
    };
    const chineseUnitMap = { 十: 10, 百: 100, 千: 1000, 萬: 10000 };

    const parseChineseNumber = (str) => {
      let total = 0,
        unit = 1,
        num = 0;
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

    // 移除貨幣符號和空格
    const cleaned = val.replace(/[元台幣\s,]/g, "").trim();

    // 處理「萬」單位
    if (cleaned.includes("萬")) {
      const numericPart = cleaned.replace("萬", "").trim();
      const number = isNaN(Number(numericPart))
        ? parseChineseNumber(numericPart)
        : parseFloat(numericPart);
      return Math.round(number * 10000);
    }

    // 嘗試解析為數字
    const number = parseFloat(cleaned);
    return isNaN(number) ? val : number;
  }

  return val;
};

// 改進的 Supabase 查詢函式
async function querySupabaseByParams(params = {}) {
  try {
    // 驗證環境變數
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
      throw new Error("缺少必要的 Supabase 環境變數");
    }

    // 構建查詢參數
    const query = Object.entries(params)
      .filter(([_, value]) => value !== undefined && value !== null)
      .map(([key, value]) => {
        if (typeof value === "object") {
          if (value.gte !== undefined)
            return `${encodeURIComponent(key)}=gte.${parsePrice(value.gte)}`;
          if (value.lte !== undefined)
            return `${encodeURIComponent(key)}=lte.${parsePrice(value.lte)}`;
          if (value.eq !== undefined)
            return `${encodeURIComponent(key)}=eq.${parsePrice(value.eq)}`;
        }
        return `${encodeURIComponent(key)}=ilike.${encodeURIComponent(`%${value}%`)}`;
      })
      .join("&");

    const url = `${process.env.SUPABASE_URL}/rest/v1/cars?select=*&${query}`;
    console.log("🚀 查詢 Supabase URL:", url);

    // 發送請求
    const resp = await fetch(url, {
      headers: {
        apikey: process.env.SUPABASE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_KEY}`,
        "Content-Type": "application/json",
      },
    });

    // 檢查 HTTP 狀態碼
    if (!resp.ok) {
      const errorText = await resp.text();
      console.error(`Supabase 請求失敗 (${resp.status}):`, errorText);
      throw new Error(`Supabase 請求失敗: ${resp.statusText}`);
    }

    // 檢查內容類型
    const contentType = resp.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      const raw = await resp.text();
      console.error("⚠️ Supabase 回傳非 JSON：", raw);
      throw new Error("Supabase 返回非 JSON 響應");
    }

    return await resp.json();
  } catch (error) {
    console.error("❌ Supabase 查詢錯誤：", error);
    throw error; // 重新拋出錯誤讓上層處理
  }
}

// LINE 回覆函式
async function replyToLine(replyToken, text) {
  try {
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

    if (!response.ok) {
      const errorText = await response.text();
      console.error("LINE 回覆失敗:", errorText);
      throw new Error("LINE 回覆失敗");
    }
  } catch (error) {
    console.error("❌ LINE 回覆錯誤：", error);
    throw error;
  }
}

// 主處理函式
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", ["POST"]);
      return res.status(405).end("Method Not Allowed");
    }

    const body = req.body;
    const event = body.events?.[0];
    const userText = event?.message?.text;
    const replyToken = event?.replyToken;
    const userId = event?.source?.userId;

    if (!userText || !replyToken) {
      return res.status(200).json({ status: "ok", message: "Invalid message" });
    }

    // 準備對話上下文
    const contextMessages = memory[userId]?.map((text) => ({
      role: "user",
      content: text,
    })) || [];

    // 使用 GPT 分析用戶意圖
    const gptResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `你是亞鈺汽車的客服助手，請用以下 JSON 結構分析使用者訊息，並只回傳該 JSON：\n{
  "category": "cars" | "company" | "other",
  "params": { ... },
  "followup": "..."
}`,
        },
        ...contextMessages,
        { role: "user", content: userText },
      ],
    });

    // 解析 GPT 回應
    let result;
    try {
      result = JSON.parse(
        gptResponse.choices[0].message.content
          .trim()
          .replace(/^```json\n?|\n?```$/g, "")
      );
    } catch (e) {
      console.error("GPT JSON 解析錯誤:", e);
      await replyToLine(
        replyToken,
        "不好意思，請再試一次，我們會請專人協助您！"
      );
      return res.status(200).json({ status: "ok", message: "GPT JSON parse error" });
    }

    const { category, params = {}, followup } = result;
    const currentBrand = params?.廠牌;
    const lastParams = topicMemory[userId] || {};
    const lastBrand = lastParams.廠牌;

    // 更新記憶
    if (currentBrand && currentBrand !== lastBrand) {
      memory[userId] = [userText];
      topicMemory[userId] = { ...params };
    } else {
      memory[userId] = [...(memory[userId] || []), userText];
      topicMemory[userId] = { ...lastParams, ...params };
    }

    let replyText = followup || "";

    // 處理車輛或公司查詢
    if (category === "cars" || category === "company") {
      try {
        const data = await querySupabaseByParams(params);
        
        if (Array.isArray(data) && data.length > 0) {
          const prompt = `請用繁體中文、客服語氣、字數不超過250字，直接回答使用者查詢條件為 ${JSON.stringify(
            params
          )}，以下是結果：\n${JSON.stringify(data)}`;
          
          const chatReply = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
              {
                role: "system",
                content: "你是亞鈺汽車的客服專員，請根據以下內容精準回覆客戶問題：",
              },
              { role: "user", content: prompt },
            ],
          });
          
          replyText = chatReply.choices[0].message.content.trim();
        } else {
          replyText = "目前查無符合條件的資料，您還有其他問題嗎？";
        }
      } catch (error) {
        console.error("查詢處理錯誤:", error);
        replyText = "查詢時發生錯誤，請稍後再試或聯繫客服人員。";
      }
    }

    // 回覆用戶
    await replyToLine(replyToken, replyText);
    return res.status(200).json({ status: "ok" });
    
  } catch (error) {
    console.error("❌ 主處理函式錯誤：", error);
    return res.status(200).json({ status: "error", message: "error handled" });
  }
}
