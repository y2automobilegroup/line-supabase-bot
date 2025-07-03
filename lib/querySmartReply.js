// lib/querySmartReply.js
import axios from 'axios';

export async function querySmartReply(userInput) {
  try {
    const pineconeResponse = await queryPinecone(userInput);

    if (pineconeResponse && pineconeResponse.score >= parseFloat(process.env.PINECONE_SCORE_THRESHOLD || '0.8')) {
      return { answer: pineconeResponse.text, source: 'Pinecone' };
    }

    const supabaseResponse = await querySupabase(userInput);
    if (supabaseResponse) {
      return { answer: supabaseResponse, source: 'Supabase' };
    }

    return { answer: null, source: 'NotFound' };
  } catch (error) {
    console.error('querySmartReply error:', error);
    return { answer: null, source: 'Error' };
  }
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
