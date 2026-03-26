async function sendTelegramMessage(chatId, text) {
  const resp = await fetch(`https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text
    })
  });

  return resp.json();
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true });
  }

  const body = req.body || {};
  const msg = body.message;

  if (!msg?.chat?.id || !msg?.text) {
    return res.status(200).json({ ok: true });
  }

  const chatId = msg.chat.id;
  const text = msg.text;

  if (text === "/start") {
    await sendTelegramMessage(
      chatId,
      "🔥 البوت شغال\nابعت طلب زي:\n- احصائيات\n- ضيف يوزر أحمد\n- ضيف عرض 20%\n- ابعت اشعار"
    );
    return res.status(200).json({ ok: true });
  }

  const aiResp = await fetch(`${process.env.APP_BASE_URL}/api/ai`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: text, source: "telegram" })
  });

  const aiData = await aiResp.json();

  await sendTelegramMessage(chatId, aiData.reply || "تم استلام الطلب.");

  return res.status(200).json({ ok: true });
}
