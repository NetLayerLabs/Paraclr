# Paraclr PRODUCTION keeper (Monad testnet today, Monad mainnet at launch) — see keeper/HOSTING.md.
#
#   docker build -f keeper/Dockerfile -t paraclr-keeper .        # context = repo root
#   # Monad testnet (what runs today; deployments/10143.json, keeper/.env.testnet.example):
#   docker run --env-file keeper/.env.testnet -e KEEPER_SECRETS_FROM_ENV=1 -p 8787:8787 paraclr-keeper \
#     node keeper/src/keeper.cjs --network testnet --yes-testnet
#   # Monad mainnet (the image's default CMD; needs deployments/143.json):
#   docker run --env-file keeper/.env.mainnet -e KEEPER_SECRETS_FROM_ENV=1 -p 8787:8787 paraclr-keeper
#
# The image holds ONE bundled file (keeper/src/prod/cli.ts → keeper.cjs, viem included) plus the
# committed deployments/*.json. It contains no keys: every secret comes from the platform's
# secret store as environment variables (KEEPER_SECRETS_FROM_ENV=1). No demo code is bundled
# (no faucet, price pusher, crash or demo takers).

# ---- build ---------------------------------------------------------------------------------
# Only the keeper's two build deps are installed (not the Next.js app's): viem (bundled) and
# esbuild, pinned to the versions in package-lock.json. Bump them together with the lockfile.
FROM node:22-bookworm-slim AS build
ARG VIEM_VERSION=2.56.0
ARG ESBUILD_VERSION=0.28.2
WORKDIR /app
RUN npm init -y >/dev/null \
 && npm install --no-audit --no-fund --no-save "viem@${VIEM_VERSION}" "esbuild@${ESBUILD_VERSION}"
COPY tsconfig.json ./
COPY keeper/src ./keeper/src
COPY src/lib/chain/abi/ParaclrClearinghouseProd.ts ./src/lib/chain/abi/ParaclrClearinghouseProd.ts
RUN npx esbuild keeper/src/prod/cli.ts --bundle --platform=node --target=node22 --format=cjs \
      --legal-comments=none --outfile=/out/keeper/src/keeper.cjs

# ---- runtime -------------------------------------------------------------------------------
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    KEEPER_SECRETS_FROM_ENV=1 \
    KEEPER_PORT=8787
WORKDIR /app
# REPO_ROOT resolves to /app (bundle at /app/keeper/src), so deployments/143.json is found there.
COPY --from=build /out/keeper/src/keeper.cjs ./keeper/src/keeper.cjs
COPY deployments/ ./deployments/
USER node
EXPOSE 8787
# Liveness only (head poller advancing); /health is the detailed status for humans and the app.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.KEEPER_PORT||8787)+'/livez').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# --yes-mainnet: deploying this container IS the confirmation; the process still prints balances
# and the burn estimate at startup and refuses to start on any chain but 143.
CMD ["node", "keeper/src/keeper.cjs", "--network", "mainnet", "--yes-mainnet"]
