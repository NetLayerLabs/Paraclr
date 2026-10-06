// POST /faucet: a little native gas + 10,000 test AUSD for a new wallet, from the faucet key.
//
// Monad reserve-balance rule (docs.monad.xyz/developer-essentials/reserve-balance): a tx whose
// VALUE transfer takes the sender below min(its starting balance, 10 MON) reverts, unless it is
// the sender's first tx in 3 blocks. Keep the faucet key above 10 MON + its giveaway budget.

import { encodeFunctionData, formatEther, getAddress, isAddress, type Address, type Hex } from "viem";
import { abis, type KeeperContext } from "./context";
import { estimateLimit, waitForReceipts } from "./sender";

export class FaucetError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface FaucetResult {
  /** null when the wallet already had at least FAUCET_GAS_WEI (no gas sent). */
  gasTxHash: Hex | null;
  ausdTxHash: Hex;
  gasWei: string;
  ausd: string;
}

export class Faucet {
  private readonly lastDrip = new Map<string, number>();

  constructor(private readonly ctx: KeeperContext) {}

  async drip(addressInput: unknown): Promise<FaucetResult> {
    if (typeof addressInput !== "string" || !isAddress(addressInput)) {
      throw new FaucetError("body must be { address: 0x… }", 400);
    }
    const address: Address = getAddress(addressInput);
    const { ctx } = this;
    const key = address.toLowerCase();
    const now = Date.now();
    const last = this.lastDrip.get(key);
    const cooldown = ctx.config.faucetCooldownMs;
    if (last !== undefined && now - last < cooldown) {
      throw new FaucetError("rate limited", 429, { retryAfterMs: cooldown - (now - last) });
    }
    this.lastDrip.set(key, now); // reserve the slot before any await (concurrent duplicates → 429)

    try {
      const sender = ctx.senders.for(ctx.roles.faucet);
      const balance = await ctx.client.getBalance({ address });
      const needGas = balance < ctx.config.faucetGasWei;

      const mintData = encodeFunctionData({
        abi: abis.ausd,
        functionName: "mint",
        args: [address, ctx.config.faucetAusd],
      });
      const [gasLimit, mintLimit] = await Promise.all([
        needGas
          ? estimateLimit(ctx.client, { account: sender.address, to: address, value: ctx.config.faucetGasWei }, 0)
          : null,
        estimateLimit(ctx.client, { account: sender.address, to: ctx.dep.ausd, data: mintData }, ctx.config.gasMarginBps),
      ]);

      // Same key, consecutive nonces; both in flight together.
      const gasTx = gasLimit
        ? await sender.send({ to: address, value: ctx.config.faucetGasWei, gas: gasLimit.limit })
        : null;
      const mintTx = await sender.send({ to: ctx.dep.ausd, data: mintData, gas: mintLimit.limit });

      const hashes = [mintTx.hash, ...(gasTx ? [gasTx.hash] : [])];
      const got = await waitForReceipts(ctx.client, hashes, {
        pollMs: ctx.config.receiptPollMs,
        timeoutMs: ctx.config.receiptTimeoutMs,
      });
      for (const h of hashes) {
        const r = got.get(h);
        if (!r) throw new FaucetError(`faucet tx ${h} not mined in time`, 504, { txHash: h });
        if (r.receipt.status !== "success") {
          throw new FaucetError(`faucet tx ${h} reverted`, 502, {
            txHash: h,
            hint: ctx.info.network === "monad-testnet" ? "check the faucet key's MON balance (reserve 10 MON)" : undefined,
          });
        }
      }
      return {
        gasTxHash: gasTx?.hash ?? null,
        ausdTxHash: mintTx.hash,
        gasWei: needGas ? ctx.config.faucetGasWei.toString() : "0",
        ausd: ctx.config.faucetAusd.toString(),
      };
    } catch (err) {
      this.lastDrip.delete(key); // failed drips don't burn the user's cooldown
      throw err;
    }
  }

  describe() {
    return {
      gas: formatEther(this.ctx.config.faucetGasWei),
      ausd: Number(this.ctx.config.faucetAusd) / 1e6,
      cooldownMs: this.ctx.config.faucetCooldownMs,
    };
  }
}
