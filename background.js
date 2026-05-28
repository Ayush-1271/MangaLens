// background.js
// Service worker - handles two things:
// 1. Fetching images from manga sites (CORS + Referer fix)
// 2. Calling Gemini Vision API to OCR + translate image text

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent";

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

// Fetch image bytes and return as base64
// Must go through service worker because:
// 1. Manga CDNs block cross-origin canvas reads
// 2. Sites like MangaDex require a Referer header matching their domain
async function fetchImage(url, pageUrl) {
  try {
    // Build headers — some CDNs (MangaDex, MangaPlus) reject requests without Referer
    const headers = { "Referer": pageUrl || new URL(url).origin };

    let res = await fetch(url, { headers });

    // Some CDNs don't like the Referer — retry without it
    if (!res.ok) {
      res = await fetch(url);
    }

    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }

    const blob = await res.blob();

    // Sanity check — if we got HTML instead of an image something went wrong
    if (blob.type && blob.type.includes("text")) {
      return { ok: false, error: "Got HTML instead of image" };
    }

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const b64 = btoa(bytes.reduce((s, b) => s + String.fromCharCode(b), ""));
    const mimeType = blob.type || guessMime(url);

    return { ok: true, base64: b64, mimeType };
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
    const entries = Object.entries(glossary).slice(0, 30); // cap to avoid huge prompts
    glossaryHint = `\nKeep these translations consistent:\n${JSON.stringify(Object.fromEntries(entries))}`;
  }

  const prompt = `You are translating manga/manhwa image text to ${targetLang}.

Find ALL visible text: speech bubbles, thought bubbles, captions, narration boxes, sound effects, signs, labels.
${glossaryHint}

Return ONLY a valid JSON array. No explanation, no markdown fences. If no text found, return [].

Each item must follow this exact schema:
{
  "original": "text as it appears in the image",
  "translated": "text translated to ${targetLang}",
  "bbox": {
    "x": 0.0,
    "y": 0.0,
    "w": 0.0,
    "h": 0.0
  },
  "bgColor": "#ffffff",
  "isVertical": false,
  "type": "speech_bubble"
}

bbox values are 0.0 to 1.0 fractions of the image dimensions (top-left origin).
bgColor is your best guess at the background color behind the text.
type is one of: speech_bubble, thought_bubble, caption, sfx, sign, narration`;

  try {
    const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inlineData: { mimeType, data: base64 } }
          ]
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 4096
        }
      })
    });

    const data = await res.json();

    if (!res.ok) {
      const errMsg = data?.error?.message || "Gemini API error";
      console.error("[MangaLens] Gemini error:", errMsg);
      return { ok: false, error: errMsg };
    }

    let raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    // strip markdown fences if Gemini wraps in them
    raw = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();

    const regions = JSON.parse(raw);
    return { ok: true, regions };

  } catch (err) {
    console.error("[MangaLens] callGemini failed:", err.message);
    return { ok: false, error: err.message };
  }
}
