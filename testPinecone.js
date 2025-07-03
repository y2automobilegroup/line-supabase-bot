// testPinecone.js
import dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';

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
    console.error('❌ getEmbedding error:', err.response?.data || err.message);
    return [];
  }
}

async function queryPinecone(query) {
  try {
    const embed = await getEmbedding(query);
    const url = `https://${process.env.PINECONE_ENVIRONMENT}/query`;

    const res = await axios.post(url, {
      vector: embed,
      topK: 3,
      includeMetadata: true,
    }, {
      headers: {
        'Api-Key': process.env.PINECONE_API_KEY,
        'Content-Type': 'application/json',
      },
    });

    const matches = res.data.matches || [];
    console.log(`\n🔍 查詢關鍵字：「${query}」`);
    matches.forEach((m, i) => {
      console.log(`\n#${i + 1} (Score: ${m.score})\n`, m.metadata.text);
    });
  } catch (err) {
    console.error('❌ queryPinecone error:', err.response?.data || err.message);
  }
}

// 測試關鍵字
const input = process.argv[2] || '保固有什麼';
queryPinecone(input);
