const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { credential } = require("firebase-admin");

function getDB() {
  if (!getApps().length) {
    initializeApp({ credential: credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    })});
  }
  return getFirestore();
}

const GROQ_KEY = process.env.GROQ_KEY;
const TG_TOKEN = process.env.TG_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(s => s.trim());
const chatHistory = {};

async function sendTG(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function logActivity(db, type, label, detail) {
  try {
    const id = "act_" + Date.now();
    await db.collection("activity_log").doc(id).set({ id, type, label, detail: detail||"", source: "telegram", createdAt: new Date().toISOString() });
  } catch(e) {}
}

async function askGroq(systemPrompt, history) {
  const messages = [{ role: "system", content: systemPrompt }, ...history];
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({ model: "meta-llama/llama-4-maverick-17b-128e-instruct", messages, max_tokens: 800, temperature: 0 }),
    });
    const d = await res.json();
    console.log("GROQ status:", res.status, "| reply:", d.choices?.[0]?.message?.content?.slice(0,80) || JSON.stringify(d.error));
    return d.choices?.[0]?.message?.content || "";
  } catch(e) {
    console.error("GROQ error:", e.message);
    return "";
  }
}

async function buildAdminContext(db) {
  const [accsSnap, offsSnap] = await Promise.all([
    db.collection("accounts").get(),
    db.collection("offers").get(),
  ]);
  const accs = accsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const offs = offsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const today = new Date(Date.now() + 2*3600000).toISOString().slice(0,10);
  const activeOffs = offs.filter(o => !o.expiryDate || o.expiryDate >= today);

  let ctx = `أنت مساعد إداري ذكي لوكالة Rebranding. بتنفذ أوامر الأدمن بالعربي.
النهارده: ${today}

قواعد صارمة:
1. لو الأدمن بيرد على سؤال زائر (رسالة فيها [ID:uq_]) — مش هتعمل [ACTION] خالص
2. [ACTION] بتستخدمه فقط لو الأدمن طلب صراحة إضافة أو تعديل أو حذف
3. لو الأدمن قال "ضيف عرض" لازم تسأله عن تاريخ الانتهاء لو مش قاله — أو قوله "مفتوح" لو قال كده
4. expiryDate فاضي = عرض مفتوح بدون تاريخ ✅
5. استخدم الـ ID الصح من القائمة بالظبط
6. لو مش متأكد من الأكونت — اسأل
7. content بتحط فيه كل التفاصيل: السعر، المكونات، الوصف الكامل

الأكشنات (استخدم [ACTION] وبعدين JSON):
[ACTION]{"type":"add_offer","accountId":"ID","title":"...","content":"السعر والتفاصيل","expiryDate":"YYYY-MM-DD أو فاضي لو مفتوح","badge":"جديد"}
[ACTION]{"type":"edit_offer","offerId":"ID","changes":{"title":"...","expiryDate":"..."}}
[ACTION]{"type":"delete_offer","offerId":"ID"}
[ACTION]{"type":"add_account","name":"...","category":"...","description":"..."}
[ACTION]{"type":"delete_account","accountId":"ID"}
[ACTION]{"type":"edit_account","accountId":"ID","changes":{"fixedReply":"...","timesReply":"...","contactReply":"...","status":"نشط","name":"...","description":"..."}}
[ACTION]{"type":"add_reply","accountId":"ID","label":"اسم الزرار","text":"نص الرد"}
[ACTION]{"type":"delete_reply","accountId":"ID","label":"..."}
[ACTION]{"type":"add_info","accountId":"ID","question":"...","answer":"..."}
[ACTION]{"type":"delete_info","accountId":"ID","question":"..."}
[ACTION]{"type":"change_password","newPassword":"..."}

مهم: "مفتوح" أو "بدون تاريخ" = expiryDate: ""
مهم: مسح الرد الثابت = edit_account + fixedReply: ""

=== الأكونتات ===\n`;

  accs.forEach(a => {
    ctx += `• ${a.name} | ID: ${a.id} | ${a.status||"نشط"}\n`;
    activeOffs.filter(o => o.accountId === a.id).forEach(o => {
      ctx += `  ↳ عرض: ${o.title} | ID: ${o.id} | ينتهي: ${o.expiryDate||"مفتوح"}\n`;
    });
  });

  return { ctx, accs, offs: activeOffs, allOffs: offs };
}

async function execAction(db, actionStr, accs, offs) {
  const parsed = JSON.parse(actionStr);
  const t = parsed.type;

  if (t === "add_offer") {
    const acc = accs.find(a => a.id === parsed.accountId);
    if (!acc) return `❌ مش لاقي الأكونت`;
    const id = "off_" + Date.now();
    await db.collection("offers").doc(id).set({
      id, accountId: parsed.accountId, title: parsed.title||"",
      description: "", content: parsed.content||"",
      image: "", link: "", expiryDate: parsed.expiryDate||"",
      badge: parsed.badge||"جديد", updatedAt: new Date().toISOString()
    });
    await logActivity(db, "add_offer", "إضافة عرض: "+parsed.title, "الأكونت: "+acc.name);
    return `✅ تم إضافة العرض!\nالأكونت: ${acc.name}\nالعنوان: ${parsed.title}\n${parsed.expiryDate?"ينتهي: "+parsed.expiryDate:"⏳ مفتوح"}`;
  }

  if (t === "edit_offer") {
    const off = offs.find(o => o.id === parsed.offerId);
    if (!off) return `❌ مش لاقي العرض`;
    await db.collection("offers").doc(off.id).set({ ...off, ...parsed.changes, updatedAt: new Date().toISOString() });
    await logActivity(db, "edit_offer", "تعديل عرض: "+off.title, "");
    return `✅ تم تعديل: ${off.title}`;
  }

  if (t === "delete_offer") {
    const off = offs.find(o => o.id === parsed.offerId);
    if (!off) return `❌ مش لاقي العرض`;
    await db.collection("offers").doc(off.id).delete();
    await logActivity(db, "delete_offer", "حذف عرض: "+off.title, "");
    return `🗑️ تم حذف: ${off.title}`;
  }

  if (t === "add_account") {
    const id = "acc_" + Date.now();
    await db.collection("accounts").doc(id).set({
      id, name: parsed.name||"", category: parsed.category||"عام",
      description: parsed.description||"", status: "نشط",
      avatar: "", coverImage: "", tags: [], links: [],
      extraReplies: [], galleryImages: [], trainedQA: [],
      fixedReply: "", timesReply: "", contactReply: "",
      pinned: false, joinedDate: new Date().toISOString().slice(0,10),
      updatedAt: new Date().toISOString()
    });
    await logActivity(db, "add_account", "إضافة أكونت: "+parsed.name, "");
    return `✅ تم إضافة الأكونت: ${parsed.name}`;
  }

  if (t === "delete_account") {
    const acc = accs.find(a => a.id === parsed.accountId);
    if (!acc) return `❌ مش لاقي الأكونت`;
    await db.collection("accounts").doc(acc.id).delete();
    await logActivity(db, "delete_account", "حذف أكونت: "+acc.name, "");
    return `🗑️ تم حذف: ${acc.name}`;
  }

  if (t === "edit_account") {
    const acc = accs.find(a => a.id === parsed.accountId);
    if (!acc) return `❌ مش لاقي الأكونت`;
    await db.collection("accounts").doc(acc.id).set({ ...acc, ...parsed.changes, updatedAt: new Date().toISOString() });
    await logActivity(db, "edit_account", "تعديل أكونت: "+acc.name, JSON.stringify(parsed.changes||{}).slice(0,80));
    return `✅ تم تعديل: ${acc.name}`;
  }

  if (t === "add_reply") {
    const acc = accs.find(a => a.id === parsed.accountId);
    if (!acc) return `❌ مش لاقي الأكونت`;
    const replies = (acc.extraReplies||[]).concat([{ label: parsed.label, text: parsed.text }]);
    await db.collection("accounts").doc(acc.id).update({ extraReplies: replies, updatedAt: new Date().toISOString() });
    await logActivity(db, "add_reply", "إضافة رد: "+parsed.label, "الأكونت: "+acc.name);
    return `✅ تم إضافة الرد "${parsed.label}" لـ ${acc.name}`;
  }

  if (t === "delete_reply") {
    const acc = accs.find(a => a.id === parsed.accountId);
    if (!acc) return `❌ مش لاقي الأكونت`;
    const replies = (acc.extraReplies||[]).filter(r => r.label !== parsed.label);
    await db.collection("accounts").doc(acc.id).update({ extraReplies: replies, updatedAt: new Date().toISOString() });
    return `✅ تم حذف الرد "${parsed.label}" من ${acc.name}`;
  }

  if (t === "add_info") {
    const acc = accs.find(a => a.id === parsed.accountId);
    if (!acc) return `❌ مش لاقي الأكونت`;
    const existing = acc.trainedQA||[];
    const isDup = existing.find(x => x.q?.trim() === parsed.question?.trim());
    const newQA = isDup
      ? existing.map(x => x.q?.trim() === parsed.question?.trim() ? { q: x.q, a: parsed.answer } : x)
      : [...existing, { q: parsed.question, a: parsed.answer }];
    await db.collection("accounts").doc(acc.id).update({ trainedQA: newQA, updatedAt: new Date().toISOString() });
    await logActivity(db, "add_info", "تدريب: "+(parsed.question||"").slice(0,50), "الأكونت: "+acc.name);
    return `✅ تم تدريب البوت!\nالأكونت: ${acc.name}\nالسؤال: ${parsed.question}`;
  }

  if (t === "delete_info") {
    const acc = accs.find(a => a.id === parsed.accountId);
    if (!acc) return `❌ مش لاقي الأكونت`;
    const qa = (acc.trainedQA||[]).filter(q => q.q !== parsed.question);
    await db.collection("accounts").doc(acc.id).update({ trainedQA: qa, updatedAt: new Date().toISOString() });
    return `✅ تم حذف السؤال من ${acc.name}`;
  }

  if (t === "change_password") {
    await db.collection("settings").doc("admin").set({ password: parsed.newPassword, updatedAt: new Date().toISOString() }, { merge: true });
    await logActivity(db, "change_password", "تغيير الباسورد", "");
    return `🔐 تم تغيير الباسورد!\nالجديد: ${parsed.newPassword}`;
  }

  return `❌ أكشن مش معروف: ${t}`;
}

async function handleReply(db, replyText, originalText, accs) {
  const idMatch = originalText.match(/\[ID:(uq_\d+)\]/);
  if (!idMatch) return false;
  const qDoc = await db.collection("unanswered_questions").doc(idMatch[1]).get();
  if (!qDoc.exists) return false;
  const qData = qDoc.data();
  await db.collection("unanswered_questions").doc(idMatch[1]).update({ a: replyText });
  const aidMatch = originalText.match(/\[AID:([^\]]+)\]/);
  const accId = aidMatch ? aidMatch[1].trim() : null;
  let matched = accId ? accs.find(a => a.id === accId) : null;
  if (!matched) matched = accs.find(a => a.name === qData.accName);
  if (matched) {
    const existing = matched.trainedQA||[];
    const isDup = existing.find(x => x.q?.trim() === qData.q?.trim());
    const newQA = isDup
      ? existing.map(x => x.q?.trim() === qData.q?.trim() ? { q: x.q, a: replyText } : x)
      : [...existing, { q: qData.q, a: replyText }];
    await db.collection("accounts").doc(matched.id).update({ trainedQA: newQA, updatedAt: new Date().toISOString() });
  }
  return { q: qData.q, accName: matched?.name || qData.accName };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("ok");
  const { message } = req.body || {};
  if (!message) return res.status(200).send("ok");

  const chatId = String(message.chat?.id);
  const text = (message.text || "").trim();
  if (!text) return res.status(200).send("ok");

  if (ADMIN_IDS.length && !ADMIN_IDS.includes(chatId)) {
    await sendTG(chatId, "⛔ مش مصرح ليك.");
    return res.status(200).send("ok");
  }

  if (text === "/start" || text === "/reset") {
    chatHistory[chatId] = [];
    await sendTG(chatId, "👋 أهلاً! قولي إيه اللي عايزه.");
    return res.status(200).send("ok");
  }

  try {
    const db = getDB();

    // أوامر سريعة
    if (text === "/list") {
      const snap = await db.collection("accounts").get();
      const accs = snap.docs.map(d => d.data());
      await sendTG(chatId, accs.length ? `📁 الأكونتات (${accs.length}):\n\n` + accs.map((a,i) => `${i+1}. ${a.name} — ${a.category||"عام"} | ${a.status||"نشط"}`).join("\n") : "مفيش أكونتات");
      return res.status(200).send("ok");
    }
    if (text === "/offers") {
      const [accsSnap, offsSnap] = await Promise.all([db.collection("accounts").get(), db.collection("offers").get()]);
      const accs = accsSnap.docs.map(d => d.data());
      const today = new Date(Date.now()+2*3600000).toISOString().slice(0,10);
      const offs = offsSnap.docs.map(d => d.data()).filter(o => !o.expiryDate || o.expiryDate >= today);
      await sendTG(chatId, offs.length ? `🎁 العروض (${offs.length}):\n\n` + offs.map(o => `• ${o.title}\n  ${accs.find(a=>a.id===o.accountId)?.name||"?"} — ${o.expiryDate||"مفتوح"}`).join("\n\n") : "مفيش عروض نشطة");
      return res.status(200).send("ok");
    }
    if (text === "/expiring") {
      const [accsSnap, offsSnap] = await Promise.all([db.collection("accounts").get(), db.collection("offers").get()]);
      const accs = accsSnap.docs.map(d => d.data());
      const today = new Date(Date.now()+2*3600000).toISOString().slice(0,10);
      const offs = offsSnap.docs.map(d => d.data()).filter(o => o.expiryDate && o.expiryDate >= today && Math.ceil((new Date(o.expiryDate)-new Date())/86400000) <= 3);
      await sendTG(chatId, offs.length ? `⚠️ هتنتهي قريب:\n\n` + offs.map(o => `• ${o.title} — ${accs.find(a=>a.id===o.accountId)?.name||"?"} (${Math.ceil((new Date(o.expiryDate)-new Date())/86400000)} يوم)`).join("\n") : "✅ مفيش عروض هتنتهي خلال 3 أيام");
      return res.status(200).send("ok");
    }
    if (text === "/stats") {
      const [accsSnap, offsSnap, uqSnap] = await Promise.all([db.collection("accounts").get(), db.collection("offers").get(), db.collection("unanswered_questions").get()]);
      const today = new Date(Date.now()+2*3600000).toISOString().slice(0,10);
      const accs = accsSnap.docs.map(d => d.data());
      const offs = offsSnap.docs.map(d => d.data());
      const uqs = uqSnap.docs.map(d => d.data());
      const totalQA = accs.reduce((s,a)=>s+(a.trainedQA||[]).length,0);
      await sendTG(chatId, `📊 الإحصائيات:\n\n👤 أكونتات: ${accs.length}\n🎁 عروض نشطة: ${offs.filter(o=>!o.expiryDate||o.expiryDate>=today).length}\n🧠 أسئلة مدربة: ${totalQA}\n❓ غير مجاوبة: ${uqs.filter(q=>!q.a).length}`);
      return res.status(200).send("ok");
    }

    // رد على سؤال زائر
    if (message.reply_to_message?.text?.includes("[ID:uq_")) {
      const accsSnap = await db.collection("accounts").get();
      const accs = accsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const result = await handleReply(db, text, message.reply_to_message.text, accs);
      if (result) {
        await sendTG(chatId, `✅ تم حفظ الإجابة!\nالأكونت: ${result.accName}\nالسؤال: ${result.q}\nالإجابة: ${text}`);
        return res.status(200).send("ok");
      }
    }

    // AI
    const { ctx, accs, offs } = await buildAdminContext(db);
    if (!chatHistory[chatId]) chatHistory[chatId] = [];
    chatHistory[chatId].push({ role: "user", content: text });
    if (chatHistory[chatId].length > 8) chatHistory[chatId] = chatHistory[chatId].slice(-8);

    const reply = await askGroq(ctx, chatHistory[chatId]);
    chatHistory[chatId].push({ role: "assistant", content: reply });

    const actionMatch = reply.match(/\[ACTION\]\s*(\{[\s\S]*?\})/);
    if (actionMatch) {
      const cleanReply = reply.replace(/\[ACTION\]\s*\{[\s\S]*?\}/, "").trim();
      if (cleanReply) await sendTG(chatId, cleanReply);
      try {
        const result = await execAction(db, actionMatch[1], accs, offs);
        await sendTG(chatId, result);
      } catch(e) {
        await sendTG(chatId, "❌ خطأ في التنفيذ: " + e.message);
      }
    } else {
      await sendTG(chatId, reply || "❌ مفيش رد من الـ AI — حاول تاني");
    }

  } catch(e) {
    console.error("webhook error:", e.message);
    await sendTG(chatId, "❌ خطأ: " + e.message);
  }
  res.status(200).send("ok");
};
