# Mainnet beta: launch-day posts, fallback, replies

Status: DRAFT. Nothing here has been posted. A human must review it before anything goes live. Handles are unverified
placeholders; see the verification table in `launch-thread.md`.

## The gate for every post in this file

Post the **launch-day** posts only if **all** of these are true on the day:

- `deployments/143.json` is committed with `"production": true`, and the rebuilt landing page shows "Live on Monad
  mainnet · unaudited beta · capped" with the contract table.
- Every launch-gate check in `docs/PRODUCTION_PLAN.md` passed, and its evidence is in the repo.
- `/terms` and `/risk` have had legal review (or the launch waits).
- Every number below matches the on-chain value the app shows. Fill placeholders from `deployments/143.json`, then
  check them in the app.

If the gate didn't pass, use the **fallback** post instead and don't mention real money anywhere else.

## Extra rules for mainnet posts

- Every launch-day post that mentions the beta carries the label, or the thread's first post does: **"Unaudited beta ·
  capped · use only what you can afford to lose."**
- Never "audited", "safe", "secure", "guaranteed", "risk-free", "no MEV". Audit status is always "not audited:
  internal review and Slither only".
- No yield, return or APY talk. No price talk about MON or any token.
- Don't ask anyone to deposit. Point to the risks before the app.
- Agora (AUSD) and Pyth are infrastructure we use, not partners. Never "partnered with", "backed by", "official".
- The measured results and the X-ray are demo-stack numbers. Say "on Monad testnet" or "local anvil, not Monad" when
  quoting them, never "on mainnet".

Placeholders: `[CAP_DEPOSIT]` / `[CAP_LANE]` = deposit cap per account / TVL cap per lane in whole AUSD, `[MAX_LEV]` =
max leverage, `[TIMELOCK_H]` = timelock delay in hours, `[MIN_DELAY]` = minimum order delay with its unit (e.g. "2
s"), `[FEE_BPS]` = trading fee in bps, `[CHECK]` = the launch-gate check that failed (fallback only). Character counts
are X-weighted lengths from `docs/x/count.py`; a URL or `[LINK: …]` counts as 23.

---

## Launch-day thread

### 1/6: announcement (243 chars)

```
Paraclr is live on Monad mainnet as a small, capped beta: per-block liquidation auctions, per-lane backstops and a solvency check every block, now with real AUSD and Pyth prices.

Unaudited beta · capped · use only what you can afford to lose.
```

Media: `[SCREENSHOT: landing status strip "Live on Monad mainnet · unaudited beta · capped" + contract table]`

### 2/6: what's real now (273 chars)

```
What changed from the testnet demo:

- Collateral is Agora's AUSD (@withAUSD) on Monad mainnet. No faucet, no mint.
- Prices are Pyth updates verified on chain: too old, too uncertain or not positive, and the contract rejects them.
- No synthetic accounts, no crash button.
```

### 3/6: delayed orders (280 chars; 274 when filled)

```
Orders are delayed on purpose. You commit size, margin and a worst price; the order fills at the first Pyth price published [MIN_DELAY] or more after the commit.

Neither you nor the executor picks the price, which closes the classic oracle front-run. MEV-resistant, not MEV-free.
```

### 4/6: caps and admin (259 chars; 233 when filled)

```
Hard caps for the beta: [CAP_DEPOSIT] AUSD per account, [CAP_LANE] AUSD per lane, [MAX_LEV]x max leverage.

The owner is a multisig behind a [TIMELOCK_H]h timelock. A guardian key can only pause; withdrawals, closes and liquidations keep working while paused.
```

### 5/6: audit status and the gate (269 chars)

```
Not audited: internal review and Slither only. We launched after a gate: the full test suite incl. invariants, Slither with high/medium findings fixed or justified, an adversarial internal review, and a rehearsal on a mainnet fork.

That isn't an audit. Hence the caps.
```

### 6/6: links (244 chars)

```
Check every address before you approve anything: [LINK: landing contract table]
Read the risks first: [LINK: risk page]
App: [LINK: app]
Code: [LINK: repo]

Built for Monad Metropolis. Use only what you can afford to lose.
```

---

## Single post (if you'd rather not thread) (279 chars; 272 when filled)

```
Paraclr's capped beta is live on Monad mainnet: fair liquidation auctions with real AUSD, Pyth prices verified on chain, delayed orders, [MAX_LEV]x max leverage.

Not audited: internal review and Slither only. Use only what you can afford to lose.

Risks: [LINK: risk page]
```

## Fallback: the gate didn't pass (250 chars; 274 when filled)

```
No mainnet beta yet. Our launch gate says a real-money deploy needs every check to pass, and [CHECK] didn't make it in time.

So the Monad Metropolis submission is the testnet build, with nothing at stake. The mainnet set waits for an external audit.
```

Reviewer note: `[CHECK]` is one plain phrase, e.g. "the mainnet-fork rehearsal". Don't soften it.

---

## Replies for launch day

**"Is it audited?"** (227 chars)

```
No. Internal review and Slither only, plus a full test suite and a rehearsal on a mainnet fork. That's why it's a capped beta: small caps, a timelock on every change, a pause-only guardian. Use only what you can afford to lose.
```

**"Is it safe?"** (220 chars)

```
We won't call it that. It's unaudited code holding real money, so it's capped and every change waits in a public timelock. The risk page lists what can go wrong, from contract bugs to AUSD depegs: [LINK: risk page]
```

**"Can the team take my funds?"** (276 chars; 267 when filled)

```
The owner is a multisig behind a [TIMELOCK_H]h timelock: every parameter, oracle or role change is scheduled on chain and waits before it applies. The guardian can only pause. Read the contracts and watch the timelock; the code decides, not this reply. [LINK: repo]
```

**"Why didn't my order fill instantly?"** (222 chars; 216 when filled)

```
By design. Orders fill at the first Pyth price published [MIN_DELAY] or more after you commit, so nobody can trade on a price they've already seen. If it can't fill within your worst price, you can cancel after the window.
```

**"Why are the caps so low?"** (157 chars)

```
Because the code isn't audited. Caps bound what a bug could cost. They change only through the timelock, and we'd want an external audit before raising them.
```

**"Is this an official Agora / Pyth / Monad product?"** (144 chars)

```
No. We use AUSD and Pyth price feeds as public infrastructure, on Monad. No partnership, affiliation or endorsement. Built for Monad Metropolis.
```
