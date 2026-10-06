// Server-only: the most recent recorded Conflict X-ray (`bench/xray/*.json`,
// written by `npm run bench`) for the app's Clearing screen, so it can show
// measured evidence before anyone runs a crash in this session. Import ONLY
// from Server Components (src/app/app/page.tsx) — it uses node:fs.
//
// Preference: the given chain id first (the network the app runs against),
// then Monad testnet, then anything. Newest file wins. Malformed files are
// skipped, never guessed at.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { normalizeXray, type XrayReport } from "./keeper";

export interface RecordedXray {
  report: XrayReport;
  /** File name inside bench/xray/. */
  file: string;
  /** File mtime, ISO date (YYYY-MM-DD). */
  savedAt: string | null;
}

const MONAD_TESTNET = 10143;

export async function readLatestXray(preferChainId: number | null): Promise<RecordedXray | null> {
  const dir = join(process.cwd(), "bench", "xray");
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
  } catch {
    return null; // no X-ray recorded yet
  }
  const files = await Promise.all(
    names.map(async (file) => {
      try {
        const s = await stat(join(dir, file));
        const chainId = Number(file.split("-")[0]);
        return { file, mtime: s.mtimeMs, chainId: Number.isFinite(chainId) ? chainId : null };
      } catch {
        return null;
      }
    }),
  );
  const rank = (c: number | null) => (c !== null && c === preferChainId ? 0 : c === MONAD_TESTNET ? 1 : 2);
  const ordered = files
    .filter((f): f is NonNullable<typeof f> => f !== null)
    .sort((a, b) => rank(a.chainId) - rank(b.chainId) || b.mtime - a.mtime);
  for (const f of ordered) {
    try {
      const report = normalizeXray(JSON.parse(await readFile(join(dir, f.file), "utf8")));
      if (report) return { report, file: f.file, savedAt: new Date(f.mtime).toISOString().slice(0, 10) };
    } catch {
      /* skip malformed */
    }
  }
  return null;
}
