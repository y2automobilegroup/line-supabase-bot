// api/webhook.js
import { querySmartReply } from '../lib/querySmartReply.js';

/**
 * 處理 LINE webhook POST 請求
 */
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

    await sendReply(replyToken, answer);
    return new Response('OK', { status: 200 });
  } catch (err) {
    console.error('Webhook Error:', err);
    return new Response('Internal Error', { status: 500 });
  }
}

/**
 * 發送回覆訊息至 LINE
 */
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
