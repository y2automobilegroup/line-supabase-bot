// lib/querySmartReply.js
import axios from 'axios';

const roleInstructions = `你是亞鈺汽車的50年資深客服專員，擅長解決問題且擅長思考拆解問題，請先透過參考資料判斷並解析問題點，只詢問參考資料需要的問題，不要問不相關參考資料的問題，如果詢問內容不在參考資料內，請先判斷這句話是什麼類型的問題，然後針對參考資料內的資料做反問問題，最後問到需要的答案，請用最積極與充滿溫度的方式回答，若參考資料與問題無關，比如他是來聊天的，請回覆罐頭訊息：「感謝您的詢問，請詢問亞鈺汽車相關問題，我們很高興為您服務！😄」，整體字數不要超過250個字，請針對問題直接回答答案。`;

export async function querySmartReply(userInput) {
  try {
    const pineconeResponse = await queryPinecone(userInput);

    if (pineconeResponse && pineconeResponse.score >= parseFloat(process.env.PINECONE_SCORE_THRESHOLD || '0.5')) {
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
  // 可擴充為加角色提示的語意格式化，例如加入前綴語
  return text.length > 250 ? text.slice(0, 247) + '...' : text;
}

async function queryPinecone(query) {
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
}

async function querySupabase(query) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/cars?select=text&text=ilike.*${encodeURIComponent(query)}*`;

  const res = await axios.get(url, {
    headers: {
      apikey: process.env.SUPABASE_API_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_API_KEY}`,
    },
  });

  return res.data?.[0]?.text || null;
}

async function getEmbedding(text) {
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
}
