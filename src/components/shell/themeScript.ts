// Shared (server + client) theme constants for the trading app at /app.
//
// The app is dark-first with a light option. The choice lives in this
// browser's localStorage; with no stored choice the app follows
// prefers-color-scheme. The landing and legal pages ignore it: they carry
// their own brand tokens (docs/DESIGN.md) and /app removes the attribute when
// it unmounts.

export type Theme = "dark" | "light";

export const THEME_STORAGE_KEY = "paraclr.theme";

/**
 * Runs while the HTML is parsed (before the first paint) on a hard load of
 * /app, so the terminal never flashes the wrong theme. Every storage / media
 * access is guarded: private windows and blocked storage fall back to the OS
 * preference, then to dark.
 */
export const THEME_INIT_SCRIPT = `(function(){var t=null;try{t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)})}catch(e){}if(t!=="light"&&t!=="dark"){try{t=window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"}catch(e){t="dark"}}try{document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`;
