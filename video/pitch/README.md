# Paraclr pitch (NetLayer Labs, Monad Metropolis)

The team pitch for the hackathon's "Pitch video" field (limit 2:00). MrNetwork, founder of NetLayer Labs, on camera,
tightened at the word level, with fact cards, four real app cutaways, burned-in word-lit captions and a NetLayer end card.
Final length **1:54.6** (1:49.6 of talk + a 5 s end card), 4K master at 30 fps.

## What is real

- **The talk:** `UseParaclr.MOV`, recorded by the founder (3840x2160, 60 fps, 1:58.6). Nothing he says was re-recorded or
  generated. The edit (`scripts/edit.mjs`) only removes the head and tail, "uh" x2, "like", a stammered "a, a,",
  "So, and", six sentence-leading "So"s, and pauses longer than 0.8 s (stops), 0.55 s (commas) or 0.34 s (between words).
  Captions show his words; only spellings are corrected (the speech-to-text heard "Karma" for Calmr, "Visco" for Visko,
  "Paraclar" for Paraclr, "Netslayer" for NetLayer).
- **Cards** carry what he says, plus repo facts:
  - netlayerlabs.com: Italy, 5 shipped, 3 on mainnet, Calmr 1st place at Visko Orbis;
  - the founder: the $4 000 prize;
  - this repo's README (Monad testnet, 2026-10-10 Arena crash): 28% less taken from traders (1 052.41 vs 1 464.26 AUSD vs the
    fixed 1% fee), 0 vs 49 cross-lane dependency edges, 8 lanes, a 0 → +5 bps per block discount on the live testnet.
  - No Paraclr mainnet claims.
- **Cutaways:** real screen recordings of paraclr.xyz from `video/demo` (the landing's auction clock, the Arena lanes,
  the Conflict X-ray, the Arena crash). They are labelled on screen: real app, Monad testnet, test funds.
- **Audio:**
  - His voice, cleaned with an 80 Hz high-pass, light FFT denoise, de-ess and 2.5:1 compression, at -16 LUFS (`scripts/voice.mjs`).
  - A low instrumental bed from the ElevenLabs Music API, about 27 dB under the voice (the Fitr pitch is about 26 dB).
  - A few ElevenLabs sound effects.
  - The master is finished at -14 LUFS, ≤ -1 dBTP.
- **Brand:** NetLayer's own chrome artwork (`public/brand`) and Paraclr's logo, which is the only brand colour on the cards.

## Build it

```sh
npm install
# the take: 1080p30 proxy for drafts, 4K30 intermediate for the master (public/footage is gitignored)
ffmpeg -i public/footage/UseParaclr.MOV -an -vf "fps=30,scale=1920:1080:flags=lanczos" -c:v libx264 -crf 17 -g 15 -pix_fmt yuv420p public/footage/use-1080.mp4
ffmpeg -i public/footage/UseParaclr.MOV -an -vf fps=30 -c:v libx264 -crf 14 -g 15 -pix_fmt yuv420p public/footage/use-4k.mp4
node scripts/voice.mjs public/footage/UseParaclr.MOV && cp .cache/voice-clean.wav public/audio/voice.wav
node scripts/transcribe.mjs          # ElevenLabs speech-to-text, word timestamps (key read at runtime, never printed)
node scripts/edit.mjs                # cuts -> src/edit.json
node scripts/bed.mjs && node scripts/sfx.mjs
node scripts/stills.mjs              # contact sheet -> out/stills/sheet.jpg
npm run draft                        # half scale
npm run render4k && node scripts/finish.mjs
npm run poster                       # 4K thumbnail
```

Phase 1 (a voice-only kinetic film, composition `VoiceFilm`, `script.json`, `scripts/timing.mjs`) is kept for reference.
