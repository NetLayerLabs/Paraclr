// Gas drip policy + queue + HTTP route tests: `npm run test:keeper` (node --test through tsx).

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { clientIp, decideDrip, GasDrip, hashIp, spentToday, type DripChainPort, type DripLedger, type DripPolicy, type DripRecord } from "./drip";
import { startProdServer, type ProdDeps } from "./server";

const POLICY: DripPolicy = {
  amountWei: parseEther("0.3"),
  minBalanceWei: parseEther("0.05"),
  dailyBudgetWei: parseEther("10"),
  perIpMax: 3,
  ipWindowMs: 86_400_000,
};
const ON = { enabled: true };
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const FRESH = { recipientBalance: BigInt(0), recipientHasCode: false, walletBalance: parseEther("5"), gasCostWei: parseEther("0.003") };

const rec = (address: string, over: Partial<DripRecord> = {}): DripRecord => ({
  address: address.toLowerCase(),
  ip: "ip1",
  at: NOW - 60_000,
  amountWei: POLICY.amountWei.toString(),
  status: "sent",
  ...over,
});
const ledgerOf = (...rs: DripRecord[]): DripLedger => ({ byAddress: Object.fromEntries(rs.map((r) => [r.address, r])) });
const empty = (): DripLedger => ({ byAddress: {} });
const code = (d: ReturnType<typeof decideDrip>) => (d.ok ? "ok" : d.code);

describe("decideDrip (pure policy)", () => {
  it("drips a fresh wallet", () => {
    assert.equal(code(decideDrip(ON, empty(), { address: A, ip: "ip1", now: NOW, chain: FRESH }, POLICY)), "ok");
  });
  it("is off when disabled, with the reason", () => {
    const d = decideDrip({ enabled: false, reason: "refused on Monad mainnet" }, empty(), { address: A, ip: "x", now: NOW }, POLICY);
    assert.equal(code(d), "disabled");
    assert.match((d as { error: string }).error, /mainnet/);
  });
  it("rejects a malformed address", () => {
    assert.equal(code(decideDrip(ON, empty(), { address: "0x123", ip: "x", now: NOW }, POLICY)), "bad_address");
  });
  it("drips once per address ever (case-insensitive)", () => {
    const l = ledgerOf(rec(A, { at: NOW - 30 * 86_400_000 }));
    assert.equal(code(decideDrip(ON, l, { address: A.toUpperCase().replace("0X", "0x"), ip: "other", now: NOW, chain: FRESH }, POLICY)), "already_dripped");
  });
  it("reports a queued drip as in progress", () => {
    assert.equal(code(decideDrip(ON, ledgerOf(rec(A, { status: "queued" })), { address: A, ip: "x", now: NOW }, POLICY)), "in_progress");
  });
  it("lets an address retry after a failed drip", () => {
    assert.equal(code(decideDrip(ON, ledgerOf(rec(A, { status: "failed" })), { address: A, ip: "ip1", now: NOW, chain: FRESH }, POLICY)), "ok");
  });
  it("refuses contracts", () => {
    assert.equal(code(decideDrip(ON, empty(), { address: A, ip: "x", now: NOW, chain: { ...FRESH, recipientHasCode: true } }, POLICY)), "contract");
  });
  it("refuses wallets at or above the minimum balance", () => {
    const at = { ...FRESH, recipientBalance: POLICY.minBalanceWei };
    assert.equal(code(decideDrip(ON, empty(), { address: A, ip: "x", now: NOW, chain: at }, POLICY)), "has_balance");
    const below = { ...FRESH, recipientBalance: POLICY.minBalanceWei - BigInt(1) };
    assert.equal(code(decideDrip(ON, empty(), { address: A, ip: "x", now: NOW, chain: below }, POLICY)), "ok");
  });
  it("allows 3 per IP per rolling 24 h; failed ones don't count", () => {
    const addrs = ["0x" + "a".repeat(40), "0x" + "b".repeat(40), "0x" + "c".repeat(40)];
    const three = ledgerOf(...addrs.map((a) => rec(a, { ip: "ip1" })));
    assert.equal(code(decideDrip(ON, three, { address: B, ip: "ip1", now: NOW, chain: FRESH }, POLICY)), "ip_limit");
    assert.equal(code(decideDrip(ON, three, { address: B, ip: "ip2", now: NOW, chain: FRESH }, POLICY)), "ok");
    const oneFailed = ledgerOf(rec(addrs[0], { ip: "ip1", status: "failed" }), rec(addrs[1]), rec(addrs[2]));
    assert.equal(code(decideDrip(ON, oneFailed, { address: B, ip: "ip1", now: NOW, chain: FRESH }, POLICY)), "ok");
    const old = ledgerOf(...addrs.map((a) => rec(a, { at: NOW - 86_400_000 - 1 })));
    assert.equal(code(decideDrip(ON, old, { address: B, ip: "ip1", now: NOW, chain: FRESH }, POLICY)), "ok");
  });
  it("stops at the daily budget (UTC day), counting queued drips", () => {
    const tight = { ...POLICY, dailyBudgetWei: parseEther("0.6"), perIpMax: 100 };
    const l = ledgerOf(rec(A), rec(B, { status: "queued" }));
    assert.equal(spentToday(l, NOW), parseEther("0.6"));
    assert.equal(code(decideDrip(ON, l, { address: "0x" + "3".repeat(40), ip: "ip9", now: NOW, chain: FRESH }, tight)), "budget_exhausted");
    // yesterday's drips don't count today
    const y = ledgerOf(rec(A, { at: NOW - 86_400_000 }), rec(B, { at: NOW - 86_400_000 }));
    assert.equal(code(decideDrip(ON, y, { address: "0x" + "3".repeat(40), ip: "ip9", now: NOW, chain: FRESH }, tight)), "ok");
  });
  it("refuses when the drip wallet can't cover amount + gas (incl. queued drips)", () => {
    const low = { ...FRESH, walletBalance: POLICY.amountWei + FRESH.gasCostWei - BigInt(1) };
    assert.equal(code(decideDrip(ON, empty(), { address: A, ip: "x", now: NOW, chain: low }, POLICY)), "drip_empty");
    const exact = { ...FRESH, walletBalance: POLICY.amountWei + FRESH.gasCostWei };
    assert.equal(code(decideDrip(ON, empty(), { address: A, ip: "x", now: NOW, chain: exact }, POLICY)), "ok");
    const queued = ledgerOf(rec(B, { status: "queued", ip: "q" }));
    assert.equal(code(decideDrip(ON, queued, { address: A, ip: "x", now: NOW, chain: exact }, POLICY)), "drip_empty");
  });
  it("ledger-only precheck runs without chain facts", () => {
    assert.equal(code(decideDrip(ON, empty(), { address: A, ip: "x", now: NOW }, POLICY)), "ok");
  });
});

describe("clientIp", () => {
  const req = (xff: string | undefined) => ({ headers: xff === undefined ? {} : { "x-forwarded-for": xff }, socket: { remoteAddress: "10.0.0.9" } }) as never;
  it("uses the socket address unless KEEPER_TRUST_PROXY is set", () => {
    assert.equal(clientIp(req("1.1.1.1"), 0), "10.0.0.9");
  });
  it("takes the entry the trusted proxy appended (N-th from the right)", () => {
    assert.equal(clientIp(req("6.6.6.6, 2.2.2.2"), 1), "2.2.2.2");
    assert.equal(clientIp(req("6.6.6.6, 2.2.2.2, 3.3.3.3"), 2), "2.2.2.2");
    assert.equal(clientIp(req(undefined), 1), "10.0.0.9");
  });
});

// ---------------------------------------------------------------------------
// Service + HTTP route with a stub chain
// ---------------------------------------------------------------------------

const ACCOUNT = privateKeyToAccount(generatePrivateKey()); // throwaway, never funded

function stubPort(balances: Record<string, bigint>, opts: { contracts?: string[]; revert?: boolean } = {}) {
  const sent: Array<{ to: Address; value: bigint; at: number }> = [];
  let n = 0;
  const port: DripChainPort = {
    getBalance: async (a) => balances[a.toLowerCase()] ?? BigInt(0),
    hasCode: async (a) => (opts.contracts ?? []).includes(a.toLowerCase()),
    gasCostWei: async () => parseEther("0.003"),
    transfer: async (to, value) => {
      if (sent.length && Date.now() - sent[sent.length - 1].at < 0) throw new Error("not serial");
      sent.push({ to, value, at: Date.now() });
      const hash = `0x${(++n).toString(16).padStart(64, "0")}` as Hex;
      const mined = new Promise<{ ok: boolean; block: number | null }>((r) =>
        setTimeout(() => {
          if (!opts.revert) {
            balances[to.toLowerCase()] = (balances[to.toLowerCase()] ?? BigInt(0)) + value;
            balances[ACCOUNT.address.toLowerCase()] -= value;
          }
          r({ ok: !opts.revert, block: 100 + n });
        }, 20),
      );
      return { hash, mined };
    },
  };
  return { port, sent };
}

function makeDrip(port: DripChainPort | null, over: { refuse?: string; stateFile?: string } = {}) {
  return new GasDrip({
    account: ACCOUNT,
    refuse: over.refuse,
    port,
    stateFile: over.stateFile ?? join(mkdtempSync(join(tmpdir(), "drip-")), "state.json"),
    explorer: "https://testnet.monadexplorer.com",
    trustProxyHops: 0,
    policy: POLICY,
    log: () => {},
  });
}

describe("GasDrip service", () => {
  it("sends once, persists the ledger, and refuses a second request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "drip-"));
    const file = join(dir, "state.json");
    const { port, sent } = stubPort({ [ACCOUNT.address.toLowerCase()]: parseEther("5") });
    const drip = makeDrip(port, { stateFile: file });
    const r = await drip.request(A, "1.2.3.4");
    assert.equal(r.status === "sending" || r.status === "sent", true);
    assert.ok(r.txHash);
    assert.match(r.explorer!, /\/tx\/0x/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].value, POLICY.amountWei);
    await new Promise((res) => setTimeout(res, 60));
    assert.equal(drip.status(A).status, "sent");
    const saved = JSON.parse(readFileSync(file, "utf8")) as DripLedger;
    assert.equal(saved.byAddress[A.toLowerCase()].status, "sent");
    assert.equal(saved.byAddress[A.toLowerCase()].ip, hashIp("1.2.3.4"));
    await assert.rejects(drip.request(A, "9.9.9.9"), (e: { code?: string }) => e.code === "already_dripped");
    // a fresh process over the same file still remembers
    const again = makeDrip(port, { stateFile: file });
    await assert.rejects(again.request(A, "9.9.9.9"), (e: { code?: string }) => e.code === "already_dripped");
    assert.equal(again.healthJson().todaySpent, "0.3");
  });

  it("serialises concurrent drips (one transfer mined before the next is sent)", async () => {
    const { port, sent } = stubPort({ [ACCOUNT.address.toLowerCase()]: parseEther("5") });
    const order: string[] = [];
    const wrapped: DripChainPort = {
      ...port,
      transfer: async (to, value) => {
        order.push(`send ${to.slice(0, 6).toLowerCase()}`);
        const s = await port.transfer(to, value);
        return { hash: s.hash, mined: s.mined.then((m) => (order.push(`mined ${to.slice(0, 6).toLowerCase()}`), m)) };
      },
    };
    const drip = makeDrip(wrapped);
    const addrs = ["0x" + "a".repeat(40), "0x" + "b".repeat(40), "0x" + "c".repeat(40)];
    const rs = await Promise.all(addrs.map((a, i) => drip.request(a, `ip${i}`, { waitMs: 5 })));
    assert.equal(rs.length, 3);
    await new Promise((res) => setTimeout(res, 200));
    assert.equal(sent.length, 3);
    assert.deepEqual(order, ["send 0xaaaa", "mined 0xaaaa", "send 0xbbbb", "mined 0xbbbb", "send 0xcccc", "mined 0xcccc"]);
  });

  it("marks a reverted transfer failed and lets the address retry", async () => {
    const { port } = stubPort({ [ACCOUNT.address.toLowerCase()]: parseEther("5") }, { revert: true });
    const drip = makeDrip(port);
    await drip.request(A, "1.1.1.1");
    await new Promise((res) => setTimeout(res, 60));
    const s = drip.status(A);
    assert.equal(s.status, "failed");
    assert.match(s.error!, /reverted/);
    assert.equal(drip.healthJson().todaySpent, "0");
  });

  it("refuses contracts, funded wallets and an empty drip wallet", async () => {
    const { port } = stubPort({ [ACCOUNT.address.toLowerCase()]: parseEther("5"), [B.toLowerCase()]: parseEther("1") }, { contracts: [A.toLowerCase()] });
    const drip = makeDrip(port);
    await assert.rejects(drip.request(A, "x"), (e: { code?: string }) => e.code === "contract");
    await assert.rejects(drip.request(B, "x"), (e: { code?: string }) => e.code === "has_balance");
    const dry = makeDrip(stubPort({ [ACCOUNT.address.toLowerCase()]: parseEther("0.1") }).port);
    await assert.rejects(dry.request(A, "x"), (e: { code?: string; status?: number }) => e.code === "drip_empty" && e.status === 503);
  });

  it("is disabled without a key and on mainnet", async () => {
    const off = new GasDrip({ account: null, port: null, stateFile: null, explorer: "", trustProxyHops: 0, policy: POLICY, log: () => {} });
    assert.equal(off.healthJson().enabled, false);
    assert.match(String(off.healthJson().reason), /DRIP_PRIVATE_KEY/);
    await assert.rejects(off.request(A, "x"), (e: { code?: string }) => e.code === "disabled");
    const main = makeDrip(stubPort({}).port, { refuse: "refused on Monad mainnet" });
    assert.equal(main.healthJson().enabled, false);
    await assert.rejects(main.request(A, "x"), (e: { code?: string }) => e.code === "disabled");
  });
});

describe("POST /drip + GET /drip/:address on the production HTTP server", () => {
  it("serves the route with CORS and {error, code} errors", async () => {
    const { port } = stubPort({ [ACCOUNT.address.toLowerCase()]: parseEther("5"), [B.toLowerCase()]: parseEther("1") });
    const drip = makeDrip(port);
    const ctx = {
      config: { corsOrigins: ["http://localhost:3004"], port: 0 },
      chain: { fork: true, profile: { label: "test" } },
    };
    const server = startProdServer({ ctx, drip } as unknown as ProdDeps);
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const pre = await fetch(`${base}/drip`, { method: "OPTIONS", headers: { origin: "http://localhost:3004" } });
      assert.equal(pre.status, 204);
      assert.equal(pre.headers.get("access-control-allow-origin"), "http://localhost:3004");

      const ok = await fetch(`${base}/drip`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3004" }, body: JSON.stringify({ address: A }) });
      assert.equal(ok.status, 200);
      const body = (await ok.json()) as { status: string; txHash: string };
      assert.ok(["sending", "sent"].includes(body.status));
      assert.match(body.txHash, /^0x[0-9a-f]{64}$/);

      await new Promise((r) => setTimeout(r, 60));
      const st = (await (await fetch(`${base}/drip/${A}`)).json()) as { status: string };
      assert.equal(st.status, "sent");

      const again = await fetch(`${base}/drip`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: A }) });
      assert.equal(again.status, 409);
      assert.equal(((await again.json()) as { code: string }).code, "already_dripped");

      const rich = await fetch(`${base}/drip`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: B }) });
      assert.equal(rich.status, 409);
      assert.deepEqual(Object.keys((await rich.json()) as object).sort(), ["code", "error"]);

      const bad = await fetch(`${base}/drip`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: "nope" }) });
      assert.equal(bad.status, 400);
      assert.equal(((await bad.json()) as { code: string }).code, "bad_address");

      const none = (await (await fetch(`${base}/drip/${"0x" + "9".repeat(40)}`)).json()) as { status: string };
      assert.equal(none.status, "none");
    } finally {
      server.close();
    }
  });
});
