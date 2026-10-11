// A long-lived headless Chrome on the live site, driven step by step for the footage capture
// (the signed-in app can only be explored after the sign-in, so its clips are recorded
// interactively rather than by one blind script). Window 1600x900 CSS px at device scale 2.
//   node scripts/session.mjs                      starts Chrome + a control server on 127.0.0.1:$PORT (default 9777)
//   curl -s localhost:9777 --data-binary @step.js  runs step.js (an async function body) with the helpers below in scope
// Recordings land in .cache/frames/<clip>/ with marks in .cache/marks.json and rects in .cache/meta.json,
// the same layout scripts/encode.mjs reads. The Chrome profile lives in .cache/profile (local only).
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launch, sleep } from "./cdp.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const FRAMES = join(ROOT, ".cache/frames");
const STILLS = join(ROOT, "public/stills");
const PORT = Number(process.env.PORT || 9777);
const SCALE = 2;
const VIEW = { w: 1600, h: 900 };
mkdirSync(FRAMES, { recursive: true });
mkdirSync(STILLS, { recursive: true });
const PROFILE = join(ROOT, ".cache/profile");
mkdirSync(PROFILE, { recursive: true });

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {});
const marks = readJson(join(ROOT, ".cache/marks.json"));
const meta = readJson(join(ROOT, ".cache/meta.json"));
const save = () => {
  writeFileSync(join(ROOT, ".cache/marks.json"), JSON.stringify(marks, null, 1));
  writeFileSync(join(ROOT, ".cache/meta.json"), JSON.stringify(meta, null, 1));
};
const mark = (k) => { marks[k] = Date.now() / 1000; save(); return k; };

const b = await launch({ width: VIEW.w, height: VIEW.h, scale: SCALE, userDataDir: PROFILE, extraArgs: [`--force-device-scale-factor=${SCALE}`] });
writeFileSync(join(ROOT, ".cache/session.pid"), String(b.pid));
const js = (e) => b.js(e);

// Film pointer (headless Chrome draws none), a click ring, and an eased scroll helper.
const OVERLAY = `(() => {
  window.__ease = (el, prop, to, ms) => new Promise((done) => {
    const from = el[prop]; const start = performance.now();
    const f = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const step = (now) => { const p = Math.min(1, (now - start) / ms); el[prop] = from + (to - from) * f(p); if (p < 1) requestAnimationFrame(step); else done(el[prop]); };
    requestAnimationFrame(step);
  });
  if (document.getElementById('__cur')) return;
  const s = document.createElement('style');
  s.textContent = '#__cur{position:fixed;left:-40px;top:-40px;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(255,255,255,.97);box-shadow:0 0 0 2px rgba(110,84,255,.85),0 4px 14px rgba(0,0,0,.45);z-index:2147483647;pointer-events:none;opacity:0;transition:opacity .3s ease,transform .12s ease-out,left .8s cubic-bezier(.22,1,.36,1),top .8s cubic-bezier(.22,1,.36,1)}#__cur.down{transform:scale(.7)}.__ring{position:fixed;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;border:2px solid rgba(110,84,255,.8);z-index:2147483646;pointer-events:none;animation:__r .6s ease-out forwards}@keyframes __r{from{transform:scale(.3);opacity:1}to{transform:scale(1.5);opacity:0}}';
  document.head.appendChild(s);
  const c = document.createElement('div'); c.id = '__cur'; document.body.appendChild(c);
})()`;
const overlay = () => js(OVERLAY);
async function goto(url, settle = 6000) { await b.goto(url, settle); await overlay(); }
async function glide(x, y, settle = 900) {
  await overlay();
  await js(`(() => { const k = document.getElementById('__cur'); if (k) { k.style.opacity = '1'; k.style.left = '${x}px'; k.style.top = '${y}px'; } })()`);
  await sleep(820);
  await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await sleep(Math.max(0, settle - 820));
}
async function clickAt(x, y) {
  await js(`(() => { const k = document.getElementById('__cur'); k?.classList.add('down'); const r = document.createElement('div'); r.className = '__ring'; r.style.left = '${x}px'; r.style.top = '${y}px'; document.body.appendChild(r); setTimeout(() => { k?.classList.remove('down'); r.remove(); }, 650); })()`);
  await b.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await sleep(90);
  await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}
const centerOf = (finder) => js(`(() => { const e = ${finder}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
/** Finder for the first visible element matching selector whose text starts with/contains `text`. */
const byText = (text, sel = "button,a,[role=button],label,input") => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (e.innerText || e.value || e.getAttribute('aria-label') || '').trim().includes(${JSON.stringify(text)}); })`;
async function press(finder, settle = 900) {
  const c = await centerOf(finder);
  if (!c) throw new Error("press: not found " + finder.slice(0, 120));
  await glide(c.x, c.y, settle);
  await clickAt(c.x, c.y);
  return c;
}
async function typeText(text, perChar = 70) {
  for (const ch of text) { await b.send("Input.insertText", { text: ch }); await sleep(perChar + Math.random() * 40); }
}
const park = () => b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: VIEW.w - 6, y: VIEW.h - 4 });
const hideCursor = () => js(`(() => { const k = document.getElementById('__cur'); if (k) k.style.opacity = '0'; })()`);
const ease = (finder, to, ms) => js(`window.__ease(${finder ?? "document.scrollingElement"}, 'scrollTop', ${to}, ${ms})`);
const rectOf = async (finder) => { const r = await b.rectOf(finder); return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null; };
const text = (finder = "document.body") => js(`(${finder})?.innerText ?? null`);
const shot = (name, finder) => b.shot(join(name.startsWith("/") ? "" : ROOT, name.startsWith("/") ? name : `.cache/shots/${name}.png`), finder);
mkdirSync(join(ROOT, ".cache/shots"), { recursive: true });
const still = (name, finder) => b.shot(join(STILLS, `${name}.png`), finder);

let stopRec = null, recName = null;
async function rec(name) {
  const dir = join(FRAMES, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  stopRec = await b.screencast(dir);
  recName = name;
  mark(`${name}:start`);
  return name;
}
async function endRec() {
  if (!stopRec) return null;
  mark(`${recName}:end`);
  const frames = await stopRec();
  stopRec = null;
  const span = frames.length > 1 ? frames[frames.length - 1].t - frames[0].t : 0;
  const r = `${recName}: ${frames.length} frames over ${span.toFixed(1)}s`;
  recName = null;
  return r;
}
const setMeta = (clip, data) => { meta[clip] = { deviceScale: SCALE, viewport: VIEW, ...(meta[clip] || {}), ...data }; save(); };

const scope = { b, js, sleep, goto, glide, clickAt, centerOf, byText, press, typeText, park, hideCursor, ease, rectOf, text, shot, still, rec, endRec, mark, setMeta, overlay, marks, meta, ROOT };
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const server = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  try {
    if (body.trim() === "QUIT") { res.end("bye\n"); if (stopRec) await endRec(); b.close(); server.close(); process.exit(0); }
    const fn = new AsyncFunction(...Object.keys(scope), body);
    const out = await fn(...Object.values(scope));
    res.end((typeof out === "string" ? out : JSON.stringify(out, null, 1)) + "\n" + (b.consoleLines.length ? "console:\n" + b.consoleLines.splice(0).slice(-8).join("\n") + "\n" : ""));
  } catch (e) { res.end("ERROR " + (e.stack || e.message) + "\n"); }
});
server.listen(PORT, "127.0.0.1", () => console.log(`session on 127.0.0.1:${PORT}, chrome pid ${b.pid}`));
process.on("SIGTERM", () => { b.close(); process.exit(0); });
