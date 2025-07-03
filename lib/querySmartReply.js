// lib/querySmartReply.js
import axios from 'axios';

const roleInstructions = `你是亞鈺汽車的50年資深客服專員，擅長解決問題且擅長思考拆解問題，請先透過參考資料判斷並解析問題點，只詢問參考資料需要的問題，不要問不相關參考資料的問題，如果詢問內容不在參考資料內，請先判斷這句話是什麼類型的問題，然後針對參考資料內的資料做反問問題，最後問到需要的答案，請用最積極與充滿溫度的方式回答，若參考資料與問題無關，比如他是來聊天的，請回覆罐頭訊息：「感謝您的詢問，請詢問亞鈺汽車相關問題，我們很高興為您服務！😄」，整體字數不要超過250個字，請針對問題直接回答答案。`;

export async function querySmartReply(userInput) {
  try {
    const pineconeResponse = await queryPinecone(userInput);

    if (pineconeResponse && pineconeResponse.score >= parseFloat(process.env.PINECONE_SCORE_THRESHOLD || '0.8')) {
      return { answer: formatAnswerWithRole(pineconeResponse.text), source: 'Pinecone' };
    }

    const supabaseResponse = await querySupabase(userInput);
    if (supabaseResponse) {
      return { answer: formatAnswerWithRole(supabaseResponse), source: 'Supabase' };
    }

    return { answer: formatAnswerWithRole(null), source: 'NotFound' };
  } catch (error) {
    console.error('querySmartReply error:', error);
    return { answer: formatAnswerWithRole(null), source: 'Error' };
  }
}

function formatAnswerWithRole(text) {
  if (!text) {
    return '感謝您的詢問，請詢問亞鈺汽車相關問題，我們很高興為您服務！😄';
  }
  return `${text.length > 250 ? text.slice(0, 247) + '...' : text}`;
}

async function queryPinecone(query) {
  try {
    const embed = await getEmbedding(query);
    const url = `https://${process.env.PINECONE_ENVIRONMENT}/query`;

    const res = await axios.post(url, {
      vector: embed,
      topK: 1,
      includeMetadata: true,
    }, {
      headers: {
        'Api-Key': process.env.PINECONE_API_KEY,
        'Content-Type': 'application/json',
      },
    });

    const match = res.data.matches?.[0];
    return match ? {
      score: match.score,
      text: match.metadata.text || '(無內容)'
    } : null;
  } catch (err) {
    console.error('queryPinecone error:', err.response?.data || err.message);
    return null;
  }
}

async function querySupabase(query) {
  try {
    const encoded = encodeURIComponent(`*${query}*`);

    const searchFields = [
      '廠牌', '車款', '車型', '年式', '年份', '變速系統', '車門數', '驅動方式',
      '引擎燃料', '乘客數', '排氣量', '顏色', '安全性配備', '舒適性配備',
      '首次領牌時間', '行駛里程', '車身號碼', '引擎號碼', '外匯車資料', '車輛售價',
      '車輛賣點', '車輛副標題', '賣家保證', '特色說明', '影片看車', '物件圖片',
      '聯絡人', '行動電話', '賞車地址', 'line', '檢測機構', '查定編號', '認證書'
    ];

    const orParams = searchFields
      .map(field => `${field}.ilike.${encoded}`)
      .join(',');

    const url = `${process.env.SUPABASE_URL}/rest/v1/cars?select=*&or=(${orParams})`;

    const res = await axios.get(url, {
      headers: {
        apikey: process.env.SUPABASE_API_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_API_KEY}`,
      },
    });

    const data = res.data?.[0];
    if (!data) return null;

    return `【${data.廠牌 || ''} ${data.車款 || ''}】${data.車輛副標題 || ''}，${data.賣家保證 || ''}，配備亮點：${data.特色說明 || data.舒適性配備 || '尚未提供'}`;
  } catch (err) {
    console.error('querySupabase error:', err.response?.data || err.message);
    return null;
  }
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
