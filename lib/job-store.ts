import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { DownloadEvent } from "./sse-events";

export type RecordedEvent = {
  ts: number;
  event: DownloadEvent;
};

export type JobState = {
  jobId: string;
  child: ChildProcessWithoutNullStreams;
  events: RecordedEvent[];
  lastEventTs: number;
  startedAt: number;
  completed: boolean;
  emitter: EventEmitter;
  outDir: string;
  currentFilename: string;
  tool: "yt-dlp" | "gallery-dl";
};

// Module-level singleton — persists for the lifetime of the Node process.
// Shared by /api/download (POST) and /api/download/resume (GET).
export const JOBS: Map<string, JobState> = new Map();

/**
 * Build an SSE ReadableStream that:
 *   1. Replays buffered events with ts > sinceTs.
 *   2. If the job is already completed at replay end, closes the stream.
 *   3. Else, subscribes to live events until `done` / `error` arrives.
 *
 * Wire format uses standard SSE `id:` lines carrying the server-side ts,
 * so the client can pass the last seen id back as `sinceTs` on reconnect.
 */
export function makeSseStream(job: JobState, sinceTs: number): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      let closed = false;
      let liveSubscribed = false;
      const write = (rec: RecordedEvent): void => {
        if (closed) return;
        try {
          controller.enqueue(
            enc.encode(`id: ${rec.ts}\ndata: ${JSON.stringify(rec.event)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };
      const onEvent = (rec: RecordedEvent): void => {
        write(rec);
        if (rec.event.type === "done" || rec.event.type === "error") {
          close();
        }
      };
      const close = (): void => {
        if (closed) return;
        closed = true;
        if (liveSubscribed) job.emitter.off("event", onEvent);
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      };

      // Replay buffered events newer than sinceTs.
      for (const rec of job.events) {
        if (rec.ts > sinceTs) write(rec);
      }

      if (job.completed) {
        close();
        return;
      }

      liveSubscribed = true;
      job.emitter.on("event", onEvent);
    },
  });
}
