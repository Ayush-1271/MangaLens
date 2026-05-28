// background.js
// gemini-2.5-flash is the current free tier model (2.0 and 1.5 are retired)

const GEMINI_ENDPOINTS = [
  "https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent",
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent",
];

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "FETCH_IMAGE") { fetchImage(msg.url, msg.pageUrl).then(sendResponse); return true; }
  if (msg.type === "TRANSLATE_IMAGE") { callGemini(msg).then(sendResponse); return true; }
});

async function fetchImage(url, pageUrl) {
  try {
    const headers = { "Referer": pageUrl || new URL(url).origin };
    let res = await fetch(url, { headers });
    if (!res.ok) res = await fetch(url);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const blob = await res.blob();
    if (blob.type && blob.type.includes("text")) return { ok: false, error: "Got HTML" };
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const b64 = btoa(bytes.reduce((s, b) => s + String.fromCharCode(b), ""));
    return { ok: true, base64: b64, mimeType: blob.type || guessMime(url) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function guessMime(url) {
  if (url.includes(".png")) return "image/png";
  if (url.includes(".webp")) return "image/webp";
  return "image/jpeg";
}

async function callGemini({ base64, mimeType, targetLang, glossary, apiKey }) {
  const glossaryHint = (glossary && Object.keys(glossary).length)
    ? `\nKeep these translations consistent:\n${JSON.stringify(Object.fromEntries(Object.entries(glossary).slice(0,30)))}`
    : "";

  const prompt = `Translate all text in this manga/manhwa image to ${targetLang}.${glossaryHint}

Find: speech bubbles, thought bubbles, captions, narration boxes, sound effects, signs.

Return ONLY a JSON array, no explanation, no markdown. Empty array [] if no text found.

Each item: {"original":"...","translated":"...","bbox":{"x":0.0,"y":0.0,"w":0.0,"h":0.0},"bgColor":"#ffffff","type":"speech_bubble"}

bbox is 0.0-1.0 fraction of image size.`;

  let lastError = "All models failed";

  for (const endpoint of GEMINI_ENDPOINTS) {
    try {
      const res = await fetch(`${endpoint}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType, data: base64 } }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
        })
      });

      const data = await res.json();

      if (!res.ok) {
        lastError = data?.error?.message || "API error";
        const modelName = endpoint.split("/models/")[1].split(":")[0];
        console.warn(`[MangaLens] ${modelName} failed:`, lastError.slice(0, 100));
        if (lastError.includes("API_KEY") || lastError.includes("invalid key")) break;
        continue; // try next model
      }

      let raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
      raw = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
      const regions = JSON.parse(raw);
      const modelName = endpoint.split("/models/")[1].split(":")[0];
      console.log(`[MangaLens] ✅ success with ${modelName}, regions: ${regions.length}`);
      return { ok: true, regions };

    } catch (err) {
      lastError = err.message;
      console.warn("[MangaLens] endpoint error:", err.message);
    }
  }

  console.error("[MangaLens] ❌ all models failed:", lastError);
  return { ok: false, error: lastError };
}
