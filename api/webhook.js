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

const TG_TOKEN = process.env.TG_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(s => s.trim());

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
    await sendTG(chatId, "👋 أهلاً! قولي إيه اللي عايزه.");
    return res.status(200).send("ok");
  }

  try {
    const db = getDB();
    const accsSnap = await db.collection("accounts").get();
    const offsSnap = await db.collection("offers").get();
    const accs = accsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const offs = offsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const today = new Date(Date.now()+2*3600000).toISOString().slice(0,10);

    function findAcc(name) {
      if (!name) return null;
      name = name.trim();
      return accs.find(a => a.name === name) || accs.find(a => a.name.includes(name) || name.includes(a.name));
    }

    // رد على سؤال زائر
    if (message.reply_to_message?.text?.includes("[ID:uq_")) {
      const result = await handleReply(db, text, message.reply_to_message.text, accs);
      if (result) {
        await sendTG(chatId, `✅ تم حفظ الإجابة!\nالأكونت: ${result.accName}\nالسؤال: ${result.q}\nالإجابة: ${text}`);
        return res.status(200).send("ok");
      }
    }

    // أوامر سريعة
    if (text === "/list") {
      await sendTG(chatId, accs.length ? `📁 الأكونتات (${accs.length}):\n\n` + accs.map((a,i) => `${i+1}. ${a.name} — ${a.category||"عام"} | ${a.status||"نشط"}`).join("\n") : "مفيش أكونتات");
      return res.status(200).send("ok");
    }
    if (text === "/offers") {
      const active = offs.filter(o => !o.expiryDate || o.expiryDate >= today);
      await sendTG(chatId, active.length ? `🎁 العروض (${active.length}):\n\n` + active.map(o => `• ${o.title}\n  ${accs.find(a=>a.id===o.accountId)?.name||"?"} — ${o.expiryDate||"مفتوح"}`).join("\n\n") : "مفيش عروض نشطة");
      return res.status(200).send("ok");
    }
    if (text === "/expiring") {
      const exp = offs.filter(o => o.expiryDate && o.expiryDate >= today && Math.ceil((new Date(o.expiryDate)-new Date())/86400000) <= 3);
      await sendTG(chatId, exp.length ? `⚠️ هتنتهي قريب:\n\n` + exp.map(o => `• ${o.title} — ${accs.find(a=>a.id===o.accountId)?.name||"?"} (${Math.ceil((new Date(o.expiryDate)-new Date())/86400000)} يوم)`).join("\n") : "✅ مفيش عروض هتنتهي خلال 3 أيام");
      return res.status(200).send("ok");
    }
    if (text === "/stats") {
      const uqSnap = await db.collection("unanswered_questions").get();
      const uqs = uqSnap.docs.map(d => d.data());
      const totalQA = accs.reduce((s,a)=>s+(a.trainedQA||[]).length,0);
      await sendTG(chatId, `📊 الإحصائيات:\n\n👤 أكونتات: ${accs.length}\n🎁 عروض نشطة: ${offs.filter(o=>!o.expiryDate||o.expiryDate>=today).length}\n🧠 أسئلة مدربة: ${totalQA}\n❓ غير مجاوبة: ${uqs.filter(q=>!q.a).length}`);
      return res.status(200).send("ok");
    }

    // شوف أكونت
    const showMatch = text.match(/^(?:شوف|بيانات)\s+(.+)/i);
    if (showMatch) {
      const acc = findAcc(showMatch[1]);
      if (!acc) { await sendTG(chatId, `❌ مش لاقي "${showMatch[1]}"`); return res.status(200).send("ok"); }
      const accOffs = offs.filter(o => o.accountId === acc.id && (!o.expiryDate || o.expiryDate >= today));
      let msg = `👤 ${acc.name} | ${acc.category||"عام"} | ${acc.status||"نشط"}\n`;
      if (acc.fixedReply) msg += `\n💬 الرد الثابت:\n${acc.fixedReply}\n`;
      if (acc.timesReply) msg += `\n⏰ المواعيد:\n${acc.timesReply}\n`;
      if (acc.contactReply) msg += `\n📞 التواصل:\n${acc.contactReply}\n`;
      if (acc.extraReplies?.length) msg += `\n🔘 ردود (${acc.extraReplies.length}): ` + acc.extraReplies.map(r=>r.label).join(" · ") + "\n";
      if (accOffs.length) msg += `\n🎁 عروض:\n` + accOffs.map(o=>`• ${o.title} — ${o.expiryDate||"مفتوح"}`).join("\n");
      if (acc.trainedQA?.length) msg += `\n🧠 أسئلة: ${acc.trainedQA.length}`;
      await sendTG(chatId, msg);
      return res.status(200).send("ok");
    }

    // جدد العروض المنتهية
    if (text.match(/جدد\s*(?:كل)?\s*(?:ال)?عروض/i)) {
      const newDate = new Date(Date.now()+30*86400000).toISOString().slice(0,10);
      const expired = offs.filter(o => o.expiryDate && o.expiryDate < today);
      if (!expired.length) { await sendTG(chatId, "✅ مفيش عروض منتهية"); return res.status(200).send("ok"); }
      for (const o of expired) await db.collection("offers").doc(o.id).update({ expiryDate: newDate, updatedAt: new Date().toISOString() });
      await sendTG(chatId, `✅ تم تجديد ${expired.length} عرض — ينتهوا: ${newDate}`);
      return res.status(200).send("ok");
    }

    // انسخ عروض
    const copyMatch = text.match(/(?:انسخ|نسخ)\s*عروض\s*(.+?)\s*(?:لـ|ل|إلى)\s*(.+)/i);
    if (copyMatch) {
      const src = findAcc(copyMatch[1]), dst = findAcc(copyMatch[2]);
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

    // ══ KEYWORD DETECTION ══

    // 1. تغيير الباسورد
    const pwMatch = text.match(/(?:غير|عدل|بدل|change)\s*(?:ال)?(?:باسورد|password|كلمة\s*المرور)\s*(?:خليه|الي|إلى|لـ|to|=|:)?\s*([\S]{2,30})/i);
    if (pwMatch) {
      const newPw = pwMatch[1].trim();
      await db.collection("settings").doc("admin").set({ password: newPw, updatedAt: new Date().toISOString() }, { merge: true });
      await logActivity(db,"change_password","تغيير الباسورد","تليجرام");
      await sendTG(chatId, `🔐 تم تغيير الباسورد!\nالجديد: ${newPw}`);
      return res.status(200).send("ok");
    }

    // 2. إضافة رد جاهز
    const addReplyMatch = text.match(/(?:ضيف|اضف|أضف)\s*رد\s*(?:في|ل|لـ)\s*(.+?)\s*(?:اسمه|با\s*اسم|باسم|اسم)\s*(.+?)\s*(?:المحتوي|المحتوى|النص|وهو|هو)\s*(.+)/is);
    if (addReplyMatch) {
      const acc = findAcc(addReplyMatch[1]);
      const label = addReplyMatch[2].trim();
      const replyText = addReplyMatch[3].trim();
      if (!acc) { await sendTG(chatId, `❌ مش لاقي أكونت "${addReplyMatch[1]}"\n` + accs.map(a=>`• ${a.name}`).join("\n")); return res.status(200).send("ok"); }
      const replies = (acc.extraReplies||[]).concat([{ label, text: replyText }]);
      await db.collection("accounts").doc(acc.id).update({ extraReplies: replies, updatedAt: new Date().toISOString() });
      await logActivity(db,"add_reply","إضافة رد: "+label,"الأكونت: "+acc.name);
      await sendTG(chatId, `✅ تم إضافة الرد!\nالأكونت: ${acc.name}\nالاسم: ${label}\nالنص: ${replyText}`);
      return res.status(200).send("ok");
    }

    // 3. حذف رد جاهز
    const delReplyMatch = text.match(/(?:احذف|امسح|ازل|حذف|مسح)\s*رد\s*(.+?)\s*(?:من|في)\s*(.+)/is);
    if (delReplyMatch) {
      const acc = findAcc(delReplyMatch[2]);
      const label = delReplyMatch[1].trim();
      if (!acc) { await sendTG(chatId, `❌ مش لاقي أكونت "${delReplyMatch[2]}"`); return res.status(200).send("ok"); }
      const replies = (acc.extraReplies||[]).filter(r => r.label !== label);
      await db.collection("accounts").doc(acc.id).update({ extraReplies: replies, updatedAt: new Date().toISOString() });
      await sendTG(chatId, `✅ تم حذف الرد "${label}" من ${acc.name}`);
      return res.status(200).send("ok");
    }

    // 4. إضافة عرض
    const addOfferMatch = text.match(/(?:ضيف|اضف|أضف)\s*عرض\s*(?:في|ل|لـ)\s*(.+?)\s*(?:اسمه|با\s*اسم|باسم|عنوانه|اسم)\s*(.+?)(?:\s*(?:المحتوي|المحتوى|التفاصيل|الوصف)\s*(.+?))?(?:\s*ينتهي\s*([\d\-\/]+))?$/is);
    if (addOfferMatch) {
      const acc = findAcc(addOfferMatch[1]);
      const title = addOfferMatch[2].trim();
      const content = (addOfferMatch[3]||"").trim();
      const expiry = addOfferMatch[4] ? addOfferMatch[4].replace(/\//g,"-") : "";
      if (!acc) { await sendTG(chatId, `❌ مش لاقي أكونت "${addOfferMatch[1]}"\n` + accs.map(a=>`• ${a.name}`).join("\n")); return res.status(200).send("ok"); }
      const id = "off_"+Date.now();
      await db.collection("offers").doc(id).set({ id, accountId: acc.id, title, description: "", content, image: "", link: "", expiryDate: expiry, badge: "جديد", updatedAt: new Date().toISOString() });
      await logActivity(db,"add_offer","إضافة عرض: "+title,"الأكونت: "+acc.name);
      await sendTG(chatId, `✅ تم إضافة العرض!\nالأكونت: ${acc.name}\nالعنوان: ${title}\n${expiry?"ينتهي: "+expiry:"⏳ مفتوح"}`);
      return res.status(200).send("ok");
    }

    // 5. حذف عرض
    const delOfferMatch = text.match(/(?:احذف|امسح|حذف|مسح)\s*عرض\s*(.+?)(?:\s*(?:من|في)\s*(.+))?$/is);
    if (delOfferMatch) {
      const title = delOfferMatch[1].trim();
      const off = offs.find(o => o.title === title || o.title.includes(title) || title.includes(o.title));
      if (!off) { await sendTG(chatId, `❌ مش لاقي عرض "${title}"`); return res.status(200).send("ok"); }
      await db.collection("offers").doc(off.id).delete();
      await logActivity(db,"delete_offer","حذف عرض: "+off.title,"تليجرام");
      await sendTG(chatId, `🗑️ تم حذف العرض: ${off.title}`);
      return res.status(200).send("ok");
    }

    // 6. إضافة أكونت
    const addAccMatch = text.match(/(?:ضيف|اضف|أضف)\s*(?:اكونت|أكونت|account)\s*اسمه\s*(.+?)(?:\s*(?:كاتيجوري|كتيجوري|نوعه|نوع)\s*(.+))?$/is);
    if (addAccMatch) {
      const name = addAccMatch[1].trim();
      const category = (addAccMatch[2]||"عام").trim();
      const id = "acc_"+Date.now();
      await db.collection("accounts").doc(id).set({ id, name, category, description: "", status: "نشط", avatar: "", coverImage: "", tags: [], links: [], extraReplies: [], galleryImages: [], trainedQA: [], fixedReply: "", timesReply: "", contactReply: "", pinned: false, joinedDate: new Date().toISOString().slice(0,10), updatedAt: new Date().toISOString() });
      await logActivity(db,"add_account","إضافة أكونت: "+name,"تليجرام");
      await sendTG(chatId, `✅ تم إضافة الأكونت!\nالاسم: ${name}\nالكاتيجوري: ${category}`);
      return res.status(200).send("ok");
    }

    // 7. حذف أكونت
    const delAccMatch = text.match(/(?:احذف|امسح|حذف|مسح)\s*(?:اكونت|أكونت|account)\s*(.+)/is);
    if (delAccMatch) {
      const acc = findAcc(delAccMatch[1]);
      if (!acc) { await sendTG(chatId, `❌ مش لاقي أكونت "${delAccMatch[1]}"`); return res.status(200).send("ok"); }
      await db.collection("accounts").doc(acc.id).delete();
      await logActivity(db,"delete_account","حذف أكونت: "+acc.name,"تليجرام");
      await sendTG(chatId, `🗑️ تم حذف الأكونت: ${acc.name}`);
      return res.status(200).send("ok");
    }

    // 8. تعليم البوت
    const addInfoMatch = text.match(/(?:علم|علّم|درب)\s*(?:ال)?بوت\s*(?:إن|ان|انه|إنه)?\s*(.+?)\s*(?:الإجابة|الاجابة|والإجابة|والجواب|جوابه|ردوده)\s*(.+)/is);
    if (addInfoMatch) {
      const parts = addInfoMatch[1].trim().split(/\s+/);
      let acc = null, question = addInfoMatch[1].trim();
      for (let i = parts.length; i > 0; i--) {
        const found = findAcc(parts.slice(0,i).join(" "));
        if (found) { acc = found; question = parts.slice(i).join(" "); break; }
      }
      const answer = addInfoMatch[2].trim();
      if (!acc||!question) { await sendTG(chatId, `❌ مش فاهم الأكونت أو السؤال\nاكتب: علم البوت إن [اسم الأكونت] [السؤال] الإجابة [الجواب]`); return res.status(200).send("ok"); }
      const existing = acc.trainedQA||[];
      const isDup = existing.find(x => x.q?.trim() === question.trim());
      const newQA = isDup ? existing.map(x => x.q?.trim()===question.trim() ? {q:x.q,a:answer} : x) : [...existing,{q:question,a:answer}];
      await db.collection("accounts").doc(acc.id).update({ trainedQA: newQA, updatedAt: new Date().toISOString() });
      await logActivity(db,"add_info","تدريب البوت: "+question.slice(0,50),"الأكونت: "+acc.name);
      await sendTG(chatId, `✅ تم تدريب البوت!\nالأكونت: ${acc.name}\nالسؤال: ${question}\nالجواب: ${answer}`);
      return res.status(200).send("ok");
    }

    // 9. الرد الثابت
    const fixedReplyMatch = text.match(/(?:امسح|احذف|مسح|حذف|عدل|غير|ضيف|اضف|أضف)\s*(?:ال)?رد\s*(?:ال)?ثابت\s*(?:من|في|ل|لـ)\s*(.+?)(?:\s*(?:خليه|وخليه|يكون|وهو|هو)\s*(.+))?$/is);
    if (fixedReplyMatch) {
      const acc = findAcc(fixedReplyMatch[1]);
      const newFixed = fixedReplyMatch[2] ? fixedReplyMatch[2].trim() : "";
      if (!acc) { await sendTG(chatId, `❌ مش لاقي أكونت "${fixedReplyMatch[1]}"`); return res.status(200).send("ok"); }
      await db.collection("accounts").doc(acc.id).update({ fixedReply: newFixed, updatedAt: new Date().toISOString() });
      await sendTG(chatId, newFixed ? `✅ تم تعديل الرد الثابت لـ ${acc.name}` : `✅ تم مسح الرد الثابت من ${acc.name}`);
      return res.status(200).send("ok");
    }

    // 10. المواعيد
    const timesMatch = text.match(/(?:عدل|غير|بدل|اضبط|حدد)\s*(?:ال)?(?:مواعيد|وقت|اوقات|أوقات|ساعات)\s*(?:في|من|ل|بتاع|بتاعت)?\s*(.+?)\s*(?:خليها|خليه|يكون|وخليها|تكون|هي|هتكون)?\s*[:\-]?\s*(.+)/is);
    if (timesMatch) {
      const acc = findAcc(timesMatch[1]);
      const newTimes = timesMatch[2].trim();
      if (!acc) { await sendTG(chatId, `❌ مش لاقي أكونت "${timesMatch[1]}"`); return res.status(200).send("ok"); }
      await db.collection("accounts").doc(acc.id).update({ timesReply: newTimes, updatedAt: new Date().toISOString() });
      await sendTG(chatId, `✅ تم تعديل المواعيد لـ ${acc.name}`);
      return res.status(200).send("ok");
    }

    // 11. التواصل
    const contactMatch = text.match(/(?:عدل|غير|بدل)\s*(?:ال)?(?:تواصل|كونتاكت|رقم|واتساب)\s*(?:في|من|ل|بتاع|بتاعت)?\s*(.+?)\s*(?:خليه|خليها|يكون|هو)?\s*[:\-]?\s*(.+)/is);
    if (contactMatch) {
      const acc = findAcc(contactMatch[1]);
      const newContact = contactMatch[2].trim();
      if (!acc) { await sendTG(chatId, `❌ مش لاقي أكونت "${contactMatch[1]}"`); return res.status(200).send("ok"); }
      await db.collection("accounts").doc(acc.id).update({ contactReply: newContact, updatedAt: new Date().toISOString() });
      await sendTG(chatId, `✅ تم تعديل التواصل لـ ${acc.name}`);
      return res.status(200).send("ok");
    }

    // مش فاهم
    await sendTG(chatId, `مش فاهم قصدك 🤔\nجرب:\n• ضيف عرض في [أكونت] اسمه [عنوان]\n• احذف عرض [اسم]\n• علم البوت إن [أكونت] [سؤال] الإجابة [جواب]\n• /list أو /offers أو /stats`);

  } catch(e) {
    console.error("webhook error:", e.message);
    await sendTG(chatId, "❌ خطأ: " + e.message);
  }
  res.status(200).send("ok");
};
