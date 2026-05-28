// content.js
const MIN_SIZE     = 150;
const DONE_ATTR    = "data-ml-done";
const PENDING_ATTR = "data-ml-pending";

let cfg = { apiKey: "", targetLang: "English", enabled: false };
let observerStarted = false;

init();

async function init() {
  cfg = await loadSettings();
  console.log("[MangaLens] init — enabled:", cfg.enabled, "hasKey:", !!cfg.apiKey);
  if (!cfg.enabled || !cfg.apiKey) return;
  scanImages();
  watchForNewImages();
}

chrome.runtime.onMessage.addListener((m) => {
  if (m.type === "SETTINGS_UPDATED") {
    cfg = m.settings;
    if (cfg.enabled && cfg.apiKey) {
      scanImages();
      if (!observerStarted) watchForNewImages();
    }
  }
  if (m.type === "SCAN_NOW") {
    console.log("[MangaLens] manual scan triggered");
    scanImages();
  }
});

function scanImages() {
  const all = document.querySelectorAll(`img:not([${DONE_ATTR}]):not([${PENDING_ATTR}])`);
  console.log(`[MangaLens] scanning — found ${all.length} unprocessed img tags`);
  all.forEach(queueImage);
}

function queueImage(img) {
  const w = img.naturalWidth  || img.clientWidth  || parseInt(img.getAttribute("width")  || "0");
  const h = img.naturalHeight || img.clientHeight || parseInt(img.getAttribute("height") || "0");

  const src = img.currentSrc || img.src || img.getAttribute("data-src") || "";

  if (!src || src.startsWith("data:") || src === window.location.href) return;
  if (w < MIN_SIZE || h < MIN_SIZE) {
    return;
  }

  console.log(`[MangaLens] queuing ${w}x${h} — ${src.slice(0, 80)}`);
  img.setAttribute(PENDING_ATTR, "1");

  if (img.complete && img.naturalWidth > 0) {
    handleImage(img);
  } else {
    img.addEventListener("load", () => handleImage(img), { once: true });
    if (!img.src && img.dataset.src) img.src = img.dataset.src;
  }
}

async function handleImage(img) {
  const src = img.currentSrc || img.src;
  if (!src || src.startsWith("data:")) { markDone(img, "skip"); return; }

  console.log("[MangaLens] fetching:", src.slice(0, 80));

  const fetched = await msg({ type: "FETCH_IMAGE", url: src, pageUrl: window.location.href });

  if (!fetched?.ok) {
    console.error("[MangaLens] ❌ fetch failed:", fetched?.error, "url:", src.slice(0, 80));
    markDone(img, "fetch-err");
    return;
  }

  console.log("[MangaLens] ✅ fetched, size:", fetched.base64.length, "mime:", fetched.mimeType);

  const glossary = await loadGlossary();
  const result = await msg({
    type: "TRANSLATE_IMAGE",
    base64: fetched.base64,
    mimeType: fetched.mimeType,
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
  if (!result.regions?.length) return;

  saveToGlossary(result.regions, glossary);
  drawTranslated(img, result.regions);
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
  wrap.style.cssText = "position:relative; display:inline-block; line-height:0;";
  wrap.style.width   = computed.width;
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
  const observer = new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === "IMG") queueImage(node);
        node.querySelectorAll?.(`img:not([${DONE_ATTR}]):not([${PENDING_ATTR}])`).forEach(queueImage);
      }
      if (m.type === "attributes" && m.target.tagName === "IMG"
          && (m.attributeName === "src" || m.attributeName === "data-src")) {
        const t = m.target;
        if (!t.hasAttribute(DONE_ATTR) && !t.hasAttribute(PENDING_ATTR)) queueImage(t);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "data-src"] });
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
