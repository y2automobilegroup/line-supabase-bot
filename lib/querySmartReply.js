import axios from 'axios';

const roleInstructionsPinecone = `你是亞鈺汽車50年資深客服專員，請根據參考資料中提供的制度說明（如保固、五日鑑賞、估價流程等）分析客人問題類型並判斷是否符合條件。禁止虛構內容，可做條件判定與友善引導。`;

const roleInstructionsSupabase = `你是亞鈺汽車的客服助手，請根據車輛資料進行快速摘要，包括廠牌、年份、型號、配備亮點、里程數與是否外匯等資訊，用自然口語方式回覆客人詢問車輛內容。`;

const memoryStore = {};

export async function querySmartReply(userInput, userId) {
  try {
    const embed = await getEmbedding(userInput);
    const pineconeMatches = await queryPinecone(embed);
    const highScoreMatches = pineconeMatches.filter(m => m.score >= 0.5);
    const pineconeContext = highScoreMatches.length > 0 ? highScoreMatches.map(m => m.metadata.text).join('\n') : null;

    const fallbackContext = !pineconeContext ? await querySupabaseContext(userInput) : null;
    const context = pineconeContext || fallbackContext;

    if (!context) {
      return {
        answer: formatAnswerWithRole(null),
        source: 'NotFound'
      };
    }

    if (!memoryStore[userId]) memoryStore[userId] = [];
    memoryStore[userId].push({ role: 'user', content: userInput });

    const rolePrompt = pineconeContext ? roleInstructionsPinecone : roleInstructionsSupabase;
    const messages = [
      { role: 'system', content: rolePrompt },
      ...memoryStore[userId],
      {
        role: 'user',
        content: `參考資料如下：\n${context}\n\n請根據以上參考資料內容，分析客戶問題並給出回應。問題：${userInput}`
      }
    ];

    const reply = await chatWithGPT(messages);
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
    const fields = [
      '廠牌', '車款', '車型', '年式', '年份', '變速系統', '車門數', '驅動方式',
      '引擎燃料', '乘客數', '排氣量', '顏色', '首次領牌時間', '行駛里程',
      '車身號碼', '引擎號碼', '外匯車資料', '車輛售價', '車輛賣點',
      '車輛副標題', '賣家保證', '影片看車', '聯絡人', '行動電話',
      '賞車地址', 'line', '檢測機構', '查定編號', '認證書',
      '安全性配備', '舒適性配備'
    ];
    const orClauses = fields.map(field => `${field}.ilike.${encoded}`);
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
