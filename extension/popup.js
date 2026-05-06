const $ = (id) => document.getElementById(id);
const api = typeof browser !== "undefined" ? browser : chrome;

const DEFAULTS = {
  server: "http://localhost:3001",
  quality: "best",
  tool: "auto",
};

async function getSettings() {
  const r = await api.storage.local.get(["server", "quality", "tool"]);
  return {
    server: (r.server || DEFAULTS.server).replace(/\/+$/, ""),
    quality: r.quality || DEFAULTS.quality,
    tool: r.tool || DEFAULTS.tool,
  };
}

async function getCurrentTabUrl() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.url || "";
}

function parseUrls(text) {
  return text
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
}

(async () => {
  const url = await getCurrentTabUrl();
  if (/^https?:\/\//i.test(url)) $("urls").value = url;
  const { quality, tool } = await getSettings();
  $("quality").value = quality;
  $("tool").value = tool;
  $("urls").focus();
  $("urls").select();
})();

$("quality").addEventListener("change", (e) => {
  api.storage.local.set({ quality: e.target.value });
});
$("tool").addEventListener("change", (e) => {
  api.storage.local.set({ tool: e.target.value });
});

async function grab() {
  const urls = parseUrls($("urls").value);
  if (!urls.length) {
    $("status").textContent = "Paste at least one http(s) URL";
    $("status").className = "muted err";
    return;
  }
  const { server } = await getSettings();
  const params = new URLSearchParams();
  for (const u of urls) params.append("url", u);
  await api.tabs.create({ url: `${server}/?${params.toString()}` });
  window.close();
}

$("grab").addEventListener("click", grab);

$("urls").addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    grab();
  }
});

$("settings").addEventListener("click", (e) => {
  e.preventDefault();
  api.runtime.openOptionsPage();
});
