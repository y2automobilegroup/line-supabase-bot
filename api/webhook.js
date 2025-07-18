import OpenAI from "openai";
import fetch from "node-fetch";
import { Pinecone } from "@pinecone-database/pinecone";
import { createClient } from '@supabase/supabase-js';

// 初始化所有服務
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 記憶體快取
const memoryCache = {
  userDialogs: {},    // 用戶對話歷史
  topicContext: {},   // 話題上下文
  vectorResults: {}   // 向量查詢結果快取
};

// 價格解析器（保持不變）
const parsePrice = val => {
  if (typeof val !== "string") return val;
  const cleaned = val.replace(/[元台幣\s]/g, "").trim();
  // ...（原有價格解析邏輯）
};

// Pinecone 查詢強化函式
async function queryKnowledgeBase(userText, userId) {
  try {
    // 檢查快取
    const cacheKey = `${userId}_${userText}`;
    if (memoryCache.vectorResults[cacheKey]) {
      return memoryCache.vectorResults[cacheKey];
    }

    // 生成嵌入向量
    const embedding = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: userText
    });
    const vector = embedding.data[0].embedding;

    // 查詢 Pinecone（Serverless 模式）
    const index = pinecone.index('knowledge', {
      host: process.env.PINECONE_ENDPOINT
    });

    const results = await index.query({
      vector,
      topK: 5,
      includeMetadata: true
    });

    // 快取結果（有效期5分鐘）
    memoryCache.vectorResults[cacheKey] = results.matches || [];
    setTimeout(() => delete memoryCache.vectorResults[cacheKey], 300000);

    return memoryCache.vectorResults[cacheKey];
  } catch (error) {
    console.error('知識庫查詢失敗:', error);
    return []; // 返回空陣列以觸發後備查詢
  }
}

// Supabase 後備查詢
async function queryFallbackDatabase(params) {
  try {
    // 構建動態查詢
    let query = supabase.from('cars').select('*');
    
    // 處理價格範圍查詢
    if (params.price) {
      if (params.price.gte) query = query.gte('price', parsePrice(params.price.gte));
      if (params.price.lte) query = query.lte('price', parsePrice(params.price.lte));
    }

    // 處理其他條件
    Object.entries(params).forEach(([key, value]) => {
      if (key !== 'price' && typeof value === 'string') {
        query = query.ilike(key, `%${value}%`);
      }
    });

    const { data, error } = await query;
    return error ? [] : data;
  } catch (error) {
    console.error('資料庫查詢失敗:', error);
    return [];
  }
}

export default async function handler(req, res) {
  try {
    // 請求驗證
    if (req.method !== "POST") return res.status(405).end();
    const { events } = req.body;
    const event = events?.[0];
    const userText = event?.message?.text;
    const replyToken = event?.replyToken;
    const userId = event?.source?.userId;

    if (!userText || !replyToken) return res.status(200).send("Invalid message");

    // 知識庫優先查詢
    const knowledgeMatches = await queryKnowledgeBase(userText, userId);
    let replyText = "";

    if (knowledgeMatches.length > 0) {
      // 從 Pinecone 結果生成回覆
      const context = knowledgeMatches.map(m => m.metadata.text).join("\n\n");
      const gptResponse = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{
          role: "system",
          content: "根據以下知識庫資料用親切客服語氣回答，回答需包含資料來源重點且不超過200字"
        }, {
          role: "user",
          content: `問題：「${userText}」\n\n相關資料：${context}`
        }]
      });
      replyText = gptResponse.choices[0].message.content;
    } else {
      // Supabase 後備查詢
      const gptAnalysis = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{
          role: "system",
          content: "將用戶問題解析為資料庫查詢條件，輸出JSON格式：{\"brand\":\"\",\"model\":\"\",\"price\":{\"gte\":0,\"lte\":0}}"
        }, {
          role: "user",
          content: userText
        }]
      });

      const params = JSON.parse(gptAnalysis.choices[0].message.content);
      const dbResults = await queryFallbackDatabase(params);

      if (dbResults.length > 0) {
        replyText = `找到${dbResults.length}筆符合資料：\n` +
          dbResults.slice(0, 3).map(item => 
            `${item.brand} ${item.model} ${item.price}萬`
          ).join('\n');
      } else {
        replyText = "很抱歉，目前沒有找到符合條件的車輛資訊。是否需要其他協助？";
      }
    }

    // 更新對話上下文
    memoryCache.userDialogs[userId] = [
      ...(memoryCache.userDialogs[userId] || []),
      { role: "user", content: userText },
      { role: "assistant", content: replyText }
    ].slice(-6); // 保留最近3輪對話

    // 回覆用戶
    await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.LINE_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        replyToken,
        messages: [{ type: "text", text: replyText }]
      })
    });

    return res.status(200).json({ status: "success" });

  } catch (error) {
    console.error("全域錯誤:", {
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
    
    try {
      await fetch("https://api.line.me/v2/bot/message/reply", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.LINE_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          replyToken,
          messages: [{ type: "text", text: "系統暫時無法回應，請稍後再試" }]
        })
      });
    } catch (lineError) {
      console.error("LINE回覆失敗:", lineError);
    }

    return res.status(200).json({ status: "error_handled" });
  }
}
