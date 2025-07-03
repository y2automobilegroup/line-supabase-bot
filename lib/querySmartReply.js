import axios from 'axios';

const roleInstructions = `你是亞鈺汽車的50年資深客服專員，擅長解決問題且擅長思考拆解問題，請先透過參考資料判斷並解析問題點，只詢問參考資料需要的問題，不要問不相關參考資料的問題，如果詢問內容不在參考資料內，請先判斷這句話是什麼類型的問題，然後針對參考資料內的資料做反問問題，最後問到需要的答案，請用最積極與充滿溫度的方式回答，若參考資料與問題無關，比如他是來聊天的，請回覆罐頭訊息：\"感謝您的詢問，請詢問亞鈺汽車相關問題，我們很高興為您服務！😄\"，整體字數不要超過250個字，請針對問題直接回答答案且抓取重點回復`;

export async function querySmartReply(userInput) {
  try {
    // 🔍 Step 1: Get embedding
    const embed = await getEmbedding(userInput);

    // 🔍 Step 2: 查詢 Pinecone，取前 5 筆高分 context
    const pineconeMatches = await queryPinecone(embed);
    const pineconeContext = pineconeMatches.length > 0
      ? pineconeMatches.map(m => m.metadata.text).join('\n')
      : null;

    // 🔍 Step 3: 若 Pinecone 無結果 → fallback 查 Supabase
    const fallbackContext = !pineconeContext
      ? await querySupabaseContext(userInput)
      : null;

    const context = pineconeContext || fallbackContext;

    // ❌ 若都沒資料
    if (!context) {
      return {
        answer: formatAnswerWithRole(null),
        source: 'NotFound',
      };
    }

    // 🤖 Step 4: 輸入 GPT 判斷並回答
    const reply = await chatWithGPT(context, userInput);
    return {
      answer: formatAnswerWithRole(reply),
      source: pineconeContext ? 'Pinecone' : 'Supabase'
    };
  } catch (err) {
    console.error("querySmartReply error:", err.message);
    return {
      answer: formatAnswerWithRole(null),
      source: 'Error'
    };
  }
}
