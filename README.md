# MangaLens — Chrome Extension

**Developer:** Ayush Ranjan (CipherMoth)

A Chrome extension that translates text *inside* manga and manhwa images.

---

## Why I built this

Google Translate can translate a webpage, but it skips over images entirely. That's fine for most sites but completely useless for manga readers — the actual story is in the speech bubbles, which are part of the image.

I was reading some manhwa and kept having to screenshot panels and run them through separate OCR tools. That got old fast. So I built this.

The extension uses Gemini Vision to detect and translate text in manga images, then redraws the image with the translated text overlaid in place. You can toggle back to the original at any time.

---

## What it does

- Detects text in manga images automatically (speech bubbles, captions, sound effects, narration boxes)
- Translates to 18 languages using Gemini 1.5 Flash Vision
- Replaces the image text in-place on the canvas — the art stays, only the words change
- Builds a translation memory as you read, so character names and terms stay consistent across pages
- Hover over any image for a "Show Original" toggle
- Works with lazy-loaded images (infinite scroll readers like Webtoon)

---

## What it doesn't do (honestly)

- Doesn't handle images inside iframes (some embedded readers)
- Complex textured backgrounds don't fill perfectly — plain white speech bubbles work best
- Very stylized SFX (big bang effects etc.) are approximated
- Rate-limited to 15 images/minute on Gemini's free tier
- Needs an internet connection for every image

---

## Setup

**Step 1 — Get a Gemini API key (free)**

Go to [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) and create a key.
Free tier gives 15 requests/minute and 1500/day — enough for casual reading.

**Step 2 — Load the extension**

1. Open `chrome://extensions/`
2. Enable Developer Mode (top right)
3. Click "Load unpacked" → select this folder
4. The MangaLens icon should appear in your toolbar

**Step 3 — Configure**

Click the extension icon, paste your API key, pick your language, hit Save.

Done. Open a manga site and it should start translating automatically.

---

## Tested sites

- MangaDex
- Webtoon / LINE Webtoon  
- MangaPlus (Shonen Jump)
- Toomics
- Most sites with standard `<img>` manga pages

---

## How it works (technical)

Content script scans for `<img>` elements over 200px. For each one:

1. The image is fetched through the service worker — necessary because manga CDNs block cross-origin canvas reads
2. Sent to Gemini Vision with a prompt asking for bounding boxes, detected text, translations, and background color estimates
3. The original image is drawn to a canvas, text regions are filled with the estimated background color, translated text is overlaid
4. The canvas replaces the original `<img>` in the DOM

Translation memory is stored in `chrome.storage.local` and passed along with each Gemini call so character names stay consistent.

---

## Project structure

```
manga-translator/
├── manifest.json      # Manifest V3
├── background.js      # Service worker — image fetching + Gemini API
├── content.js         # Page scanning, canvas rendering, DOM replacement
├── popup.html         # Settings UI
├── popup.js           # Popup logic
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Troubleshooting

**Images aren't translating**
- Check DevTools → Console for errors (F12)
- Verify the API key is correct in the popup
- Make sure the extension is enabled for this page

**"quota exceeded" or rate limit errors**
- Free tier is 15 req/min — scroll slowly or wait a moment
- Consider upgrading the Gemini API plan for heavy reading sessions

**Text overflows or looks wrong**
- The font size auto-fits but very narrow bubbles with long text will clip
- Reload the page if something looks broken

---

## Privacy

- API key is stored locally in Chrome storage, never sent anywhere except Google's Gemini API
- Images are sent to Google for processing (same as using Google Lens manually)
- No data is collected by this extension

---

*Built for personal use, published in case it's useful to anyone else.*
