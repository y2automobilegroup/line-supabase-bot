import OpenAI from "openai";
import fetch from "node-fetch";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req, res) {
  try {
    console.log("✅ 收到請求 method:", req.method);
    console.log("📥 req.body：", req.body);

    if (req.method !== "POST") return res.status(405).end("Only POST allowed");

    const body = req.body;
    const event = body.events?.[0];
    const messageType = event?.message?.type;
    const userText = event?.message?.text;
    const replyToken = event?.replyToken;

    console.log("📩 接收到 LINE event：", event);
    console.log("📨 messageType:", messageType);
    console.log("📝 userText:", userText);
    console.log("🔁 replyToken:", replyToken);

    if (messageType !== "text" || !userText || !replyToken) {
      console.log("❌ 非文字訊息或缺資料，略過");
      return res.status(200).send("Non-text message ignored");
    }

    const gpt = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `
你是分類助手，請根據使用者詢問的內容，輸出 JSON 格式 { category, params }。
category 僅能為以下四種之一：cars、company、address、contact。
請不要輸出其他類別名稱。

你是亞鈺汽車的50年資深客服專員，擅長解決問題且擅長思考拆解問題。
請先透過參考資料判斷並解析問題點，只詢問參考資料需要的問題，不要問不相關參考資料的問題。
如果詢問內容不在參考資料內，請先判斷這句話是什麼類型的問題，
然後針對參考資料內的資料做反問問題，最後問到需要的答案。
請用最積極與充滿溫度的方式回答。

若 category 為 cars，請根據下列欄位自動比對對應語意作為 params 的 key：

可用欄位為：
廠牌、車款、車型、年式、年份、變速系統、車門數、驅動方式、引擎燃料、乘客數、排氣量、顏色、首次領牌時間、行駛里程、車身號碼、車輛售價、賣家保證、聯絡人、賞車地址、檢測機構、認證書 等欄位。

請根據使用者提問自動判斷哪些欄位最適合被拿來查詢，params 中只要放有助於查詢的 key/value 即可，內容不清楚的就省略不要加。

例如：「2020年C300有嗎」➡️ 應輸出：  
{"category":"cars","params":{"年份":"2020","車型":"C300"}}

若參考資料與問題無關，比如他是來聊天的，請回覆罐頭訊息：
"感謝您的詢問，請詢問亞鈺汽車相關問題，我們很高興為您服務！😄"

整體回覆請縮減，不要超過100個字。
⚠️ 所有回覆請使用**合法 JSON 字串格式**，例如："{"category":"cars","params":{"品牌":"Toyota"}}"
`.trim()
        },
        { role: "user", content: userText }
      ]
    });

    console.log("🧠 GPT 回傳內容：", gpt.choices[0].message.content);

    let result;
    try {
      result = JSON.parse(gpt.choices[0].message.content);
    } catch (e) {
      console.log("❌ GPT 回傳格式錯誤，無法解析 JSON：", e.message);
      await replyToLine(replyToken, "不好意思，我目前無法理解您的問題，我們會請專人聯繫您！");
      return res.status(200).send("GPT JSON parse error");
    }

    const { category, params } = result;
    const normalizedCategory = category.toLowerCase();

    const tableMap = {
      cars: "cars",
      company: "company_profile",
      address: "company_info",
      contact: "contact_info"
    };

    const table = tableMap[normalizedCategory];
    console.log("📦 分類結果：", category, "| 對應資料表：", table);

    let replyText = "";

    if (!table) {
      replyText = "亞鈺客服您好，我們會請專人儘快回覆您！😊";
      console.log("⚠️ category 無對應資料表，進入 fallback");
    } else {
      const query = Object.entries(params)
        .map(([key, value]) => `${key}=ilike.${encodeURIComponent(value)}`)
        .join("&");

      const url = `${process.env.SUPABASE_URL}/rest/v1/${table}?select=*&${query}`;
      console.log("🌐 查詢 URL：", url);

      const resp = await fetch(url, {
        headers: {
          apikey: process.env.SUPABASE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_KEY}`
        }
      });

      const data = await resp.json();
      console.log("🔍 Supabase 回傳資料：", data);

      if (Array.isArray(data) && data.length > 0) {
        if (normalizedCategory === "cars") {
          replyText = `目前共有 ${data.length} 輛符合條件的車輛，例如：${data[0].brand} ${data[0].車型 || "車款"}，${data[0].年份 || ""} 年`;
        } else if (normalizedCategory === "address") {
          replyText = `我們的地址是：${data[0].地址}`;
        } else {
          replyText = JSON.stringify(data[0], null, 2);
        }
      } else {
        replyText = "抱歉，目前查無相關資料。";
      }
    }

    await replyToLine(replyToken, replyText);
    res.status(200).json({ status: "ok" });
  } catch (error) {
    console.error("❌ webhook 執行錯誤：", error);
    res.status(200).send("error handled");
  }
}

async function replyToLine(replyToken, text) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.LINE_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }]
    })
  });
}
