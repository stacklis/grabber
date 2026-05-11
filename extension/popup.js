const $ = (id) => document.getElementById(id);
const api = typeof browser !== "undefined" ? browser : chrome;

const DEFAULTS = {
  // Tailscale-first default — works from any device on the tailnet.
  // Override in Settings to point at localhost or a different host.
  server: "http://100.99.119.80:3001",
  quality: "best",
  tool: "auto",
};

let currentAbort = null;

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

function setStatus(text, kind = "") {
  $("status").textContent = text;
  $("status").className =
    "muted" + (kind === "err" ? " err" : kind === "ok" ? " ok" : "");
}

function showProgress() {
  $("progress-wrap").hidden = false;
  $("progress-fill").style.width = "0%";
  $("progress-fill").classList.remove("indeterminate");
  $("progress-filename").textContent = "";
  $("progress-stats").textContent = "";
}

function hideProgress() {
  $("progress-wrap").hidden = true;
}

function setProgress(pct, filename, speed, eta) {
  const fill = $("progress-fill");
  if (pct == null || isNaN(pct)) {
    fill.classList.add("indeterminate");
  } else {
    fill.classList.remove("indeterminate");
    fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  }
  if (filename) $("progress-filename").textContent = filename;
  const parts = [];
  if (pct != null && !isNaN(pct)) parts.push(`${pct.toFixed(0)}%`);
  if (speed) parts.push(speed);
  if (eta && eta !== "Unknown") parts.push(`eta ${eta}`);
  $("progress-stats").textContent = parts.join(" · ");
}

function notify(title, message) {
  try {
    api.notifications?.create?.({
      type: "basic",
      iconUrl: api.runtime.getURL("icons/icon128.png"),
      title,
      message,
    });
  } catch (_) {
    /* notifications API unavailable — silent fail */
  }
}

function setBusy(busy) {
  $("grab").disabled = busy;
  $("open-tab").disabled = busy;
  $("urls").disabled = busy;
  $("quality").disabled = busy;
  $("tool").disabled = busy;
}

async function downloadOne(server, url, quality, tool) {
  const ac = new AbortController();
  currentAbort = ac;
  let resp;
  try {
    resp = await fetch(`${server}/api/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, quality, tool }),
      signal: ac.signal,
    });
  } catch (e) {
    currentAbort = null;
    if (e.name === "AbortError") throw e;
    throw new Error(`Cannot reach ${server} — ${e.message}`);
  }
  if (!resp.ok || !resp.body) {
    currentAbort = null;
    const text = await resp.text().catch(() => "");
    throw new Error(`Server ${resp.status}: ${text.slice(0, 120) || resp.statusText}`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let lastError = null;
  let receivedDone = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const blocks = buf.split("\n\n");
      buf = blocks.pop() || "";
      for (const block of blocks) {
        const m = block.match(/^data:\s*(.+)$/m);
        if (!m) continue;
        let ev;
        try {
          ev = JSON.parse(m[1]);
        } catch {
          continue;
        }
        if (ev.type === "status" && ev.message) {
          setStatus(ev.message);
        } else if (ev.type === "progress") {
          setProgress(ev.percent, ev.filename, ev.speed, ev.eta);
        } else if (ev.type === "done") {
          receivedDone = true;
          setProgress(100, ev.filename);
        } else if (ev.type === "error") {
          lastError = new Error(ev.message || "unknown error");
        }
      }
    }
  } finally {
    currentAbort = null;
  }

  if (lastError && !receivedDone) throw lastError;
}

async function grabHere() {
  const urls = parseUrls($("urls").value);
  if (!urls.length) {
    setStatus("Paste at least one http(s) URL", "err");
    return;
  }
  const { server, quality, tool } = await getSettings();

  setBusy(true);
  showProgress();
  setStatus("");

  let completed = 0;
  try {
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      setStatus(
        `(${i + 1}/${urls.length}) ${url.replace(/^https?:\/\//, "").slice(0, 50)}…`,
      );
      await downloadOne(server, url, quality, tool);
      completed++;
    }
    setStatus(
      `Done · ${completed} URL${completed === 1 ? "" : "s"} grabbed`,
      "ok",
    );
    notify(
      "Grabber: complete",
      `${completed} URL${completed === 1 ? "" : "s"} downloaded`,
    );
  } catch (e) {
    if (e?.name === "AbortError") {
      setStatus(`Cancelled (${completed} of ${urls.length} done)`, "err");
    } else {
      const msg = e?.message || String(e);
      setStatus(msg, "err");
      notify("Grabber: failed", msg.slice(0, 200));
    }
  } finally {
    setBusy(false);
    setTimeout(() => {
      // Auto-hide progress after 5s if popup is still open
      if ($("status").className.includes("ok")) hideProgress();
    }, 5000);
  }
}

async function openInTab() {
  const urls = parseUrls($("urls").value);
  if (!urls.length) {
    setStatus("Paste at least one http(s) URL", "err");
    return;
  }
  const { server } = await getSettings();
  const params = new URLSearchParams();
  for (const u of urls) params.append("url", u);
  await api.tabs.create({ url: `${server}/?${params.toString()}` });
  window.close();
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

$("grab").addEventListener("click", grabHere);
$("open-tab").addEventListener("click", openInTab);
$("cancel").addEventListener("click", () => {
  if (currentAbort) {
    currentAbort.abort();
  }
});

$("urls").addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    grabHere();
  }
});

$("settings").addEventListener("click", (e) => {
  e.preventDefault();
  api.runtime.openOptionsPage();
});
