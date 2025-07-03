// api/webhook.js
import { querySmartReply } from '../lib/querySmartReply.js';
import dotenv from 'dotenv';
dotenv.config();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    const body = await readRequestBody(req);
    const event = body.events?.[0];

    if (!event || !event.message?.text || !event.replyToken) {
      return res.status(400).send('Invalid request');
    }

    const userMessage = event.message.text;
    const replyToken = event.replyToken;

    const { answer, source } = await querySmartReply(userMessage);
    const replyText = formatResponseByRole(answer, source);

    await sendReply(replyToken, replyText);
    return res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook handler error:', error);
    return res.status(500).send('Internal Server Error');
  }
}

async function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function formatResponseByRole(answer, source) {
  if (!answer) {
    return '感謝您的詢問，請詢問亞鈺汽車相關問題，我們很高興為您服務！😄';
  }
  return answer;
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
