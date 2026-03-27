
import {
  executeIntent,
  buildContext,
  classifyIntent,
  saveSupportTicket,
  listPendingSupport,
  answerSupportTicket,
  getRecentMemory,
  saveMemory,
  askGroq
} from "../lib/core.js";

const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };



function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json; charset=utf-8" }
  });
}

function adminChatPrompt() {
  return `أنت مساعد إداري ذكي لنظام Rebranding.
- افهم الطلبات الحرة بالعربية أو الإنجليزية.
- لو الطلب إداري وممكن تنفيذه، رجّع JSON فقط بالشكل:
{"mode":"intent","intent":{...}}
- لو الطلب سؤال عادي أو دردشة، رجّع JSON فقط بالشكل:
{"mode":"chat","reply":"..."}
- لو الطلب عن تذاكر الدعم المعلقة، استخدم الأنواع:
  get_pending_support, answer_support_ticket
- لو الطلب عن الإحصائيات استخدم get_stats
- لو الطلب عن المستخدمين/العروض/الأكونتات استخدم نفس الأنواع المتاحة في النظام.
- لو محتاج تفاصيل ناقصة قلها في reply بدل التنفيذ.
- الردود تكون عربية واضحة ومختصرة.
`;}

function websitePrompt() {
  return `أنت بوت خدمة عملاء لموقع Rebranding.
- لا تنفذ أوامر إدارية أبدًا.
- جاوب فقط من المعلومات العامة المتاحة: العروض، الأكونتات، المساعدة، طريقة التواصل.
- لو السؤال خارج المعرفة أو يحتاج تدخل بشري، رجّع JSON فقط:
{"mode":"escalate","reply":"..."}
- لو تقدر تجاوب، رجّع JSON فقط:
{"mode":"chat","reply":"..."}
- الرد يكون مهذب جدًا وبالعربية المصرية.
`;}

function extractJson(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("No JSON");
  return JSON.parse(m[0]);
}

export default async function handler(req) {
  try {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 200, headers: CORS_HEADERS });
    }

    if (req.method === "GET") {
      return json({ ok: true, message: "AI route is working" });
    }

    if (req.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    const body = await req.json();
    const message = String(body.message || "").trim();
    const source = String(body.source || "admin_chat");
    const actorId = String(body.actorId || body.chatId || "unknown");
    const sessionId = String(body.sessionId || body.chatId || actorId || Date.now());
    const supportTicketId = String(body.supportTicketId || "").trim();

    if (!message) return json({ ok: false, reply: "ابعت رسالة الأول." }, 400);

    const context = await buildContext();
    const memory = await getRecentMemory(sessionId);

    let plan;
    if (source === "website_bot") {
      const prompt = `${websitePrompt()}\n\nالسياق المختصر:\naccounts=${JSON.stringify(context.accounts.slice(0,15).map(a => ({name:a.name,category:a.category,description:a.description})))}\noffers=${JSON.stringify(context.offers.slice(0,15).map(o => ({title:o.title,description:o.description,expiryDate:o.expiryDate})))}\n\nرسالة العميل: ${message}`;
      const raw = await askGroq([{ role: 'system', content: websitePrompt() }, ...memory, { role: 'user', content: prompt }]);
      plan = extractJson(raw);

      if (plan.mode === 'escalate') {
        const ticket = await saveSupportTicket({
          sessionId,
          actorId,
          question: message,
          source,
          customerName: body.customerName || "",
          customerContact: body.customerContact || ""
        });
        const reply = plan.reply || "محتاج أتأكد من التفاصيل دي، فهحول سؤالك للإدارة وهيتم الرد عليك قريب.";
        await saveMemory(sessionId, 'user', message);
        await saveMemory(sessionId, 'assistant', reply);
        return json({ ok: true, reply, escalated: true, ticketId: ticket.id });
      }

      const reply = plan.reply || "أقدر أساعدك في العروض والحسابات المتاحة أو أوصلك بالدعم.";
      await saveMemory(sessionId, 'user', message);
      await saveMemory(sessionId, 'assistant', reply);
      return json({ ok: true, reply, mode: 'chat' });
    }

    // Admin chat / telegram / dashboard
    const raw = await askGroq([{ role: 'system', content: adminChatPrompt() }, ...memory, { role: 'user', content: message }]);
    try {
      plan = extractJson(raw);
    } catch {
      plan = null;
    }

    let reply = "تمام.";
    let performed = false;

    if (supportTicketId && message) {
      reply = await answerSupportTicket(supportTicketId, message, actorId);
      performed = true;
    } else if (plan?.mode === 'intent' && plan.intent) {
      reply = await executeIntent(plan.intent, context, source);
      performed = true;
    } else if (/(الاسئلة المعلقة|الأسئلة المعلقة|pending|support)/i.test(message)) {
      reply = await listPendingSupport();
      performed = true;
    } else if (plan?.mode === 'chat' && plan.reply) {
      reply = plan.reply;
    } else {
      reply = raw || "مش واضح 100%، اكتب الطلب بشكل أوضح.";
    }

    await saveMemory(sessionId, 'user', message);
    await saveMemory(sessionId, 'assistant', reply);

    return json({ ok: true, reply, performed });
  } catch (e) {
    return json({ ok: true, reply: "في مشكلة بسيطة في التنفيذ. راجع الإعدادات أو جرّب تاني.", error: String(e.message || e) });
  }
}
