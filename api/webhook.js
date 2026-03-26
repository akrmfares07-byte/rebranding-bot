
const { getDB, handleAdminText } = require("../lib/core");

const TG_TOKEN = process.env.TG_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(s => s.trim()).filter(Boolean);

async function sendTG(chatId, text) {
  if (!TG_TOKEN) throw new Error("TG_TOKEN missing");
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

async function handleReplyTraining(db, replyText, originalText, chatId) {
  const idMatch = originalText.match(/\[ID:(uq_\d+)\]/);
  if (!idMatch) return false;
  const qId = idMatch[1];
  const qDoc = await db.collection("unanswered_questions").doc(qId).get();
  if (!qDoc.exists) return false;
  const qData = qDoc.data();
  await db.collection("unanswered_questions").doc(qId).update({ a: replyText, answeredAt: new Date().toISOString() });
  await sendTG(chatId, `✅ تم حفظ الإجابة\nالأكونت: ${qData.accName || '—'}\nالسؤال: ${qData.q || '—'}\nالإجابة: ${replyText}`);
  return true;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("ok");
  const { message } = req.body || {};
  if (!message) return res.status(200).send("ok");

  const chatId = String(message.chat?.id || "");
  const text = String(message.text || "").trim();
  if (!text) return res.status(200).send("ok");

  if (ADMIN_IDS.length && !ADMIN_IDS.includes(chatId)) {
    await sendTG(chatId, "⛔ غير مصرح ليك تستخدم البوت ده.");
    return res.status(200).send("ok");
  }

  if (text === "/start" || text === "/help") {
    await sendTG(chatId, "👋 أوامر سريعة:\n• ضيف يوزر باسم أحمد\n• اعمل عرض جديد للأكونت X\n• ابعت إشعار بعنوان ...\n• هات الإحصائيات\n• هات العروض اللي قربت تنتهي");
    return res.status(200).send("ok");
  }

  try {
    const db = getDB();
    if (message.reply_to_message && await handleReplyTraining(db, text, message.reply_to_message.text || "", chatId)) {
      return res.status(200).send("ok");
    }
    const data = await handleAdminText(text, "telegram");
    await sendTG(chatId, `${data.reply}\n\n${data.result}`.trim());
  } catch (e) {
    console.error("webhook error", e);
    await sendTG(chatId, "❌ حصل خطأ: " + e.message);
  }
  return res.status(200).send("ok");
};
