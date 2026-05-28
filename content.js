// content.js
const MIN_SIZE     = 300;   // only process real manga pages, not UI thumbnails
const DONE_ATTR    = "data-ml-done";
const PENDING_ATTR = "data-ml-pending";
const MAX_SEND_PX  = 800;   // downscale to this width before sending — saves ~70% tokens
const CACHE_PREFIX = "mlcache:";
const MAX_QUEUE    = 3;     // max concurrent API calls at once

let cfg = { apiKey: "", targetLang: "English", enabled: false };
let observerStarted = false;
let queue = [];
let running = 0;

init();

async function init() {
  cfg = await loadSettings();
  if (!cfg.enabled || !cfg.apiKey) return;
  watchForVisibleImages(); // only translate what user actually sees
  watchForNewImages();
}

chrome.runtime.onMessage.addListener((m) => {
  if (m.type === "SETTINGS_UPDATED") {
    cfg = m.settings;
    if (cfg.enabled && cfg.apiKey) {
      watchForVisibleImages();
      if (!observerStarted) watchForNewImages();
    }
  }
});

// ── Only process images that enter the viewport ──────────────
function watchForVisibleImages() {
  const io = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const img = entry.target;
        if (!img.hasAttribute(DONE_ATTR) && !img.hasAttribute(PENDING_ATTR)) {
          queueImage(img);
        }
        io.unobserve(img); // stop watching once queued
      }
    }
  }, { rootMargin: "200px" }); // start 200px before visible

  // observe all existing large images
  document.querySelectorAll(`img:not([${DONE_ATTR}]):not([${PENDING_ATTR}])`).forEach(img => {
    const w = img.naturalWidth  || img.clientWidth  || 0;
    const h = img.naturalHeight || img.clientHeight || 0;
    if (w >= MIN_SIZE && h >= MIN_SIZE) io.observe(img);
  });

  window._mangaLensIO = io; // save for watchForNewImages to reuse
}

function queueImage(img) {
  const src = img.currentSrc || img.src || img.getAttribute("data-src") || "";
  const w   = img.naturalWidth  || img.clientWidth  || 0;
  const h   = img.naturalHeight || img.clientHeight || 0;

  if (!src || src.startsWith("data:") || src === window.location.href) return;
  if (src.endsWith(".svg") || src.includes(".svg?") || src.includes("svg+xml")) return;
  if (w < MIN_SIZE || h < MIN_SIZE) return;

  img.setAttribute(PENDING_ATTR, "1");

  const process = () => {
    if (img.complete && img.naturalWidth > 0) {
      enqueue(img);
    } else {
      img.addEventListener("load", () => enqueue(img), { once: true });
    }
  };
  process();
}

// ── Concurrency-limited queue ─────────────────────────────────
function enqueue(img) {
  queue.push(img);
  drain();
}

function drain() {
  while (running < MAX_QUEUE && queue.length > 0) {
    const img = queue.shift();
    running++;
    handleImage(img).finally(() => { running--; drain(); });
  }
}

async function handleImage(img) {
  const src = img.currentSrc || img.src;
  if (!src || src.startsWith("data:")) { markDone(img, "skip"); return; }

  // ── Check cache first ────────────────────────────────────────
  const cacheKey = await getCacheKey(img, src);
  const cached   = await getCache(cacheKey);
  if (cached) {
    console.log("[MangaLens] cache hit:", cacheKey.slice(0, 40));
    markDone(img, "cached");
    if (cached.regions?.length) drawTranslated(img, cached.regions);
    return;
  }

  // ── Fetch + downscale ────────────────────────────────────────
  const fetched = await msg({ type: "FETCH_IMAGE", url: src, pageUrl: window.location.href });
  if (!fetched?.ok) { markDone(img, "fetch-err"); return; }

  // Downscale on canvas before sending — massive token savings
  const { base64, mimeType } = await downscale(img, fetched.base64, fetched.mimeType);
  console.log(`[MangaLens] sending ${(base64.length * 0.75 / 1024).toFixed(0)}KB (downscaled from ${(fetched.base64.length * 0.75 / 1024).toFixed(0)}KB)`);

  const glossary = await loadGlossary();
  const result = await msg({
    type: "TRANSLATE_IMAGE",
    base64, mimeType,
    targetLang: cfg.targetLang,
    glossary,
    apiKey: cfg.apiKey
  });

  markDone(img, "1");

  if (!result?.ok) {
    console.error("[MangaLens] ❌ Gemini failed:", result?.error);
    return;
  }

  console.log("[MangaLens] ✅ translated, regions:", result.regions?.length);
  if (!result.regions?.length) { await saveCache(cacheKey, { regions: [] }); return; }

  saveToGlossary(result.regions, glossary);
  await saveCache(cacheKey, { regions: result.regions });
  drawTranslated(img, result.regions);
}

// ── Downscale image to MAX_SEND_PX wide using canvas ─────────
function downscale(img, base64, mimeType) {
  return new Promise(resolve => {
    const W = img.naturalWidth;
    const H = img.naturalHeight;

    // if already small enough, send as-is
    if (W <= MAX_SEND_PX) { resolve({ base64, mimeType }); return; }

    const scale  = MAX_SEND_PX / W;
    const newW   = MAX_SEND_PX;
    const newH   = Math.round(H * scale);

    const canvas  = document.createElement("canvas");
    canvas.width  = newW;
    canvas.height = newH;
    const ctx = canvas.getContext("2d");

    const tmp = new Image();
    tmp.onload = () => {
      ctx.drawImage(tmp, 0, 0, newW, newH);
      // JPEG at 0.75 quality — enough for text, much smaller than PNG
      const dataUrl  = canvas.toDataURL("image/jpeg", 0.75);
      const newBase64 = dataUrl.split(",")[1];
      resolve({ base64: newBase64, mimeType: "image/jpeg" });
    };
    tmp.onerror = () => resolve({ base64, mimeType }); // fallback to original
    tmp.src = `data:${mimeType};base64,${base64}`;
  });
}

// ── Cache helpers ─────────────────────────────────────────────
async function getCacheKey(img, src) {
  // For blob URLs (MangaDex), use chapter URL + img index as key
  if (src.startsWith("blob:")) {
    const imgs   = Array.from(document.querySelectorAll("img"));
    const index  = imgs.indexOf(img);
    const chapter = window.location.pathname.replace(/\//g, "-");
    return CACHE_PREFIX + chapter + "-" + index;
  }
  // For regular URLs, use the URL itself
  return CACHE_PREFIX + src.replace(/[^a-z0-9]/gi, "").slice(-80);
}

async function getCache(key) {
  return new Promise(res => chrome.storage.local.get(key, d => res(d[key] || null)));
}

async function saveCache(key, value) {
  return new Promise(res => chrome.storage.local.set({ [key]: value }, res));
}

function markDone(img, val) {
  img.setAttribute(DONE_ATTR, val);
  img.removeAttribute(PENDING_ATTR);
}

// ── Canvas rendering ─────────────────────────────────────────

function drawTranslated(img, regions) {
  const W = img.naturalWidth;
  const H = img.naturalHeight;

  const canvas  = document.createElement("canvas");
  canvas.width  = W;
  canvas.height = H;

  const computed = window.getComputedStyle(img);
  canvas.style.cssText  = img.style.cssText;
  canvas.style.width    = computed.width;
  canvas.style.height   = computed.height;
  canvas.style.maxWidth = "100%";
  canvas.style.display  = "block";
  canvas.className      = img.className;

  const ctx = canvas.getContext("2d");

  const render = () => {
    ctx.drawImage(img, 0, 0, W, H);
    for (const region of regions) {
      const x = Math.floor(region.bbox.x * W);
      const y = Math.floor(region.bbox.y * H);
      const w = Math.ceil(region.bbox.w  * W);
      const h = Math.ceil(region.bbox.h  * H);
      if (w < 4 || h < 4) continue;

      const bg = region.bgColor || "#ffffff";
      if (bg !== "transparent") {
        ctx.save();
        ctx.fillStyle = bg;
        bubbleRect(ctx, x, y, w, h, 5);
        ctx.fill();
        ctx.restore();
      }
      placeText(ctx, region.translated, x, y, w, h, region.type);
    }
  };

  if (img.complete && img.naturalWidth > 0) render();
  else { const t = new Image(); t.crossOrigin = "anonymous"; t.onload = render; t.src = img.currentSrc || img.src; }

  const wrap = document.createElement("div");
  wrap.style.cssText  = "position:relative; display:inline-block; line-height:0;";
  wrap.style.width    = computed.width;
  wrap.style.maxWidth = "100%";

  img.parentNode.insertBefore(wrap, img);
  wrap.appendChild(canvas);
  img.style.display = "none";
  wrap.appendChild(img);
  addToggle(wrap, canvas, img);
}

function placeText(ctx, text, x, y, w, h, type) {
  if (!text) return;
  ctx.save();
  const pad   = Math.max(3, Math.floor(Math.min(w, h) * 0.06));
  const isSFX = type === "sfx";
  const font  = isSFX ? "'Impact', 'Arial Black', sans-serif" : "'Arial', sans-serif";
  let fontSize = Math.min(h * 0.85, w * 0.9, 32);
  const minSize = 7;
  let lines = [];
  while (fontSize >= minSize) {
    ctx.font = `bold ${fontSize}px ${font}`;
    lines = wrapLines(ctx, text, w - pad * 2);
    if (lines.length * fontSize * 1.3 <= h - pad * 2) break;
    fontSize -= 1;
  }
  ctx.font         = `bold ${fontSize}px ${font}`;
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  ctx.strokeStyle  = "rgba(255,255,255,0.95)";
  ctx.lineWidth    = 3;
  ctx.fillStyle    = isSFX ? "#7c2d00" : "#111111";
  const lineH  = fontSize * 1.3;
  const totalH = lines.length * lineH;
  const startY = y + (h - totalH) / 2 + lineH / 2;
  const midX   = x + w / 2;
  for (let i = 0; i < lines.length; i++) {
    ctx.strokeText(lines[i], midX, startY + i * lineH);
    ctx.fillText(lines[i], midX, startY + i * lineH);
  }
  ctx.restore();
}

function wrapLines(ctx, text, maxW) {
  const words = text.split(" ");
  const lines = [];
  let cur = "";
  for (const word of words) {
    const test = cur ? `${cur} ${word}` : word;
    if (ctx.measureText(test).width > maxW && cur) { lines.push(cur); cur = word; }
    else cur = test;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [text];
}

function bubbleRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y,     x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h,     x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y,         x + r, y);
  ctx.closePath();
}

function addToggle(wrap, canvas, img) {
  let orig = false;
  const btn = document.createElement("button");
  btn.textContent = "👁 Original";
  btn.style.cssText = `position:absolute;top:6px;right:6px;background:rgba(0,0,0,0.65);color:#fff;
    border:none;border-radius:4px;padding:3px 9px;cursor:pointer;font-size:11px;
    font-family:sans-serif;opacity:0;transition:opacity 0.15s;z-index:9999;line-height:1.5;`;
  wrap.appendChild(btn);
  wrap.addEventListener("mouseenter", () => btn.style.opacity = "1");
  wrap.addEventListener("mouseleave", () => btn.style.opacity = "0");
  btn.addEventListener("click", e => {
    e.stopPropagation();
    orig = !orig;
    canvas.style.display = orig ? "none" : "block";
    img.style.display    = orig ? "block" : "none";
    btn.textContent      = orig ? "✨ Translated" : "👁 Original";
  });
}

function watchForNewImages() {
  observerStarted = true;
  const io = window._mangaLensIO;
  const observer = new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        const imgs = node.tagName === "IMG" ? [node] : [...(node.querySelectorAll?.("img") || [])];
        for (const img of imgs) {
          const w = img.naturalWidth  || img.clientWidth  || 0;
          const h = img.naturalHeight || img.clientHeight || 0;
          if (w >= MIN_SIZE && h >= MIN_SIZE && !img.hasAttribute(DONE_ATTR) && !img.hasAttribute(PENDING_ATTR)) {
            io ? io.observe(img) : queueImage(img);
          }
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function loadSettings() {
  return new Promise(res => chrome.storage.sync.get(["apiKey", "targetLang", "enabled"], d => {
    res({ apiKey: d.apiKey || "", targetLang: d.targetLang || "English", enabled: d.enabled !== false });
  }));
}
function loadGlossary() {
  return new Promise(res => chrome.storage.local.get("glossary", d => res(d.glossary || {})));
}
function saveToGlossary(regions, existing) {
  const u = { ...existing };
  for (const r of regions) { if (r.original && r.translated && !u[r.original]) u[r.original] = r.translated; }
  chrome.storage.local.set({ glossary: u });
}
function msg(payload) {
  return new Promise(res => chrome.runtime.sendMessage(payload, res));
}
