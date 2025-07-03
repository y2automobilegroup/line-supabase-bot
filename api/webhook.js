// api/webhook.js
import { querySmartReply } from '../lib/querySmartReply.js';

/**
 * 格式化角色回覆
 */
function formatResponseByRole(answer) {
  if (!answer) {
    return '感謝您的詢問，請詢問亞鈺汽車相關問題，我們很高興為您服務！😄';
  }
  return answer;
}

export const config = {
  api: {
    bodyParser: false, // LINE 傳送的是 raw body
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).end('Method Not Allowed');
  }

  try {
    // 解析 raw body
    const buffers = [];
    for await (const chunk of req) {
      buffers.push(chunk);
    }
    const body = Buffer.concat(buffers).toString();
    const jsonBody = JSON.parse(body);

    const event = jsonBody.events?.[0];
    const userMessage = event?.message?.text;
    const replyToken = event?.replyToken;

    if (!userMessage || !replyToken) {
      return res.status(400).send('Invalid LINE payload');
    }

    const { answer } = await querySmartReply(userMessage);
    const replyText = formatResponseByRole(answer);

    await sendReply(replyToken, replyText);
    return res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook Error:', err);
    return res.status(500).send('Internal Server Error');
  }
}

async function sendReply(replyToken, text) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
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
}
