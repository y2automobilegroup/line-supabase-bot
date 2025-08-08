import OpenAI from "openai";
import fetch from "node-fetch";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const memory = {}; // 儲存對話上下文記憶
const topicMemory = {}; // 儲存主題相關參數記憶

const parsePrice = (val) => {
  if (typeof val !== "string") return val;

  const chineseNumMap = { "零": 0, "一": 1, "二": 2, "兩": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
  const chineseUnitMap = { "十": 10, "百": 100, "千": 1000, "萬": 10000 };

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
    if (!isNaN(Number(numericPart))) return Math.round(parseFloat(numericPart) * 10000);
    return parseChineseNumber(numericPart) * 10000;
  }
  return isNaN(Number(cleaned)) ? val : Number(cleaned);
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export default async function handler(req, res) {
  console.log("📥 Incoming LINE webhook request:", JSON.stringify(req.body, null, 2));

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

    const requiredEnv = ["OPENAI_API_KEY", "SUPABASE_URL", "SUPABASE_KEY", "LINE_TOKEN"];
    const missingEnv = requiredEnv.filter(env => !process.env[env]);
    if (missingEnv.length > 0) {
      console.error(`缺少環境變數: ${missingEnv.join(", ")}`);
      await replyToLine(replyToken, "系統發生錯誤，請稍後再試！");
      return res.status(200).json({ status: "ok", message: `缺少環境變數: ${missingEnv.join(", ")}` });
    }

    // 初始化或更新記憶
    memory[userId] = memory[userId] || [];
    topicMemory[userId] = topicMemory[userId] || {};
    memory[userId].push(userText); // 記錄當前訊息

    // 限制上下文記憶為最近 1 條訊息
    const contextMessages = memory[userId].slice(-1).map(text => ({ role: "user", content: text }));

    // 重試邏輯，最多重試 2 次
    let gptResult = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const gpt = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            {
              role: "system",
              content: `你是亞鈺汽車的客服助手，無論客戶問什麼問題，僅基於 cars 表格內容回覆。返回以下 JSON 結構：
{
  "category": "cars" | "other",
  "params": { ... },
  "followup": "..."
}

**資料表結構**：
- 表格名稱：cars
- 欄位：物件編號, 廠牌, 車款, 車型, 年式, 年份, 變速系統, 車門數, 驅動方式, 引擎燃料, 乘客數, 排氣量, 顏色, 安全性配備, 舒適性配備, 首次領牌時間, 行駛里程, 車身號碼, 引擎號碼, 外匯車資料, 車輛售價, 車輛賣點, 車輛副標題, 賣家保證, 特色說明, 影片看車, 物件圖片, 聯絡人, 行動電話, 賞車地址, line, 檢測機構, 查定編號, 認證書

**規則**：
1. category 總是設為 "cars"，params 包含與問題相關的查詢條件（如 "廠牌" 或 "年份"），使用 gte/lte/eq 或 ilike。
2. 若問題無法轉為查詢條件，params 為空，followup 提供基於表格的通用回覆。
3. 確保 params 鍵名與資料表欄位一致。
4. followup 為簡潔回覆，基於表格內容回答。`
            },
            ...contextMessages,
            { role: "user", content: userText }
          ],
          temperature: 0.7,
          max_tokens: 200
        });

        const content = gpt.choices[0].message.content.trim().replace(/^```json\n?|\n?```$/g, "");
        gptResult = JSON.parse(content);
        if (!gptResult.category || !gptResult.params || !gptResult.followup) {
          throw new Error("無效的 JSON 結構");
        }
        break;
      } catch (e) {
        if (e.status === 429 && attempt < 3) {
          console.warn(`OpenAI 429 錯誤，第 ${attempt} 次嘗試，等待 ${attempt * 2000}ms 後重試`);
          await delay(attempt * 2000);
          continue;
        }
        console.error("GPT 錯誤:", e.message);
        await replyToLine(replyToken, "系統忙碌中，請稍後再試或聯繫我們！");
        return res.status(200).json({ status: "ok", message: `GPT 錯誤: ${e.message}` });
      }
    }

    if (!gptResult) {
      await replyToLine(replyToken, "系統忙碌中，請稍後再試或聯繫我們！");
      return res.status(200).json({ status: "ok", message: "GPT 請求失敗" });
    }

    const { category, params, followup } = gptResult;

    if (category === "other") {
      await replyToLine(replyToken, followup || "請提供與車輛相關的問題，我們將根據車輛資訊回覆！");
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

    if (!query) {
      console.log("無有效查詢參數，跳過查詢");
      await replyToLine(replyToken, followup || "目前無法根據您的問題查詢，請提供更具體的車輛相關條件（如廠牌、年份），我們將根據車輛資訊回覆！");
      return res.status(200).json({ status: "ok", message: "無有效查詢參數" });
    }

    const supabaseUrl = process.env.SUPABASE_URL.replace(/\/+$/, "");
    const url = `${supabaseUrl}/rest/v1/cars?select=*&${query}`;
    console.log("🚀 查詢 Supabase URL:", url);

    try {
      const resp = await fetch(url, {
        headers: {
          apikey: process.env.SUPABASE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_KEY`,
          "Content-Type": "application/json",
          "Prefer": "return=representation"
        },
        signal: AbortSignal.timeout(10000)
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        console.error(`Supabase 錯誤: ${resp.status} ${resp.statusText}`, errorText);
        await replyToLine(replyToken, "目前無法查詢車輛資料，請稍後再試或聯繫我們的聯絡人！");
        return res.status(200).json({ status: "ok", message: `Supabase 查詢失敗: ${errorText}` });
      }

      const rawText = await resp.text();
      try {
        data = JSON.parse(rawText);
      } catch (e) {
        console.error("⚠️ Supabase 回傳非 JSON：", rawText);
        await replyToLine(replyToken, "目前無法查詢車輛資料，請稍後再試或聯繫我們的聯絡人！");
        return res.status(200).json({ status: "ok", message: "Supabase 回傳非 JSON" });
      }
    } catch (e) {
      console.error("Supabase 查詢錯誤 (cars):", e.message);
      await replyToLine(replyToken, "目前無法查詢車輛資料，請稍後再試或聯繫我們的聯絡人！");
      return res.status(200).json({ status: "ok", message: `Supabase 查詢錯誤: ${e.message}` });
    }

    // 基於查詢結果回覆，僅提供簡潔答案
    let replyText = "";
    if (Array.isArray(data) && data.length > 0) {
      const count = data.length;
      replyText = `目前有 ${count} 台符合條件的車輛，涵蓋廠牌、車款、年份等資訊。如需詳細資料（如車輛售價、聯絡人），請繼續提問！`;
    } else {
      replyText = "目前查無符合條件的車輛資料，請提供更多條件（如廠牌、年份）或聯繫我們的聯絡人！";
    }

    await replyToLine(replyToken, replyText);
    return res.status(200).json({ status: "ok", reply: replyText });
  } catch (error) {
    console.error("❌ webhook 錯誤：", error.message, error.stack);
    const replyToken = req.body.events?.[0]?.replyToken;
    if (replyToken) {
      await replyToLine(replyToken, "系統忙碌中，請稍後再試或聯繫我們的聯絡人！");
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
      console.error(`LINE API 錯誤: ${response.status} ${resp.statusText}`, errorText);
    }
  } catch (error) {
    console.error("LINE 回覆錯誤:", error.message);
  }
}
