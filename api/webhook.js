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
const chatHistory = {}; // cache مؤقت

async function getHistory(db, chatId) {
  try {
    const doc = await db.collection("chat_history").doc(chatId).get();
    if (!doc.exists) return [];
    return doc.data().messages || [];
  } catch(e) { return []; }
}

async function saveHistory(db, chatId, messages) {
  try {
    // احتفظ بآخر 10 رسائل بس
    const trimmed = messages.slice(-10);
    await db.collection("chat_history").doc(chatId).set({
      messages: trimmed,
      updatedAt: new Date().toISOString()
    });
    chatHistory[chatId] = trimmed; // cache محلي
  } catch(e) {}
}

async function sendTG(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

async function logActivity(db, type, label, detail) {
  try {
    const id = "act_" + Date.now();
    await db.collection("activity_log").doc(id).set({ id, type, label, detail: detail||"", source: "telegram", createdAt: new Date().toISOString() });
  } catch(e) {}
}

async function askGroq(systemPrompt, history) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({
          model: "meta-llama/llama-4-maverick-17b-128e-instruct",
          temperature: 0,
          max_tokens: 1000,
          messages: [{ role: "system", content: systemPrompt }, ...history],
        }),
      });
      const data = await res.json();
      return data.choices?.[0]?.message?.content || "";
    } catch(e) { if (i === 2) return ""; await new Promise(r => setTimeout(r, 1000)); }
  }
  return "";
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
      description: parsed.description||"", content: parsed.content||"",
      image: "", link: "", expiryDate: parsed.expiryDate||"",
      badge: parsed.badge||"جديد", updatedAt: new Date().toISOString()
    });
    await logActivity(db, "add_offer", "إضافة عرض: "+parsed.title, "الأكونت: "+acc.name);
    return `✅ تم إضافة العرض!\nالأكونت: ${acc.name}\nالعنوان: ${parsed.title}${parsed.expiryDate?"\nينتهي: "+parsed.expiryDate:"\n⏳ مفتوح"}`;
  }

  if (t === "edit_offer") {
    const off = offs.find(o => o.id === parsed.offerId);
    if (!off) return `❌ مش لاقي العرض`;
    await db.collection("offers").doc(off.id).set({ ...off, ...parsed.changes, updatedAt: new Date().toISOString() });
    await logActivity(db, "edit_offer", "تعديل عرض: "+off.title, "تليجرام");
    return `✅ تم تعديل: ${off.title}`;
  }

  if (t === "delete_offer") {
    const off = offs.find(o => o.id === parsed.offerId);
    if (!off) return `❌ مش لاقي العرض`;
    if (!parsed.confirmed) {
      return `⚠️ متأكد إنك عايز تحذف العرض "${off.title}"؟\nرد بـ "أيوه احذف" للتأكيد`;
    }
    await db.collection("offers").doc(parsed.offerId).delete();
    await logActivity(db, "delete_offer", "حذف عرض: "+off.title, "تليجرام");
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
    await logActivity(db, "add_account", "إضافة أكونت: "+parsed.name, "تليجرام");
    return `✅ تم إضافة الأكونت: ${parsed.name}`;
  }

  if (t === "delete_account") {
    const acc = accs.find(a => a.id === parsed.accountId);
    if (!acc) return `❌ مش لاقي الأكونت`;
    if (!parsed.confirmed) {
      return `⚠️ متأكد إنك عايز تحذف أكونت "${acc.name}" وكل بياناته؟\nرد بـ "أيوه احذف" للتأكيد`;
    }
    await db.collection("accounts").doc(acc.id).delete();
    await logActivity(db, "delete_account", "حذف أكونت: "+acc.name, "تليجرام");
    return `🗑️ تم حذف الأكونت: ${acc.name}`;
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
    const replies = (acc.extraReplies||[]).concat([{ label: parsed.label||"رد", text: parsed.text||"" }]);
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
    await logActivity(db, "add_info", "تدريب البوت: "+(parsed.question||"").slice(0,50), "الأكونت: "+acc.name);
    return `✅ تم تدريب البوت!\nالأكونت: ${acc.name}\nالسؤال: ${parsed.question}`;
  }

  if (t === "delete_info") {
    const acc = accs.find(a => a.id === parsed.accountId);
    if (!acc) return `❌ مش لاقي الأكونت`;
    const qa = (acc.trainedQA||[]).filter(q => q.q !== parsed.question);
    await db.collection("accounts").doc(acc.id).update({ trainedQA: qa, updatedAt: new Date().toISOString() });
    return `✅ تم حذف السؤال من ${acc.name}`;
  }

  if (t === "delete_image") {
    const acc = accs.find(a => a.id === parsed.accountId);
    if (!acc) return `❌ مش لاقي الأكونت`;
    const imgs = (acc.galleryImages||[]).filter(img => img !== parsed.imageUrl);
    await db.collection("accounts").doc(acc.id).update({ galleryImages: imgs, updatedAt: new Date().toISOString() });
    return `✅ تم حذف الصورة`;
  }

  if (t === "change_password") {
    if (!parsed.newPassword) return `❌ محتاج الباسورد الجديد`;
    await db.collection("settings").doc("admin").set({ password: parsed.newPassword, updatedAt: new Date().toISOString() }, { merge: true });
    await logActivity(db, "change_password", "تغيير الباسورد", "تليجرام");
    return `🔐 تم تغيير الباسورد!\nالجديد: ${parsed.newPassword}`;
  }

  return `❌ أكشن مش معروف: ${t}`;
}

async function handleReply(db, replyText, originalText, accs) {
  const idMatch = originalText.match(/\[ID:(uq_\d+)\]/);
  if (!idMatch) return false;
  const qId = idMatch[1];
  const qDoc = await db.collection("unanswered_questions").doc(qId).get();
  if (!qDoc.exists) return false;
  const qData = qDoc.data();
  await db.collection("unanswered_questions").doc(qId).update({ a: replyText });
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
    return { q: qData.q, accName: matched.name };
  }
  return { q: qData.q, accName: qData.accName };
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

  let ctx = `أنت مساعد إداري ذكي لوكالة Rebranding. بتتناقش مع الأدمن بالعربي وبتنفذ طلباته.
النهارده: ${today}

🧠 أسلوبك:
- افهم قصد الأدمن حتى لو الجملة مش مكتملة أو فيها أخطاء إملائية
- لو حاجة ناقصة — اسأل سؤال واحد بس عنها
- لو عندك كل المعلومات — نفّذ فوراً بـ [ACTION]
- بعد التنفيذ قول جملة واحدة بس "✅ تم"
- لو الأدمن بيرد على سؤال زائر (رسالة فيها [ID:uq_]) — مش بتعمل [ACTION] خالص

📋 الأكشنات:
[ACTION]{"type":"add_offer","accountId":"ID","title":"عنوان","content":"تفاصيل وسعر ومكونات","expiryDate":"YYYY-MM-DD أو فاضي لو مفتوح","badge":"جديد"}
[ACTION]{"type":"edit_offer","offerId":"ID","changes":{"title":"...","expiryDate":"..."}}
[ACTION]{"type":"delete_offer","offerId":"ID"}
[ACTION]{"type":"add_account","name":"...","category":"...","description":"..."}
[ACTION]{"type":"delete_account","accountId":"ID"}
[ACTION]{"type":"edit_account","accountId":"ID","changes":{"fixedReply":"...","timesReply":"...","contactReply":"...","status":"نشط","name":"...","description":"..."}}
[ACTION]{"type":"add_reply","accountId":"ID","label":"اسم الزرار","text":"نص الرد"}
[ACTION]{"type":"delete_reply","accountId":"ID","label":"اسم الزرار"}
[ACTION]{"type":"add_info","accountId":"ID","question":"...","answer":"..."}
[ACTION]{"type":"delete_info","accountId":"ID","question":"..."}
[ACTION]{"type":"change_password","newPassword":"..."}

⚠️ قواعد:
- expiryDate فاضي = عرض مفتوح ✅
- "مفتوح" أو "بدون تاريخ" = expiryDate: ""
- content = كل التفاصيل (السعر، المكونات، الوصف)
- مسح الرد الثابت = edit_account + fixedReply: ""
- لو الأدمن قال "مفتوح" للتاريخ — نفّذ فوراً بـ expiryDate: ""
- الحذف: لازم confirmed:true في الـ ACTION — لو الأدمن مأكدش اسأله أولاً
- لو الأدمن قال "أيوه احذف" أو "اتفضل" أو "أكيد" = confirmed:true

=== الأكونتات ===\n`;

  accs.forEach(a => {
    ctx += `• ${a.name} | ID: ${a.id} | ${a.status||"نشط"}\n`;
    activeOffs.filter(o => o.accountId === a.id).forEach(o => {
      ctx += `  ↳ عرض: ${o.title} | ID: ${o.id} | ينتهي: ${o.expiryDate||"مفتوح"}\n`;
    });
  });

  return { ctx, accs, offs: activeOffs, allOffs: offs };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("ok");
  const { message } = req.body || {};
  if (!message) return res.status(200).send("ok");

  const chatId = String(message.chat?.id);
  const text = (message.text || "").trim();

  if (ADMIN_IDS.length && !ADMIN_IDS.includes(chatId)) {
    await sendTG(chatId, "⛔ مش مصرح ليك.");
    return res.status(200).send("ok");
  }

  if (text === "/start" || text === "/reset") {
    chatHistory[chatId] = [];
    try {
      const db = getDB();
      await db.collection("chat_history").doc(chatId).delete();
    } catch(e) {}
    await sendTG(chatId, "👋 أهلاً! قولي إيه اللي عايزه.");
    return res.status(200).send("ok");
  }

  try {
    const db = getDB();

    // ══ أوامر سريعة ══
    if (text === "/list") {
      const snap = await db.collection("accounts").get();
      const accs = snap.docs.map(d => d.data());
      if (!accs.length) { await sendTG(chatId, "مفيش أكونتات"); return res.status(200).send("ok"); }
      await sendTG(chatId, `📁 الأكونتات (${accs.length}):\n\n` + accs.map((a,i) => `${i+1}. ${a.name} — ${a.category||"عام"} | ${a.status||"نشط"}`).join("\n"));
      return res.status(200).send("ok");
    }

    if (text === "/offers") {
      const [accsSnap, offsSnap] = await Promise.all([db.collection("accounts").get(), db.collection("offers").get()]);
      const accs = accsSnap.docs.map(d => d.data());
      const today = new Date(Date.now()+2*3600000).toISOString().slice(0,10);
      const offs = offsSnap.docs.map(d => d.data()).filter(o => !o.expiryDate || o.expiryDate >= today);
      if (!offs.length) { await sendTG(chatId, "مفيش عروض نشطة"); return res.status(200).send("ok"); }
      await sendTG(chatId, `🎁 العروض (${offs.length}):\n\n` + offs.map(o => {
        const acc = accs.find(a => a.id === o.accountId);
        const days = o.expiryDate ? Math.ceil((new Date(o.expiryDate)-new Date())/86400000) : null;
        return `• ${o.title}\n  ${acc?.name||"?"} — ${o.expiryDate||"مفتوح"}${days!==null?` (${days} يوم)`:""}`;
      }).join("\n\n"));
      return res.status(200).send("ok");
    }

    if (text === "/expiring") {
      const [accsSnap, offsSnap] = await Promise.all([db.collection("accounts").get(), db.collection("offers").get()]);
      const accs = accsSnap.docs.map(d => d.data());
      const today = new Date(Date.now()+2*3600000).toISOString().slice(0,10);
      const offs = offsSnap.docs.map(d => d.data()).filter(o => {
        if (!o.expiryDate || o.expiryDate < today) return false;
        return Math.ceil((new Date(o.expiryDate)-new Date())/86400000) <= 3;
      });
      if (!offs.length) { await sendTG(chatId, "✅ مفيش عروض هتنتهي خلال 3 أيام"); return res.status(200).send("ok"); }
      await sendTG(chatId, `⚠️ عروض هتنتهي قريب:\n\n` + offs.map(o => {
        const acc = accs.find(a => a.id === o.accountId);
        return `• ${o.title}\n  ${acc?.name||"?"} — باقي ${Math.ceil((new Date(o.expiryDate)-new Date())/86400000)} يوم`;
      }).join("\n\n"));
      return res.status(200).send("ok");
    }

    if (text === "/stats") {
      const [accsSnap, offsSnap, uqSnap] = await Promise.all([db.collection("accounts").get(), db.collection("offers").get(), db.collection("unanswered_questions").get()]);
      const today = new Date(Date.now()+2*3600000).toISOString().slice(0,10);
      const accs = accsSnap.docs.map(d => d.data());
      const offs = offsSnap.docs.map(d => d.data());
      const uqs = uqSnap.docs.map(d => d.data());
      const totalQA = accs.reduce((s,a) => s+(a.trainedQA||[]).length, 0);
      await sendTG(chatId, `📊 الإحصائيات:\n\n👤 أكونتات: ${accs.length}\n🎁 عروض نشطة: ${offs.filter(o=>!o.expiryDate||o.expiryDate>=today).length}\n🧠 أسئلة مدربة: ${totalQA}\n❓ غير مجاوبة: ${uqs.filter(q=>!q.a).length}\n✅ مجاوبة: ${uqs.filter(q=>q.a).length}`);
      return res.status(200).send("ok");
    }

    // شوف أكونت
    const showMatch = text.match(/^(?:شوف|بيانات)\s+(.+)/i);
    if (showMatch) {
      const snap = await db.collection("accounts").get();
      const offsSnap = await db.collection("offers").get();
      const accs = snap.docs.map(d => d.data());
      const offs = offsSnap.docs.map(d => d.data());
      const today = new Date(Date.now()+2*3600000).toISOString().slice(0,10);
      const name = showMatch[1].trim();
      const acc = accs.find(a => a.name === name) || accs.find(a => a.name.includes(name) || name.includes(a.name));
      if (!acc) { await sendTG(chatId, `❌ مش لاقي "${name}"`); return res.status(200).send("ok"); }
      const accOffs = offs.filter(o => o.accountId === acc.id && (!o.expiryDate || o.expiryDate >= today));
      let msg = `👤 ${acc.name} | ${acc.category||"عام"} | ${acc.status||"نشط"}\n`;
      if (acc.fixedReply) msg += `\n💬 الرد الثابت:\n${acc.fixedReply}\n`;
      if (acc.timesReply) msg += `\n⏰ المواعيد:\n${acc.timesReply}\n`;
      if (acc.contactReply) msg += `\n📞 التواصل:\n${acc.contactReply}\n`;
      if (acc.extraReplies?.length) msg += `\n🔘 ردود (${acc.extraReplies.length}): ` + acc.extraReplies.map(r=>`${r.label}`).join(" · ") + "\n";
      if (accOffs.length) msg += `\n🎁 عروض (${accOffs.length}):\n` + accOffs.map(o=>`• ${o.title} — ${o.expiryDate||"مفتوح"}`).join("\n");
      if (acc.trainedQA?.length) msg += `\n🧠 أسئلة: ${acc.trainedQA.length}`;
      await sendTG(chatId, msg);
      return res.status(200).send("ok");
    }

    // جدد كل العروض المنتهية
    if (text.match(/جدد\s*(?:كل)?\s*(?:ال)?عروض/i)) {
      const snap = await db.collection("offers").get();
      const today = new Date(Date.now()+2*3600000).toISOString().slice(0,10);
      const newDate = new Date(Date.now()+30*86400000).toISOString().slice(0,10);
      const expired = snap.docs.map(d=>({id:d.id,...d.data()})).filter(o=>o.expiryDate&&o.expiryDate<today);
      if (!expired.length) { await sendTG(chatId, "✅ مفيش عروض منتهية"); return res.status(200).send("ok"); }
      for (const o of expired) await db.collection("offers").doc(o.id).update({ expiryDate: newDate, updatedAt: new Date().toISOString() });
      await sendTG(chatId, `✅ تم تجديد ${expired.length} عرض — ينتهوا: ${newDate}`);
      return res.status(200).send("ok");
    }

    // انسخ عروض
    const copyMatch = text.match(/(?:انسخ|نسخ)\s*عروض\s*(.+?)\s*(?:لـ|ل|إلى)\s*(.+)/i);
    if (copyMatch) {
      const [accsSnap, offsSnap] = await Promise.all([db.collection("accounts").get(), db.collection("offers").get()]);
      const accs = accsSnap.docs.map(d=>({id:d.id,...d.data()}));
      const offs = offsSnap.docs.map(d=>({id:d.id,...d.data()}));
      const today = new Date(Date.now()+2*3600000).toISOString().slice(0,10);
      const src = accs.find(a=>a.name===copyMatch[1].trim())||accs.find(a=>a.name.includes(copyMatch[1].trim())||copyMatch[1].trim().includes(a.name));
      const dst = accs.find(a=>a.name===copyMatch[2].trim())||accs.find(a=>a.name.includes(copyMatch[2].trim())||copyMatch[2].trim().includes(a.name));
      if (!src||!dst) { await sendTG(chatId, `❌ مش لاقي الأكونتات`); return res.status(200).send("ok"); }
      const srcOffs = offs.filter(o=>o.accountId===src.id&&(!o.expiryDate||o.expiryDate>=today));
      if (!srcOffs.length) { await sendTG(chatId, `❌ مفيش عروض نشطة في ${src.name}`); return res.status(200).send("ok"); }
      for (const o of srcOffs) {
        const newId = "off_"+Date.now()+Math.random().toString(36).slice(2,5);
        await db.collection("offers").doc(newId).set({...o, id: newId, accountId: dst.id, updatedAt: new Date().toISOString()});
      }
      await sendTG(chatId, `✅ تم نسخ ${srcOffs.length} عرض من ${src.name} لـ ${dst.name}`);
      return res.status(200).send("ok");
    }

    // ══ رد على سؤال زائر ══
    if (message.reply_to_message) {
      const originalText = message.reply_to_message.text || "";
      if (originalText.includes("[ID:uq_")) {
        const accsSnap = await db.collection("accounts").get();
        const accs = accsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        const result = await handleReply(db, text, originalText, accs);
        if (result) {
          await sendTG(chatId, `✅ تم حفظ الإجابة!\nالأكونت: ${result.accName}\nالسؤال: ${result.q}\nالإجابة: ${text}`);
          return res.status(200).send("ok");
        }
      }
    }

    // ══ AI — بيفهم كل حاجة تانية ══
    const { ctx, accs, offs } = await buildAdminContext(db);
    // جيب الـ history من cache أو Firestore
    if (!chatHistory[chatId]) chatHistory[chatId] = await getHistory(db, chatId);
    chatHistory[chatId].push({ role: "user", content: text });

    const reply = await askGroq(ctx, chatHistory[chatId]);
    chatHistory[chatId].push({ role: "assistant", content: reply });
    await saveHistory(db, chatId, chatHistory[chatId]);

    // لو فيه [ACTION] نفذه
    const actionMatch = reply.match(/\[ACTION\]\s*(\{[\s\S]*?\})/);
    if (actionMatch) {
      const cleanReply = reply.replace(/\[ACTION\]\s*\{[\s\S]*?\}/, "").trim();
      if (cleanReply) await sendTG(chatId, cleanReply);
      try {
        const result = await execAction(db, actionMatch[1], accs, offs);
        await sendTG(chatId, result);
      } catch(e) {
        await sendTG(chatId, "❌ خطأ: " + e.message);
      }
    } else {
      await sendTG(chatId, reply || "مش فاهم، حاول تاني.");
    }

  } catch(e) {
    console.error(e);
    await sendTG(chatId, "❌ خطأ: " + e.message);
    res.status(200).send("ok");
  }
  res.status(200).send("ok");
};
