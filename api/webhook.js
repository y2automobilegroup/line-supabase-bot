import OpenAI from "openai";
import fetch from "node-fetch";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const memory = {};
const topicMemory = {};

// 列名中英文映射
const columnMapping = {
  "物件編號": "item_id",
  "廠牌": "brand",
  "車款": "model",
  "車型": "car_type",
  "年式": "model_year",
  "年份": "manufacture_year",
  "變速系統": "transmission",
  "車門數": "doors",
  "驅動方式": "drive_type",
  "引擎燃料": "fuel_type",
  "乘客數": "passengers",
  "排氣量": "engine_cc",
  "顏色": "color",
  "安全性配備": "safety_features",
  "舒適性配備": "comfort_features",
  "首次領牌時間": "first_registration",
  "行駛里程": "mileage",
  "車身號碼": "vin",
  "引擎號碼": "engine_no",
  "外匯車資料": "import_info",
  "車輛售價": "price",
  "車輛賣點": "selling_points",
  "車輛副標題": "subtitle",
  "賣家保證": "warranty",
  "特色說明": "features",
  "影片看車": "video_url",
  "物件圖片": "images",
  "聯絡人": "contact",
  "行動電話": "phone",
  "賞車地址": "address",
  "line": "line_id",
  "檢測機構": "inspection_org",
  "查定編號": "inspection_no",
  "認證書": "certification"
};

// 價格解析器（支援中文數字）
const parsePrice = val => {
  if (typeof val !== "string") return val;

  const chineseNumMap = {
    "零": 0, "一": 1, "二": 2, "兩": 2, "三": 3, "四": 4,
    "五": 5, "六": 6, "七": 7, "八": 8, "九": 9
  };

  const chineseUnitMap = {
    "十": 10, "百": 100, "千": 1000, "萬": 10000, "億": 100000000
  };

  const parseChineseNumber = str => {
    let total = 0, unit = 1, num = 0;
    for (let i = str.length - 1; i >= 0; i--) {
      const char = str[i];
      if (chineseUnitMap[char]) {
        unit = chineseUnitMap[char];
        if (num === 0) num = 1;
        total += num * unit;
        num = 0;
      } else if (chineseNumMap[char] !== undefined) {
        num = chineseNumMap[char];
      } else if (!isNaN(Number(char))) {
        num = Number(char);
      }
    }
    return total + num;
  };

  const cleaned = val.replace(/[元台幣\s,]/g, "").trim();
  if (cleaned.includes("萬")) {
    const numericPart = cleaned.replace("萬", "");
    return parseFloat(numericPart) * 10000;
  }
  if (cleaned.includes("億")) {
    const numericPart = cleaned.replace("億", "");
    return parseFloat(numericPart) * 100000000;
  }
  return isNaN(Number(cleaned)) ? parseChineseNumber(cleaned) : Number(cleaned);
};

// 安全查詢建構器
const buildSupabaseQuery = (table, params) => {
  const queryParams = new URLSearchParams();
  queryParams.append('select', '*');

  Object.entries(params || {}).forEach(([key, value]) => {
    const dbKey = columnMapping[key] || key;
    
    if (typeof value === 'object') {
      if (value.gte !== undefined) queryParams.append(dbKey, `gte.${parsePrice(value.gte)}`);
      if (value.lte !== undefined) queryParams.append(dbKey, `lte.${parsePrice(value.lte)}`);
      if (value.eq !== undefined) queryParams.append(dbKey, `eq.${parsePrice(value.eq)}`);
    } else if (value !== undefined && value !== null && value !== '') {
      queryParams.append(dbKey, `ilike.%${value}%`);
    }
  });

  return `${process.env.SUPABASE_URL}/rest/v1/${table}?${queryParams.toString()}`;
};

// 強化錯誤處理的資料獲取
const fetchFromSupabase = async (url) => {
  try {
    const startTime = Date.now();
    const resp = await fetch(url, {
      headers: {
        apikey: process.env.SUPABASE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000 // 10秒超時
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${errorText.slice(0, 200)}`);
    }

    const data = await resp.json();
    console.log(`✅ 成功查詢 ${url} (${Date.now() - startTime}ms)`);
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error(`❌ 查詢失敗 ${url}:`, error.message);
    return null;
  }
};

// LINE 回覆函數
const replyToLine = async (replyToken, text) => {
  try {
    await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.LINE_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        replyToken,
        messages: [{ type: "text", text: text.slice(0, 2000) }] // LINE 限制2000字
      }),
      timeout: 5000
    });
  } catch (error) {
    console.error("LINE 回覆失敗:", error);
  }
};

export default async function handler(req, res) {
  try {
    // 基礎驗證
    if (req.method !== "POST") return res.status(405).json({ error: "僅允許 POST 請求" });
    
    const { events } = req.body;
    const event = events?.[0];
    if (!event) return res.status(400).json({ error: "無效的事件格式" });

    const { message, replyToken, source } = event;
    const userText = message?.text;
    const userId = source?.userId;

    if (!userText || !replyToken) {
      return res.status(200).json({ status: "忽略無效訊息" });
    }

    // 記憶體管理
    const updateMemory = (params) => {
      const currentBrand = params?.廠牌;
      const lastParams = topicMemory[userId] || {};

      if (currentBrand && currentBrand !== lastParams.廠牌) {
        memory[userId] = [userText];
        topicMemory[userId] = { ...params };
      } else {
        memory[userId] = [...(memory[userId] || []), userText];
        topicMemory[userId] = { ...lastParams, ...params };
      }
    };

    // GPT 分析使用者意圖
    const contextMessages = memory[userId]?.map(text => ({ 
      role: "user", 
      content: text 
    })) || [];

    const gptResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `（保持原有系統提示）`
        },
        ...contextMessages,
        { role: "user", content: userText }
      ],
      temperature: 0.3,
      max_tokens: 500
    });

    let parsedResult;
    try {
      const rawContent = gptResponse.choices[0].message.content;
      parsedResult = JSON.parse(rawContent.trim().replace(/^```json\n?|\n?```$/g, ""));
    } catch (e) {
      await replyToLine(replyToken, "抱歉，解析訊息時發生問題，請換個方式詢問");
      return res.status(200).json({ error: "GPT 回應解析失敗" });
    }

    const { category, params = {}, followup } = parsedResult;
    updateMemory(params);

    // 處理非車輛相關查詢
    if (category === "other") {
      await replyToLine(replyToken, followup || "請提供更多車輛相關資訊");
      return res.status(200).json({ status: "非車輛查詢" });
    }

    // 查詢 Supabase 資料
    const tables = category === "cars" ? ["cars", "company"] : ["company"];
    let responseData = [];

    for (const table of tables) {
      const url = buildSupabaseQuery(table, params);
      console.log("🔍 查詢 URL:", url);

      const data = await fetchFromSupabase(url);
      if (data && data.length > 0) {
        responseData = data;
        break;
      }
    }

    // 生成回覆
    let replyText;
    if (responseData.length > 0) {
      const prompt = `根據以下查詢條件和結果生成客服回覆：
條件: ${JSON.stringify(params)}
結果: ${JSON.stringify(responseData.slice(0, 3))} // 限制資料量
要求: 用繁體中文、親切口吻、不超過200字、重點突出規格與價格`;

      const gptReply = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { 
            role: "system", 
            content: "你是專業汽車銷售顧問，回覆需包含: 1. 符合條件車款數量 2. 主要規格 3. 價格範圍 4. 邀請進一步洽詢" 
          },
          { role: "user", content: prompt }
        ],
        temperature: 0.7
      });

      replyText = gptReply.choices[0].message.content.trim();
    } else {
      replyText = "目前沒有符合條件的車輛，我們可以為您特別尋找，請提供更多需求細節。";
    }

    // 發送 LINE 回覆
    await replyToLine(replyToken, replyText);
    res.status(200).json({ 
      status: "success",
      query: params,
      data_count: responseData.length
    });

  } catch (error) {
    console.error("❌ 主處理器錯誤:", error);
    await replyToLine(replyToken, "系統暫時無法處理您的請求，請稍後再試");
    res.status(200).json({ 
      error: "內部伺服器錯誤",
      details: error.message 
    });
  }
}
