import { JOBS, makeSseStream } from "@/lib/job-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId");
  const sinceTsRaw = url.searchParams.get("sinceTs");
  const sinceTs = sinceTsRaw ? Math.max(0, parseInt(sinceTsRaw, 10) || 0) : 0;

  if (!jobId) {
    return new Response("missing jobId", { status: 400 });
  }
  const job = JOBS.get(jobId);
  if (!job) {
    return new Response("job not found (may have expired)", { status: 404 });
  }

  return new Response(makeSseStream(job, sinceTs), {
    headers: { ...SSE_HEADERS, "X-Grabber-Job-Id": job.jobId },
  });
}
