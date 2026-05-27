// background.js
// Service worker - handles two things:
// 1. Fetching images from manga sites (they have CORS restrictions, so content script can't do it directly)
// 2. Calling Gemini Vision API to OCR + translate image text

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "FETCH_IMAGE") {
    fetchImage(msg.url).then(sendResponse);
    return true;
  }
  if (msg.type === "TRANSLATE_IMAGE") {
    callGemini(msg).then(sendResponse);
    return true;
  }
});

// Fetch image bytes and return as base64
// Can't do this from content.js because manga sites block cross-origin canvas reads
async function fetchImage(url) {
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const b64 = btoa(bytes.reduce((s, b) => s + String.fromCharCode(b), ""));
    return { ok: true, base64: b64, mimeType: blob.type || "image/jpeg" };
  } catch (err) {
    console.error("[MangaLens] fetch failed:", err.message);
    return { ok: false, error: err.message };
  }
}

async function callGemini({ base64, mimeType, targetLang, glossary, apiKey }) {
  // Build glossary hint if we have known terms from previous pages
  let glossaryHint = "";
  if (glossary && Object.keys(glossary).length > 0) {
    glossaryHint = `\nKeep these translations consistent (original → ${targetLang}):\n${JSON.stringify(glossary)}`;
  }

  const prompt = `You are translating manga/manhwa image text to ${targetLang}.

Find ALL visible text: speech bubbles, thought bubbles, captions, narration boxes, sound effects, signs.
${glossaryHint}

Return ONLY a JSON array. No explanation, no markdown fences. If no text found, return [].

Each item:
{
  "original": "text as it appears",
  "translated": "translated to ${targetLang}",
  "bbox": { "x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0 },
  "bgColor": "#ffffff",
  "isVertical": false,
  "type": "speech_bubble | thought_bubble | caption | sfx | sign | narration"
}

bbox values are 0.0–1.0 fractions of image width/height (top-left origin).
bgColor is your best guess at the background color behind the text.`;

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
      const msg = data?.error?.message || "Gemini API error";
      console.error("[MangaLens] Gemini error:", msg);
      return { ok: false, error: msg };
    }

    let raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    // strip markdown fences if gemini wraps in them anyway
    raw = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();

    const regions = JSON.parse(raw);
    return { ok: true, regions };

  } catch (err) {
    console.error("[MangaLens] callGemini failed:", err.message);
    return { ok: false, error: err.message };
  }
}
