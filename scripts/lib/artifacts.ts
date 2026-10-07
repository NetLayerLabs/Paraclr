// Compile contracts in a shadow root (never races contracts/out or another agent's build) and load
// forge artifacts. Used by the testnet fallback-oracle CLI, the testnet rehearsal and the sandbox.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Abi, Hex } from "viem";
import { foundryBin, shadowRoot } from "../../keeper/src/foundry";

export interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

/** `forge build` in contracts/cache/shadow/<name>/root; returns a loader for its artifacts. */
export async function buildArtifacts(name: string): Promise<(file: string, contract: string) => Artifact> {
  const shadow = shadowRoot(name);
  await new Promise<void>((resolve, reject) => {
    const c = spawn(foundryBin("forge"), ["build", "--root", shadow.root], { cwd: shadow.root, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d: Buffer) => (out += d));
    c.stderr.on("data", (d: Buffer) => (out += d));
    c.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`forge build failed: ${out.slice(-600)}`))));
  });
  return (file, contract) => {
    const a = JSON.parse(readFileSync(join(shadow.root, "out", file, `${contract}.json`), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
    return { abi: a.abi, bytecode: a.bytecode.object };
  };
}
