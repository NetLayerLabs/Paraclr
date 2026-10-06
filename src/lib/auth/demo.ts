import type { Session } from "@/lib/types";

const HEX = "0123456789abcdef";

/** Random, well-formed (but unowned) 20-byte address for demo sessions. */
export function randomDemoAddress(): string {
  const bytes = new Uint8Array(20);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = "0x";
  for (const b of bytes) out += HEX[b >> 4] + HEX[b & 15];
  return out;
}

export function demoSession(): Session {
  return { address: randomDemoAddress(), method: "demo", displayName: "Demo Trader" };
}

export function shortAddress(address: string, lead = 6, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}
