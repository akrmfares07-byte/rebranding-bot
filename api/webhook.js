function isAdmin(chatId) {
  const admins = String(process.env.ADMIN_IDS || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
  if (!admins.length) return true;
  return admins.includes(String(chatId));
}

async function tg(method, body) {
  const token = process.env.TG_TOKEN;
  const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp.json();
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(200).json({ ok: true });
    const body = req.body || {};
    const msg = body.message;
    if (!msg?.chat?.id || !msg?.text) return res.status(200).json({ ok: true });

    const chatId = String(msg.chat.id);
    const text = String(msg.text || '').trim();

    if (!isAdmin(chatId)) {
      await tg('sendMessage', { chat_id: chatId, text: '❌ البوت ده خاص بالإدارة فقط.' });
      return res.status(200).json({ ok: true });
    }

    if (text === '/start') {
      await tg('sendMessage', {
        chat_id: chatId,
        text:
          '🔥 البوت الذكي شغال\n\n' +
          'أمثلة:\n' +
          '- احصائيات\n' +
          '- هات الأسئلة المعلقة\n' +
          '- ضيف يوزر أحمد\n' +
          '- اعمل عرض 20% باسم رمضان\n' +
          '- دور على حساب مطعم',
      });
      return res.status(200).json({ ok: true });
    }

    const base = process.env.APP_BASE_URL || '';
    const aiResp = await fetch(`${base}/api/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'telegram',
        chatId,
        actorId: chatId,
        sessionId: chatId,
        message: text,
      }),
    });
    const aiData = await aiResp.json();
    await tg('sendMessage', { chat_id: chatId, text: aiData.reply || 'تم.' });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(200).json({ ok: true, error: String(e?.message || e) });
  }
}
