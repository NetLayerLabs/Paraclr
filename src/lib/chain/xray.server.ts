// Server-only: the most recent recorded Conflict X-ray (`bench/xray/*.json`,
// written by `npm run bench`) for the app's Clearing screen, so it can show
// measured evidence before anyone runs a crash in this session. Import ONLY
// from Server Components (src/app/app/page.tsx) - it uses node:fs.
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
  // Newest by the report's own `generatedAt` (file mtimes are all the checkout time on a fresh clone or
  // deploy; the mtime is only the fallback for a report without one). Only the chosen file is parsed in full.
  const files = await Promise.all(
    names.map(async (file) => {
      try {
        const path = join(dir, file);
        const [st, raw] = await Promise.all([stat(path), readFile(path, "utf8")]);
        const gen = /"generatedAt"\s*:\s*"([^"]+)"/.exec(raw)?.[1];
        const genMs = gen ? Date.parse(gen) : NaN;
        const chainId = Number(file.split("-")[0]);
        return { file, raw, at: Number.isFinite(genMs) ? genMs : st.mtimeMs, chainId: Number.isFinite(chainId) ? chainId : null };
      } catch {
        return null;
      }
    }),
  );
  const rank = (c: number | null) => (c !== null && c === preferChainId ? 0 : c === MONAD_TESTNET ? 1 : 2);
  const ordered = files
    .filter((f): f is NonNullable<typeof f> => f !== null)
    .sort((a, b) => rank(a.chainId) - rank(b.chainId) || b.at - a.at);
  for (const f of ordered) {
    try {
      const report = normalizeXray(JSON.parse(f.raw));
      if (report) return { report, file: f.file, savedAt: new Date(f.at).toISOString().slice(0, 10) };
    } catch {
      /* skip malformed */
    }
  }
  return null;
}
