// content.js
// Runs on every page. Finds manga images, translates the text inside them,
// and replaces them with canvas elements showing the translated version.

// skip images smaller than this (icons, avatars, buttons, etc.)
const MIN_SIZE = 200;

const DONE_ATTR    = "data-ml-done";
const PENDING_ATTR = "data-ml-pending";

let cfg = { apiKey: "", targetLang: "English", enabled: false };

init();

async function init() {
  cfg = await loadSettings();
  if (!cfg.enabled || !cfg.apiKey) return;

  scanImages();
  watchForNewImages();
}

// popup can toggle the extension without reloading the page
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "SETTINGS_UPDATED") {
    cfg = msg.settings;
    if (cfg.enabled && cfg.apiKey) {
      scanImages();
      watchForNewImages();
    }
  }
});

function scanImages() {
  document.querySelectorAll(`img:not([${DONE_ATTR}]):not([${PENDING_ATTR}])`).forEach(queueImage);
}

function queueImage(img) {
  const w = img.naturalWidth  || img.width  || parseInt(img.getAttribute("width")  || "0");
  const h = img.naturalHeight || img.height || parseInt(img.getAttribute("height") || "0");
  if (w < MIN_SIZE || h < MIN_SIZE) return;

  img.setAttribute(PENDING_ATTR, "1");

  if (img.complete) {
    handleImage(img);
  } else {
    img.addEventListener("load", () => handleImage(img), { once: true });
  }
}

async function handleImage(img) {
  const src = img.currentSrc || img.src;
  if (!src || src.startsWith("data:")) {
    img.setAttribute(DONE_ATTR, "skip");
    img.removeAttribute(PENDING_ATTR);
    return;
  }

  // fetch the image through the service worker (bypasses CORS)
  const fetched = await msg({ type: "FETCH_IMAGE", url: src });
  if (!fetched?.ok) {
    img.setAttribute(DONE_ATTR, "fetch-err");
    img.removeAttribute(PENDING_ATTR);
    return;
  }

  const glossary = await loadGlossary();

  const result = await msg({
    type:       "TRANSLATE_IMAGE",
    base64:     fetched.base64,
    mimeType:   fetched.mimeType,
    targetLang: cfg.targetLang,
    glossary,
    apiKey:     cfg.apiKey
  });

  img.setAttribute(DONE_ATTR, "1");
  img.removeAttribute(PENDING_ATTR);

  if (!result?.ok || !result.regions?.length) return;

  // save newly discovered terms for consistency on future pages
  saveToGlossary(result.regions, glossary);

  drawTranslated(img, result.regions);
}

function drawTranslated(img, regions) {
  const W = img.naturalWidth;
  const H = img.naturalHeight;

  const canvas   = document.createElement("canvas");
  canvas.width   = W;
  canvas.height  = H;
  canvas.style.cssText = img.style.cssText;
  canvas.className     = img.className;
  canvas.style.maxWidth  = "100%";
  canvas.style.display   = "block";

  const ctx = canvas.getContext("2d");

  const render = () => {
    ctx.drawImage(img, 0, 0, W, H);

    for (const region of regions) {
      const x = Math.floor(region.bbox.x * W);
      const y = Math.floor(region.bbox.y * H);
      const w = Math.ceil(region.bbox.w  * W);
      const h = Math.ceil(region.bbox.h  * H);

      // clear original text
      const bg = region.bgColor || "#ffffff";
      if (bg !== "transparent") {
        ctx.save();
        ctx.fillStyle = bg;
        bubbleRect(ctx, x, y, w, h, 5);
        ctx.fill();
        ctx.restore();
      }

      // draw translated text
      placeText(ctx, region.translated, x, y, w, h, region.type);
    }
  };

  if (img.complete && img.naturalWidth > 0) {
    render();
  } else {
    // shouldn't happen often but just in case
    const tmp = new Image();
    tmp.crossOrigin = "anonymous";
    tmp.onload = render;
    tmp.src = src;
  }

  // wrap in a div so we can position the toggle button
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:relative; display:inline-block;";
  img.parentNode.insertBefore(wrap, img);
  wrap.appendChild(canvas);

  img.style.display = "none";
  wrap.appendChild(img); // keep it in DOM for toggle

  addToggle(wrap, canvas, img);
}

function placeText(ctx, text, x, y, w, h, type) {
  ctx.save();

  const pad = Math.max(4, Math.floor(w * 0.06));
  const isSFX = type === "sfx";
  const font  = isSFX ? "'Impact', sans-serif" : "'Arial', sans-serif";

  let fontSize = Math.min(h * 0.85, w * 0.9);
  const minSize = 8;

  // shrink font until text fits
  let lines = [];
  while (fontSize > minSize) {
    ctx.font = `bold ${fontSize}px ${font}`;
    lines = wrapLines(ctx, text, w - pad * 2);
    if (lines.length * fontSize * 1.25 <= h - pad * 2) break;
    fontSize -= 1;
  }

  ctx.font = `bold ${fontSize}px ${font}`;
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle    = "#111111";
  ctx.shadowColor  = "rgba(255,255,255,0.85)";
  ctx.shadowBlur   = 3;

  const lineH  = fontSize * 1.25;
  const totalH = lines.length * lineH;
  const startY = y + (h - totalH) / 2 + lineH / 2;
  const midX   = x + w / 2;

  lines.forEach((line, i) => {
    ctx.fillText(line, midX, startY + i * lineH);
  });

  ctx.restore();
}

function wrapLines(ctx, text, maxW) {
  const words = text.split(" ");
  const lines = [];
  let cur = "";

  for (const word of words) {
    const test = cur ? `${cur} ${word}` : word;
    if (ctx.measureText(test).width > maxW && cur) {
      lines.push(cur);
      cur = word;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function bubbleRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y,     x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h,     x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y,         x + r, y);
  ctx.closePath();
}

// little "show original" button on hover
function addToggle(wrap, canvas, img) {
  let showingOriginal = false;

  const btn = document.createElement("button");
  btn.textContent = "👁 Original";
  btn.style.cssText = `
    position:absolute; top:6px; right:6px;
    background:rgba(0,0,0,0.6); color:#fff; border:none;
    padding:3px 8px; border-radius:4px; cursor:pointer;
    font-size:11px; font-family:sans-serif;
    opacity:0; transition:opacity 0.15s; pointer-events:auto;
  `;
  wrap.appendChild(btn);

  wrap.addEventListener("mouseenter", () => { btn.style.opacity = "1"; });
  wrap.addEventListener("mouseleave", () => { btn.style.opacity = "0"; });

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    showingOriginal = !showingOriginal;
    canvas.style.display = showingOriginal ? "none"  : "block";
    img.style.display    = showingOriginal ? "block" : "none";
    btn.textContent      = showingOriginal ? "✨ Translated" : "👁 Original";
  });
}

// watch for images that load after the initial page render (lazy-loaded readers)
function watchForNewImages() {
  const observer = new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.tagName === "IMG") queueImage(node);
        if (node.querySelectorAll) {
          node.querySelectorAll(`img:not([${DONE_ATTR}]):not([${PENDING_ATTR}])`).forEach(queueImage);
        }
      }
      // handle lazy loaders that swap the src attribute
      if (m.type === "attributes" && m.target.tagName === "IMG" && m.attributeName === "src") {
        const target = m.target;
        if (!target.hasAttribute(DONE_ATTR) && !target.hasAttribute(PENDING_ATTR)) {
          queueImage(target);
        }
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src"]
  });
}

// storage helpers
function loadSettings() {
  return new Promise(res => {
    chrome.storage.sync.get(["apiKey", "targetLang", "enabled"], d => {
      res({ apiKey: d.apiKey || "", targetLang: d.targetLang || "English", enabled: d.enabled !== false });
    });
  });
}

function loadGlossary() {
  return new Promise(res => chrome.storage.local.get("glossary", d => res(d.glossary || {})));
}

function saveToGlossary(regions, existing) {
  const updated = { ...existing };
  for (const r of regions) {
    if (r.original && r.translated && !updated[r.original]) {
      updated[r.original] = r.translated;
    }
  }
  chrome.storage.local.set({ glossary: updated });
}

function msg(payload) {
  return new Promise(res => chrome.runtime.sendMessage(payload, res));
}
