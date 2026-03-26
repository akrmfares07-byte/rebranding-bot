function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function tg(method, body) {
  const token = process.env.TG_TOKEN;
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  return res.json();
}

function isAdmin(chatId) {
  const admins = String(process.env.ADMIN_IDS || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);

  if (!admins.length) return true;
  return admins.includes(String(chatId));
}

export default async function handler(request) {
  if (request.method !== "POST") {
    return jsonResponse({ ok: true });
  }

  try {
    const body = await request.json();
    const msg = body.message;

    if (!msg?.chat?.id || !msg?.text) {
      return jsonResponse({ ok: true });
    }

    const chatId = msg.chat.id;
    const text = msg.text;

    if (!isAdmin(chatId)) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "❌ البوت ده خاص بالإدارة فقط."
      });
      return jsonResponse({ ok: true });
    }

    if (text === "/start") {
      await tg("sendMessage", {
        chat_id: chatId,
        text:
          "🔥 البوت الذكي شغال\n\n" +
          "أمثلة:\n" +
          "- احصائيات\n" +
          "- ضيف يوزر احمد 010\n" +
          "- اعمل عرض 20% باسم رمضان\n" +
          "- هات العروض\n" +
          "- دور على حساب مطعم\n" +
          "- ضيف حساب باسم خزين فئة مشويات"
      });

      return jsonResponse({ ok: true });
    }

    const aiRes = await fetch(`${process.env.APP_BASE_URL}/api/ai`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "telegram",
        chatId: String(chatId),
        actorId: String(chatId),
        message: text
      })
    });

    const ai = await aiRes.json();

    await tg("sendMessage", {
      chat_id: chatId,
      text: ai.reply || "تم."
    });

    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ ok: true });
  }
}
