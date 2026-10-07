// `npm run keeper:init -- --network mainnet|testnet` — generate the production HOT keys locally.
//
// Writes DEPLOYER_PRIVATE_KEY, GUARDIAN_PRIVATE_KEY, OPS_PRIVATE_KEY and the 8 KEEPER_PRIVATE_KEYS
// into keeper/.env.mainnet / keeper/.env.testnet (or --env PATH) with mode 600. Prints ADDRESSES
// only. Testnet also gets PRICE_SIGNER_PRIVATE_KEY (the trial-end fallback oracle's signer: holds
// no MON, only signs prices; docs/RUNBOOK.md "Testnet: trial-end fallback").
//
//   - File missing: it is created from keeper/.env.mainnet.example with the keys filled in.
//   - File present: only EMPTY key variables are filled; every other line (your RPC, multisig,
//     caps, webhook…) is kept byte for byte. Existing keys are never replaced unless you pass
//       --force               regenerate ALL hot keys (old ones are moved to a retired file), or
//       --rotate a,b,…        regenerate only these roles: deployer, guardian, ops, keeper[0]..keeper[7], keepers
//     A replaced key is written to keeper/.env.mainnet.retired-<UTC time> (mode 600) so you can
//     sweep its MON with `keeper:fund -- --sweep-retired`, then delete that file.
//
// Never paste these keys anywhere. The owner (multisig/hardware wallet behind the timelock) is
// NOT generated here: it is an address you control elsewhere (OWNER_MULTISIG_ADDRESS).

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { LANES, normaliseKey, rel, resolveEnvFile, selectProdNetwork, type Args } from "./config";

const SINGLE_BASE = ["DEPLOYER_PRIVATE_KEY", "GUARDIAN_PRIVATE_KEY", "OPS_PRIVATE_KEY"] as const;
type SingleVar = (typeof SINGLE_BASE)[number] | "PRICE_SIGNER_PRIVATE_KEY";
const ROLE_OF: Record<string, SingleVar> = {
  deployer: "DEPLOYER_PRIVATE_KEY",
  guardian: "GUARDIAN_PRIVATE_KEY",
  ops: "OPS_PRIVATE_KEY",
  signer: "PRICE_SIGNER_PRIVATE_KEY",
};

function readVar(lines: string[], name: string): string | undefined {
  const line = lines.find((l) => l.startsWith(`${name}=`));
  if (line === undefined) return undefined;
  return line.slice(name.length + 1).trim();
}

function setVar(lines: string[], name: string, value: string): void {
  const i = lines.findIndex((l) => l.startsWith(`${name}=`));
  if (i >= 0) lines[i] = `${name}=${value}`;
  else lines.push(`${name}=${value}`);
}

function parseRotate(spec: string): { single: Set<string>; keepers: Set<number> } {
  const single = new Set<string>();
  const keepers = new Set<number>();
  for (const raw of spec.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (ROLE_OF[raw]) single.add(ROLE_OF[raw]);
    else if (raw === "keepers") for (let i = 0; i < LANES; i++) keepers.add(i);
    else {
      const m = /^keeper\[(\d)\]$/.exec(raw);
      if (!m || Number(m[1]) >= LANES) throw new Error(`--rotate: unknown role "${raw}" (deployer, guardian, ops, signer, keeper[0..7], keepers)`);
      keepers.add(Number(m[1]));
    }
  }
  return { single, keepers };
}

export function initMainnet(args: Args): void {
  const net = selectProdNetwork(args.network);
  const SINGLE: readonly SingleVar[] = net.name === "testnet" ? [...SINGLE_BASE, "PRICE_SIGNER_PRIVATE_KEY"] : SINGLE_BASE;
  const file = resolveEnvFile(args);
  const exists = existsSync(file);
  const lines = (exists ? readFileSync(file, "utf8") : readFileSync(net.envExample, "utf8")).split("\n");
  const force = args.force === true;
  const rotate = typeof args.rotate === "string" ? parseRotate(args.rotate) : { single: new Set<string>(), keepers: new Set<number>() };
  if (args.rotate === true) throw new Error("--rotate needs a list, e.g. --rotate guardian or --rotate keeper[3]");

  const retired: string[] = [];
  const changed: string[] = [];
  const kept: string[] = [];

  for (const name of SINGLE) {
    const cur = readVar(lines, name);
    const replace = force || rotate.single.has(name);
    if (cur && !replace) {
      normaliseKey(name, cur); // fail loudly on a malformed existing key
      kept.push(name);
      continue;
    }
    if (cur) retired.push(`${name}=${cur}  # address ${privateKeyToAccount(normaliseKey(name, cur)).address}`);
    setVar(lines, name, generatePrivateKey());
    changed.push(name);
  }

  const curKeepers = (readVar(lines, "KEEPER_PRIVATE_KEYS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (curKeepers.length !== 0 && curKeepers.length !== LANES && !force) {
    throw new Error(`KEEPER_PRIVATE_KEYS has ${curKeepers.length} keys; expected ${LANES} (fix it by hand, or --force to regenerate all)`);
  }
  const keepers: Hex[] = [];
  for (let i = 0; i < LANES; i++) {
    const cur = curKeepers[i];
    const replace = force || rotate.keepers.has(i) || !cur;
    if (cur && !replace) {
      keepers.push(normaliseKey(`KEEPER_PRIVATE_KEYS[${i}]`, cur));
      continue;
    }
    if (cur) retired.push(`# keeper[${i}] ${cur}  # address ${privateKeyToAccount(normaliseKey(`KEEPER_PRIVATE_KEYS[${i}]`, cur)).address}`);
    keepers.push(generatePrivateKey());
    changed.push(`keeper[${i}]`);
  }
  if (curKeepers.length === LANES && changed.every((c) => !c.startsWith("keeper["))) kept.push("KEEPER_PRIVATE_KEYS");
  setVar(lines, "KEEPER_PRIVATE_KEYS", keepers.join(","));

  if (changed.length === 0) {
    console.log("every hot key is already set; nothing changed (use --rotate <role> or --force).");
  } else {
    if (retired.length) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const retiredFile = `${file}.retired-${stamp}`;
      writeFileSync(
        retiredFile,
        `# Keys RETIRED by keeper:init on ${new Date().toISOString()}. SECRET.\n` +
          `# Sweep their remaining MON (npm run keeper:fund -- --network ${net.name} --sweep-retired <this file>),\n` +
          "# revoke any on-chain role they hold (timelock), then delete this file.\n" +
          retired.join("\n") +
          "\n",
        { mode: 0o600 },
      );
      console.log(`moved ${retired.length} replaced key(s) to ${rel(retiredFile)} (mode 600)`);
    }
    const header = exists
      ? []
      : [`# GENERATED by \`npm run keeper:init -- --network ${net.name}\` on ${new Date().toISOString()} from ${rel(net.envExample)}.`];
    writeFileSync(file, [...header, ...lines].join("\n"), { mode: 0o600 });
  }
  chmodSync(file, 0o600);

  const addr = (name: string) => {
    const v = readVar(lines, name);
    return v ? privateKeyToAccount(normaliseKey(name, v)).address : "(unset)";
  };
  const verb = !exists ? "created" : changed.length ? "updated" : "unchanged:";
  console.log(`${verb} ${rel(file)} (mode 600). Hot-key ADDRESSES (fund these with ${net.realValue ? "mainnet" : "TESTNET"} MON):`);
  console.log(`  deployer    ${addr("DEPLOYER_PRIVATE_KEY")}${changed.includes("DEPLOYER_PRIVATE_KEY") ? "  (new)" : ""}`);
  console.log(`  guardian    ${addr("GUARDIAN_PRIVATE_KEY")}${changed.includes("GUARDIAN_PRIVATE_KEY") ? "  (new)" : ""}`);
  console.log(`  ops         ${addr("OPS_PRIVATE_KEY")}${changed.includes("OPS_PRIVATE_KEY") ? "  (new)" : ""}`);
  keepers.forEach((k, i) => console.log(`  keeper[${i}]   ${privateKeyToAccount(k).address}${changed.includes(`keeper[${i}]`) ? "  (new)" : ""}`));
  if (SINGLE.includes("PRICE_SIGNER_PRIVATE_KEY")) {
    console.log(`  signer      ${addr("PRICE_SIGNER_PRIVATE_KEY")}${changed.includes("PRICE_SIGNER_PRIVATE_KEY") ? "  (new)" : ""}  (fallback-oracle price signer: needs NO MON)`);
  }
  const missing = ["OWNER_MULTISIG_ADDRESS", "KEEPER_CORS_ORIGIN", "PYTH_API_KEY"].filter((v) => !readVar(lines, v));
  if (missing.length) console.log(`still to fill in by hand: ${missing.join(", ")} (see the comments in the file).`);
  console.log(`Next: \`npm run keeper:fund -- --network ${net.name}\` previews the MON each role needs (docs/RUNBOOK.md).`);
}
