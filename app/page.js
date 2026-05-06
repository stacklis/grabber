"use client";

import { useEffect, useRef, useState } from "react";
import "./globals.css";

const DEFAULT_OUT = "C:\\Users\\jared\\Downloads";
const QUALITY_LABELS = {
  best: "Best (default)",
  "1080p": "1080p MP4",
  "720p": "720p MP4",
  "480p": "480p MP4",
  audio: "Audio only (MP3)",
};

const HISTORY_KEY = "grabber.history";
const QUALITY_KEY = "grabber.quality";
const FOLDER_KEY = "grabber.folder";
const TOOL_KEY = "grabber.tool";
const PLAYLIST_KEY = "grabber.playlist";

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function parseUrls(text) {
  return text
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
}

export default function Home() {
  const [text, setText] = useState("");
  const [quality, setQuality] = useState("best");
  const [folder, setFolder] = useState(DEFAULT_OUT);
  const [tool, setTool] = useState("auto");
  const [playlist, setPlaylist] = useState(false);
  const [items, setItems] = useState([]); // active + recently finished in this session
  const [history, setHistory] = useState([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const autoStartedRef = useRef(false);

  useEffect(() => {
    try {
      const q = localStorage.getItem(QUALITY_KEY);
      if (q && QUALITY_LABELS[q]) setQuality(q);
      const f = localStorage.getItem(FOLDER_KEY);
      if (f) setFolder(f);
      const t = localStorage.getItem(TOOL_KEY);
      if (t) setTool(t);
      const p = localStorage.getItem(PLAYLIST_KEY);
      if (p === "1") setPlaylist(true);
      const h = localStorage.getItem(HISTORY_KEY);
      if (h) {
        const parsed = JSON.parse(h);
        if (Array.isArray(parsed)) setHistory(parsed);
      }
    } catch {}
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(QUALITY_KEY, quality);
    } catch {}
  }, [quality]);
  useEffect(() => {
    try {
      localStorage.setItem(FOLDER_KEY, folder);
    } catch {}
  }, [folder]);
  useEffect(() => {
    try {
      localStorage.setItem(TOOL_KEY, tool);
    } catch {}
  }, [tool]);
  useEffect(() => {
    try {
      localStorage.setItem(PLAYLIST_KEY, playlist ? "1" : "0");
    } catch {}
  }, [playlist]);

  // ?url= prefill + autostart (supports repeated url params for batch)
  useEffect(() => {
    if (autoStartedRef.current) return;
    try {
      const params = new URLSearchParams(window.location.search);
      const urls = params.getAll("url").filter((u) => /^https?:\/\//i.test(u));
      if (urls.length) {
        setText(urls.join("\n"));
        autoStartedRef.current = true;
        // wait a tick so quality/folder load from localStorage
        setTimeout(() => {
          startDownloads(urls);
        }, 50);
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function updateItem(id, patch) {
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, ...patch } : it))
    );
  }

  function pushHistory(entry) {
    setHistory((prev) => {
      const next = [entry, ...prev].slice(0, 200);
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }

  async function runOne(item) {
    const ctrl = new AbortController();
    updateItem(item.id, { status: "active", abort: ctrl, error: "" });
    try {
      const res = await fetch("/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: item.url,
          quality: item.quality,
          outputFolder: item.folder,
          tool: item.tool,
          playlist: !!item.playlist,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const t = await res.text().catch(() => "");
        throw new Error(t || `Request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop() || "";
        for (const evt of events) {
          const line = evt.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          let payload;
          try {
            payload = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          if (payload.type === "progress") {
            updateItem(item.id, {
              percent: payload.percent ?? null,
              indeterminate: !!payload.indeterminate,
              speed: payload.speed || "",
              eta: payload.eta || "",
              size: payload.size || "",
              filename: payload.filename || "",
              count: payload.count,
            });
          } else if (payload.type === "status") {
            updateItem(item.id, {
              statusMsg: payload.message || "",
              filename: payload.filename || undefined,
              tool: payload.tool || undefined,
            });
          } else if (payload.type === "done") {
            updateItem(item.id, {
              status: "done",
              percent: 100,
              statusMsg: payload.message || "Done",
              filename: payload.filename || "",
            });
            pushHistory({
              id: item.id,
              url: item.url,
              filename: payload.filename || "",
              size: payload.count
                ? `${payload.count} file${payload.count === 1 ? "" : "s"}`
                : item.size || "",
              folder: payload.outputFolder || item.folder,
              timestamp: Date.now(),
            });
          } else if (payload.type === "error") {
            updateItem(item.id, {
              status: "error",
              error: payload.message || "Error",
            });
          }
        }
      }

      // stream ended without explicit done/error? mark errored if still active
      const cur = itemsRef.current.find((x) => x.id === item.id);
      if (cur && cur.status === "active") {
        updateItem(item.id, { status: "error", error: "Stream ended unexpectedly" });
      }
    } catch (err) {
      if (err.name === "AbortError") {
        updateItem(item.id, { status: "error", error: "Cancelled" });
      } else {
        updateItem(item.id, {
          status: "error",
          error: err.message || "Error",
        });
      }
    }
  }

  function startDownloads(urls) {
    const newItems = urls.map((u) => ({
      id: uid(),
      url: u,
      quality,
      folder,
      tool,
      playlist,
      status: "queued",
      percent: 0,
      indeterminate: false,
      speed: "",
      eta: "",
      size: "",
      filename: "",
      statusMsg: "Queued",
      error: "",
    }));
    setItems((prev) => [...newItems, ...prev]);
    for (const it of newItems) {
      runOne(it);
    }
  }

  function onSubmit(e) {
    e.preventDefault();
    const urls = parseUrls(text);
    if (!urls.length) return;
    startDownloads(urls);
    setText("");
  }

  function onRetry(item) {
    runOne({ ...item });
  }

  function onCancel(item) {
    if (item.abort) {
      try {
        item.abort.abort();
      } catch {}
    }
  }

  function clearFinished() {
    setItems((prev) => prev.filter((it) => it.status === "active" || it.status === "queued"));
  }

  function clearHistory() {
    setHistory([]);
    try {
      localStorage.removeItem(HISTORY_KEY);
    } catch {}
  }

  const activeCount = items.filter(
    (i) => i.status === "active" || i.status === "queued"
  ).length;

  return (
    <main>
      <div className="card">
        <header>
          <div className="title">grabber</div>
          <div className="subtitle">local multi-tool downloader</div>
        </header>

        <form onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor="urls">URLs (one per line)</label>
            <textarea
              id="urls"
              rows={3}
              placeholder="https://…"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>

          <div className="row">
            <div className="field">
              <label htmlFor="quality">Format / quality</label>
              <select
                id="quality"
                value={quality}
                onChange={(e) => setQuality(e.target.value)}
              >
                {Object.entries(QUALITY_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="tool">Tool</label>
              <select
                id="tool"
                value={tool}
                onChange={(e) => setTool(e.target.value)}
              >
                <option value="auto">Auto detect</option>
                <option value="yt-dlp">yt-dlp (video)</option>
                <option value="gallery-dl">gallery-dl (images)</option>
              </select>
            </div>
          </div>

          <div className="field">
            <label htmlFor="folder">Output folder</label>
            <input
              id="folder"
              type="text"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder={DEFAULT_OUT}
            />
          </div>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={playlist}
              onChange={(e) => setPlaylist(e.target.checked)}
            />
            <span>Download full playlist (yt-dlp only)</span>
          </label>

          <button type="submit" disabled={!parseUrls(text).length}>
            Start download{parseUrls(text).length > 1 ? "s" : ""}
          </button>
        </form>
      </div>

      {items.length > 0 && (
        <div className="card section">
          <div className="section-head">
            <div className="section-title">
              Downloads {activeCount > 0 && <span className="muted">({activeCount} active)</span>}
            </div>
            {items.some((i) => i.status === "done" || i.status === "error") && (
              <button className="link" type="button" onClick={clearFinished}>
                Clear finished
              </button>
            )}
          </div>
          <ul className="items">
            {items.map((it) => (
              <li key={it.id} className={`item ${it.status}`}>
                <div className="item-row">
                  <div className="item-name" title={it.filename || it.url}>
                    {it.filename || it.url}
                  </div>
                  <div className="item-actions">
                    {it.status === "active" && (
                      <button
                        type="button"
                        className="link"
                        onClick={() => onCancel(it)}
                      >
                        Cancel
                      </button>
                    )}
                    {it.status === "error" && (
                      <button
                        type="button"
                        className="link retry"
                        onClick={() => onRetry(it)}
                      >
                        Retry
                      </button>
                    )}
                  </div>
                </div>
                <div className="bar">
                  <div
                    className={`bar-fill ${
                      it.indeterminate && it.status === "active"
                        ? "indeterminate"
                        : ""
                    }`}
                    style={{
                      width:
                        it.status === "done"
                          ? "100%"
                          : it.indeterminate
                          ? "100%"
                          : `${it.percent || 0}%`,
                    }}
                  />
                </div>
                <div className="item-meta">
                  {it.status === "error" ? (
                    <span className="err">{it.error || "Error"}</span>
                  ) : it.status === "done" ? (
                    <span className="ok">{it.statusMsg || "Done"}</span>
                  ) : (
                    <>
                      <span className="muted">
                        {it.indeterminate
                          ? it.count
                            ? `${it.count} files`
                            : "downloading…"
                          : it.percent
                          ? `${it.percent.toFixed(1)}%`
                          : it.statusMsg || "starting…"}
                      </span>
                      {it.speed && <span className="muted"> · {it.speed}</span>}
                      {it.eta && <span className="muted"> · ETA {it.eta}</span>}
                      {it.size && <span className="muted"> · {it.size}</span>}
                    </>
                  )}
                </div>
                <div className="item-url" title={it.url}>
                  {it.url}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {history.length > 0 && (
        <div className="card section">
          <div className="section-head">
            <div className="section-title">
              History <span className="muted">({history.length})</span>
            </div>
            <button className="link" type="button" onClick={clearHistory}>
              Clear history
            </button>
          </div>
          <ul className="items">
            {history.map((h) => (
              <li key={h.id} className="item done">
                <div className="item-name" title={h.filename || h.url}>
                  {h.filename || h.url}
                </div>
                <div className="item-meta">
                  {h.size && <span className="muted">{h.size}</span>}
                  {h.size && <span className="muted"> · </span>}
                  <span className="muted">
                    {new Date(h.timestamp).toLocaleString()}
                  </span>
                  {h.folder && (
                    <>
                      <span className="muted"> · </span>
                      <span className="muted" title={h.folder}>
                        {h.folder}
                      </span>
                    </>
                  )}
                </div>
                <div className="item-url" title={h.url}>
                  {h.url}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}
