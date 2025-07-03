// api/webhook.js
import { querySmartReply } from '../lib/querySmartReply.js';

// webhook handler 必須為具名的 async function，Vercel 才能正確識別
export async function POST(req) {
  try {
    const body = await req.json();
    const event = body.events?.[0];
    const userMessage = event?.message?.text;
    const replyToken = event?.replyToken;

    if (!userMessage || !replyToken) {
      return new Response('Invalid request', { status: 400 });
    }

    const { answer } = await querySmartReply(userMessage);
    const replyText = answer || '感謝您的詢問，請詢問亞鈺汽車相關問題，我們很高興為您服務！😄';

    await sendReply(replyToken, replyText);

    return new Response('OK', { status: 200 });
  } catch (err) {
    console.error('Webhook Error:', err);
    return new Response('Internal Server Error', { status: 500 });
  }
}

async function sendReply(replyToken, text) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
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

  if (!res.ok) {
    const errorText = await res.text();
    console.error('LINE API 回應錯誤:', errorText);
  }
}
