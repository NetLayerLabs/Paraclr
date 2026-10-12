# Paraclr demo film

A 2:46 film made with [Remotion](https://www.remotion.dev) for the judges of Monad Metropolis: the
liquidation race, Paraclr's block clock, its 8 lanes, the live app and Arena on Monad testnet, and the
measured proof. Thesis: **Paraclr replaces the liquidation race with a clock.**

The motif, "The Clock and the Lanes": eight thin parallel lanes (the 8 lanes of the logo artwork) with
block ticks running along them, about one block per 0.33 s. The lanes never cross. When one lane
lights up, it resolves in place while the other seven keep running (`src/ui/Lanes.tsx`).

`video/teaser/` is the older 15 s teaser and is separate.

## What is real

- **Cold open:** CoinGlass's own 24 h figures for 10–11 October 2025 were $19.13 billion liquidated
  and 1,618,240 traders, the largest day on its records. Those are the only figures that do not come
  from this repo. The source is named on screen.
- **The race (scene 2):** a schematic of the typical first-bot-wins, fixed-penalty liquidation,
  labelled "schematic" on screen. It has no numbers.
- **The clock:**
  - the first half is real footage of the live landing hero at paraclr.xyz. The site itself calls that
    readout a schematic, slowed down, and so does the on-screen label;
  - the chart uses the live testnet parameters in `deployments/10143.json`: +5 bps per block, the pool
    minimum at 75 bps (block +15) and the 1% fixed fee. 75 bps is the earliest the pool can take: in the
    Arena runs recorded for this film, the keeper's pool takes landed at 1.00–1.10% (blocks 20–22), which
    is why the narration says the pool "can take from seventy-five";
  - the seconds use the 303 ms block interval measured in the bench file below.
- **The lanes:** a motion graphic of the real design (`uint160(account) % 8`, lane-local storage).
- **The app:** real footage of paraclr.xyz/app on Monad testnet, recorded on 2026-10-11 with headless
  Chrome (1600×900, device scale 2) in a new Privy account:
  - email sign-in (the email is blurred in the page and covered in the film; the one-time code is
    never shown);
  - the 0.3 MON gas drip;
  - "Claim test AUSD" from Agora's testnet faucet (10,000 test AUSD);
  - the beta risk notice, accepted;
  - a 10 AUSD deposit;
  - a 3x SOL long of 0.270 SOL, filled at 111.15 at the first Pyth price about 3 s after the order
    was committed.
- **The Arena:** one real press of "Crash the market" on paraclr.xyz/arena (crash #4 on that
  deployment). Per the page, it runs on the Arena's demo stack on Monad testnet: a MockOracle shock and
  synthetic accounts. The 8 lanes cleared in about 9 s. The footage holds on the cleared lanes.
- **What traders kept:** `bench/results/10143-2026-10-10T22-40-07Z.json`, measured on Monad testnet:
  - a −20% shock with 22 accounts liquidated;
  - the auctions took 1,052.41 AUSD (2,564.20 equity at start − 1,511.79 returned);
  - the fixed-fee counterfactual (`legacyCounterfactual.traderLoss`) is 1,464.26 AUSD;
  - that is 28.1% less, shown as 28%.
- **Conflict X-ray:** `bench/xray/10143-run-mv2ze6l6-xzyi6.json`, using `debug_traceTransaction`
  (prestateTracer) and same-block edges:
  - Paraclr's lanes: 18 txs and 0 cross-lane edges;
  - the naive shared-state build: 25 txs and 49 cross-lane edges;
  - the matrices are drawn from that file's transactions and edges;
  - one lane-less tx (`seedAccounts`, the demo top-up) is sorted last.
  This run is a different crash from the 28% file. The bench file's own X-ray
  (`run-mv2za35r-mfh66`) shows 0 vs 18. Each X-ray file traces one crash on both builds.
- **Built on:** the partner logos are the files in the app's `public/partners/`. The Safe and timelock
  addresses and the 600 s delay come from `deployments/10143.json`. "256 Foundry tests · 23 invariant
  tests" comes from the README. Not yet audited.
- **Logos:** Paraclr's are the real masters in `public/brand/`, made transparent by
  `scripts/brand.mjs` the same way the app's `scripts/brand-assets.mjs` does it, and never redrawn. The
  turn scene draws 8 lines over the mark's own lane positions, then dissolves into the artwork. The
  NetLayer Labs mark and wordmark are lifted from NetLayer's header render by `scripts/netlayer.mjs`.
- **Narration, music and sound:** ElevenLabs.
  - The narrator is Sarah (`eleven_multilingual_v2`), picked from an audition against Lily and Alice
    (`scripts/audition.mjs`).
  - "Paraclr" is read as "Paraclear".
  - The score was made with ElevenLabs Music, and the effects with sound generation.

Every number on screen is labelled Monad testnet or test funds. Nothing here claims mainnet. Figures are
shown exactly as in their sources, with thousands grouped by a thin space (U+2009) and a decimal point
(`src/ui/format.ts`), so they read the same in Europe and the US.

## Build it

The ElevenLabs key is read at runtime from `/Users/mrnetwork/Syntura/video/.env` (`scripts/env.mjs`).
It is never stored here.

```
npm install
npm run brand && node scripts/netlayer.mjs && node scripts/data.mjs   # logos and evidence -> src/data.json
npm run vo && npm run timing && npm run music && npm run sfx          # narration, word timing, score, effects
node scripts/session.mjs   # capture: a headless Chrome on paraclr.xyz driven step by step (see the file)
npm run encode             # .cache/frames -> public/footage + src/footage.json
npm run studio             # preview
node scripts/stills.mjs 400 1300 ...                                  # half-scale check stills
npm run draft                                                         # half-scale draft
npm run render4k && node scripts/finish.mjs                           # 4K master, -14 LUFS / -1 dBTP
ffmpeg -i out/paraclr-demo-4k.mp4 -vf scale=1920:1080:flags=lanczos -c:v libx264 -crf 16 -preset slow -c:a copy out/paraclr-demo-1080p.mp4
npm run poster                                                        # 1920×1080 thumbnail
```

- `script.json` holds every spoken line.
- `src/timing.json` (from `scripts/timing.mjs`) places each word on the frame where it is spoken, and
  the scenes animate on those words (`wordAt`).
- Footage, stills, renders and caches stay local (gitignored).

## The technical demo cut

A second composition, `TechDemo` (`src/TechDemo.tsx`, `script-tech.json`, `src/timing-tech.json`). It is
built for the hackathon's "Technical demo video" slot: the working product first. It runs 2:48 (168.0 s),
and 120.4 s of that (71.7%) is real footage of paraclr.xyz:

| scene | seconds | |
|---|---|---|
| open, problem, turn (the film's hook) | 29.6 | motion graphics |
| sign-in, gas and faucet, open long, close, on chain | 48.0 | footage |
| Clearing tab | 19.2 | footage, zoomed onto the lanes, then onto Envio's stats |
| Backstop tab | 14.0 | footage, zoomed onto the pools, the pool panel, then 0.00 earned |
| Arena crash #4 | 18.9 | footage |
| X-ray | 20.4 | footage, with a card naming the bench runs |
| built on, close | 18.0 | motion graphics |
 It reuses the film's look, voice and hook, and keeps its own
audio (`public/audio/vo-tech/`) and timing, so the film's files are never touched.

What is real, in addition to the film's list above:

- **Close:** filmed on 2026-10-12 in the same Privy account. The first close attempt reverted on-chain
  (block #70295482) under Monad's reserve-balance rule, because the wallet held under 10 MON and the
  close was not its first transaction in 3 blocks. After the wallet was topped up with testnet MON, the
  close filled at 111.55 (the Pyth price of 04:00:35 UTC), realized +0.11 AUSD, in block #70296603. The
  film shows the app's own share card for that round trip. The app has since been changed to wait out
  the 3-block rule itself.
- **On chain:** History (indexed by Envio) shows the open filling in 3 s. The close's fill tx
  `0x0ad54f7c…fb58fba` is shown on MonadVision, recorded in a visible Chrome window
  (`scripts/explorer.mjs`), because the explorer shows a bot check to headless Chrome.
- **Clearing and Backstop tabs:** shown as they are on the production deployment. It has 13 accounts,
  no auctions yet, pools with an exit value of 805.00 AUSD and nothing earned yet. The narration says so.
- **X-ray:** the Arena's live X-ray of crash #4 (run `mv4b7d4t-dx2sr`) shows Paraclr 0 vs shared 11
  cross-lane edges. A card beside it names the measured bench runs (0 vs 49, and 28%) and their files.

Build it: `node scripts/reuse.mjs && SCRIPT=script-tech.json node scripts/voiceover.mjs && SCRIPT=script-tech.json node scripts/timing.mjs`,
then render the `TechDemo` composition the same way as the film (`--scale 2 ...`, `finish.mjs`, Lanczos 1080p).
The cover art is the `PosterTech` still, embedded as `attached_pic`.

## The 30-second promo

The `Promo` composition (`src/promo/Promo.tsx`) is a 28.6 s clip for social posts and the form's
"promotion" field. It reuses the film's scenes, footage and brand, and its cuts follow the music.

- **Music:** a new 30 s ElevenLabs cue at 119.5 BPM (`scripts/promo-music.mjs`). `scripts/promo-audio.mjs`
  re-edits it on bar lines (the last 2 bars of the build, the drop and 8 bars, then the last 4 bars again),
  so the drop lands at 4.02 s, right on the logo. Every montage cut sits on a beat.
- **Voice:** three short lines from Sarah. "Liquidation is a race." and "Fair liquidations for Monad. Crash
  it yourself." are new; "Paraclr replaces the race with a clock." is the film's take, copied into
  `public/audio/vo-promo/`.
- **What is real:** the six montage cuts are the same live paraclr.xyz recordings as the technical demo:
  - Privy sign-in, with the email blurred;
  - the SOL long filling at the Pyth price;
  - the close's share card (+0.11 AUSD, +1.1%);
  - Arena crash #4 on the demo stack with synthetic accounts;
  - its 8 lanes clearing;
  - its live X-ray, 0 vs 11.
  The proof cards show the bench files' 28% (1 052.41 vs 1 464.26 AUSD) and 0 vs 49, with the file names
  on screen. The race at the start is the film's schematic.

Build it: `node scripts/promo-music.mjs && node scripts/promo-audio.mjs`, then render `Promo` like the
film. The cover art is the `Poster` still.
