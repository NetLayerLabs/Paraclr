"use client";

// Mounted once by AppShell. Runs the price source and fans every tick out to
// the global store (pushPrice) and the candle store:
//   - sim mode, or chain mode that fell back: Chainlink Data Streams when
//     configured, simulator otherwise, with the flash-crash `priceShock`;
//   - chain mode live: the on-chain oracle (OraclePriceSource) — the exact
//     marks the clearinghouse uses. No client-side shock is ever applied to
//     it; on chain the crash is a real oracle transaction.

import { useEffect } from "react";
import { getState, pushPrice, useParaclr } from "@/lib/store";
import { CANDLE_MS, MAX_CANDLES, OraclePriceSource, createPriceSource, type PriceSource } from "@/lib/prices";
import { ingestTick, resetFeeds, seedHistory } from "@/lib/prices/feedStore";

// The applied shock follows `priceShock` through an under-damped spring, so a
// jump 1 → 0.8 plays out as a ~1.5s slide that overshoots a couple of percent
// and bounces — a visible crash wick on the chart instead of a teleport.
const STIFFNESS = 18; // 1/s²
const DAMPING = 5.2; // 1/s
const SPRING_STEP_MS = 16;
/** Don't hold live prices back for more than this while backfilling. */
const BACKFILL_TIMEOUT_MS = 4_000;

export function PriceFeedProvider() {
  const status = useParaclr((s) => s.chain.status);
  const oracle = useParaclr((s) => s.chain.contracts?.oracle ?? null);
  const markets = useParaclr((s) => s.chain.contracts?.markets ?? null);
  const deployBlock = useParaclr((s) => s.chain.contracts?.deployBlock ?? null);

  useEffect(() => {
    // Chain mode still probing: wait so we don't mix simulated and on-chain ticks.
    if (status === "connecting") return;

    const onChain = status === "ready" && oracle !== null && markets !== null;
    const source: PriceSource = onChain
      ? new OraclePriceSource({ oracle, markets, deployBlock })
      : createPriceSource();

    let cancelled = false;
    let stop: (() => void) | null = null;
    let spring: ReturnType<typeof setInterval> | undefined;

    if (!onChain) {
      const history = source.history?.(CANDLE_MS, MAX_CANDLES);
      if (history) seedHistory(history);

      let shock = getState().priceShock;
      let velocity = 0;
      let lastT = performance.now();
      spring = setInterval(() => {
        const now = performance.now();
        let dt = Math.min(250, now - lastT);
        lastT = now;
        const target = getState().priceShock;
        if (shock === target && velocity === 0) return;
        while (dt > 0) {
          const h = Math.min(SPRING_STEP_MS, dt) / 1000;
          const accel = STIFFNESS * (target - shock) - DAMPING * velocity;
          velocity += accel * h;
          shock += velocity * h;
          dt -= SPRING_STEP_MS;
        }
        if (Math.abs(target - shock) < 1e-5 && Math.abs(velocity) < 1e-4) {
          shock = target;
          velocity = 0;
        }
      }, 33);

      stop = source.start((tick) => {
        const shocked = shock === 1 ? tick : { ...tick, price: tick.price * shock };
        pushPrice(shocked);
        ingestTick(shocked);
      });
    } else {
      resetFeeds();
      const begin = () => {
        if (cancelled) return;
        stop = source.start((tick) => {
          pushPrice(tick);
          ingestTick(tick);
        });
      };
      const backfill = source.backfill?.(CANDLE_MS, MAX_CANDLES);
      if (!backfill) begin();
      else {
        const timeout = new Promise<null>((r) => setTimeout(() => r(null), BACKFILL_TIMEOUT_MS));
        Promise.race([backfill, timeout])
          .then((h) => {
            if (h && !cancelled) seedHistory(h);
          })
          .catch(() => undefined)
          .finally(begin);
      }
    }

    return () => {
      cancelled = true;
      stop?.();
      if (spring) clearInterval(spring);
    };
  }, [status, oracle, markets, deployBlock]);

  return null;
}
