import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `npm run dev:sandbox` (the local testnet sandbox on :3002) runs next to the
  // usual `next dev` on :3001. Next allows one dev server per output directory
  // (a lockfile in it), so the sandbox builds into its own.
  distDir: process.env.PARACLR_DIST_DIR || ".next",
};

export default nextConfig;
