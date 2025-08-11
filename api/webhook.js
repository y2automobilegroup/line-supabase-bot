import OpenAI from "openai";
import fetch from "node-fetch";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const memory = {}; // 儲存對話歷史
const topicMemory = {}; // 儲存主題參數
const aiPaused = {}; // AI 暫停狀態
const lastOfficialInput = {}; // 官方輸入時間

const OFFICIAL_USER_ID = process.env.LINE_OFFICIAL_USER_ID;
const MAX_MEMORY_ITEMS = 20; // 10 對話 = 20 條（用戶 + AI）

const parsePrice = (val) => {
  if (typeof val !== "string") return val;
  const chineseNumMap = { "零": 0, "一": 1, "二": 2, "兩": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
  const chineseUnitMap = { "十": 10, "百": 100, "千": 1000, "萬": 10000 };
  const parseChineseNumber = (str) => {
    let total = 0, unit = 1, num = 0;
    for (let i = str.length - 1; i >= 0; i--) {
      const char = str[i];
      if (chineseUnitMap[char]) { unit = chineseUnitMap[char]; if (num === 0) num = 1; total += num * unit; num = 0; unit = 1; }
      else if (chineseNumMap[char] !== undefined) num = chineseNumMap[char];
      else if (!isNaN(Number(char))) num = Number(char);
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
  console.log("Received request method:", req.method, "body:", JSON.stringify(req.body, null, 2));

  try {
    if (req.method !== "POST") {
      console.warn("⚠️ Non-POST request received:", req.method);
      return res.status(405).json({ error: "Method Not Allowed", message: "僅允許 POST 請求" });
    }

    const { events } = req.body;
    if (!events || !Array.isArray(events) || events.length === 0) {
      console.warn("⚠️ No events in webhook payload or invalid events array");
      return res.status(200).json({ status: "ok", message: "No events to process" });
    }

    const event = events[0];
    const userText = event?.message?.text?.trim();
    const replyToken = event?.replyToken;
    const userId = event?.source?.userId;

    if (!userText || !replyToken || !userId) {
      console.warn("⚠️ Missing required fields:", { userText, replyToken, userId });
      await replyToLine(replyToken, "請提供完整的訊息內容，謝謝！");
      return res.status(200).json({ status: "ok", message: "缺少必要欄位，已回覆用戶" });
    }

    const requiredEnv = ["OPENAI_API_KEY", "SUPABASE_URL", "SUPABASE_KEY", "LINE_TOKEN", "LINE_OFFICIAL_USER_ID"];
    const missingEnv = requiredEnv.filter(env => !process.env[env]);
    if (missingEnv.length > 0) {
      console.error(`缺少環境變數: ${missingEnv.join(", ")}`);
      await replyToLine(replyToken, "系統發生錯誤，請稍後再試！");
      return res.status(200).json({ status: "ok", message: `缺少環境變數: ${missingEnv.join(", ")}` });
    }

    // 記憶最近 10 對話（20 條記錄）
    memory[userId] = memory[userId] || [];
    if (memory[userId].length >= MAX_MEMORY_ITEMS) {
      memory[userId].splice(0, 2); // 移除最早的 1 對話
    }
    memory[userId].push(`用戶: ${userText}`);

    topicMemory[userId] = topicMemory[userId] || {};
    aiPaused[userId] = aiPaused[userId] || false;
    lastOfficialInput[userId] = lastOfficialInput[userId] || 0;

    console.log("User ID:", userId, "Official User ID:", OFFICIAL_USER_ID);

    if (userId === OFFICIAL_USER_ID) {
      lastOfficialInput[userId] = Date.now();
      if (!aiPaused[userId]) {
        aiPaused[userId] = true;
        await replyToLine(replyToken, "AI 回覆已暫停，我們將手動處理您的問題！");
        console.log("AI 暫停觸發，userId:", userId);
        return res.status(200).json({ status: "ok", message: "AI 暫停" });
      }
    }

    const timeSinceLastInput = (Date.now() - lastOfficialInput[userId]) / 1000;
    if (aiPaused[userId] && timeSinceLastInput > 180) {
      aiPaused[userId] = false;
      console.log("AI 回覆因無官方輸入超過3分鐘已恢復:", userId);
    }

    if (aiPaused[userId]) {
      console.log("AI 暫停中，跳過自動回覆:", userId);
      return res.status(200).json({ status: "ok", message: "AI 暫停中" });
    }

    const contextMessages = memory[userId].map((text, index) => ({ role: "user", content: text }));
    const estimatedTokens = contextMessages.length * 10 + userText.length + 100; // 粗略估計
    console.log("Estimated tokens:", estimatedTokens, "Context Messages:", contextMessages);

    // 若令牌估計超過閾值，縮減上下文
    let trimmedContext = contextMessages;
    if (estimatedTokens > 20000) {
      trimmedContext = contextMessages.slice(-10); // 縮減至 5 對話
      console.log("Token limit exceeded, trimmed to:", trimmedContext);
    }

    const gpt = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `你是亞鈺汽車客服助手，基於對話歷史返回 JSON：{"category":"cars"|"other","params":{}, "followup":"..."}。若問車輛數量，category 設 "cars"，params 含條件（如價格範圍），followup 回覆數量。若問具體車輛（如"哪5台"），根據前次條件從 cars 表查詢並列出詳情。cars 表欄位：物件編號, 廠牌, 車款, 車型, 年式, 年份, 變速系統, 車門數, 驅動方式, 引擎燃料, 乘客數, 排氣量, 顏色, 安全性配備, 舒適性配備, 首次領牌時間, 行駛里程, 車身號碼, 引擎號碼, 外匯車資料, 車輛售價, 車輛賣點, 車輛副標題, 賣家保證, 特色說明, 影片看車, 物件圖片, 聯絡人, 行動電話, 賞車地址, line, 檢測機構, 查定編號, 認證書。回覆簡潔，列出最多5台車（廠牌、車款、售價）。`
        },
        ...trimmedContext,
        { role: "user", content: userText }
      ],
      temperature: 0.7,
      max_tokens: 300
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
      return res.status(200).json({ status: "ok", message: "GPT JSON 解析錯誤" });
    }

    const { category, params, followup } = result;
    let data = [];
    if (category === "cars" && Object.keys(params).length > 0) {
      const query = Object.entries(params)
        .filter(([key]) => ["車輛售價"].includes(key))
        .filter(([_, value]) => value !== undefined && value !== null)
        .map(([key, value]) => {
          if (typeof value === "object" && value.lte !== undefined) return `${key}=lte.${encodeURIComponent(parsePrice(value.lte))}`;
          return `${key}=ilike.${encodeURIComponent(`%${value}%`)}`;
        })
        .join("&");

      const supabaseUrl = process.env.SUPABASE_URL.replace(/\/+$/, "");
      const url = `${supabaseUrl}/rest/v1/cars?select=廠牌,車款,車輛售價${query ? `&${query}` : ""}&limit=5`;
      console.log("🚀 查詢 Supabase URL:", url);

      try {
        const resp = await fetch(url, {
          headers: {
            apikey: process.env.SUPABASE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_KEY}`,
            "Content-Type": "application/json",
            "Prefer": "return=representation"
          },
          signal: AbortSignal.timeout(10000)
        });

        if (!resp.ok) {
          const errorText = await resp.text();
          console.error(`Supabase 錯誤: ${resp.status} ${resp.statusText}`, errorText);
          await replyToLine(replyToken, "目前無法查詢車輛資料，請稍後再試！");
          return res.status(200).json({ status: "ok", message: `Supabase 查詢失敗: ${errorText}` });
        }

        data = await resp.json();
      } catch (e) {
        console.error("Supabase 查詢錯誤:", e.message);
        await replyToLine(replyToken, "目前無法查詢車輛資料，請稍後再試！");
        return res.status(200).json({ status: "ok", message: `Supabase 查詢錯誤: ${e.message}` });
      }
    }

    let replyText = followup;
    if (category === "cars" && data.length > 0) {
      replyText = `符合條件的車輛：\n${data.map(car => `${car.廠牌} ${car.車款} - $${car.車輛售價}元`).join("\n")}`;
    }

    memory[userId].push(`AI: ${replyText}`); // 記錄 AI 回覆
    await replyToLine(replyToken, replyText);
    return res.status(200).json({ status: "ok", reply: replyText });
  } catch (error) {
    console.error("❌ webhook 錯誤：", error.message, error.stack);
    const replyToken = req.body.events?.[0]?.replyToken;
    if (replyToken) {
      await replyToLine(replyToken, "系統發生錯誤，請稍後再試！");
    }
    return res.status(200).json({ status: "ok", message: `內部錯誤: ${error.message}` });
  }
}

async function replyToLine(replyToken, text) {
  if (!replyToken || !text) {
    console.warn("缺少 replyToken 或 text，無法回覆 LINE");
    return;
  }
  try {
    const response = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.LINE_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        replyToken,
        messages: [{ type: "text", text: text.slice(0, 2000) }]
      }),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`LINE API 錯誤: ${response.status} ${response.statusText}`, errorText);
    }
  } catch (error) {
    console.error("LINE 回覆錯誤:", error.message);
  }
}
