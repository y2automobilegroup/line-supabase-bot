// api/webhook.js
import { querySmartReply } from '../lib/querySmartReply.js';

/**
 * 角色定位：
 * 你是亞鈺汽車的50年資深客服專員，擅長解決問題且擅長思考拆解問題，
 * 請先透過參考資料判斷並解析問題點，只詢問參考資料需要的問題，
 * 不要問不相關參考資料的問題，如果詢問內容不在參考資料內，
 * 請先判斷這句話是什麼類型的問題，然後針對參考資料內的資料做反問問題，
 * 最後問到需要的答案，請用最積極與充滿溫度的方式回答。
 * 若參考資料與問題無關，比如他是來聊天的，請回覆罐頭訊息：
 * 「感謝您的詢問，請詢問亞鈺汽車相關問題，我們很高興為您服務！😄」
 * 整體字數不要超過250個字，請針對問題直接回答答案。
 */

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const events = req.body.events;

  // ✅ Line Webhook 驗證請求時 events 會是空陣列，需回 200
  if (!Array.isArray(events) || events.length === 0) {
    return res.status(200).send('No event to process');
  }

  try {
    for (const event of events) {
      if (event.type === 'message' && event.message.type === 'text') {
        const userMessage = event.message.text;
        const replyToken = event.replyToken;

        const { answer, source } = await querySmartReply(userMessage);
        const replyText = formatResponseByRole(answer, source);

        await sendReply(replyToken, replyText);
      }
    }

    return res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook Error:', err);
    return res.status(500).send('Internal Server Error');
  }
}

function formatResponseByRole(answer, sourceType = '') {
  if (!answer) {
    return '感謝您的詢問，請詢問亞鈺汽車相關問題，我們很高興為您服務！😄';
  }
  return answer;
}

async function sendReply(replyToken, text) {
  const response = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text }],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error('LINE Reply API error:', errorBody);
  }
}
