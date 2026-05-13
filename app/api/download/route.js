import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HOME = os.homedir();
const DEFAULT_OUT = path.join(HOME, "Downloads");
const COOKIES_DIR = path.join(process.cwd(), "cookies");
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const FFMPEG_DIR_FALLBACK = "C:\\ffmpeg\\bin";
const FFMPEG_DIR_CANDIDATES = [
  FFMPEG_DIR_FALLBACK,
  "C:\\Program Files\\ffmpeg\\bin",
  path.join(HOME, "ffmpeg", "bin"),
];

function findFfmpegDir() {
  for (const dir of FFMPEG_DIR_CANDIDATES) {
    if (existsSync(path.join(dir, "ffmpeg.exe"))) return path.normalize(dir);
  }
  return path.normalize(FFMPEG_DIR_FALLBACK);
}

function findCookiesFile(url) {
  if (!existsSync(COOKIES_DIR)) return null;
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  let files;
  try {
    files = readdirSync(COOKIES_DIR).filter((f) => f.toLowerCase().endsWith(".txt"));
  } catch {
    return null;
  }
  if (!files.length) return null;
  // Prefer a filename that matches the hostname (e.g. noodlemagazine.txt)
  const match = files.find((f) => {
    const stem = f.replace(/\.txt$/i, "").toLowerCase();
    return stem && (host === stem || host.endsWith("." + stem) || host.includes(stem));
  });
  return path.join(COOKIES_DIR, match || files[0]);
}

function cookieArgs(url) {
  const file = findCookiesFile(url);
  if (file) return ["--cookies", file];
  return ["--cookies-from-browser", "firefox"];
}

const YTDLP_CANDIDATES = [
  path.join(HOME, "yt-dlp.exe"),
  path.join(HOME, ".local", "bin", "yt-dlp.exe"),
  path.join(HOME, "Downloads", "yt-dlp.exe"),
  "C:\\ffmpeg\\bin\\yt-dlp.exe",
  "C:\\Program Files\\yt-dlp\\yt-dlp.exe",
  "C:\\ProgramData\\chocolatey\\bin\\yt-dlp.exe",
];

const GALLERY_DL_CANDIDATES = [
  path.join(HOME, ".local", "bin", "gallery-dl.exe"),
  path.join(HOME, "gallery-dl.exe"),
  path.join(HOME, "Downloads", "gallery-dl.exe"),
  "C:\\Program Files\\gallery-dl\\gallery-dl.exe",
];

function resolveBinary(name, candidates) {
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

let ytdlpResolved = null;
let galleryDlResolved = null;
function getYtdlp() {
  if (ytdlpResolved && existsSync(ytdlpResolved)) return ytdlpResolved;
  ytdlpResolved = resolveBinary("yt-dlp", YTDLP_CANDIDATES);
  return ytdlpResolved;
}
function getGalleryDl() {
  if (galleryDlResolved && existsSync(galleryDlResolved)) return galleryDlResolved;
  galleryDlResolved = resolveBinary("gallery-dl", GALLERY_DL_CANDIDATES);
  return galleryDlResolved;
}

const QUALITIES = new Set(["best", "1080p", "720p", "480p", "audio"]);
const TOOLS = new Set(["auto", "yt-dlp", "gallery-dl"]);

const GALLERY_HOSTS = [
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

// Hosts that benefit from gallery-dl for /thread/ or gallery-style URLs but use yt-dlp for video pages.
// Returns "gallery-dl" if URL pathname looks gallery-ish, otherwise null (let default rules apply).
function urlPrefersGallery(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const p = u.pathname.toLowerCase();
    if (host.endsWith("xhamster.com") && (p.includes("/photos/") || p.includes("/gallery/"))) {
      return "gallery-dl";
    }
  } catch {}
  return null;
}

function detectTool(url) {
  const prefer = urlPrefersGallery(url);
  if (prefer) return prefer;
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const g of GALLERY_HOSTS) {
      if (host === g || host.endsWith("." + g)) return "gallery-dl";
    }
  } catch {}
  return "yt-dlp";
}

function ytdlpArgs(url, quality, outDir, { playlist = false, ffmpegDir = null } = {}) {
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
    return [
      ...common,
      "-x",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "0",
      "-o",
      out,
      url,
    ];
  }

  // HLS-friendly format chain: prefer mp4+m4a (direct merge), fall back to any
  // bestvideo+bestaudio combo, then to a single combined "best" stream.
  // Height-restricted qualities prepend [height<=N] to the first two preferences.
  let format;
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

  return [
    ...common,
    "--format",
    format,
    "--merge-output-format",
    "mp4",
    "-o",
    out,
    url,
  ];
}

function galleryArgs(url, outDir) {
  const args = [
    "-D",
    outDir,
    "--user-agent",
    USER_AGENT,
  ];
  // gallery-dl uses different flags than yt-dlp for cookies
  const file = findCookiesFile(url);
  if (file) {
    args.push("--cookies", file);
  } else {
    args.push("--cookies-from-browser", "firefox");
  }
  args.push(url);
  return args;
}

function parseYtdlpProgress(line) {
  const m = line.match(
    /^\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\s*\w+)(?:\s+at\s+([\d.]+\s*\w+\/s))?(?:\s+ETA\s+([\d:\-]+))?/
  );
  if (!m) return null;
  return {
    percent: Math.min(100, Math.max(0, parseFloat(m[1]))),
    size: (m[2] || "").trim(),
    speed: (m[3] || "").trim(),
    eta: (m[4] || "").trim(),
  };
}

function parseDestination(line) {
  const m = line.match(/^\[download\]\s+Destination:\s+(.+)$/);
  if (m) return m[1].trim();
  const m2 = line.match(/^\[Merger\]\s+Merging formats into\s+"(.+)"\s*$/);
  if (m2) return m2[1].trim();
  const m3 = line.match(/^\[ExtractAudio\]\s+Destination:\s+(.+)$/);
  if (m3) return m3[1].trim();
  return null;
}

function lineBuffer(onLine) {
  let buf = "";
  return (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.search(/\r\n|\n|\r/)) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + (buf.substr(idx, 2) === "\r\n" ? 2 : 1));
      onLine(line);
    }
  };
}

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const {
    url,
    quality = "best",
    outputFolder,
    tool = "auto",
    playlist = false,
  } = body || {};
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    return new Response("Invalid URL", { status: 400 });
  }
  if (!QUALITIES.has(quality)) {
    return new Response("Invalid quality", { status: 400 });
  }
  if (!TOOLS.has(tool)) {
    return new Response("Invalid tool", { status: 400 });
  }

  const rawOut =
    typeof outputFolder === "string" && outputFolder.trim()
      ? outputFolder.trim()
      : DEFAULT_OUT;
  const outDir = path.normalize(rawOut);

  try {
    mkdirSync(outDir, { recursive: true });
  } catch (err) {
    return new Response(`Cannot create output folder: ${err.message}`, {
      status: 400,
    });
  }

  const chosenTool = tool === "auto" ? detectTool(url) : tool;
  const ffmpegDir = findFfmpegDir();

  let bin, args;
  if (chosenTool === "gallery-dl") {
    bin = getGalleryDl();
    if (!bin) {
      return new Response(
        `gallery-dl not found. Looked in:\n${GALLERY_DL_CANDIDATES.join("\n")}\nand on PATH. Install gallery-dl or place it at one of these paths.`,
        { status: 500 }
      );
    }
    args = galleryArgs(url, outDir);
  } else {
    bin = getYtdlp();
    if (!bin) {
      return new Response(
        `yt-dlp not found. Looked in:\n${YTDLP_CANDIDATES.join("\n")}\nand on PATH. Install yt-dlp or place it at one of these paths.`,
        { status: 500 }
      );
    }
    args = ytdlpArgs(url, quality, outDir, { playlist: !!playlist, ffmpegDir });
  }

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      let closed = false;
      const send = (obj) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {}
      };

      send({
        type: "status",
        message: `Launching ${chosenTool} (${bin})`,
        tool: chosenTool,
      });

      let child;
      try {
        child = spawn(bin, args, { windowsHide: true });
      } catch (err) {
        send({
          type: "error",
          message: `Failed to start ${chosenTool}: ${err.message}`,
        });
        close();
        return;
      }

      let lastErrLine = "";
      let currentFilename = "";
      let galleryCount = 0;

      const handleYtdlpLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        const dest = parseDestination(trimmed);
        if (dest) {
          currentFilename = path.basename(dest);
          send({
            type: "status",
            message: `Downloading ${currentFilename}`,
            filename: currentFilename,
            path: dest,
          });
          return;
        }

        const prog = parseYtdlpProgress(trimmed);
        if (prog) {
          send({
            type: "progress",
            ...prog,
            filename: currentFilename,
          });
          return;
        }

        if (
          trimmed.startsWith("[Merger]") ||
          trimmed.startsWith("[ExtractAudio]") ||
          trimmed.startsWith("[ffmpeg]")
        ) {
          send({ type: "status", message: trimmed });
        }
      };

      const handleGalleryLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        // gallery-dl prints downloaded paths plain or prefixed with `# ` (skipped) / `* ` (skipped exists)
        // a downloaded file is just a path on its own line (no leading marker)
        if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("/")) {
          galleryCount++;
          currentFilename = path.basename(trimmed);
          send({
            type: "progress",
            indeterminate: true,
            filename: currentFilename,
            path: trimmed,
            count: galleryCount,
          });
          return;
        }
        if (trimmed.startsWith("# ") || trimmed.startsWith("* ")) {
          // skipped existing
          send({ type: "status", message: trimmed });
        }
      };

      const onLine =
        chosenTool === "gallery-dl" ? handleGalleryLine : handleYtdlpLine;

      child.stdout.on("data", lineBuffer(onLine));
      child.stderr.on(
        "data",
        lineBuffer((line) => {
          const t = line.trim();
          if (!t) return;
          lastErrLine = t;
          if (/^ERROR/i.test(t) || /\[error\]/i.test(t)) {
            send({ type: "error", message: t });
          }
        })
      );

      let spawnError = null;
      child.on("error", (err) => {
        spawnError = err;
        send({
          type: "error",
          message: `Failed to start ${chosenTool}: ${err.message} (path: ${bin})`,
        });
        // Don't close here — wait for 'close' to fire (it usually does, even on spawn failure).
        // If it doesn't, the safety timer below closes us out.
        setTimeout(() => {
          if (!closed) close();
        }, 250);
      });

      child.on("close", (code) => {
        if (spawnError) {
          close();
          return;
        }
        if (code === 0) {
          send({
            type: "done",
            message:
              chosenTool === "gallery-dl"
                ? `Saved ${galleryCount} file${galleryCount === 1 ? "" : "s"} to ${outDir}`
                : `Saved to ${outDir}`,
            filename: currentFilename,
            outputFolder: outDir,
            count: chosenTool === "gallery-dl" ? galleryCount : 1,
          });
        } else {
          send({
            type: "error",
            message: lastErrLine || `${chosenTool} exited with code ${code}`,
          });
        }
        close();
      });

      const abort = () => {
        if (child && !child.killed) {
          try {
            child.kill();
          } catch {}
        }
        // Let 'close' fire and deliver the final frame; don't close the stream here.
      };
      req.signal.addEventListener("abort", abort);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
