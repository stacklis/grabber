"use client";

import { useEffect, useRef, useState } from "react";
import type { DownloadEvent } from "@/lib/sse-events";
import { withConcurrencyLimit } from "@/lib/queue";
import "./globals.css";

// Empty means "land in GRABBER_DOWNLOAD_ROOT itself". The server resolves
// user input under that root and rejects escapes.
const DEFAULT_OUT = "";

const MAX_CONCURRENT = 4;
// If we haven't seen any event (including heartbeat) for this long while
// the tab was hidden, assume the stream is dead and reconnect.
const STALE_MS = 35_000;

type Quality = "best" | "1080p" | "720p" | "480p" | "audio";
type Tool = "auto" | "yt-dlp" | "gallery-dl";

const QUALITY_LABELS: Record<Quality, string> = {
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

type DownloadStatus = "queued" | "active" | "done" | "error";

type DownloadItem = {
  id: string;
  url: string;
  quality: Quality;
  folder: string;
  tool: Tool;
  playlist: boolean;
  status: DownloadStatus;
  percent: number | null;
  indeterminate: boolean;
  speed: string;
  eta: string;
  size: string;
  filename: string;
  statusMsg: string;
  error: string;
  count?: number;
  abort?: AbortController;
  jobId?: string;
  lastEventTs: number;
  /** Wall-clock ms when we last received any event. Used to detect dead streams. */
  lastReceivedAt: number;
  /** True between abort-for-reconnect and the next reader replacing it. */
  reconnecting?: boolean;
};

type HistoryEntry = {
  id: string;
  url: string;
  filename: string;
  size: string;
  folder: string;
  timestamp: number;
};

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function parseUrls(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
}

function isQuality(v: string): v is Quality {
  return v === "best" || v === "1080p" || v === "720p" || v === "480p" || v === "audio";
}

function isTool(v: string): v is Tool {
  return v === "auto" || v === "yt-dlp" || v === "gallery-dl";
}

export default function Home(): React.ReactNode {
  const [text, setText] = useState("");
  const [quality, setQuality] = useState<Quality>("best");
  const [folder, setFolder] = useState(DEFAULT_OUT);
  const [tool, setTool] = useState<Tool>("auto");
  const [playlist, setPlaylist] = useState(false);
  const [items, setItems] = useState<DownloadItem[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const itemsRef = useRef<DownloadItem[]>(items);
  itemsRef.current = items;
  const autoStartedRef = useRef(false);

  useEffect(() => {
    try {
      const q = localStorage.getItem(QUALITY_KEY);
      if (q && isQuality(q)) setQuality(q);
      const f = localStorage.getItem(FOLDER_KEY);
      if (f !== null) setFolder(f);
      const t = localStorage.getItem(TOOL_KEY);
      if (t && isTool(t)) setTool(t);
      const p = localStorage.getItem(PLAYLIST_KEY);
      if (p === "1") setPlaylist(true);
      const h = localStorage.getItem(HISTORY_KEY);
      if (h) {
        const parsed: unknown = JSON.parse(h);
        if (Array.isArray(parsed)) setHistory(parsed as HistoryEntry[]);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(QUALITY_KEY, quality);
    } catch {
      /* ignore */
    }
  }, [quality]);
  useEffect(() => {
    try {
      localStorage.setItem(FOLDER_KEY, folder);
    } catch {
      /* ignore */
    }
  }, [folder]);
  useEffect(() => {
    try {
      localStorage.setItem(TOOL_KEY, tool);
    } catch {
      /* ignore */
    }
  }, [tool]);
  useEffect(() => {
    try {
      localStorage.setItem(PLAYLIST_KEY, playlist ? "1" : "0");
    } catch {
      /* ignore */
    }
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
        setTimeout(() => {
          startDownloads(urls);
        }, 50);
      }
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tab-visibility resume: on mobile, backgrounding a tab stalls (and
  // sometimes silently kills) the SSE reader. When we come back, any
  // item that is `active` but hasn't received an event recently gets a
  // fresh resume connection — the server kept the job alive and buffered
  // events past lastEventTs.
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      for (const it of itemsRef.current) {
        if (it.status !== "active" || !it.jobId) continue;
        if (now - it.lastReceivedAt < STALE_MS) continue;
        reconnectItem(it);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function updateItem(id: string, patch: Partial<DownloadItem>): void {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  function pushHistory(entry: HistoryEntry): void {
    setHistory((prev) => {
      const next = [entry, ...prev].slice(0, 200);
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  /** Drive a SSE response stream and apply events to the item. */
  async function consumeStream(item: DownloadItem, res: Response): Promise<void> {
    if (!res.body) throw new Error("Response has no body");
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
        const lines = evt.split("\n");
        let idVal = 0;
        let dataStr = "";
        for (const ln of lines) {
          if (ln.startsWith("id: ")) idVal = parseInt(ln.slice(4), 10) || 0;
          else if (ln.startsWith("data: ")) dataStr = ln.slice(6);
        }
        if (!dataStr) continue;
        let payload: DownloadEvent;
        try {
          payload = JSON.parse(dataStr) as DownloadEvent;
        } catch {
          continue;
        }
        if (idVal > 0) {
          updateItem(item.id, { lastEventTs: idVal, lastReceivedAt: Date.now() });
        } else {
          updateItem(item.id, { lastReceivedAt: Date.now() });
        }
        applyEvent(item, payload);
      }
    }
  }

  function applyEvent(item: DownloadItem, payload: DownloadEvent): void {
    if (payload.type === "heartbeat") return;
    if (payload.type === "queued") {
      updateItem(item.id, { statusMsg: `Queued (#${payload.position})` });
      return;
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
      return;
    }
    if (payload.type === "status") {
      updateItem(item.id, {
        statusMsg: payload.message || "",
        filename: payload.filename || undefined,
        tool: (payload.tool && isTool(payload.tool) ? payload.tool : undefined) as
          | Tool
          | undefined,
      });
      return;
    }
    if (payload.type === "done") {
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
        size: payload.count ? `${payload.count} file${payload.count === 1 ? "" : "s"}` : "",
        folder: payload.outputFolder || item.folder,
        timestamp: Date.now(),
      });
      return;
    }
    if (payload.type === "error") {
      updateItem(item.id, { status: "error", error: payload.message || "Error" });
      return;
    }
  }

  async function runOne(item: DownloadItem): Promise<void> {
    const ctrl = new AbortController();
    updateItem(item.id, {
      status: "active",
      abort: ctrl,
      error: "",
      lastReceivedAt: Date.now(),
    });
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
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(t || `Request failed (${res.status})`);
      }
      const jobId = res.headers.get("X-Grabber-Job-Id") || undefined;
      if (jobId) updateItem(item.id, { jobId });

      await consumeStream(item, res);

      // Stream ended without explicit done/error — only mark error if still active
      // and not in the middle of a reconnect handoff.
      const cur = itemsRef.current.find((x) => x.id === item.id);
      if (cur && cur.status === "active" && !cur.reconnecting) {
        // Try one reconnect before giving up — server may still have the job alive.
        if (cur.jobId) {
          reconnectItem(cur);
          return;
        }
        updateItem(item.id, { status: "error", error: "Stream ended unexpectedly" });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const name = err instanceof Error ? err.name : "";
      if (name === "AbortError") {
        const cur = itemsRef.current.find((x) => x.id === item.id);
        if (cur?.reconnecting) {
          // Replaced by resumeItem — swallow.
          return;
        }
        updateItem(item.id, { status: "error", error: "Cancelled" });
      } else {
        updateItem(item.id, { status: "error", error: msg || "Error" });
      }
    }
  }

  function reconnectItem(item: DownloadItem): void {
    if (!item.jobId) return;
    updateItem(item.id, { reconnecting: true });
    if (item.abort) {
      try {
        item.abort.abort();
      } catch {
        /* ignore */
      }
    }
    queueMicrotask(() => {
      void resumeItem(item);
    });
  }

  async function resumeItem(item: DownloadItem): Promise<void> {
    if (!item.jobId) return;
    const ctrl = new AbortController();
    const sinceTs = item.lastEventTs || 0;
    updateItem(item.id, {
      abort: ctrl,
      reconnecting: false,
      lastReceivedAt: Date.now(),
    });
    try {
      const res = await fetch(
        `/api/download/resume?jobId=${encodeURIComponent(item.jobId)}&sinceTs=${sinceTs}`,
        { signal: ctrl.signal },
      );
      if (!res.ok) {
        if (res.status === 404) {
          // Job already cleaned up server-side; mark done if it likely finished.
          updateItem(item.id, {
            status: "error",
            error: "Reconnect: job expired (may have completed while away)",
          });
          return;
        }
        const t = await res.text().catch(() => "");
        throw new Error(t || `Resume failed (${res.status})`);
      }
      await consumeStream(item, res);
    } catch (err: unknown) {
      const name = err instanceof Error ? err.name : "";
      const msg = err instanceof Error ? err.message : String(err);
      if (name === "AbortError") {
        const cur = itemsRef.current.find((x) => x.id === item.id);
        if (cur?.reconnecting) return;
      }
      // Don't aggressively error — the next visibilitychange may retry.
      console.warn("resume error:", msg);
    }
  }

  function startDownloads(urls: string[]): void {
    const newItems: DownloadItem[] = urls.map((u) => ({
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
      lastEventTs: 0,
      lastReceivedAt: 0,
    }));
    setItems((prev) => [...newItems, ...prev]);
    // Concurrency cap: run at most MAX_CONCURRENT runOne()s at a time.
    // Beyond cap, items sit with status="queued" until a slot opens.
    void withConcurrencyLimit(
      MAX_CONCURRENT,
      newItems.map((it) => () => runOne(it)),
    );
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    const urls = parseUrls(text);
    if (!urls.length) return;
    startDownloads(urls);
    setText("");
  }

  function onRetry(item: DownloadItem): void {
    void runOne({ ...item, lastEventTs: 0, lastReceivedAt: 0 });
  }

  function onCancel(item: DownloadItem): void {
    if (item.abort) {
      try {
        item.abort.abort();
      } catch {
        /* ignore */
      }
    }
  }

  function clearFinished(): void {
    setItems((prev) => prev.filter((it) => it.status === "active" || it.status === "queued"));
  }

  function clearHistory(): void {
    setHistory([]);
    try {
      localStorage.removeItem(HISTORY_KEY);
    } catch {
      /* ignore */
    }
  }

  const activeCount = items.filter(
    (i) => i.status === "active" || i.status === "queued",
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
            <p className="hint">paste one URL per line, then hit Start</p>
          </div>

          <div className="row">
            <div className="field">
              <label htmlFor="quality">Format / quality</label>
              <select
                id="quality"
                value={quality}
                onChange={(e) => {
                  const v = e.target.value;
                  if (isQuality(v)) setQuality(v);
                }}
              >
                {(Object.keys(QUALITY_LABELS) as Quality[]).map((v) => (
                  <option key={v} value={v}>
                    {QUALITY_LABELS[v]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="tool">Tool</label>
              <select
                id="tool"
                value={tool}
                onChange={(e) => {
                  const v = e.target.value;
                  if (isTool(v)) setTool(v);
                }}
              >
                <option value="auto">Auto detect</option>
                <option value="yt-dlp">yt-dlp (video)</option>
                <option value="gallery-dl">gallery-dl (images)</option>
              </select>
            </div>
          </div>

          <div className="field">
            <label htmlFor="folder">
              Output subfolder <span className="muted">(under GRABBER_DOWNLOAD_ROOT)</span>
            </label>
            <input
              id="folder"
              type="text"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder="e.g. videos/youtube — empty = root"
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
                      <button type="button" className="link" onClick={() => onCancel(it)}>
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
                      it.indeterminate && it.status === "active" ? "indeterminate" : ""
                    }`}
                    style={{
                      width:
                        it.status === "done"
                          ? "100%"
                          : it.indeterminate
                            ? "100%"
                            : `${it.percent ?? 0}%`,
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
                  <span className="muted">{new Date(h.timestamp).toLocaleString()}</span>
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
