const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { credential } = require("firebase-admin");

const SHEET_ID = "1wdBmHTmg5JdLujX-6P-MHXsoCjDwCLZWcF8BwJdlYEM";
const TG_TOKEN = process.env.TG_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(s => s.trim());
const SHEETS_CLIENT_EMAIL = process.env.SHEETS_CLIENT_EMAIL;
const SHEETS_PRIVATE_KEY = process.env.SHEETS_PRIVATE_KEY?.replace(/\\n/g, "\n");

function getDB() {
  if (!getApps().length) {
    initializeApp({
      credential: credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      }),
    });
  }
  return getFirestore();
}

async function sendTG(text) {
  for (const id of ADMIN_IDS) {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: id, text, parse_mode: "HTML" }),
    });
  }
}

// ══ GOOGLE SHEETS ══
async function getSheetsToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: SHEETS_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600, iat: now,
  })).toString("base64url");
  const { createSign } = require("crypto");
  const sign = createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(SHEETS_PRIVATE_KEY, "base64url");
  const jwt = `${header}.${payload}.${sig}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  return data.access_token;
}

async function syncToSheets(db) {
  try {
    const token = await getSheetsToken();
    const snap = await db.collection("unanswered_questions").get();
    const today = new Date().toISOString().slice(0, 10);
    const todayQs = snap.docs.map(d => d.data()).filter(q => q.createdAt?.slice(0, 10) === today);
    if (!todayQs.length) return 0;
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent("الأسئلة")}!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ values: todayQs.map(q => [
        q.createdAt ? new Date(q.createdAt).toLocaleString("ar-EG") : "",
        q.accName || "", q.q || "", q.a || "",
        q.a ? "✅ متجاوب" : "⏳ في الانتظار"
      ])}),
    });
    return todayQs.length;
  } catch(e) { console.error("Sheets error:", e.message); return 0; }
}

// ══ تقرير المساء (7 م) ══
async function eveningReport(db) {
  const today = new Date().toISOString().slice(0, 10);
  const egyptNow = new Date(Date.now() + 2*3600000).toLocaleString("ar-EG", {weekday:"long", day:"numeric", month:"long"});

  const [accsSnap, offsSnap, uqSnap] = await Promise.all([
    db.collection("accounts").get(),
    db.collection("offers").get(),
    db.collection("unanswered_questions").get()
  ]);

  const accs = accsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const offs = offsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const uqs = uqSnap.docs.map(d => d.data());

  // أسئلة النهارده
  const todayQs = uqs.filter(q => q.createdAt?.slice(0,10) === today);
  const answered = todayQs.filter(q => q.a).length;
  const unanswered = todayQs.filter(q => !q.a).length;

  // أسئلة من أكتر من 24 ساعة مش مجاوبة
  const oldUnanswered = uqs.filter(q => !q.a && q.createdAt && (Date.now() - new Date(q.createdAt).getTime()) > 24*3600000);

  // عروض هتنتهي خلال 3 أيام
  const in3 = new Date(Date.now() + 3*86400000).toISOString().slice(0,10);
  const expiring = offs.filter(o => o.expiryDate && o.expiryDate >= today && o.expiryDate <= in3);

  // أكونتات من 30 يوم مفيش عرض
  const in30ago = new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
  const noOffers = accs.filter(a => {
    if (a.status !== "نشط") return false;
    const accOffs = offs.filter(o => o.accountId === a.id && o.expiryDate >= today);
    const lastOff = offs.filter(o => o.accountId === a.id).sort((x,y) => (y.updatedAt||"").localeCompare(x.updatedAt||""))[0];
    return accOffs.length === 0 && (!lastOff || lastOff.updatedAt?.slice(0,10) <= in30ago);
  });

  // أسئلة متكررة
  const qMap = {};
  uqs.filter(q => !q.a).forEach(q => {
    const key = q.q?.trim().toLowerCase().slice(0,30);
    if (!key) return;
    if (!qMap[key]) qMap[key] = { q: q.q, accName: q.accName, count: 0 };
    qMap[key].count++;
  });
  const repeated = Object.values(qMap).filter(q => q.count >= 2);

  // Sync to sheets
  await syncToSheets(db);

  // Build report
  let msg = `🌆 <b>تقرير المساء — ${egyptNow}</b>\n\n`;
  msg += `❓ أسئلة النهارده: ${todayQs.length}\n`;
  msg += `✅ متجاوب: ${answered} | ⏳ في الانتظار: ${unanswered}\n`;

  if (oldUnanswered.length > 0) {
    msg += `\n🚨 <b>أسئلة من أكتر من 24 ساعة مش مجاوبة (${oldUnanswered.length}):</b>\n`;
    oldUnanswered.slice(0,3).forEach(q => {
      msg += `• "${q.q?.slice(0,40)}" — ${q.accName}\n`;
    });
  }

  if (expiring.length > 0) {
    msg += `\n⚠️ <b>عروض هتنتهي قريب:</b>\n`;
    expiring.forEach(o => {
      const acc = accs.find(a => a.id === o.accountId);
      const days = Math.ceil((new Date(o.expiryDate) - new Date()) / 86400000);
      msg += `• ${o.title} (${acc?.name||"?"}) — باقي ${days} يوم\n`;
    });
  }

  if (noOffers.length > 0) {
    msg += `\n📭 <b>أكونتات من 30 يوم مفيش عروض:</b>\n`;
    noOffers.slice(0,5).forEach(a => msg += `• ${a.name}\n`);
  }

  if (repeated.length > 0) {
    msg += `\n🔁 <b>أسئلة بتتكرر:</b>\n`;
    repeated.slice(0,3).forEach(q => msg += `• "${q.q?.slice(0,40)}" — ${q.count} مرة\n`);
    msg += `\n💡 ردّ عليهم وهيتحفظوا في البوت!`;
  }

  await sendTG(msg);
}

// ══ تقرير الفجر (1 ص) ══
async function dawnReport(db) {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  const [accsSnap, offsSnap, uqSnap] = await Promise.all([
    db.collection("accounts").get(),
    db.collection("offers").get(),
    db.collection("unanswered_questions").get()
  ]);

  const accs = accsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const offs = offsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const uqs = uqSnap.docs.map(d => d.data());

  // ملخص امبارح
  const yestQs = uqs.filter(q => q.createdAt?.slice(0,10) === yesterday);
  const yestAnswered = yestQs.filter(q => q.a).length;

  // أكتر أكونت بيتسأل عنه امبارح
  const accCount = {};
  yestQs.forEach(q => { accCount[q.accName] = (accCount[q.accName]||0) + 1; });
  const topAcc = Object.entries(accCount).sort((a,b) => b[1]-a[1])[0];

  // عروض بتنتهي النهارده
  const todayExpiring = offs.filter(o => o.expiryDate === today);

  let msg = `🌙 <b>تقرير الفجر</b>\n\n`;
  msg += `📅 <b>ملخص امبارح:</b>\n`;
  msg += `❓ أسئلة: ${yestQs.length} | ✅ متجاوب: ${yestAnswered}\n`;
  if (topAcc) msg += `🏆 أكتر أكونت: ${topAcc[0]} (${topAcc[1]} سؤال)\n`;

  if (todayExpiring.length > 0) {
    msg += `\n🔴 <b>عروض بتنتهي النهارده:</b>\n`;
    todayExpiring.forEach(o => {
      const acc = accs.find(a => a.id === o.accountId);
      msg += `• ${o.title} — ${acc?.name||"?"}\n`;
    });
  }

  // إجمالي الأسئلة الغير مجاوبة
  const totalUnanswered = uqs.filter(q => !q.a).length;
  if (totalUnanswered > 0) {
    msg += `\n⏳ إجمالي أسئلة في الانتظار: ${totalUnanswered}\n`;
  }

  msg += `\n☀️ صباح النور!`;

  await sendTG(msg);
}

module.exports = async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).send("Unauthorized");
  }
  try {
    const db = getDB();
    const type = req.query?.type || "evening";
    if (type === "dawn") {
      await dawnReport(db);
    } else {
      await eveningReport(db);
    }
    res.status(200).json({ ok: true, type });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};
