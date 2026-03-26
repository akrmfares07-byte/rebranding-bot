import {
  executeAction,
  getPendingConfirmation,
  setPendingConfirmation,
  clearPendingConfirmation,
  saveChatMemory,
  getRecentChatMemory
} from "../lib/core.js";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function extractJson(text) {
  const match = String(text || "").match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON returned");
  return JSON.parse(match[0]);
}

function isYes(text) {
  const t = String(text || "").trim().toLowerCase();
  return ["yes", "y", "confirm", "ok", "تمام", "ايوه", "نعم", "نفذ", "أكد"].includes(t);
}

function isNo(text) {
  const t = String(text || "").trim().toLowerCase();
  return ["no", "n", "cancel", "الغاء", "إلغاء", "لأ", "لا", "وقف"].includes(t);
}

function needsConfirmation(action) {
  return ["send_notification_all", "delete_user", "delete_offer", "delete_account"].includes(action);
}

async function callGroq(messages) {
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.GROQ_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages
    })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Groq failed: ${txt}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "{}";
}

async function planAction(message, memory = []) {
  const system = `
أنت عقل تحكم إداري لتطبيق.
مهمتك ترجع JSON فقط، بدون أي كلام إضافي.

الـ actions المسموحة:
- normal_chat
- stats
- add_user
- list_users
- create_offer
- list_offers
- add_account
- search_accounts
- send_notification_all
- unknown

ارجع JSON بالشكل:
{
  "kind": "chat | action",
  "action": "normal_chat | stats | add_user | list_users | create_offer | list_offers | add_account | search_accounts | send_notification_all | unknown",
  "data": {},
  "reply": "رد عربي طبيعي مختصر للمستخدم لو kind=chat",
  "reason": "سبب مختصر"
}

قواعد مهمة:
- لو المستخدم بيدردش فقط، استخدم normal_chat.
- لو الطلب ناقص تفاصيل، حاول تستنتج بأقل افتراض آمن.
- لو قال "إحصائيات" => action=stats
- لو قال "ضيف يوزر احمد 010" => action=add_user و data فيها name و phone لو موجود
- لو قال "اعمل عرض 20% باسم رمضان" => action=create_offer
- لو قال "هات العروض" => action=list_offers
- لو قال "دور على حساب مطعم" => action=search_accounts و data.query
- لو قال "ضيف حساب" => action=add_account
- لو مش واضح إطلاقًا => unknown
- الرد يكون بالعربية.
`;

  const content = await callGroq([
    { role: "system", content: system },
    ...memory,
    { role: "user", content: message }
  ]);

  return extractJson(content);
}

async function chatReply(message, memory = []) {
  const system = `
أنت مساعد ذكي داخل بوت إداري.
اتكلم بالعربي المصري بشكل واضح وعملي.
لو السؤال عام، جاوب باختصار.
لو المستخدم يطلب تنفيذ وإنت مش هتنفذ هنا، قلله بشكل طبيعي.
`;

  const content = await callGroq([
    { role: "system", content: system },
    ...memory,
    { role: "user", content: message }
  ]);

  return content;
}

export default async function handler(request) {
  if (request.method === "GET") {
    return jsonResponse({ ok: true, message: "AI route is working" });
  }

  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  try {
    const body = await request.json();
    const message = String(body.message || "").trim();
    const chatId = String(body.chatId || "");
    const source = String(body.source || "dashboard");
    const actorId = String(body.actorId || chatId || "unknown");

    if (!message) {
      return jsonResponse({ ok: false, reply: "ابعت رسالة الأول." }, 400);
    }

    if (chatId) {
      const pending = await getPendingConfirmation(chatId);
      if (pending) {
        if (isYes(message)) {
          const reply = await executeAction(pending.action, pending.data, { source, actorId });
          await clearPendingConfirmation(chatId);
          await saveChatMemory(chatId, "user", message);
          await saveChatMemory(chatId, "assistant", reply);
          return jsonResponse({ ok: true, reply });
        }

        if (isNo(message)) {
          await clearPendingConfirmation(chatId);
          const reply = "❌ تم إلغاء العملية.";
          await saveChatMemory(chatId, "user", message);
          await saveChatMemory(chatId, "assistant", reply);
          return jsonResponse({ ok: true, reply });
        }
      }
    }

    const memory = chatId ? await getRecentChatMemory(chatId) : [];
    const plan = await planAction(message, memory);

    let reply = "تمام.";
    let performed = false;

    if (plan.kind === "action" && plan.action && plan.action !== "unknown" && plan.action !== "normal_chat") {
      if (needsConfirmation(plan.action) && chatId) {
        await setPendingConfirmation(chatId, {
          action: plan.action,
          data: plan.data || {}
        });

        reply = `⚠️ العملية دي محتاجة تأكيد.\nاكتب: نعم\nأو: لا`;
      } else {
        reply = await executeAction(plan.action, plan.data || {}, { source, actorId });
        performed = true;
      }
    } else if (plan.action === "normal_chat" || plan.kind === "chat") {
      reply = plan.reply || await chatReply(message, memory);
    } else {
      reply = await chatReply(message, memory);
    }

    if (chatId) {
      await saveChatMemory(chatId, "user", message);
      await saveChatMemory(chatId, "assistant", reply);
    }

    return jsonResponse({
      ok: true,
      performed,
      action: plan.action || "normal_chat",
      reply
    });
  } catch (err) {
    return jsonResponse({
      ok: true,
      reply: "في حاجة وقفت التنفيذ. راجع المتغيرات و Firebase وجرّب تاني."
    });
  }
}
