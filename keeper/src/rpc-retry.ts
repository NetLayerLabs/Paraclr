// Rate-limit retries for every keeper / script RPC client (demo stack and production).

import type { Transport } from "viem";

/**
 * True for a provider's per-second request cap. Monad's public testnet RPC (QuickNode) answers
 * -32007 "50/second request limit reached" or "requests limited to 15/sec", per call, also inside
 * a batch; viem's built-in retry doesn't cover that code. The call was refused, not processed,
 * so retrying it (even eth_sendRawTransaction) is safe.
 */
export function isRateLimited(err: unknown): boolean {
  for (let e = err as { code?: unknown; status?: unknown; message?: unknown; details?: unknown; cause?: unknown } | undefined, depth = 0; e && depth < 8; e = e.cause as typeof e, depth++) {
    if (e.code === -32007 || e.status === 429) return true;
    if (/request limit|requests? limited to|rate.?limit|too many requests/i.test(`${String(e.message ?? "")} ${String(e.details ?? "")}`)) return true;
  }
  return false;
}

/** Retries rate-limited calls with jittered exponential backoff (≈ 0.25 s … 8 s, 10 tries). */
export function withRateLimitRetry(base: Transport): Transport {
  return (opts) => {
    const t = base(opts);
    const request = (async (args: Parameters<typeof t.request>[0], options?: Parameters<typeof t.request>[1]) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await t.request(args, options);
        } catch (err) {
          if (attempt >= 10 || !isRateLimited(err)) throw err;
          await new Promise((r) => setTimeout(r, Math.min(8_000, 250 * 2 ** attempt) * (0.75 + Math.random() / 2)));
        }
      }
    }) as typeof t.request;
    return { ...t, request };
  };
}
