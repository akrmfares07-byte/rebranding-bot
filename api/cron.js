// api/cron.js — Vercel cron job
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { credential } = require("firebase-admin");

const LOGO = "https://res.cloudinary.com/diepkkeyu/image/upload/v1773517119/404042723_763352762472137_4889753537613967821_n_p3hhjh.jpg";

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

async function sendToAll(db, title, body) {
  // 1. Save to Firestore notifications
  const id = "notif_" + Date.now();
  await db.collection("notifications").doc(id).set({
    id, title, body: body || "",
    createdAt: new Date().toISOString(),
    read: false
  });

  // 2. Send FCM push to all tokens
  const snap = await db.collection("fcm_tokens").get();
  const tokens = [];
  snap.forEach(doc => {
    const data = doc.data();
    if (data.token && typeof data.token === "string" && data.token.length > 20) {
      tokens.push(data.token);
    }
  });

  if (tokens.length === 0) return { sent: 0 };

  const messaging = getMessaging();
  let sent = 0;
  const deletePromises = [];

  for (let i = 0; i < tokens.length; i += 500) {
    const batch = tokens.slice(i, i + 500);
    const result = await messaging.sendEachForMulticast({
      tokens: batch,
      notification: { title, body: body || "" },
      android: { priority: "high" },
      apns: { payload: { aps: { sound: "default", badge: 1 } } },
      webpush: {
        headers: { Urgency: "high" },
        notification: { title, body: body || "", icon: LOGO }
      }
    });

    sent += result.successCount || 0;

    // Clean expired tokens
    if (result.responses) {
      result.responses.forEach((resp, idx) => {
        if (!resp.success && resp.error) {
          const code = resp.error.code;
          if (
            code === "messaging/registration-token-not-registered" ||
            code === "messaging/invalid-registration-token"
          ) {
            const badToken = batch[idx];
            snap.forEach(doc => {
              if (doc.data().token === badToken) {
                deletePromises.push(db.collection("fcm_tokens").doc(doc.id).delete());
              }
            });
          }
        }
      });
    }
  }

  if (deletePromises.length > 0) await Promise.allSettled(deletePromises);

  return { sent, tokens: tokens.length };
}

module.exports = async (req, res) => {
  const type = req.query.type;

  try {
    const db = getDB();

    if (type === "basma1") {
      // ⏰ 6 المغرب — تذكير البصمة الأولى
      const result = await sendToAll(db,
        "⏰ متنساش البصمة!",
        "الساعة 6 المغرب — سجّل حضورك دلوقتي 🕕"
      );
      return res.status(200).json({ ok: true, type, ...result });
    }

    if (type === "basma2") {
      // ⏰ 6:15 المغرب — تذكير ثاني
      const result = await sendToAll(db,
        "⚠️ أوعي تكون نسيت البصمة!",
        "الساعة 6:15 — لسه وقت تسجل حضورك 🔔"
      );
      return res.status(200).json({ ok: true, type, ...result });
    }

    if (type === "evening") {
      // إشعار المساء
      const result = await sendToAll(db,
        "🌙 مساء الخير",
        "تابع العروض والأكونتات الجديدة على Rebranding"
      );
      return res.status(200).json({ ok: true, type, ...result });
    }

    if (type === "dawn") {
      // إشعار الفجر
      const result = await sendToAll(db,
        "🌅 صباح الخير",
        "ابدأ يومك بمراجعة أكونتاتك على Rebranding"
      );
      return res.status(200).json({ ok: true, type, ...result });
    }

    return res.status(400).json({ error: "Unknown type: " + type });

  } catch (e) {
    console.error("cron error:", e.message);
    return res.status(500).json({ error: e.message });
  }
};
