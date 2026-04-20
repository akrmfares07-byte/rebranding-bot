export default function handler(req, res) {
  const { t, d, i, r } = req.query;

  // Fallbacks
  const title = (t && t !== "undefined") ? t : 'Rebranding | Luxury Marketing Agency';
  const description = (d && d !== "undefined") ? d : 'أقوى العروض والخصومات من شركاء Rebranding - تسوق الآن!';
  const image = (i && i !== "undefined") ? i : 'https://rebranding-orpin.vercel.app/logo.png'; 
  const targetUrl = r || 'https://rebranding-orpin.vercel.app';

  // Securely escape double quotes to avoid breaking HTML attributes
  const safeTitle = String(title).replace(/"/g, '&quot;');
  const safeDesc = String(description).replace(/"/g, '&quot;');
  const safeImg = String(image).replace(/"/g, '&quot;');

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <title>${safeTitle}</title>
  <meta name="description" content="${safeDesc}">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  
  <!-- Open Graph -->
  <meta property="og:title" content="${safeTitle}">
  <meta property="og:description" content="${safeDesc}">
  <meta property="og:image" content="${safeImg}">
  <meta property="og:url" content="${targetUrl}">
  <meta property="og:type" content="website">

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${safeTitle}">
  <meta name="twitter:description" content="${safeDesc}">
  <meta name="twitter:image" content="${safeImg}">

  <!-- Luxury Theme -->
  <meta name="theme-color" content="#d4a574">

  <script>
    // Redirect instantly to the target URL inside the SPA
    window.location.replace("${targetUrl}");
  </script>

  <style>
    body {
      background: #0a0a0a;
      color: #d4a574;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      font-family: system-ui, -apple-system, sans-serif;
      margin: 0;
      flex-direction: column;
      gap: 1rem;
    }
    .loader {
      width: 40px;
      height: 40px;
      border: 3px solid rgba(212, 165, 116, 0.2);
      border-top: 3px solid #d4a574;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="loader"></div>
  <p style="font-weight:600; letter-spacing:0.05em">جارٍ توجيهك بأمان للعرض...</p>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(html);
}
