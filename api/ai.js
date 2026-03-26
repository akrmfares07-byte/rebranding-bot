export default async function handler(req, res) {
  try {
    if (!process.env.GROQ_KEY) {
      return res.status(200).json({
        reply: "GROQ_KEY missing"
      });
    }

    const body = req.body || {};
    const message = body.message || "قول hello";

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
            content: "رد باختصار بالعربي."
          },
          {
            role: "user",
            content: message
          }
        ]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(200).json({
        reply: "Groq request failed",
        details: data
      });
    }

    const reply = data?.choices?.[0]?.message?.content || "no reply";

    return res.status(200).json({ reply });
  } catch (e) {
    return res.status(200).json({
      reply: "AI crash",
      error: String(e?.message || e)
    });
  }
}
