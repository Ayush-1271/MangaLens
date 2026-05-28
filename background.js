// background.js
// Service worker - handles two things:
// 1. Fetching images from manga sites (CORS + Referer fix)
// 2. Calling Gemini Vision API to OCR + translate image text

// Try models in order - gemini-1.5-flash has confirmed free tier globally
const GEMINI_ENDPOINTS = [
  "https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent",
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent",
  "https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent",
];

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "FETCH_IMAGE") {
    fetchImage(msg.url, msg.pageUrl).then(sendResponse);
    return true;
  }
  if (msg.type === "TRANSLATE_IMAGE") {
    callGemini(msg).then(sendResponse);
    return true;
  }
});

async function fetchImage(url, pageUrl) {
  try {
    const headers = { "Referer": pageUrl || new URL(url).origin };
    let res = await fetch(url, { headers });
    if (!res.ok) res = await fetch(url);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

    const blob = await res.blob();
    if (blob.type && blob.type.includes("text")) return { ok: false, error: "Got HTML instead of image" };

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const b64 = btoa(bytes.reduce((s, b) => s + String.fromCharCode(b), ""));
    return { ok: true, base64: b64, mimeType: blob.type || guessMime(url) };
  } catch (err) {
    console.error("[MangaLens] fetch failed:", url, err.message);
    return { ok: false, error: err.message };
  }
}

function guessMime(url) {
  if (url.includes(".png"))  return "image/png";
  if (url.includes(".webp")) return "image/webp";
  if (url.includes(".gif"))  return "image/gif";
  return "image/jpeg";
}

async function callGemini({ base64, mimeType, targetLang, glossary, apiKey }) {
  let glossaryHint = "";
  if (glossary && Object.keys(glossary).length > 0) {
    const entries = Object.entries(glossary).slice(0, 30);
    glossaryHint = `\nKeep these translations consistent:\n${JSON.stringify(Object.fromEntries(entries))}`;
  }

  const prompt = `You are translating manga/manhwa image text to ${targetLang}.

Find ALL visible text: speech bubbles, thought bubbles, captions, narration boxes, sound effects, signs.
${glossaryHint}

Return ONLY a valid JSON array. No explanation, no markdown fences. If no text found, return [].

Each item:
{
  "original": "text as it appears",
  "translated": "text translated to ${targetLang}",
  "bbox": { "x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0 },
  "bgColor": "#ffffff",
  "isVertical": false,
  "type": "speech_bubble"
}

bbox values are 0.0 to 1.0 fractions of image dimensions.`;

  let lastError = "No model worked";

  for (const endpoint of GEMINI_ENDPOINTS) {
    try {
      const res = await fetch(`${endpoint}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inlineData: { mimeType, data: base64 } }
            ]
          }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
        })
      });

      const data = await res.json();

      if (!res.ok) {
        const errMsg = data?.error?.message || "API error";
        console.warn("[MangaLens] model failed:", endpoint.split("/models/")[1], "-", errMsg.slice(0, 80));
        lastError = errMsg;
        // if quota error, try next model; if auth error, stop
        if (errMsg.includes("API_KEY") || errMsg.includes("invalid")) break;
        continue;
      }

      // success!
      let raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
      raw = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
      const regions = JSON.parse(raw);
      console.log("[MangaLens] ✅ translated using", endpoint.split("/models/")[1].split(":")[0]);
      return { ok: true, regions };

    } catch (err) {
      console.warn("[MangaLens] endpoint error:", err.message);
      lastError = err.message;
    }
  }

  console.error("[MangaLens] all models failed. Last error:", lastError);
  return { ok: false, error: lastError };
}
