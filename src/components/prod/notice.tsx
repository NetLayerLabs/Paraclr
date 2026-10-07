// The testnet notice ("test funds, no real value") can be closed: on the landing page, the sign-in
// screen and inside the app. Closing hides every element marked data-notice="testnet" (a rule in
// globals.css on html[data-notice-closed]) and is remembered in this browser. The fact stays visible
// elsewhere: the app's network badge, the sign-in badge and the landing hero. The mainnet beta
// banner ("unaudited, capped") has no close button.

export const NOTICE_KEY = "paraclr.notice.testnet.v1";
export const NOTICE_ATTR = "data-notice-closed";

/** Runs while the HTML is parsed, so a closed notice never flashes on load. */
const INIT = `(function(){try{if(localStorage.getItem(${JSON.stringify(NOTICE_KEY)})==="closed")document.documentElement.setAttribute(${JSON.stringify(NOTICE_ATTR)},"testnet")}catch(e){}})()`;

/** The pre-paint script. Executable only in the server HTML; inert on the client (like ThemeScript). */
export function NoticeScript() {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: INIT }}
    />
  );
}
