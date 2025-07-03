import axios from 'axios';

const roleInstructions = `你是亞鈺汽車的50年資深客服專員，擅長解決問題且擅長拆解問題，請根據客戶的提問，先萃取出與問題有關的車輛資訊（例如品牌、年份、型號、金額、車況等），並嘗試推論出顧客可能想了解的問題類型（如：是否在保固內、是否符合退換條件、是否能估價等），然後結合下方參考資料中的內容來給出答案。如果資料無法直接回答，請給出友善且具引導性的回應。禁止虛構細節與保證，整體字數不超過250字。`;

// 用戶對話記憶（userId => array of message）
const memoryStore = {};

export async function querySmartReply(userInput, userId) {
  try {
    // 🔍 Step 1: Get embedding
    const embed = await getEmbedding(userInput);

    // 🔍 Step 2: 查詢 Pinecone，取前 5 筆高分 context
    const pineconeMatches = await queryPinecone(embed);
    const highScoreMatches = pineconeMatches.filter(m => m.score >= 0.8);
    const pineconeContext = highScoreMatches.length > 0
      ? highScoreMatches.map(m => m.metadata.text).join('\n')
      : null;

    // 🔍 Step 3: 若 Pinecone 無結果 → fallback 查 Supabase
    const fallbackContext = !pineconeContext
      ? await querySupabaseContext(userInput)
      : null;

    const context = pineconeContext || fallbackContext;

    // ❌ 若都沒資料
    if (!context) {
      return {
        answer: formatAnswerWithRole(null),
        source: 'NotFound',
      };
    }

    // 🔄 對話記憶：初始化使用者記憶
    if (!memoryStore[userId]) memoryStore[userId] = [];

    // ✅ 加入目前問題
    memoryStore[userId].push({ role: 'user', content: userInput });

    // 🤖 Step 4: 輸入 GPT 拆解問題、萃取車況、回答
    const messages = [
      { role: 'system', content: roleInstructions },
      ...memoryStore[userId],
      { role: 'user', content: `參考資料：${context}\n\n請根據以上資料與使用者輸入的內容，判斷問題類型並給出適當回應。問題：${userInput}` },
    ];

    const reply = await chatWithGPT(messages);

    // ✅ 回覆也加入記憶
    memoryStore[userId].push({ role: 'assistant', content: reply });

    return {
      answer: formatAnswerWithRole(reply),
      source: pineconeContext ? 'Pinecone' : 'Supabase'
    };
  } catch (err) {
    console.error("querySmartReply error:", err.message);
    return {
      answer: formatAnswerWithRole(null),
      source: 'Error'
    };
  }
}

function formatAnswerWithRole(text) {
  if (!text) {
    return '感謝您的詢問，請詢問亞鈺汽車相關問題，我們很高興為您服務！😄';
  }
  return `${text.length > 250 ? text.slice(0, 247) + '...' : text}`;
}

async function getEmbedding(text) {
  try {
    const res = await axios.post('https://api.openai.com/v1/embeddings', {
      input: text,
      model: 'text-embedding-ada-002',
    }, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });
    return res.data.data[0].embedding;
  } catch (err) {
    console.error('getEmbedding error:', err.response?.data || err.message);
    return [];
  }
}

async function queryPinecone(embed) {
  try {
    const url = `https://${process.env.PINECONE_ENVIRONMENT}/query`;
    const res = await axios.post(url, {
      vector: embed,
      topK: 5,
      includeMetadata: true,
    }, {
      headers: {
        'Api-Key': process.env.PINECONE_API_KEY,
        'Content-Type': 'application/json',
      },
    });
    return res.data.matches || [];
  } catch (err) {
    console.error('queryPinecone error:', err.response?.data || err.message);
    return [];
  }
}

async function querySupabaseContext(query) {
  try {
    const encoded = `*${query}*`;
    const searchFields = [
      '廠牌', '車款', '車型', '年式', '年份', '變速系統', '車門數', '驅動方式',
      '引擎燃料', '乘客數', '排氣量', '顏色', '首次領牌時間', '行駛里程',
      '車身號碼', '引擎號碼', '外匯車資料', '車輛售價', '車輛賣點',
      '車輛副標題', '賣家保證', '影片看車', '聯絡人', '行動電話',
      '賞車地址', 'line', '檢測機構', '查定編號', '認證書',
      '安全性配備', '舒適性配備'
    ];
    const orClauses = searchFields.map(field => `${field}.ilike.${encoded}`);
    const orParams = orClauses.join(',');
    const url = `${process.env.SUPABASE_URL}/rest/v1/cars?select=*&or=${orParams}`;
    const res = await axios.get(url, {
      headers: {
        apikey: process.env.SUPABASE_API_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_API_KEY}`,
      },
    });
    const match = res.data?.[0];
    return match ? JSON.stringify(match) : null;
  } catch (err) {
    console.error('querySupabase error:', err.response?.data || err.message);
    return null;
  }
}

async function chatWithGPT(messages) {
  try {
    const res = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o',
      messages,
    }, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });
    return res.data.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.error('chatWithGPT error:', err.response?.data || err.message);
    return null;
  }
}
