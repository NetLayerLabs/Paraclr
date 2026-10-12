// Records a Paraclr transaction on the Monad testnet explorer (MonadVision, where the app's
// "↗" tx links land). The explorer shows a bot check to headless Chrome, so this one clip is
// recorded in a visible window (1600x900 CSS px, device scale 2).
//   TX=0x... node scripts/explorer.mjs   -> .cache/frames/explorer/ (then npm run encode)
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { launch, sleep } from "./cdp.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const TX = process.env.TX;
if (!/^0x[0-9a-f]{64}$/i.test(TX || "")) { console.error("TX=0x<64 hex> required"); process.exit(1); }
const dir = join(ROOT, ".cache/frames/explorer");
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
const b = await launch({ width: 1600, height: 900, scale: 2, headless: false,
  extraArgs: ["--force-device-scale-factor=2", "--window-position=30,30", "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion"] });
console.log("chrome pid", b.pid);
try {
  await b.goto(`https://testnet.monadvision.com/tx/${TX}`, 15000);
  for (let i = 0; i < 20 && !(await b.js("document.title")).includes("Transaction"); i++) await sleep(1000);
  console.log("title:", await b.js("document.title"));
  // hide the floating feedback button; it is site chrome, not data
  await b.js(`(() => { const s = document.createElement('style'); s.textContent = '[class*=feedback i],[id*=feedback i]{display:none!important}'; document.head.appendChild(s); })()`);
  await sleep(1500);
  const stop = await b.screencast(dir);
  await sleep(4000);
  await b.js(`(() => { const el = document.scrollingElement; const from = el.scrollTop, to = 360, t0 = performance.now(); const f = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2); const step = (now) => { const p = Math.min(1, (now - t0) / 2200); el.scrollTop = from + (to - from) * f(p); if (p < 1) requestAnimationFrame(step); }; requestAnimationFrame(step); })()`);
  await sleep(6000);
  const frames = await stop();
  await b.shot(join(ROOT, ".cache/shots/explorer.png"));
  console.log(`explorer: ${frames.length} frames`);
  console.log(await b.js("document.body.innerText.slice(0, 900).replace(/\\s+/g, ' ')"));
} finally { b.close(); }
