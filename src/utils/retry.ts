export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const status = err?.status ?? err?.statusCode ?? 0;

      // 400-level errors (except 429): don't retry
      if (status >= 400 && status < 500 && status !== 429) {
        throw err;
      }

      if (attempt === maxRetries) break;

      let waitMs: number;
      if (status === 429) {
        // Rate limited: wait 60s
        waitMs = 60_000;
        console.warn(`[retry] Rate limited (429). Waiting 60s...`);
      } else if (status >= 500) {
        // Server error: escalating wait
        const delays = [60_000, 300_000, 1_800_000]; // 1m, 5m, 30m
        waitMs = delays[attempt] ?? 1_800_000;
        console.warn(`[retry] Server error (${status}). Waiting ${waitMs / 1000}s...`);
      } else {
        // Generic error: exponential backoff
        waitMs = Math.pow(2, attempt) * 1000;
        console.warn(`[retry] Attempt ${attempt + 1} failed. Waiting ${waitMs / 1000}s...`);
      }

      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  throw lastError ?? new Error("withRetry exhausted all retries");
}
