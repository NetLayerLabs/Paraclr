// X-ray fallback for RPCs without a usable debug_traceTransaction (prestateTracer + diffMode):
// replay the resolution blocks on a local anvil fork of the chain and trace them there.
//
//   1. fork the chain at the parent of the first resolution block (`anvil --fork-url
//      --fork-block-number P --no-mining --order fifo`);
//   2. for every block P+1 … last: set the original timestamp, zero the base fee (so the
//      original signed txs stay valid), send — in original order — every tx of that block that
//      targets one of the traced contracts or comes from one of the traced txs' senders (keeps
//      their nonces continuous), then mine exactly one block. Block numbers therefore match the
//      original chain, which the auction discount clock depends on;
//   3. the re-sent txs are the original signed bytes, so their hashes are the original hashes;
//      trace them on the fork exactly like the live method.
// Fidelity check: every traced tx's replay status and gasUsed are compared with the original
// receipt; differences are returned as notes. Other txs in those blocks (unrelated contracts)
// are not replayed — state they could have changed is not read by the traced contracts.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { serializeTransaction, type Address, type Hex, type Transaction } from "viem";
import { sleep } from "./env";
import { foundryBin } from "./foundry";
import { makeClient, type Client } from "./network";

export interface ForkReplay {
  client: Client;
  forkBlock: number;
  notes: string[];
  stop: () => Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Original signed bytes of a tx: eth_getRawTransactionByHash, else re-serialised from its fields. */
async function rawTx(client: Client, tx: Transaction): Promise<Hex> {
  try {
    const raw = (await client.request({
      method: "eth_getRawTransactionByHash" as never,
      params: [tx.hash] as never,
    })) as Hex | null;
    if (raw && raw !== "0x") return raw;
  } catch {
    /* not supported → rebuild */
  }
  const sig = { r: tx.r, s: tx.s, yParity: tx.yParity, v: tx.v };
  // viem's Transaction carries everything serializeTransaction needs for legacy/2930/1559/7702.
  return serializeTransaction(tx as never, sig as never);
}

export async function forkAndReplay(opts: {
  source: Client;
  sourceRpcUrl: string;
  /** Hashes to be traced afterwards. */
  hashes: Hex[];
  /** Contracts whose state matters: every tx to these in the replayed blocks is replayed. */
  contracts: Address[];
  log?: (m: string) => void;
}): Promise<ForkReplay> {
  const { source } = opts;
  const log = opts.log ?? (() => undefined);
  const receipts = await Promise.all(opts.hashes.map((hash) => source.getTransactionReceipt({ hash })));
  const first = Math.min(...receipts.map((r) => Number(r.blockNumber)));
  const last = Math.max(...receipts.map((r) => Number(r.blockNumber)));
  const forkBlock = first - 1;
  const senders = new Set(receipts.map((r) => r.from.toLowerCase()));
  const targets = new Set(opts.contracts.map((a) => a.toLowerCase()));
  const chainId = await source.getChainId();

  const port = await freePort();
  const args = [
    "--fork-url", opts.sourceRpcUrl,
    "--fork-block-number", String(forkBlock),
    "--port", String(port),
    "--no-mining",
    "--order", "fifo",
    "--chain-id", String(chainId),
    "--gas-limit", "300000000",
    "--silent",
  ];
  const child: ChildProcess = spawn(foundryBin("anvil"), args, { stdio: "ignore" });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([new Promise((r) => child.once("exit", r)), sleep(2_000)]);
    }
  };
  const rpc = `http://127.0.0.1:${port}`;
  const fork = makeClient(rpc);
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      await sleep(150);
      up = await fork.getBlockNumber().then(() => true, () => false);
    }
    if (!up) throw new Error(`anvil fork did not start on ${rpc}`);
    log(`[xray] anvil fork of chain ${chainId} at block ${forkBlock} on :${port}; replaying ${first}…${last}`);

    const notes: string[] = [];
    let replayed = 0;
    for (let b = first; b <= last; b++) {
      const block = await source.getBlock({ blockNumber: BigInt(b), includeTransactions: true });
      const txs = (block.transactions as Transaction[]).filter(
        (t) => senders.has(t.from.toLowerCase()) || (t.to !== null && targets.has(t.to.toLowerCase())),
      );
      await fork.request({ method: "anvil_setNextBlockBaseFeePerGas" as never, params: ["0x0"] as never });
      await fork.request({
        method: "anvil_setNextBlockTimestamp" as never,
        params: [`0x${block.timestamp.toString(16)}`] as never,
      });
      for (const t of txs) {
        await fork.request({ method: "eth_sendRawTransaction" as never, params: [await rawTx(source, t)] as never });
        replayed++;
      }
      await fork.request({ method: "evm_mine" as never, params: [] as never });
      const mined = await fork.getBlock({ blockTag: "latest" });
      if (Number(mined.number) !== b) notes.push(`replay block number ${mined.number} != original ${b}`);
      if (mined.transactions.length !== txs.length) {
        notes.push(`block ${b}: replayed ${mined.transactions.length} of ${txs.length} selected txs`);
      }
    }
    // Fidelity: same outcome and gas as the original for every traced tx.
    for (const r of receipts) {
      const rr = await fork.getTransactionReceipt({ hash: r.transactionHash }).catch(() => null);
      if (!rr) {
        notes.push(`${r.transactionHash}: not mined on the fork`);
      } else if (rr.status !== r.status || rr.gasUsed !== r.gasUsed || Number(rr.blockNumber) !== Number(r.blockNumber)) {
        notes.push(
          `${r.transactionHash}: replay differs (status ${rr.status}/${r.status}, gasUsed ${rr.gasUsed}/${r.gasUsed}, ` +
            `block ${rr.blockNumber}/${r.blockNumber})`,
        );
      }
    }
    notes.unshift(
      `anvil-fork-replay: forked chain ${chainId} at block ${forkBlock}, replayed ${replayed} txs over blocks ${first}…${last} ` +
        "(every tx to a traced contract or from a traced tx's sender, in original order, original timestamps, base fee 0).",
    );
    return { client: fork, forkBlock, notes, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}
