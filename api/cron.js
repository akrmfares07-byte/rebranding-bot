import admin from 'firebase-admin';

const LOGO = 'https://res.cloudinary.com/diepkkeyu/image/upload/v1773517119/404042723_763352762472137_4889753537613967821_n_p3hhjh.jpg';

function getEgyptNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Cairo' }));
}

function getEgyptParts() {
  const now = getEgyptNow();
  return {
    hour: now.getHours(),
    minute: now.getMinutes(),
    dateKey: now.toISOString().slice(0, 10),
    iso: now.toISOString(),
  };
}

function hasFirebaseConfig() {
  return !!(process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY);
}

function getDb() {
  if (!hasFirebaseConfig()) return null;
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      }),
    });
  }
  return admin.firestore();
}

async function sendToAll(db, title, body) {
  const notifId = 'notif_' + Date.now();
  await db.collection('notifications').doc(notifId).set({
    id: notifId,
    title,
    body,
    createdAt: new Date().toISOString(),
    read: false,
  });

  const tokenSnap = await db.collection('fcm_tokens').get();
  const tokens = tokenSnap.docs.map(d => d.data()?.token).filter(t => typeof t === 'string' && t.length > 20);
  if (!tokens.length) return { sent: 0, tokens: 0 };

  const messaging = admin.messaging();
  let sent = 0;
  for (let i = 0; i < tokens.length; i += 500) {
    const batch = tokens.slice(i, i + 500);
    const result = await messaging.sendEachForMulticast({
      tokens: batch,
      notification: { title, body },
      android: { priority: 'high' },
      apns: { payload: { aps: { sound: 'default', badge: 1 } } },
      webpush: {
        headers: { Urgency: 'high' },
        notification: { title, body, icon: LOGO },
      },
    });
    sent += result.successCount || 0;
  }
  return { sent, tokens: tokens.length };
}

async function alreadyRan(db, key) {
  const ref = db.collection('cron_runs').doc(key);
  const snap = await ref.get();
  if (snap.exists) return true;
  await ref.set({ key, createdAt: new Date().toISOString() });
  return false;
}

export default async function handler(req, res) {
  try {
    const db = getDb();
    if (!db) return res.status(200).json({ ok: true, skipped: true, reason: 'Missing Firebase env' });

    const { hour, minute, dateKey, iso } = getEgyptParts();
    const slot = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    const result = { ok: true, egyptTime: iso, slot, fired: [] };

    const jobs = [
      {
        key: `basma1-${dateKey}`,
        match: hour === 18 && minute === 0,
        title: '⏰ متنساش البصمة!',
        body: 'الساعة 6:00 مساءً بتوقيت مصر — سجّل حضورك دلوقتي 🕕',
      },
      {
        key: `basma2-${dateKey}`,
        match: hour === 18 && minute === 15,
        title: '⚠️ أوعى تكون نسيت البصمة!',
        body: 'الساعة 6:15 مساءً بتوقيت مصر — لسه وقت تسجل حضورك 🔔',
      },
    ];

    for (const job of jobs) {
      if (!job.match) continue;
      if (await alreadyRan(db, job.key)) {
        result.fired.push({ key: job.key, skipped: 'already_ran' });
        continue;
      }
      const sendResult = await sendToAll(db, job.title, job.body);
      result.fired.push({ key: job.key, ...sendResult });
    }

    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
