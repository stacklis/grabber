import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsConstants, existsSync, mkdirSync, readdirSync, promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import type { DownloadEvent } from "@/lib/sse-events";
import { JOBS, makeSseStream, type JobState, type RecordedEvent } from "@/lib/job-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HOME = os.homedir();
const DOWNLOAD_ROOT = path.normalize(
  process.env.GRABBER_DOWNLOAD_ROOT || path.join(HOME, "Downloads", "grabber"),
);
const COOKIES_DIR = path.join(process.cwd(), "cookies");
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const PROCESS_TIMEOUT_MS = Number(process.env.GRABBER_PROCESS_TIMEOUT_MS) || 15 * 60_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const JOB_TTL_AFTER_COMPLETE_MS = 5 * 60_000;
const EVENT_BUFFER_CAP = 500;

// Env-driven binary paths take precedence over auto-discovery.
const ENV_FFMPEG = (process.env.GRABBER_FFMPEG_PATH || "").trim();
const ENV_YTDLP = (process.env.GRABBER_YTDLP_PATH || "").trim();
const ENV_GALLERYDL = (process.env.GRABBER_GALLERYDL_PATH || "").trim();

const FFMPEG_DIR_FALLBACK = "C:\\ffmpeg\\bin";
const FFMPEG_DIR_CANDIDATES: readonly string[] = [
  FFMPEG_DIR_FALLBACK,
  "C:\\Program Files\\ffmpeg\\bin",
  path.join(HOME, "ffmpeg", "bin"),
];

const YTDLP_CANDIDATES: readonly string[] = [
  path.join(HOME, "yt-dlp.exe"),
  path.join(HOME, ".local", "bin", "yt-dlp.exe"),
  path.join(HOME, "Downloads", "yt-dlp.exe"),
  "C:\\ffmpeg\\bin\\yt-dlp.exe",
  "C:\\Program Files\\yt-dlp\\yt-dlp.exe",
  "C:\\ProgramData\\chocolatey\\bin\\yt-dlp.exe",
];

const GALLERY_DL_CANDIDATES: readonly string[] = [
  path.join(HOME, ".local", "bin", "gallery-dl.exe"),
  path.join(HOME, "gallery-dl.exe"),
  path.join(HOME, "Downloads", "gallery-dl.exe"),
  "C:\\Program Files\\gallery-dl\\gallery-dl.exe",
];

function findFfmpegDir(): string {
  if (ENV_FFMPEG && existsSync(ENV_FFMPEG)) return path.normalize(path.dirname(ENV_FFMPEG));
  for (const dir of FFMPEG_DIR_CANDIDATES) {
    if (existsSync(path.join(dir, "ffmpeg.exe"))) return path.normalize(dir);
  }
  return path.normalize(FFMPEG_DIR_FALLBACK);
}

function findCookiesFile(url: string): string | null {
  if (!existsSync(COOKIES_DIR)) return null;
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  let files: string[];
  try {
    files = readdirSync(COOKIES_DIR).filter((f) => f.toLowerCase().endsWith(".txt"));
  } catch {
    return null;
  }
  if (!files.length) return null;
  const match = files.find((f) => {
    const stem = f.replace(/\.txt$/i, "").toLowerCase();
    return stem && (host === stem || host.endsWith("." + stem) || host.includes(stem));
  });
  return path.join(COOKIES_DIR, match || files[0]);
}

function cookieArgs(url: string): string[] {
  const file = findCookiesFile(url);
  if (file) return ["--cookies", file];
  return ["--cookies-from-browser", "firefox"];
}

function resolveBinary(name: string, candidates: readonly string[]): string | null {
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  const pathDirs = (process.env.PATH || "").split(path.delimiter);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").concat([""])
      : [""];
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

// One-time module-load resolution; falls back to per-call if a binary moves.
const YTDLP_BIN: string | null =
  (ENV_YTDLP && existsSync(ENV_YTDLP) ? ENV_YTDLP : null) ||
  resolveBinary("yt-dlp", YTDLP_CANDIDATES);
const GALLERYDL_BIN: string | null =
  (ENV_GALLERYDL && existsSync(ENV_GALLERYDL) ? ENV_GALLERYDL : null) ||
  resolveBinary("gallery-dl", GALLERY_DL_CANDIDATES);

function getYtdlp(): string | null {
  if (YTDLP_BIN && existsSync(YTDLP_BIN)) return YTDLP_BIN;
  return resolveBinary("yt-dlp", YTDLP_CANDIDATES);
}
function getGalleryDl(): string | null {
  if (GALLERYDL_BIN && existsSync(GALLERYDL_BIN)) return GALLERYDL_BIN;
  return resolveBinary("gallery-dl", GALLERY_DL_CANDIDATES);
}

type Quality = "best" | "1080p" | "720p" | "480p" | "audio";
type Tool = "auto" | "yt-dlp" | "gallery-dl";

const QUALITIES = new Set<Quality>(["best", "1080p", "720p", "480p", "audio"]);
const TOOLS = new Set<Tool>(["auto", "yt-dlp", "gallery-dl"]);

function isQuality(v: unknown): v is Quality {
  return typeof v === "string" && QUALITIES.has(v as Quality);
}
function isTool(v: unknown): v is Tool {
  return typeof v === "string" && TOOLS.has(v as Tool);
}

/** Resolve user-supplied folder under DOWNLOAD_ROOT. Returns null on escape. */
function resolveSafeOutputFolder(input: unknown): string | null {
  const raw = typeof input === "string" && input.trim() ? input.trim() : "";
  // Empty / unspecified → land in DOWNLOAD_ROOT itself.
  const resolved = raw ? path.resolve(DOWNLOAD_ROOT, raw) : DOWNLOAD_ROOT;
  const normalized = path.normalize(resolved);
  const root = path.normalize(DOWNLOAD_ROOT);
  if (normalized !== root && !normalized.startsWith(root + path.sep)) {
    return null;
  }
  return normalized;
}

const GALLERY_HOSTS: readonly string[] = [
  "pixiv.net",
  "deviantart.com",
  "imgur.com",
  "tumblr.com",
  "flickr.com",
  "danbooru.donmai.us",
  "e621.net",
  "e926.net",
  "gelbooru.com",
  "rule34.xxx",
  "rule34.us",
  "furaffinity.net",
  "artstation.com",
  "newgrounds.com",
  "weasyl.com",
  "4chan.org",
  "4channel.org",
  "boards.4chan.org",
  "kemono.party",
  "kemono.su",
  "kemono.cr",
  "coomer.party",
  "coomer.su",
  "coomer.st",
  "cyberdrop.me",
  "cyberdrop.to",
  "cyberdrop.cr",
  "cyberdrop.cc",
  "bunkr.sk",
  "bunkrr.su",
  "bunkr.su",
  "bunkr.is",
  "bunkr.la",
  "bunkr.cr",
  "bunkr.black",
  "fapello.com",
  "redgifs.com",
  "erome.com",
  "simpcity.su",
  "nudostar.com",
  "nudostar.tv",
  "saint.to",
  "saint2.su",
  "saint2.cr",
  "jpg.church",
  "jpg5.su",
  "jpg2.su",
  "jpg.pet",
  "socialmediagirls.com",
  "forums.socialmediagirls.com",
  "motherless.com",
  "luscious.net",
  "members.luscious.net",
];

function urlPrefersGallery(url: string): "gallery-dl" | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const p = u.pathname.toLowerCase();
    if (host.endsWith("xhamster.com") && (p.includes("/photos/") || p.includes("/gallery/"))) {
      return "gallery-dl";
    }
  } catch {
    /* ignore */
  }
  return null;
}

function detectTool(url: string): "yt-dlp" | "gallery-dl" {
  const prefer = urlPrefersGallery(url);
  if (prefer) return prefer;
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const g of GALLERY_HOSTS) {
      if (host === g || host.endsWith("." + g)) return "gallery-dl";
    }
  } catch {
    /* ignore */
  }
  return "yt-dlp";
}

type YtdlpOptions = { playlist?: boolean; ffmpegDir?: string | null };

function ytdlpArgs(url: string, quality: Quality, outDir: string, opts: YtdlpOptions = {}): string[] {
  const { playlist = false, ffmpegDir = null } = opts;
  const normalizedOut = path.normalize(outDir);
  const out = path.join(normalizedOut, "%(title)s [%(id)s].%(ext)s");
  const ffDir = path.normalize(ffmpegDir || FFMPEG_DIR_FALLBACK);

  const common = [
    "--newline",
    playlist ? "--yes-playlist" : "--no-playlist",
    "--user-agent",
    USER_AGENT,
    ...cookieArgs(url),
    "--hls-prefer-native",
    "--no-check-certificates",
    "--ffmpeg-location",
    ffDir,
  ];

  if (quality === "audio") {
    return [...common, "-x", "--audio-format", "mp3", "--audio-quality", "0", "-o", out, url];
  }

  let format: string;
  switch (quality) {
    case "1080p":
      format =
        "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best";
      break;
    case "720p":
      format =
        "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]/best";
      break;
    case "480p":
      format =
        "bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480]/best";
      break;
    case "best":
    default:
      format = "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best";
  }

  return [...common, "--format", format, "--merge-output-format", "mp4", "-o", out, url];
}

function galleryArgs(url: string, outDir: string): string[] {
  const args = ["-D", outDir, "--user-agent", USER_AGENT];
  const file = findCookiesFile(url);
  if (file) {
    args.push("--cookies", file);
  } else {
    args.push("--cookies-from-browser", "firefox");
  }
  args.push(url);
  return args;
}

type YtdlpProgress = {
  percent: number;
  size: string;
  speed: string;
  eta: string;
};

function parseYtdlpProgress(line: string): YtdlpProgress | null {
  const m = line.match(
    /^\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\s*\w+)(?:\s+at\s+([\d.]+\s*\w+\/s))?(?:\s+ETA\s+([\d:\-]+))?/,
  );
  if (!m) return null;
  return {
    percent: Math.min(100, Math.max(0, parseFloat(m[1] || "0"))),
    size: (m[2] || "").trim(),
    speed: (m[3] || "").trim(),
    eta: (m[4] || "").trim(),
  };
}

function parseDestination(line: string): string | null {
  const m = line.match(/^\[download\]\s+Destination:\s+(.+)$/);
  if (m && m[1]) return m[1].trim();
  const m2 = line.match(/^\[Merger\]\s+Merging formats into\s+"(.+)"\s*$/);
  if (m2 && m2[1]) return m2[1].trim();
  const m3 = line.match(/^\[ExtractAudio\]\s+Destination:\s+(.+)$/);
  if (m3 && m3[1]) return m3[1].trim();
  return null;
}

function lineBuffer(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let buf = "";
  return (chunk: Buffer | string) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString();
    let idx: number;
    while ((idx = buf.search(/\r\n|\n|\r/)) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + (buf.substr(idx, 2) === "\r\n" ? 2 : 1));
      onLine(line);
    }
  };
}

function newJobId(): string {
  return randomBytes(8).toString("hex");
}

function recordEvent(job: JobState, event: DownloadEvent): void {
  const ts = Date.now();
  const rec: RecordedEvent = { ts, event };
  job.events.push(rec);
  if (job.events.length > EVENT_BUFFER_CAP) {
    job.events.splice(0, job.events.length - EVENT_BUFFER_CAP);
  }
  job.lastEventTs = ts;
  job.emitter.emit("event", rec);
}

function completeJob(job: JobState): void {
  if (job.completed) return;
  job.completed = true;
  setTimeout(() => {
    JOBS.delete(job.jobId);
  }, JOB_TTL_AFTER_COMPLETE_MS);
}

async function cleanupPartialFile(outDir: string, filename: string): Promise<void> {
  if (!filename) return;
  // Best-effort: try both the recorded filename and the .part variant yt-dlp uses.
  const candidates = [
    path.join(outDir, filename),
    path.join(outDir, filename + ".part"),
  ];
  for (const c of candidates) {
    try {
      await fsp.unlink(c);
    } catch {
      /* ignore — may not exist or already cleaned */
    }
  }
}

type RequestBody = {
  url?: unknown;
  quality?: unknown;
  outputFolder?: unknown;
  tool?: unknown;
  playlist?: unknown;
};

function startJob(params: {
  url: string;
  quality: Quality;
  tool: Tool;
  playlist: boolean;
  outDir: string;
}): { job: JobState } | { error: string; status: number } {
  const { url, quality, tool, playlist, outDir } = params;
  const chosenTool: "yt-dlp" | "gallery-dl" = tool === "auto" ? detectTool(url) : tool;
  const ffmpegDir = findFfmpegDir();

  let bin: string | null;
  let args: string[];
  if (chosenTool === "gallery-dl") {
    bin = getGalleryDl();
    if (!bin) {
      return {
        status: 500,
        error: `gallery-dl not found. Looked in:\n${GALLERY_DL_CANDIDATES.join("\n")}\nand on PATH. Set GRABBER_GALLERYDL_PATH or install gallery-dl.`,
      };
    }
    args = galleryArgs(url, outDir);
  } else {
    bin = getYtdlp();
    if (!bin) {
      return {
        status: 500,
        error: `yt-dlp not found. Looked in:\n${YTDLP_CANDIDATES.join("\n")}\nand on PATH. Set GRABBER_YTDLP_PATH or install yt-dlp.`,
      };
    }
    args = ytdlpArgs(url, quality, outDir, { playlist, ffmpegDir });
  }

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(bin, args, { windowsHide: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 500, error: `Failed to start ${chosenTool}: ${msg}` };
  }

  const jobId = newJobId();
  const job: JobState = {
    jobId,
    child,
    events: [],
    lastEventTs: 0,
    startedAt: Date.now(),
    completed: false,
    emitter: new EventEmitter(),
    outDir,
    currentFilename: "",
    tool: chosenTool,
  };
  // Allow many concurrent resume subscribers without warnings.
  job.emitter.setMaxListeners(50);
  JOBS.set(jobId, job);

  recordEvent(job, {
    type: "status",
    message: `Launching ${chosenTool} (${bin})`,
    tool: chosenTool,
  });

  // Subprocess timeout: SIGTERM then SIGKILL.
  const timeoutHandle = setTimeout(() => {
    if (!child.killed && !job.completed) {
      recordEvent(job, {
        type: "error",
        message: `Timeout after ${Math.round(PROCESS_TIMEOUT_MS / 1000)}s — killing process`,
      });
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        if (!child.killed) {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }
      }, 5_000);
    }
  }, PROCESS_TIMEOUT_MS);

  // Heartbeat ping so phone browsers don't time out the connection during
  // long-quiet phases (e.g. gallery-dl scraping pages, yt-dlp HLS merging).
  const heartbeat = setInterval(() => {
    if (job.completed) return;
    recordEvent(job, { type: "heartbeat", ts: Date.now() });
  }, HEARTBEAT_INTERVAL_MS);

  let lastErrLine = "";
  let galleryCount = 0;

  const handleYtdlpLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const dest = parseDestination(trimmed);
    if (dest) {
      job.currentFilename = path.basename(dest);
      recordEvent(job, {
        type: "status",
        message: `Downloading ${job.currentFilename}`,
        filename: job.currentFilename,
        path: dest,
      });
      return;
    }
    const prog = parseYtdlpProgress(trimmed);
    if (prog) {
      recordEvent(job, { type: "progress", ...prog, filename: job.currentFilename });
      return;
    }
    if (
      trimmed.startsWith("[Merger]") ||
      trimmed.startsWith("[ExtractAudio]") ||
      trimmed.startsWith("[ffmpeg]")
    ) {
      recordEvent(job, { type: "status", message: trimmed });
    }
  };

  const handleGalleryLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("/")) {
      galleryCount++;
      job.currentFilename = path.basename(trimmed);
      recordEvent(job, {
        type: "progress",
        indeterminate: true,
        filename: job.currentFilename,
        path: trimmed,
        count: galleryCount,
      });
      return;
    }
    if (trimmed.startsWith("# ") || trimmed.startsWith("* ")) {
      recordEvent(job, { type: "status", message: trimmed });
    }
  };

  const onLine = chosenTool === "gallery-dl" ? handleGalleryLine : handleYtdlpLine;

  child.stdout.on("data", lineBuffer(onLine));
  child.stderr.on(
    "data",
    lineBuffer((line) => {
      const t = line.trim();
      if (!t) return;
      lastErrLine = t;
      if (/^ERROR/i.test(t) || /\[error\]/i.test(t)) {
        recordEvent(job, { type: "error", message: t });
      }
    }),
  );

  let spawnError: Error | null = null;
  child.on("error", (err) => {
    spawnError = err;
    recordEvent(job, {
      type: "error",
      message: `Failed to start ${chosenTool}: ${err.message} (path: ${bin})`,
    });
  });

  child.on("close", (code) => {
    clearTimeout(timeoutHandle);
    clearInterval(heartbeat);

    if (spawnError) {
      completeJob(job);
      return;
    }
    if (code === 0) {
      recordEvent(job, {
        type: "done",
        message:
          chosenTool === "gallery-dl"
            ? `Saved ${galleryCount} file${galleryCount === 1 ? "" : "s"} to ${outDir}`
            : `Saved to ${outDir}`,
        filename: job.currentFilename,
        outputFolder: outDir,
        count: chosenTool === "gallery-dl" ? galleryCount : 1,
      });
    } else {
      // Clean up partial file (yt-dlp leaves .part on abort/error).
      void cleanupPartialFile(outDir, job.currentFilename);
      recordEvent(job, {
        type: "error",
        message: lastErrLine || `${chosenTool} exited with code ${code}`,
      });
    }
    completeJob(job);
  });

  return { job };
}

const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

export async function POST(req: Request): Promise<Response> {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const url = body.url;
  const rawQuality = body.quality ?? "best";
  const rawTool = body.tool ?? "auto";
  const playlist = Boolean(body.playlist);

  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    return new Response("Invalid URL", { status: 400 });
  }
  if (!isQuality(rawQuality)) {
    return new Response("Invalid quality", { status: 400 });
  }
  if (!isTool(rawTool)) {
    return new Response("Invalid tool", { status: 400 });
  }

  const outDir = resolveSafeOutputFolder(body.outputFolder);
  if (!outDir) {
    return new Response(
      `outputFolder must resolve under GRABBER_DOWNLOAD_ROOT (${DOWNLOAD_ROOT}).`,
      { status: 400 },
    );
  }

  try {
    mkdirSync(outDir, { recursive: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(`Cannot create output folder: ${msg}`, { status: 400 });
  }
  try {
    await fsp.access(outDir, fsConstants.W_OK);
  } catch {
    return new Response(`Output folder not writable: ${outDir}`, { status: 400 });
  }

  const started = startJob({ url, quality: rawQuality, tool: rawTool, playlist, outDir });
  if ("error" in started) {
    return new Response(started.error, { status: started.status });
  }
  const { job } = started;

  return new Response(makeSseStream(job, 0), {
    headers: { ...SSE_HEADERS, "X-Grabber-Job-Id": job.jobId },
  });
}
