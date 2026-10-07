// Anvil-only helpers (local forks: rehearsals and the sandbox). Never used against a real chain:
// every function here calls anvil_* RPC methods that a real node rejects.

import { encodeFunctionData, pad, toHex, type Address, type Hex } from "viem";
import { erc20Abi } from "./abi";
import type { Client } from "./config";

async function rpc<T = unknown>(client: Client, method: string, params: unknown[] = []): Promise<T> {
  return (await client.request({ method: method as never, params: params as never })) as T;
}

export async function setNativeBalance(client: Client, who: Address, wei: bigint): Promise<void> {
  await rpc(client, "anvil_setBalance", [who, toHex(wei)]);
}

/**
 * Find the storage slot holding `balanceOf(holder)` of `token` (proxy-aware) and how the balance is
 * packed in it: ask the node which slots balanceOf touches (eth_createAccessList), then write
 * `probe << shift` into each candidate and see which (slot, shift) makes balanceOf return `probe`.
 * Agora AUSD on Monad (mainnet and testnet), for instance, keeps flags in the low byte: balance = slot >> 8.
 */
export async function findBalanceSlot(client: Client, token: Address, holder: Address): Promise<{ contract: Address; slot: Hex; shift: number }> {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [holder] });
  const al = await rpc<{ accessList: Array<{ address: Address; storageKeys: Hex[] }> }>(client, "eth_createAccessList", [{ to: token, data }, "latest"]);
  const probe = BigInt("0x1234567890");
  for (const entry of al.accessList) {
    for (const slot of entry.storageKeys) {
      const old = await rpc<Hex>(client, "eth_getStorageAt", [entry.address, slot, "latest"]);
      for (const shift of [0, 8, 16, 32, 64, 96, 128]) {
        const low = BigInt(old) & ((BigInt(1) << BigInt(shift)) - BigInt(1));
        await rpc(client, "anvil_setStorageAt", [entry.address, slot, pad(toHex((probe << BigInt(shift)) | low), { size: 32 })]);
        // A probe of a non-balance slot (e.g. the proxy's implementation pointer) may break the call.
        const now = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder] }).catch(() => null);
        await rpc(client, "anvil_setStorageAt", [entry.address, slot, old]);
        if (now === probe) return { contract: entry.address, slot, shift };
      }
    }
  }
  throw new Error(`could not locate the balance slot of ${token}`);
}

/** Set `to`'s token balance to exactly `amount` (finds the slot per holder; cheap on a local fork). */
export async function dealToken(client: Client, token: Address, to: Address, amount: bigint): Promise<void> {
  const { contract, slot, shift } = await findBalanceSlot(client, token, to);
  const old = BigInt(await rpc<Hex>(client, "eth_getStorageAt", [contract, slot, "latest"]));
  const low = old & ((BigInt(1) << BigInt(shift)) - BigInt(1));
  await rpc(client, "anvil_setStorageAt", [contract, slot, pad(toHex((amount << BigInt(shift)) | low), { size: 32 })]);
  const bal = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [to] });
  if (bal !== amount) throw new Error(`deal failed: balance ${bal} ≠ ${amount}`);
}
