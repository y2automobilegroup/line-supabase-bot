import OpenAI from "openai";
import fetch from "node-fetch";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const memory = {}; // ✅ 對話記憶物件
const topicMemory = {}; // ✅ 主題記憶（用來判斷品牌、年份是否變更）

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
    const userId = event?.source?.userId;

    console.log("📩 接收到 LINE event：", event);
    console.log("📨 messageType:", messageType);
    console.log("📝 userText:", userText);
    console.log("👤 userId:", userId);
    console.log("🔁 replyToken:", replyToken);

    if (messageType !== "text" || !userText || !replyToken) {
      console.log("❌ 非文字訊息或缺資料，略過");
      return res.status(200).send("Non-text message ignored");
    }

    const contextMessages = memory[userId]?.map(text => ({ role: "user", content: text })) || [];
    const gpt = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `你是分類助手，請根據使用者詢問的內容，永遠只輸出 JSON 格式：
{ "category": "...", "params": { ... }, "followup": "..." }

其中：
- category 僅能為：cars、company、address、contact 四選一。
- params 依照語意自動比對下列欄位：廠牌、車款、車型、年式、年份、變速系統、車門數、驅動方式、引擎燃料、乘客數、排氣量、顏色、首次領牌時間、行駛里程、車身號碼、車輛售價、賣家保證、聯絡人、賞車地址、檢測機構、認證書。
  - 若為數值條件（例如：2020年以後、低於100萬），請使用 gte / lte / eq 結構，例如：{"年份": {"gte": 2020}}
  - 若使用者問題模糊，請將你要反問的內容填入 followup 欄位，例如："您是想找特定品牌、年份，還是有預算考量呢？"
- 若只是聊天或與亞鈺汽車無關，請回傳：
  { "category": "other", "params": {}, "followup": "感謝您的詢問，請詢問亞鈺汽車相關問題，我們很高興為您服務！😄" }

請注意：只允許回傳符合上述結構的 JSON 字串，不要加多餘文字。`
        },
        ...contextMessages,
        { role: "user", content: userText }
      ]
    });

    let replyContent = gpt.choices[0].message.content;
    console.log("🧠 GPT 回傳內容：", replyContent);

    replyContent = replyContent.trim().replace(/^```json\n?|\n?```$/g, "");

    let result;
    try {
      result = JSON.parse(replyContent);
    } catch (e) {
      console.log("❌ GPT 回傳格式錯誤，無法解析 JSON：", e.message);
      await replyToLine(replyToken, "不好意思，我目前無法理解您的問題，我們會請專人聯繫您！");
      return res.status(200).send("GPT JSON parse error");
    }

    const { category, params, followup } = result;

    const currentBrand = params?.廠牌;
    const lastBrand = topicMemory[userId]?.廠牌;
    if (currentBrand && lastBrand && currentBrand !== lastBrand) {
      memory[userId] = [];
      topicMemory[userId] = {};
      console.log("🔁 品牌改變，清除上下文記憶");
    }

    memory[userId] = [...(memory[userId] || []), userText];
    if (Object.keys(params || {}).length > 0) {
      memory[userId].push(JSON.stringify(params));
      topicMemory[userId] = { ...topicMemory[userId], ...params };
    }

    if (category === "other") {
      const replyText = followup || "感謝您的詢問，請詢問亞鈺汽車相關問題，我們很高興為您服務！😄";
      await replyToLine(replyToken, replyText);
      return res.status(200).send("Reply to non-relevant message");
    }

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
    } else {
      const query = Object.entries(params || {})
        .map(([key, value]) => {
          if (typeof value === "object" && value !== null) {
            if (value.gte !== undefined) return `${encodeURIComponent(key)}=gte.${encodeURIComponent(value.gte)}`;
            if (value.lte !== undefined) return `${encodeURIComponent(key)}=lte.${encodeURIComponent(value.lte)}`;
            if (value.eq !== undefined) return `${encodeURIComponent(key)}=eq.${encodeURIComponent(value.eq)}`;
          }
          return `${encodeURIComponent(key)}=ilike.${encodeURIComponent(value)}`;
        })
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
        const prompt = `以下是使用者查詢條件為 ${JSON.stringify(params)}，查詢結果如下：\n\n${JSON.stringify(data.slice(0, 3), null, 2)}\n\n請根據上述內容以自然語氣、貼近客服風格，幫我用繁體中文回覆使用者。若有 followup 提示內容：「${followup || ""}」，請自然銜接。`;

        const chatReply = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            { role: "system", content: "你是亞鈺汽車的50年資深客服專員，擅長解決問題且擅長思考拆解問題，請先透過參考資料判斷並解析問題點，只詢問參考資料需要的問題，不要問不相關參考資料的問題，如果詢問內容不在參考資料內，請先判斷這句話是什麼類型的問題，然後針對參考資料內的資料做反問問題，最後問到需要的答案，請用最積極與充滿溫度的方式回答，若參考資料與問題無關，比如他是來聊天的，請回覆罐頭訊息：\"感謝您的詢問，請詢問亞鈺汽車相關問題，我們很高興為您服務！😄" },
            { role: "user", content: prompt }
          ]
        });

        replyText = chatReply.choices[0].message.content.trim();
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
