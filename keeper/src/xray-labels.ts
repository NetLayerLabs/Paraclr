// Best-effort human labels for the storage slots on X-ray edges ("paraclr._lanes[3].insuranceFund"
// instead of 0x…). Uses `forge inspect <Contract> storageLayout` (compiled in a shadow root, never
// touching contracts/out) and enumerates mapping keys from candidate values seen in the run:
// accounts, keepers, contract addresses, market ids and lane numbers. Unknown slots keep their raw
// `<address>:<slot>` form. Needs forge on PATH; without it the report simply has no labels.

import { spawnSync } from "node:child_process";
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { CONTRACTS_DIR } from "./env";
import { foundryBin, hasFoundry, shadowRoot } from "./foundry";
import { join } from "node:path";
import { existsSync } from "node:fs";

interface LayoutVar {
  label: string;
  slot: string;
  offset: number;
  type: string;
}
interface LayoutType {
  encoding: "inplace" | "mapping" | "dynamic_array" | "bytes";
  label: string;
  numberOfBytes: string;
  key?: string;
  value?: string;
  base?: string;
  members?: LayoutVar[];
}
interface Layout {
  storage: LayoutVar[];
  types: Record<string, LayoutType> | null;
}

export interface LabelCandidates {
  addresses: Map<string, string>; // lowercased address → display name (accounts + roles + contracts)
  /** Subset used for inner keys of nested address mappings (allowance[owner][spender]…): keeps it O(N). */
  roleAddresses: Map<string, string>;
  bytes32: Map<string, string>; // lowercased 0x… → display name (market symbols)
  smallInts: number[]; // lanes etc.
}

const MAX_ARRAY_ELEMS = 16;
const layoutCache = new Map<string, Layout | null>();

function srcFileOf(contract: string): string | null {
  for (const rel of [`src/${contract}.sol`, `src/oracles/${contract}.sol`]) {
    const p = join(CONTRACTS_DIR, rel);
    if (existsSync(p)) return p;
  }
  return null;
}

/** storageLayout of `contract` (e.g. "ParaclrClearinghouseDemo"), or null if unavailable. */
export function storageLayout(contract: string): Layout | null {
  if (layoutCache.has(contract)) return layoutCache.get(contract)!;
  let layout: Layout | null = null;
  try {
    const file = srcFileOf(contract);
    if (hasFoundry("forge")) {
      const { root } = shadowRoot("xray-inspect");
      const res = spawnSync(
        foundryBin("forge"),
        ["inspect", file ? `${file}:${contract}` : contract, "storageLayout", "--json", "--root", root],
        { cwd: root, encoding: "utf8", timeout: 180_000 },
      );
      if (res.status === 0) layout = JSON.parse(res.stdout) as Layout;
    }
  } catch {
    layout = null;
  }
  layoutCache.set(contract, layout);
  return layout;
}

function pad32(n: bigint): Hex {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

function mappingSlot(keyType: string, key: string | number, base: bigint): bigint {
  let enc: Hex;
  if (keyType.startsWith("t_address") || keyType.startsWith("t_contract")) {
    enc = encodeAbiParameters([{ type: "address" }], [key as Address]);
  } else if (keyType === "t_bytes32") {
    enc = key as Hex;
  } else {
    enc = pad32(BigInt(key));
  }
  return BigInt(keccak256(`0x${enc.slice(2)}${pad32(base).slice(2)}`));
}

function slotsOf(t: LayoutType): number {
  return Math.max(1, Math.ceil(Number(t.numberOfBytes) / 32));
}

/** Enumerate slot → label for one contract's layout given candidate mapping keys. */
function enumerate(layout: Layout, prefix: string, cand: LabelCandidates): Map<bigint, string> {
  const out = new Map<bigint, string>();
  const types = layout.types ?? {};
  const add = (slot: bigint, label: string) => {
    if (!out.has(slot)) out.set(slot, label);
  };
  const walk = (typeId: string, base: bigint, label: string, depth: number, nestedAddr = false) => {
    const t = types[typeId];
    if (!t || depth > 4) return add(base, label);
    if (t.encoding === "mapping") {
      const keyType = t.key ?? "";
      const isAddrKey = keyType.startsWith("t_address") || keyType.startsWith("t_contract");
      const keys: Array<{ k: string | number; name: string }> = [];
      if (keyType.startsWith("t_address") || keyType.startsWith("t_contract")) {
        for (const [a, name] of nestedAddr ? cand.roleAddresses : cand.addresses) keys.push({ k: a, name });
      } else if (keyType === "t_bytes32") {
        for (const [b, name] of cand.bytes32) keys.push({ k: b, name });
      } else if (/^t_u?int\d+$/.test(keyType)) {
        for (const n of cand.smallInts) keys.push({ k: n, name: String(n) });
      }
      for (const { k, name } of keys) {
        walk(t.value ?? "", mappingSlot(keyType, k, base), `${label}[${name}]`, depth + 1, nestedAddr || isAddrKey);
      }
      return;
    }
    if (t.encoding === "dynamic_array") {
      add(base, `${label}.length`);
      const elem = types[t.base ?? ""];
      const size = elem ? slotsOf(elem) : 1;
      const start = BigInt(keccak256(pad32(base)));
      for (let i = 0; i < MAX_ARRAY_ELEMS; i++) walk(t.base ?? "", start + BigInt(i * size), `${label}[${i}]`, depth + 1, nestedAddr);
      return;
    }
    if (t.members && t.members.length) {
      // Packed members share a slot: label it with all of them ("{active|startBlock|index}").
      const bySlot = new Map<string, LayoutVar[]>();
      for (const m of t.members) bySlot.set(m.slot, [...(bySlot.get(m.slot) ?? []), m]);
      for (const [slot, ms] of bySlot) {
        if (ms.length > 1) add(base + BigInt(slot), `${label}.{${ms.map((m) => m.label).join("|")}}`);
        else walk(ms[0].type, base + BigInt(slot), `${label}.${ms[0].label}`, depth + 1, nestedAddr);
      }
      return;
    }
    const staticArr = /\)(\d+)_storage$/.exec(typeId);
    if (t.base && staticArr) {
      const elem = types[t.base];
      const size = elem ? slotsOf(elem) : 1;
      for (let i = 0; i < Number(staticArr[1]); i++) walk(t.base, base + BigInt(i * size), `${label}[${i}]`, depth + 1, nestedAddr);
      return;
    }
    add(base, label);
  };
  // Packed variables share a slot: label it with every variable in it.
  const byslot = new Map<string, LayoutVar[]>();
  for (const v of layout.storage) byslot.set(v.slot, [...(byslot.get(v.slot) ?? []), v]);
  for (const [slot, vars] of byslot) {
    if (vars.length > 1) add(BigInt(slot), `${prefix}.{${vars.map((v) => v.label).join("|")}}`);
    else walk(vars[0].type, BigInt(slot), `${prefix}.${vars[0].label}`, 0);
  }
  return out;
}

export class SlotLabeler {
  private readonly tables = new Map<string, { name: string; slots: Map<bigint, string> | null }>();
  readonly available: boolean;

  /** contracts: address → { display name, solidity contract name } */
  constructor(contracts: Array<{ address: Address; name: string; contract: string }>, cand: LabelCandidates) {
    let any = false;
    for (const c of contracts) {
      const layout = storageLayout(c.contract);
      if (layout) any = true;
      this.tables.set(c.address.toLowerCase(), { name: c.name, slots: layout ? enumerate(layout, c.name, cand) : null });
    }
    this.available = any;
  }

  label(key: string): string | undefined {
    const [addr, slot] = key.split(":");
    const t = this.tables.get(addr);
    if (!t) return undefined;
    if (!slot.startsWith("0x")) return `${t.name}.${slot}`; // balance / nonce / code
    return t.slots?.get(BigInt(slot)) ?? `${t.name}.<slot ${slot}>`;
  }
}

export function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
