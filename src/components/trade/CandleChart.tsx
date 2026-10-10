"use client";

import { CARET_PATH } from "@/components/brand/Glyph";
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type { MarketSymbol, Position } from "@/lib/types";
import { liquidationPrice, useParaclr } from "@/lib/store";
import { useMarketFeed } from "@/lib/prices/feedStore";
import { MAX_CANDLES } from "@/lib/prices/markets";
import { fmtClock, fmtPct, fmtPrice } from "./format";
import styles from "./CandleChart.module.css";

/** Phone height; on wider layouts the chart fills whatever its container gives it. */
const DEFAULT_H = 232;
const PAD_T = 12;
const PAD_B = 20;
const AXIS_W = 62;
const LABEL_H = 16;

interface Level {
  key: string;
  price: number;
  label: string;
  kind: "entry-long" | "entry-short" | "liq";
}

export function CandleChart({ symbol }: { symbol: MarketSymbol }) {
  const feed = useMarketFeed(symbol);
  const allPositions = useParaclr((s) => s.positions);
  const positions = useMemo(
    () => allPositions.filter((p) => p.symbol === symbol),
    [allPositions, symbol],
  );

  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 368, h: DEFAULT_H });
  const [hover, setHover] = useState<number | null>(null);

  // The wrapper's size comes from CSS (fixed height on phones, flex-filled on
  // desktop); the SVG is absolutely positioned inside it, so no feedback loop.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      const h = Math.round(entry.contentRect.height);
      // Hidden tabs report 0×0; keep the last real size.
      if (w > 0 && h > 0) setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const width = size.w;
  const H = Math.max(160, size.h);
  const gridRows = H >= 380 ? 6 : 4;

  const candles = feed.candles;
  const plotW = width - AXIS_W;
  const plotH = H - PAD_T - PAD_B;
  const slot = plotW / MAX_CANDLES;
  const bodyW = Math.max(2, slot * 0.64);
  // Right-align: newest candle hugs the axis.
  const x0 = plotW - candles.length * slot;

  const levels: Level[] = useMemo(
    () =>
      positions.flatMap((p: Position) => [
        {
          key: `${p.id}-e`,
          price: p.entryPrice,
          label: `${p.side === "long" ? "L" : "S"} ${p.leverage}x`,
          kind: p.side === "long" ? ("entry-long" as const) : ("entry-short" as const),
        },
        { key: `${p.id}-l`, price: liquidationPrice(p), label: "LIQ", kind: "liq" as const },
      ]),
    [positions],
  );

  const { min, max } = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of candles) {
      if (c.low < lo) lo = c.low;
      if (c.high > hi) hi = c.high;
    }
    if (!Number.isFinite(lo)) return { min: 0, max: 1 };
    // Pull position levels into view when they're reasonably close.
    const span = Math.max(hi - lo, hi * 0.002);
    for (const l of levels) {
      if (l.price > 0 && l.price >= lo - span * 1.2 && l.price <= hi + span * 1.2) {
        lo = Math.min(lo, l.price);
        hi = Math.max(hi, l.price);
      }
    }
    const pad = Math.max(hi - lo, hi * 0.002) * 0.08;
    return { min: lo - pad, max: hi + pad };
  }, [candles, levels]);

  const y = (p: number) => PAD_T + ((max - p) / (max - min)) * plotH;
  const clampY = (v: number) => Math.min(PAD_T + plotH - LABEL_H / 2, Math.max(PAD_T + LABEL_H / 2, v));

  const gridPrices = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i <= gridRows; i++) out.push(max - ((max - min) * i) / gridRows);
    return out;
  }, [min, max, gridRows]);

  const last = candles[candles.length - 1];
  const shown = hover != null ? candles[hover] : last;
  const lastPrice = feed.last ?? last?.close;
  const lastUp = feed.dir >= 0;

  const onPointer = (e: PointerEvent<SVGSVGElement>) => {
    if (!candles.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const i = Math.floor((px - x0) / slot);
    setHover(Math.min(candles.length - 1, Math.max(0, i)));
  };

  const chg = shown ? ((shown.close - shown.open) / shown.open) * 100 : 0;

  return (
    <section className={styles.card}>
      <div className={styles.head}>
        <div className={styles.tf}>
          <span className={styles.tfActive}>5s</span>
          <span className={styles.live}>
            <span className={styles.liveDot} />
            LIVE
          </span>
        </div>
        {shown && (
          <div className={`mono ${styles.ohlc}`}>
            <span>
              O <b>{fmtPrice(symbol, shown.open)}</b>
            </span>
            <span>
              H <b>{fmtPrice(symbol, shown.high)}</b>
            </span>
            <span>
              L <b>{fmtPrice(symbol, shown.low)}</b>
            </span>
            <span className={chg >= 0 ? styles.up : styles.down}>{fmtPct(chg)}</span>
          </div>
        )}
      </div>

      <div ref={wrapRef} className={styles.wrap}>
        <svg
          className={styles.svg}
          width={width}
          height={H}
          viewBox={`0 0 ${width} ${H}`}
          onPointerDown={onPointer}
          onPointerMove={(e) => (e.pointerType === "mouse" || e.buttons ? onPointer(e) : undefined)}
          onPointerLeave={() => setHover(null)}
          onPointerUp={(e) => e.pointerType !== "mouse" && setHover(null)}
          onPointerCancel={() => setHover(null)}
          role="img"
          aria-label={`${symbol} 5-second candlestick chart`}
        >
          <defs>
            <linearGradient id="cc-fade" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0" style={{ stopColor: "var(--bg)", stopOpacity: 1 }} />
              <stop offset="1" style={{ stopColor: "var(--bg)", stopOpacity: 0 }} />
            </linearGradient>
          </defs>

          {/* grid + axis */}
          {gridPrices.map((p, i) => (
            <g key={i}>
              <line x1={0} x2={plotW} y1={y(p)} y2={y(p)} className={styles.grid} />
              <text x={plotW + 6} y={y(p) + 3.5} className={styles.axisText}>
                {fmtPrice(symbol, p)}
              </text>
            </g>
          ))}

          {/* time labels, once per minute */}
          {candles.map((c, i) =>
            c.time % 60_000 === 0 ? (
              <text
                key={`t${c.time}`}
                x={x0 + i * slot + slot / 2}
                y={H - 5}
                textAnchor="middle"
                className={styles.axisText}
              >
                {fmtClock(c.time).slice(0, 5)}
              </text>
            ) : null,
          )}

          {/* candles */}
          {candles.map((c, i) => {
            const up = c.close >= c.open;
            const cx = x0 + i * slot + slot / 2;
            const top = y(Math.max(c.open, c.close));
            const bot = y(Math.min(c.open, c.close));
            const isLast = i === candles.length - 1;
            return (
              <g
                key={c.time}
                className={`${up ? styles.candleUp : styles.candleDown} ${
                  hover != null && hover !== i ? styles.dim : ""
                }`}
              >
                <line x1={cx} x2={cx} y1={y(c.high)} y2={y(c.low)} className={styles.wick} />
                <rect
                  x={cx - bodyW / 2}
                  y={top}
                  width={bodyW}
                  height={Math.max(1, bot - top)}
                  rx={Math.min(1.5, bodyW / 4)}
                  className={isLast ? styles.bodyLive : styles.body}
                />
              </g>
            );
          })}

          {/* left fade so the oldest candles recede */}
          <rect x={0} y={0} width={28} height={H - PAD_B} fill="url(#cc-fade)" pointerEvents="none" />

          {/* position levels */}
          {levels.map((l) => {
            const raw = y(l.price);
            const off = raw < PAD_T ? "up" : raw > PAD_T + plotH ? "down" : null;
            const ly = clampY(raw);
            const cls =
              l.kind === "liq" ? styles.lvLiq : l.kind === "entry-long" ? styles.lvLong : styles.lvShort;
            return (
              <g key={l.key} className={cls}>
                {!off && <line x1={0} x2={plotW} y1={ly} y2={ly} className={styles.lvLine} />}
                <rect x={plotW + 1} y={ly - LABEL_H / 2} width={AXIS_W - 2} height={LABEL_H} rx={4} className={styles.lvTag} />
                {off && (
                  <path
                    d={CARET_PATH[off]}
                    transform={`translate(${plotW + 4} ${ly - 4}) scale(0.5)`}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2.4}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={styles.lvCaret}
                  />
                )}
                <text x={plotW + AXIS_W / 2 + (off ? 4 : 0)} y={ly + 3.5} textAnchor="middle" className={styles.lvText}>
                  {l.kind === "liq" ? fmtPrice(symbol, l.price) : l.label}
                </text>
                {!off && (
                  <text x={4} y={ly - 4} className={styles.lvLabel}>
                    {l.kind === "liq" ? `LIQ ${fmtPrice(symbol, l.price)}` : `${l.label} entry`}
                  </text>
                )}
              </g>
            );
          })}

          {/* last price line + tag */}
          {lastPrice != null && candles.length > 0 && (
            <g className={lastUp ? styles.lastUp : styles.lastDown}>
              <line x1={0} x2={plotW} y1={y(lastPrice)} y2={y(lastPrice)} className={styles.lastLine} />
              <rect
                x={plotW + 1}
                y={clampY(y(lastPrice)) - LABEL_H / 2 - 1}
                width={AXIS_W - 2}
                height={LABEL_H + 2}
                rx={4}
                className={styles.lastTag}
              />
              <text
                x={plotW + AXIS_W / 2}
                y={clampY(y(lastPrice)) + 3.5}
                textAnchor="middle"
                className={styles.lastText}
              >
                {fmtPrice(symbol, lastPrice)}
              </text>
            </g>
          )}

          {/* crosshair */}
          {hover != null && candles[hover] && (
            <line
              x1={x0 + hover * slot + slot / 2}
              x2={x0 + hover * slot + slot / 2}
              y1={PAD_T}
              y2={PAD_T + plotH}
              className={styles.cross}
            />
          )}
        </svg>
        {candles.length === 0 && <div className={styles.empty}>Connecting to price stream…</div>}
      </div>
    </section>
  );
}
