import OpenAI from "openai";
import fetch from "node-fetch";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const memory = {};
const topicMemory = {};
const aiPaused = {}; // 儲存每個 userId 的 AI 暫停狀態
const lastOfficialInput = {}; // 儲存官方帳號最後輸入時間

// 假設官方帳號的 userId（需從 LINE Developers 獲取）
const OFFICIAL_USER_ID = process.env.LINE_OFFICIAL_USER_ID; // 請在環境變數中設定

const parsePrice = (val) => {
  if (typeof val !== "string") return val;

  const chineseNumMap = {
    "零": 0, "一": 1, "二": 2, "兩": 2, "三": 3, "四": 4,
    "五": 5, "六": 6, "七": 7, "八": 8, "九": 9
  };

  const chineseUnitMap = {
    "十": 10, "百": 100, "千": 1000, "萬": 10000
  };

  const parseChineseNumber = (str) => {
    let total = 0, unit = 1, num = 0;
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

    memory[userId] = memory[userId] || [];
    topicMemory[userId] = topicMemory[userId] || {};
    aiPaused[userId] = aiPaused[userId] || false; // 初始化 AI 暫停狀態
    lastOfficialInput[userId] = lastOfficialInput[userId] || 0; // 初始化最後輸入時間

    memory[userId].push(userText);

    // 診斷：記錄 userId 和 OFFICIAL_USER_ID
    console.log("User ID:", userId, "Official User ID:", OFFICIAL_USER_ID);

    // 檢測官方帳號輸入並暫停 AI
    if (userId === OFFICIAL_USER_ID) {
      lastOfficialInput[userId] = Date.now(); // 更新最後輸入時間
      if (!aiPaused[userId]) {
        aiPaused[userId] = true;
        await replyToLine(replyToken, "AI 回覆已暫停，我們將手動處理您的問題！");
        console.log("AI 暫停觸發，userId:", userId);
        return res.status(200).json({ status: "ok", message: "AI 暫停" });
      }
    }

    // 檢查是否超過 3 分鐘無官方輸入，恢復 AI 並處理當前訊息
    const timeSinceLastInput = (Date.now() - lastOfficialInput[userId]) / 1000; // 秒
    if (aiPaused[userId] && timeSinceLastInput > 180) { // 3 分鐘 = 180 秒
      aiPaused[userId] = false;
      console.log("AI 回覆因無官方輸入超過3分鐘已恢復:", userId);
    }

    // 若 AI 暫停，跳過自動回覆
    if (aiPaused[userId]) {
      console.log("AI 暫停中，跳過自動回覆:", userId);
      return res.status(200).json({ status: "ok", message: "AI 暫停中" });
    }

    const contextMessages = memory[userId].map((text, index) => ({ role: "user", content: `${index + 1}. ${text}` }));

    const gpt = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `你是亞鈺汽車的客服助手，請分析使用者訊息並返回以下 JSON 結構：
{
  "category": "cars" | "other",
  "params": { ... },
  "followup": "..."
}

**資料表結構**：
- 表格名稱：cars
- 欄位：物件編號, 廠牌, 車款, 車型, 年式, 年份, 變速系統, 車門數, 驅動方式, 引擎燃料, 乘客數, 排氣量, 顏色, 安全性配備, 舒適性配備, 首次領牌時間, 行駛里程, 車身號碼, 引擎號碼, 外匯車資料, 車輛售價, 車輛賣點, 車輛副標題, 賣家保證, 特色說明, 影片看車, 物件圖片, 聯絡人, 行動電話, 賞車地址, line, 檢測機構, 查定編號, 認證書

**規則**：
1. 如果問題是大範圍問題（如「有幾台車」），category 設為 "cars"，params 為空，followup 設為引導問題（如「請問您想找哪個牌子的車？」）。
2. 若問題與車輛相關，category 設為 "cars"，params 包含對應欄位的查詢條件（如：廠牌、車款、年份、車輛售價等），數值欄位可使用範圍查詢（gte、lte、eq）。
3. 若無法判斷，category 設為 "other"，params 為空，followup 設為 "請詢問與亞鈺汽車相關的問題，謝謝！"。
4. 確保 params 中的鍵名與資料表欄位完全一致（使用中文欄位名如 "廠牌" 而非 "brand"），數值欄位應為對應格式（如 { "車輛售價": { "lte": 1000000 } }）。
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
      return res.status(200).json({ status: "ok", message: "GPT JSON 解析錯誤" });
    }

    const { category, params, followup } = result;
    const currentBrand = params?.廠牌;
    const lastParams = topicMemory[userId];
    const lastBrand = lastParams?.廠牌;

    if (currentBrand && currentBrand !== lastBrand) {
      memory[userId] = [userText];
      topicMemory[userId] = { ...params };
    } else {
      memory[userId] = [...memory[userId], userText].slice(-5);
      topicMemory[userId] = { ...lastParams, ...params };
    }

    if (category === "other") {
      await replyToLine(replyToken, followup || "請詢問與亞鈺汽車相關的問題，謝謝！");
      return res.status(200).json({ status: "ok", message: "無關訊息" });
    }

    let data = [];
    const validColumns = [
      "物件編號", "廠牌", "車款", "車型", "年式", "年份", "變速系統", "車門數", "驅動方式",
      "引擎燃料", "乘客數", "排氣量", "顏色", "安全性配備", "舒適性配備", "首次領牌時間",
      "行駛里程", "車身號碼", "引擎號碼", "外匯車資料", "車輛售價", "車輛賣點", "車輛副標題",
      "賣家保證", "特色說明", "影片看車", "物件圖片", "聯絡人", "行動電話", "賞車地址",
      "line", "檢測機構", "查定編號", "認證書"
    ];

    const query = Object.entries(params || {})
      .filter(([key]) => validColumns.includes(key))
      .filter(([_, value]) => value !== undefined && value !== null)
      .map(([key, value]) => {
        if (typeof value === "object" && value !== null) {
          if (value.gte !== undefined) return `${key}=gte.${encodeURIComponent(parsePrice(value.gte))}`;
          if (value.lte !== undefined) return `${key}=lte.${encodeURIComponent(parsePrice(value.lte))}`;
          if (value.eq !== undefined) return `${key}=eq.${encodeURIComponent(parsePrice(value.eq))}`;
        }
        return `${key}=ilike.${encodeURIComponent(`%${value}%`)}`;
      })
      .join("&");

    const supabaseUrl = process.env.SUPABASE_URL.replace(/\/+$/, "");
    const url = `${supabaseUrl}/rest/v1/cars?select=*${query ? `&${query}` : ""}`;
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
        await replyToLine(replyToken, "目前無法查詢車輛資料，請稍後再試或聯繫我們！");
        return res.status(200).json({ status: "ok", message: `Supabase 查詢失敗: ${errorText}` });
      }

      const rawText = await resp.text();
      try {
        data = JSON.parse(rawText);
      } catch (e) {
        console.error("⚠️ Supabase 回傳非 JSON：", rawText);
        await replyToLine(replyToken, "目前無法查詢車輛資料，請稍後再試或聯繫我們！");
        return res.status(200).json({ status: "ok", message: "Supabase 回傳非 JSON" });
      }
    } catch (e) {
      console.error("Supabase 查詢錯誤 (cars):", e.message);
      await replyToLine(replyToken, "目前無法查詢車輛資料，請稍後再試或聯繫我們！");
      return res.status(200).json({ status: "ok", message: `Supabase 查詢錯誤: ${e.message}` });
    }

    let replyText = "";
    if (Array.isArray(data) && data.length > 0) {
      const count = data.length;
      const prompt = `你是亞鈺汽車的50年資深客服專員，請根據查詢條件 ${JSON.stringify(params)} 和結果 ${JSON.stringify(data, null, 2)} 回答。當無特定條件時，回覆總車輛數（如「目前有 ${count} 台車」）並引導問題（如「請問您想找哪個牌子的車？」）。請用積極且溫暖的語氣，字數不超過250字。`;
      const chatReply = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: "你是亞鈺汽車的50年資深客服專員，擅長解決問題，用積極溫暖的語氣回答，字數不超過250字，針對查詢條件和數據直接回覆答案，無條件時回覆總車輛數並引導下個問題。"
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

    console.log("Generated replyText:", replyText); // 添加回覆內容日誌
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
