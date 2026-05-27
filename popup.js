const $ = id => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
  const s = await get(["apiKey", "targetLang", "enabled"]);
  $("apiKey").value        = s.apiKey     || "";
  $("lang").value          = s.targetLang || "English";
  $("chkEnabled").checked  = s.enabled    !== false;

  setStatus(s.apiKey);
  renderGlossary();
});

$("btnSave").addEventListener("click", async () => {
  const key  = $("apiKey").value.trim();
  const lang = $("lang").value;
  const on   = $("chkEnabled").checked;

  if (!key) { setStatus(""); return; }

  setStatus("saving");
  await chrome.storage.sync.set({ apiKey: key, targetLang: lang, enabled: on });
  notify({ type: "SETTINGS_UPDATED", settings: { apiKey: key, targetLang: lang, enabled: on } });
  setStatus(key);
});

$("chkEnabled").addEventListener("change", async () => {
  const on  = $("chkEnabled").checked;
  const key = $("apiKey").value.trim();
  await chrome.storage.sync.set({ enabled: on });
  if (key) notify({ type: "SETTINGS_UPDATED", settings: { apiKey: key, targetLang: $("lang").value, enabled: on } });
});

$("btnClear").addEventListener("click", async () => {
  if (!confirm("Clear translation memory?")) return;
  await chrome.storage.local.set({ glossary: {} });
  renderGlossary();
});

async function renderGlossary() {
  const { glossary } = await new Promise(r => chrome.storage.local.get("glossary", r));
  const list = $("glist");

  if (!glossary || !Object.keys(glossary).length) {
    list.innerHTML = '<span class="gempty">Builds as you read — keeps names consistent</span>';
    return;
  }

  const entries = Object.entries(glossary).slice(-25);
  list.innerHTML = entries.map(([o, t]) => `
    <div class="gitem">
      <span class="go" title="${esc(o)}">${esc(o)}</span>
      <span class="arr">→</span>
      <span class="gt" title="${esc(t)}">${esc(t)}</span>
    </div>
  `).join("");
}

function setStatus(key) {
  const dot = $("dot");
  const txt = $("statusMsg");

  if (key === "saving") {
    dot.className = "dot busy";
    txt.textContent = "Saving...";
    return;
  }
  if (!key) {
    dot.className = "dot err";
    txt.textContent = "API key required";
    return;
  }
  dot.className = "dot ok";
  txt.textContent = "Ready";
}

function get(keys) {
  return new Promise(r => chrome.storage.sync.get(keys, r));
}

async function notify(payload) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, payload).catch(() => {});
}

function esc(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
