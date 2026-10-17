# Third-party audio and software

## FluidR3_GM harmonica samples

- Local file: `public/audio/harmonica-mp3.js` (unchanged)
- SoundFont: Fluid (R3) / FluidR3_GM
- Pre-rendered distribution: Benjamin Gleitzman and contributors, [gleitz/midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts)
- Exact resource: https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/harmonica-mp3.js
- License: [Creative Commons Attribution 3.0 Unported](https://creativecommons.org/licenses/by/3.0/)
- Upstream attribution and license statement: https://github.com/gleitz/midi-js-soundfonts#soundfonts-available

The sample data is distributed separately from this application's code. No endorsement is implied.

## SoundFont loop points

- Local file: `public/audio/harmonica-loop.json` (unchanged numerical loop offsets for the FluidR3_GM harmonica)
- Source: https://goldst.dev/midi-js-soundfonts/FluidR3_GM/harmonica-loop.json
- This is the loop-data endpoint selected by smplr's Soundfont loader for this instrument; offsets refer to the FluidR3_GM source samples at 44100 Hz.

Playback instead uses `public/audio/harmonica-loops-calibrated.json`, locally derived from the decoded bundled MP3 samples at 44100 Hz to match each rendered note's pitch and waveform at the loop boundary. The original upstream table is retained for provenance. Sample attribution and license remain as listed above.

## smplr

- Version: 1.1.0 (pinned)
- Author: danigb and contributors
- Source: https://github.com/danigb/smplr
- License: MIT, as declared in the published npm package.

Development dependencies and their precise versions are recorded in `package-lock.json`.

## Musyng Kite harmonica samples

- Local file: `public/audio/musyngkite-harmonica-mp3.js` (unchanged upstream bytes)
- SoundFont: Musyng Kite, sourced upstream from https://www.synthfont.com/SoundFonts/Musyng%20Kite.sfpack
- Pre-rendered distribution: Benjamin Gleitzman and contributors, [gleitz/midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts#soundfonts-available)
- Exact resource: https://gleitz.github.io/midi-js-soundfonts/MusyngKite/harmonica-mp3.js
- License: Creative Commons Attribution-ShareAlike 3.0 Unported; full terms bundled in `public/audio/MusyngKite-LICENSE.txt`, https://creativecommons.org/licenses/by-sa/3.0/
- SHA256: `94c7c083932137e1198715db63759fa6048796fb691e99054984f80726e879f0`
- Derived loop timing metadata: `public/audio/musyngkite-loops-calibrated.json`, distributed under the same CC BY-SA 3.0 terms. The sample audio is unchanged; only separate per-note sustain offsets were derived locally.

The sample bank is bundled as local text and fetched through a data URL for compatibility with the running local service. It never executes as JavaScript. Playback makes no external requests. This resource license is separate from the application code; no endorsement is implied.

## GeneralUser GS harmonica (free)

- Author: S. Christian Collins; GeneralUser GS 2.0.3
- Source: https://github.com/mrbumpy409/GeneralUser-GS at commit `684543d5e5efaef08d02be50dcda8d552478fa60`
- Local resource: `public/audio/generaluser-harmonica-mp3.js` and separate `generaluser-loops.json`
- License v2.0 is included verbatim in `public/audio/GeneralUser-LICENSE.txt`.
- Derived here by rendering bank 0, program 22 (zero-based Harmonica), velocity85, 44100Hz mono, with FluidSynth2.6.1 (chorus/reverb disabled), then encoding as96kbpsMP3. This is a pre-rendered instrument, not a complete live GeneralUser GS synthesizer. The audio and loop table may be repackaged under the author's license.
- FluidSynth is only a development rendering tool, not bundled with the app: https://github.com/FluidSynth/fluidsynth/releases/tag/v2.6.1

## VCSL Hohner Special20 C harmonica (free)

- Author/source: Versilian Studios LLC, Versilian Community Sample Library, https://github.com/sgossner/VCSL
- Snapshot: `c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e`
- Original instrument: `Aerophones/Free Aerophones/Harmonica-Hohner-Special20-C/Sustains/{Normal,Soft,Vib}`
- Local derived resources: `public/audio/vcsl-{normal,soft,vib}-harmonica-mp3.js` and matching `*-loops.json`
- License: CC0-1.0; full upstream license in `public/audio/VCSL-LICENSE.txt`.
- Derived here by resampling the sustained WAVs to44100Hz mono and encoding as128kbpsMP3, plus independently derived sustain loops. Normal has9 sampled pitches, Soft andVib10 each; the sampler transposes nearest anchors for intervening notes and extended ranges. These are recordings of a diatonic harmonica, not a chromatic harmonica recording.
