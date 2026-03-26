export default async function handler(req, res) {
  try {
    const body = req.body || {};
    const message = body.message || "";

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.GROQ_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama3-8b-8192",
        messages: [
          {
            role: "system",
            content: "انت مساعد ذكي بيرد بشكل بسيط وواضح بالعربي."
          },
          {
            role: "user",
            content: message
          }
        ]
      })
    });

    const data = await response.json();

    const reply =
      data?.choices?.[0]?.message?.content ||
      "في مشكلة في الرد";

    return res.status(200).json({ reply });

  } catch (e) {
    return res.status(200).json({
      reply: "في مشكلة في الـ AI"
    });
  }
}
