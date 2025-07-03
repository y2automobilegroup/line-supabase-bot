// api/webhook.js
import { querySmartReply } from '../lib/querySmartReply.js';
import dotenv from 'dotenv';
dotenv.config();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).end();
  }

  const event = req.body.events?.[0];
  const userMessage = event?.message?.text;
  const replyToken = event?.replyToken;

  if (!userMessage || !replyToken) {
    return res.status(400).send('Invalid request');
  }

  try {
    const replyText = await querySmartReply(userMessage);

    await sendReply(replyToken, replyText);
    return res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook Error:', err);
    return res.status(500).send('Internal Error');
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
