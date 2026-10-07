// POST /faucet for the LOCAL SANDBOX only (`npm run sandbox`: an anvil fork of Monad testnet).
//
// Production keepers have no faucet (the demo endpoints answer 403). The sandbox enables this one
// with SANDBOX_FAUCET=1, which the keeper refuses on anything but an anvil fork (context.ts). It
// gives a wallet fork-native MON and testnet AUSD so the app can be clicked through locally:
//   MON   a real transfer (a tx hash the app can track) from a throwaway key topped up with
//         anvil_setBalance;
//   AUSD  Agora's real faucet on the fork (`requestFunds(address)`, 10,000 AUSD) when it would
//         succeed, else a storage cheat on the real testnet AUSD contract (no tx hash).
// Nothing here can run on a real chain: anvil_* methods do not exist there.

import { encodeFunctionData, formatEther, getAddress, isAddress, parseAbi, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { waitForReceipt } from "../sender";
import { erc20Abi } from "./abi";
import { dealToken, setNativeBalance } from "./anvil-cheats";
import { envNum, KNOWN_TESTNET } from "./config";
import type { ProdContext } from "./context";

const AGORA_FAUCET_ABI = parseAbi(["function requestFunds(address to)", "function faucetDripAmount() view returns (uint256)"]);

export class SandboxFaucetError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class SandboxFaucet {
  private readonly key = generatePrivateKey();
  private readonly account = privateKeyToAccount(this.key);
  private readonly last = new Map<string, number>();
  private readonly monWei = parseEther(String(envNum("SANDBOX_FAUCET_MON", 20)));
  private readonly ausd = BigInt(Math.round(envNum("SANDBOX_FAUCET_AUSD", 10_000) * 1e6));
  stats = { drips: 0, viaAgoraFaucet: 0, viaStorageCheat: 0 };

  constructor(private readonly ctx: ProdContext) {
    if (!ctx.chain.fork) throw new Error("the sandbox faucet runs only on an anvil fork");
  }

  async drip(input: unknown): Promise<{ gasTxHash: Hex; ausdTxHash: Hex | null; method: string; mon: string; ausd: string; sandbox: true; label: string }> {
    if (typeof input !== "string" || !isAddress(input)) throw new SandboxFaucetError("body must be { address: 0x… }", 400);
    const to: Address = getAddress(input);
    const now = Date.now();
    if (now - (this.last.get(to.toLowerCase()) ?? 0) < 5_000) throw new SandboxFaucetError("rate limited (5 s per address)", 429);
    this.last.set(to.toLowerCase(), now);
    const c = this.ctx.chain.client;
    const sender = this.ctx.senders.for(this.account);
    await setNativeBalance(c, this.account.address, parseEther("1000000"));

    const gas = await sender.send({ to, value: this.monWei, gas: BigInt(21_000) });
    let ausdTxHash: Hex | null = null;
    let method = "storage-cheat";
    const faucet = KNOWN_TESTNET.ausdFaucet;
    const isTestnetAusd = this.ctx.dep.ausd.toLowerCase() === KNOWN_TESTNET.ausd.toLowerCase();
    const data = encodeFunctionData({ abi: AGORA_FAUCET_ABI, functionName: "requestFunds", args: [to] });
    const viaFaucet =
      isTestnetAusd && (await c.getCode({ address: faucet }).then((x) => Boolean(x && x !== "0x"), () => false))
        ? await c.estimateGas({ account: this.account.address, to: faucet, data }).then((g) => g, () => null)
        : null;
    if (viaFaucet !== null) {
      const sub = await sender.send({ to: faucet, data, gas: (viaFaucet * BigInt(13)) / BigInt(10) });
      const { receipt } = await waitForReceipt(c, sub.hash, { pollMs: 250, timeoutMs: 30_000 });
      if (receipt.status === "success") {
        ausdTxHash = sub.hash;
        method = "agora-faucet";
      }
    }
    if (!ausdTxHash) {
      // Agora's faucet refuses (once a minute; recipients above 100,000 AUSD): cheat the balance up.
      const bal = await c.readContract({ address: this.ctx.dep.ausd, abi: erc20Abi, functionName: "balanceOf", args: [to] });
      await dealToken(c, this.ctx.dep.ausd, to, bal + this.ausd);
    }
    await waitForReceipt(c, gas.hash, { pollMs: 250, timeoutMs: 30_000 });
    this.stats.drips++;
    if (method === "agora-faucet") this.stats.viaAgoraFaucet++;
    else this.stats.viaStorageCheat++;
    return {
      gasTxHash: gas.hash,
      ausdTxHash,
      method,
      mon: formatEther(this.monWei),
      ausd: method === "agora-faucet" ? "10000" : String(Number(this.ausd) / 1e6),
      sandbox: true,
      label: "LOCAL SANDBOX faucet (anvil fork of Monad testnet): fork MON + testnet AUSD, no value",
    };
  }

  status() {
    return { enabled: true, label: "LOCAL SANDBOX only (anvil fork)", mon: formatEther(this.monWei), ausd: Number(this.ausd) / 1e6, ...this.stats };
  }
}
