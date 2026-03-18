// api/notify.js — Vercel endpoint for FCM push from frontend
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { credential } = require("firebase-admin");

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

const LOGO = "https://res.cloudinary.com/diepkkeyu/image/upload/v1773517119/404042723_763352762472137_4889753537613967821_n_p3hhjh.jpg";

// ✅ كل الدومينات المسموح بيها
const ALLOWED_ORIGINS = [
  "https://rebranding-orpin.vercel.app",
  "https://rebranding-bottt.vercel.app",
];

module.exports = async (req, res) => {
  // ✅ CORS مصلح — بيقبل كل دومينات المشروع
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    // fallback لأي دومين تاني (مثلاً لوكال ديف)
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { title, body, accId } = req.body || {};
    if (!title) return res.status(400).json({ error: "title required" });

    const db = getDB();

    // 1. Write to Firestore notifications (for in-app listeners)
    const id = "notif_" + Date.now();
    await db.collection("notifications").doc(id).set({
      id, title, body: body || "",
      accId: accId || null,
      createdAt: new Date().toISOString(),
      read: false
    });

    // 2. ✅ جيب التوكينات الصح فقط (اللي عندها حقل token فعلي)
    const snap = await db.collection("fcm_tokens").get();
    const tokens = [];
    snap.forEach(doc => {
      const data = doc.data();
      // ✅ تأكد إن التوكن موجود وليس فاضي
      if (data.token && typeof data.token === "string" && data.token.length > 20) {
        tokens.push(data.token);
      }
    });

    let sent = 0;
    let failed = 0;

    if (tokens.length > 0) {
      const messaging = getMessaging();
      for (let i = 0; i < tokens.length; i += 500) {
        const batch = tokens.slice(i, i + 500);
        const result = await messaging.sendEachForMulticast({
          tokens: batch,
          notification: { title, body: body || "" },
          data: accId ? { accId: String(accId) } : {},
          android: { priority: "high" },
          apns: { payload: { aps: { sound: "default", badge: 1 } } },
          webpush: {
            headers: { Urgency: "high" },
            notification: { title, body: body || "", icon: LOGO }
          }
        });

        sent += result.successCount || 0;
        failed += result.failureCount || 0;

        // ✅ احذف التوكينات المنتهية من Firestore تلقائياً
        if (result.responses) {
          const deletePromises = [];
          result.responses.forEach((resp, idx) => {
            if (!resp.success && resp.error) {
              const errCode = resp.error.code;
              // لو التوكن منتهي أو غير صالح — امسحه
              if (
                errCode === "messaging/registration-token-not-registered" ||
                errCode === "messaging/invalid-registration-token"
              ) {
                const badToken = batch[idx];
                // ابحث عن الـ doc اللي فيه التوكن ده وامسحه
                snap.forEach(doc => {
                  if (doc.data().token === badToken) {
                    deletePromises.push(db.collection("fcm_tokens").doc(doc.id).delete());
                  }
                });
              }
            }
          });
          if (deletePromises.length > 0) {
            await Promise.allSettled(deletePromises);
            console.log(`Cleaned up ${deletePromises.length} expired tokens`);
          }
        }
      }
    }

    return res.status(200).json({ ok: true, tokens: tokens.length, sent, failed });
  } catch (e) {
    console.error("notify error:", e.message);
    return res.status(500).json({ error: e.message });
  }
};
