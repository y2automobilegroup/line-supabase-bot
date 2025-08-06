import OpenAI from "openai";
import fetch from "node-fetch";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const memory = {};
const topicMemory = {};

// 價格解析函數 (支援中文數字)
const parsePrice = (val) => {
  if (typeof val !== "string") return val;

  const chineseNumMap = {
    零: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4,
    五: 5, 六: 6, 七: 7, 八: 8, 九: 9
  };

  const chineseUnitMap = {
    十: 10,
    百: 100,
    千: 1000,
    萬: 10000
  };

  const parseChineseNumber = (str) => {
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

// 構建 Supabase 查詢參數 (含 URL 編碼)
const buildSupabaseQuery = (params) => {
  const queryParams = [];
  
  for (const [key, value] of Object.entries(params || {})) {
    if (typeof value === 'object') {
      if (value.gte !== undefined) queryParams.push(`${key}=gte.${encodeURIComponent(parsePrice(value.gte))}`);
      if (value.lte !== undefined) queryParams.push(`${key}=lte.${encodeURIComponent(parsePrice(value.lte))}`);
      if (value.eq !== undefined) queryParams.push(`${key}=eq.${encodeURIComponent(parsePrice(value.eq))}`);
    } else {
      queryParams.push(`${key}=ilike.%${encodeURIComponent(value)}%`);
    }
  }
  
  return queryParams.join('&');
};

// 增強型 fetch 帶重試機制
const fetchWithRetry = async (url, options, retries = 3) => {
  try {
    const resp = await fetch(url, options);
    
    // 檢查狀態碼
    if (!resp.ok) {
      if (resp.status === 401) throw new Error('認證失敗，請檢查API密鑰');
      if (resp.status === 404) throw new Error('資源不存在');
      if (resp.status >= 500) throw new Error('伺服器錯誤');
    }
    
    const contentType = resp.headers.get('content-type');
    if (!contentType?.includes('application/json')) {
      throw new Error('響應不是JSON格式');
    }
    
    return await resp.json();
  } catch (error) {
    if (retries > 0) {
      console.log(`重試剩餘次數: ${retries}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      return fetchWithRetry(url, options, retries - 1);
    }
    throw error;
  }
};

// LINE 回覆函數
const replyToLine = async (replyToken, text) => {
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
};

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).end("僅允許POST請求");

    const body = req.body;
    const event = body.events?.[0];
    const userText = event?.message?.text;
    const replyToken = event?.replyToken;
    const userId = event?.source?.userId;

    if (!userText || !replyToken) return res.status(200).send("無效訊息");

    // GPT 分析用戶意圖
    const contextMessages = memory[userId]?.map(text => ({ role: "user", content: text })) || [];
    const gpt = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `你是亞鈺汽車的客服助手，請用以下 JSON 結構分析使用者訊息：
{
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
      return res.status(200).send("GPT 解析錯誤");
    }

    const { category, params, followup } = result;
    const currentBrand = params?.廠牌;
    const lastParams = topicMemory[userId] || {};
    const lastBrand = lastParams.廠牌;

    // 更新記憶上下文
    if (currentBrand && currentBrand !== lastBrand) {
      memory[userId] = [userText];
      topicMemory[userId] = { ...params };
    } else {
      memory[userId] = [...(memory[userId] || []), userText];
      topicMemory[userId] = { ...lastParams, ...params };
    }

    if (category === "other") {
      await replyToLine(replyToken, followup || "請詢問亞鈺汽車相關問題，謝謝！");
      return res.status(200).send("不相關訊息");
    }

    // Supabase 查詢
    const tables = category === "cars" ? ["company", "cars"] : ["company"];
    let data = [];

    for (const table of tables) {
      try {
        const query = buildSupabaseQuery(params);
        const url = `${process.env.SUPABASE_URL}/rest/v1/${table}?select=*&${query}`;
        
        console.log("🚀 查詢 Supabase URL:", url);
        data = await fetchWithRetry(url, {
          headers: {
            apikey: process.env.SUPABASE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_KEY}`
          }
        });
        
        if (Array.isArray(data) && data.length > 0) break;
      } catch (error) {
        console.error(`查詢 ${table} 表失敗:`, error.message);
        data = [];
      }
    }

    // 生成回覆
    let replyText = "";
    if (Array.isArray(data) && data.length > 0) {
      const prompt = `請用繁體中文、客服語氣回覆查詢結果：\n${JSON.stringify(data)}`;
      const chatReply = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: "你是專業汽車客服，用自然口吻回覆客戶問題" },
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
    console.error("❌ 系統錯誤：", error);
    await replyToLine(replyToken, "系統暫時無法處理您的請求，請稍後再試");
    res.status(200).send("錯誤已處理");
  }
}
