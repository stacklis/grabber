/**
 * Run an array of async task factories with a max concurrency cap.
 * Each factory returns a Promise on call; we never invoke more than
 * `limit` factories at once. `onSlotChange` fires whenever the active
 * slot count changes (used for UI queue indicators).
 */
export async function withConcurrencyLimit<T>(
  limit: number,
  tasks: ReadonlyArray<() => Promise<T>>,
  onSlotChange?: (activeCount: number, queuedCount: number) => void,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let active = 0;
  let nextIndex = 0;
  let queued = tasks.length;
  onSlotChange?.(active, queued);

  return new Promise<T[]>((resolve, reject) => {
    let settled = false;
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const tryStart = (): void => {
      while (active < limit && nextIndex < tasks.length) {
        const i = nextIndex++;
        active++;
        queued--;
        onSlotChange?.(active, queued);
        const fn = tasks[i];
        if (!fn) continue;
        fn()
          .then((r) => {
            results[i] = r;
          })
          .catch((err) => {
            fail(err);
          })
          .finally(() => {
            active--;
            onSlotChange?.(active, queued);
            if (settled) return;
            if (active === 0 && nextIndex >= tasks.length) {
              settled = true;
              resolve(results);
            } else {
              tryStart();
            }
          });
      }
      if (tasks.length === 0) {
        settled = true;
        resolve(results);
      }
    };

    tryStart();
  });
}
