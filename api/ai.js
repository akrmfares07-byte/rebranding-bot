export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      message: "AI route is working"
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const { message } = req.body || {};

  if (!message) {
    return res.status(400).json({ ok: false, error: "message is required" });
  }

  const text = String(message).toLowerCase();

  let action = "unknown";
  let reply = "مش واضح 100%، جرّب تكتب الطلب بشكل أوضح.";

  if (text.includes("احصائيات") || text.includes("stats")) {
    action = "stats";
    reply = "هنا المفروض نرجّع الإحصائيات من Firebase.";
  } else if (text.includes("ضيف يوزر") || text.includes("add user")) {
    action = "add_user";
    reply = "هنا المفروض ننشئ يوزر جديد.";
  } else if (text.includes("ضيف عرض") || text.includes("create offer")) {
    action = "create_offer";
    reply = "هنا المفروض ننشئ عرض جديد.";
  } else if (text.includes("ابعت اشعار") || text.includes("send notification")) {
    action = "send_notification";
    reply = "هنا المفروض نبعت إشعار.";
  }

  return res.status(200).json({
    ok: true,
    action,
    reply
  });
}
