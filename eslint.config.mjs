import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    // `npm run dev:sandbox` output (PARACLR_DIST_DIR).
    ".next-sandbox/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The Remotion teaser is a separate package with its own dependencies.
    "video/**",
  ]),
]);

export default eslintConfig;
