---
name: handsforbots-conversation
description: Build conversation behavior on Hands for Bots v2 (H4B) - what happens when the user types or speaks while the assistant is answering (interrupt, merge or queue; h4b.setInput, h4b.interrupt, the interrupt.before hook), stop buttons, and continuous voice conversation with @handsforbots/voice (hands-free open microphone, end-of-turn detection with silence or a model such as httpEndOfTurn, LiveKit turn-detector, Smart Turn or an LLM, barge-in, backchannels, sentence-by-sentence speech, phase/pauseSince/endOfTurnAt/endOfTurnCheckAt state for the UI), and noisy rooms (measuring background noise with checkNoise or the voice noise option, falling back to push-to-talk, warning the user, and the levelGate option that keeps TV or people nearby from interrupting the bot). Use when code calls h4b.interrupt, setInput, whileBusy, voice({ mode: 'hands-free' }), endTurn, discardTurn, setEndOfTurn or listens to voice.decision or voice.noise, when users complain that voice fails in noisy places, when building a voice assistant UI or a stop/send/trash button on top of H4B, or when a backend must handle interrupted replies, the conversation.interrupted signal or voice.reactions.
---

# Hands for Bots v2 — interruption and voice conversation

Full guide: `docs/en-us/conversation.md` (`docs/pt-br/conversation.md`) in https://github.com/handsforbots/handsforbots. Decision: `docs/adr/0011-interrupcao-e-fim-de-turno.md`. Sources and vendor figures: `docs/en-us/references.md`. When the code in the project disagrees with this file, trust the code (`packages/core/src/kernel.ts`, `packages/voice/src/voice.ts`).

## Input while the assistant is busy

Default (`whileBusy: 'interrupt'`): a typed or spoken message sent during a reply **cuts the reply** (it keeps only what was shown, `interrupted: true`) and becomes the next turn. If nothing came out of the running turn yet, the turn is **resumed**: aborted, its user message removed, and run again with both inputs as one message. Quick consecutive messages are joined the same way (one backend call).

| Need | Do |
|---|---|
| Market-style default (stop and send in one step) | nothing; or `createH4B({ input: { whileBusy: 'interrupt' } })` |
| Join extra messages without cutting the reply | `whileBusy: 'merge'` |
| Old behavior: every message waits its turn | `whileBusy: 'queue'` |
| Per modality / per rule | `{ whileBusy: { text: 'merge', transcript: 'interrupt' } }` or a function of the signal |
| Let the user or the app change it at runtime | `h4b.setInput({ whileBusy })`; read it from `getSnapshot().input` |
| One signal with its own rule | `h4b.signal({ ..., whileBusy: 'queue' })` |
| Stop button / Escape / barge-in | `h4b.interrupt()` (the `keyboard` plugin's Escape already does) |
| Cancel without touching the history | `h4b.abort()` |

Facts to rely on:

- Only `text`, `transcript` and `audio` triggers follow the policy. GUI events, commands, `runAction` and `push` always queue. Direct commands (menu) and captures are never joined.
- `ask()` queues unless you pass `whileBusy`, so awaited results are never merged into user input.
- `h4b.interrupt()` aborts, marks the assistant message of the running turn `interrupted: true`, cuts its text where `interrupt.before` interceptors say (default: everything shown), removes it if empty, emits `turn.interrupted`. Idle: it cuts the last reply only if an interceptor reduces `keep` (the voice plugin does, to what was spoken).
- `h4b.interrupt({ by })` says who cut it (default `api`; `whileBusy` passes the signal's modality; the voice plugin passes `voice`).
- Events: `signal.merged` `{ signal, from, resumed }`, `turn.interrupted` `{ turnId, messageId?, kept?, removed?, by? }`. `getSnapshot().queued` shows merged text.
- The widget marks interrupted replies (class `interrupted`, trailing "…", tooltip `strings.interrupted`).

Backend checklist (tell the user if their server misses any): stop the LLM call when the request is aborted (otherwise interrupting saves no tokens); use the history received on each run, never a server-side copy; accept assistant messages that end mid-text; read the one-turn context signals (ADR 0015) and say in the system prompt what they mean.

What the backend receives on the next request (context signals with `once: true`, removed after that request; a newer one under the same key is kept):
- `conversation.interrupted`: `{ messageId, kept, total, by }` after any interruption that cut a reply (also when it was removed, `kept: 0`). Off: `createH4B({ input: { reportInterruptions: false } })` or `setInput()`.
- `voice.reactions`: `{ messageId, reactions: [{ at, text }] }`, backchannels heard while the bot spoke; `at` = characters of that reply already spoken. Off: `voice({ reactions: false })`. A hint, not a fact (browser STT misses short sounds); H4B does not interpret them.
- Wire: `http`/`aiSdk` → `context['conversation.interrupted'] = [{…}]`; `agui` → `context` item `description: 'gui-event from conversation.interrupted'`, `value: 'interrupted: {json}'` (`'transcript from voice.reactions'`, `'reactions: {json}'`).
- Your own one-off news: `h4b.signal({ kind: 'context', key, once: true, … })`.

## Continuous voice conversation

```ts
voice({
  stt: webSpeechSTT(),            // or websocketSTT / voskSTT / voskBrowserSTT / httpSTT
  tts: webSpeechTTS(),
  mode: 'hands-free',              // open microphone
  endOfTurn: httpEndOfTurn({ url: '/api/end-of-turn' }), // optional
  turn: { silence: 800, minSilence: 300, maxSilence: 2000, threshold: 0.5, timeout: 600 },
  bargeIn: { minWords: 2, ignore: [...] },               // or false
  echo: textEchoFilter({ threshold: 0.6, tail: 2000 }),   // the default; false turns it off
})
await h4b.get('voice').listen()
```

- Finals pile up into **one pending turn**, sent when the turn ends. Pauses count from the last words heard (partials included), not from the late final result. After `silence` ms without a provider; with one, asked after `minSilence`, sent if probability ≥ `threshold`, else at `maxSilence`; a slow (`timeout`) or failing provider falls back to `silence`. Speaking again keeps the turn open.
- A recognizer that detects turns itself decides alone and the provider is not called: `websocketSTT({ ..., endOfTurn: true, parse })` with `parse` returning `{ final, endOfTurn }` (services such as AssemblyAI or Soniox, behind your server's token endpoint), or any provider with `capabilities.endOfTurn` that passes `{ endOfTurn }` to `onFinal`.
- Buttons: "send now" `voice.endTurn()`, "trash" `voice.discardTurn()` (keeps listening), mic off and send `voice.stop()`, mic off and discard `voice.cancel()`.
- Runtime: `voice.setEndOfTurn(provider | null)`, `voice.setEcho(filter | null)`, `voice.configure({ turn, bargeIn })`.
- Draw from `getState()`: `phase` (`idle | listening | userSpeaking | waitingEndOfTurn | botSpeaking`), `partial` (whole pending turn), `pauseSince` + `endOfTurnAt` (epoch ms: start and latest end of the pause; animate from `pauseSince` for `endOfTurnAt - pauseSince` ms with a negative delay of `pauseSince - Date.now()`), `endOfTurnCheckAt` (set only while an end-of-turn provider may still send before `endOfTurnAt`: show that the wait may end early; cleared when it says "not finished", and `endOfTurnAt` moves to `pauseSince + silence` if it fails), `interrupted`, `endOfTurn`, `error`.
- Debug with `h4b.on('voice.decision', d => …)`: `interrupt`, `ignore` (`reason: backchannel | echo`; backchannels carry `messageId` and `at`), `end-of-turn` (`reason: stt | model | silence | max-silence | manual`), `end-of-turn-unavailable`.

### End-of-turn providers

Contract: `{ name, input: 'text' | 'audio', historyTurns?, remote?, consent?, isSupported(), load?(), predict({ partial, history, language, audio? }, signal) → probability 0..1 }`.

- **Remote** (LiveKit turn-detector, a BERT classifier, a typed-decision model like Jev, or the app's LLM): `httpEndOfTurn({ url, headers?, parse?, historyTurns?, consent? })` POSTs `{ partial, history, language }` and reads `{ probability }` or `{ done }`. Put the model and its key on the server; never call a paid API from the browser.
- **Local** (Smart Turn in ONNX via `onnxruntime-web`, a small text model): implement the contract; use `load()` to download on demand.
- Audio providers need a recognizer with `capabilities.audio` (`websocketSTT`, `voskSTT`, `voskBrowserSTT`). **Web Speech exposes no audio**: with `webSpeechSTT`, use a text provider.
- Each remote call costs latency and money per pause; recommend it on by default in hands-free only if the app can afford it, and measure in the app's language (vendor numbers are not ours).

### Barge-in and speech

- Speech over the bot (speaking, or a reply streaming on screen) calls `h4b.interrupt()` before stopping the speech, so the reply keeps the sentences already spoken. Live transcripts need `minWords`; finals always count; backchannels ("aham", "tá", "ok", "uh-huh", "mhm"…, per language) never interrupt; they go to `voice.decision` and to the backend as `voice.reactions`. Pressing to talk while the bot answers interrupts too.
- While the bot is still thinking (nothing shown), speech does not interrupt: the kernel resumes the turn with both messages when the new turn ends.
- `bargeIn: false` pauses recognition while the bot speaks instead.
- **Echo filter** (on by default): with speakers the recognizer hears the bot, and browser echo cancellation often misses it (`speechSynthesis` plays outside the browser's audio path), so the bot would interrupt or answer itself. `textEchoFilter()` drops texts whose words mostly (`threshold` 0.6, runs of `minRun` 2) repeat the sentences spoken in the last `tail` ms (2000); all or nothing, single words pass. Replace it with any `EchoFilter` `{ name, tail?, filter({ text, final, speech, language }) → text | '' }` (synchronous: it runs on every partial), or `echo: false` for headphone-only apps. If users report the bot cutting itself off, check `voice.decision` for `reason: 'echo'` before raising `minWords`.
- Replies are spoken sentence by sentence as they stream (output follows input with `output: 'auto'`).
- Which voice speaks (browser, backend, models in the page), model downloads and voice effects: the `handsforbots-speech` skill.

## Privacy

Providers declare `remote` (text or audio leaves the page; `webSpeechSTT` is remote: Chrome sends audio to its service, continuously in hands-free) and may take a `consent` purpose; while not granted, the plugin skips them (next recognizer, or silence). The app shows the notice and stores the decision (see the `handsforbots-consent` skill). Microphone recognizers use echo cancellation; Web Speech does not let you set it. Recommend testing on real phones, with and without headphones, and long sessions on iOS Safari.

## Noisy rooms

The browser has no "too noisy" API; `@handsforbots/voice` measures it (levels in dBFS, percentiles over 20 ms frames). Pick the level of help:

| Goal | Use |
|---|---|
| Widget, nothing custom | `voice({ mode: 'hands-free', noise: true })`. The widget shows "Checking the background noise…", a hint while listening in a noisy room and a "too noisy, hold the mic" message after the fallback (texts: `strings: { noiseChecking, noiseHint, noiseTooLoud }`) |
| Warn but never change the mode | `noise: { tooNoisy: 'warn' }` |
| Check when the app decides (onboarding, a "test my mic" button) | `noise: { check: 'manual' }`, then `await h4b.get('voice').checkNoise()`; or `checkNoise()` / `measureNoise(stream)` exported by the package, with no plugin |
| Your own UI | read `getState().checkingNoise`, `noise` (`verdict`, `reasons`, `noiseFloorDb`, `snrDb`, `fluctuationDb`) and `noiseFallback`; or `h4b.on('voice.noise', ({ report, action }) => …)` |
| Your own measure (a model, a server) | `noise: { measure: async (signal) => report }`, building the report with `assessNoise({ levels })` |
| TV or people nearby interrupt the bot or start turns | `levelGate: true` (hands-free), `scope: 'all'` for turns too; see below |

What `noise` does (check `packages/voice/src/voice.ts` if in doubt):

- Only hands-free `listen()` is checked (`check: 'hands-free'`, default); it waits for the measurement (`durationMs`, 1500; `timeoutMs` defaults to `durationMs + 2000`, `0` disables so a stalled/suspended audio graph cannot hang) and then `settleMs` (default 100 after built-in `checkNoise()`, 0 when `measure` is supplied, 0 disables) before starting the recognizer to avoid audio-device contention (CoreAudio/Bluetooth/mobile). `checkingNoise` stays `true` until `listening` becomes `true` (or fallback/`stop`/`cancel`) with no intermediate idle gap. Push-to-talk is never checked.
- `too-noisy` → mode becomes `push-to-talk`, `noiseFallback: true`, nothing heard (default `tooNoisy: 'push-to-talk'`). `noiseFallback` clears on the next `setMode()`. `noisy` → listens; the report is in the state.
- A report newer than `maxAgeMs` (300000) is reused. When no fresh check is needed (`noise` off, push-to-talk, `check: 'manual'`, or a cached report within `maxAgeMs`), `listen()` starts the recognizer synchronously inside the call to preserve browser user activation. `stop()`/`cancel()`/`toggle()` and app disposal (`h4b.stop()`) during the check abort it. A failed measurement emits `error` (`source: 'voice:noise'`) and listening starts anyway.
- The check opens the raw microphone (`processing: false`) by default, a separate capture from Web Speech's. Capture helpers (`captureFloat`, `capturePcm16`, `monitorLevel`) resume a suspended `AudioContext`, and `checkNoise()` creates/resumes its `AudioContext` before `getUserMedia`.

Reasons and what to tell the user:

- `loud-floor`: steady loud noise. Suggest a quieter place; noise suppression helps with fans and air conditioning.
- `fluctuating`: voices, TV, traffic. The worst case for recognition and barge-in. Suggest a headset or push-to-talk; consider a higher `bargeIn.minWords`.
- `low-snr`: the user's voice is barely above the noise. Suggest speaking closer to the mic.
- `clipping`: too loud or too much gain. Suggest moving the mic away.
- `silent-input`: no signal: muted mic or wrong device. Do not call it noise.

Pitfalls:

- Defaults are a starting point (floor -50/-35 dBFS, SNR 15 dB, fluctuation 6 dB): dBFS is not sound pressure. Calibrate `thresholds` with recordings from the app's real devices before relying on `too-noisy`.
- With `webSpeechSTT` on Safari/iOS, waiting for `getUserMedia` + `durationMs` in `check: 'hands-free'` can outlive Safari's transient user activation for `SpeechRecognition.start()`: call `voice.checkNoise()` ahead of time (or use `check: 'manual'`) so the cached report lets `listen()` start `SpeechRecognition` synchronously inside the user's click/tap.
- Do not turn `noise` on for push-to-talk-only apps: it does nothing there. Do not run `checkNoise()` while the recognizer is listening on Safari/iOS without testing: two captures on one device behave differently per browser.
- The noise check cannot tell nearby voices from the user's; they show up as `fluctuating` (or `low-snr` when the user also spoke). The level gate is what keeps them out of the conversation.

### Level gate (voices nearby)

`voice({ mode: 'hands-free', levelGate: true | { scope?: 'barge-in' | 'all', gapDb?: 10, lookbackMs?: 3000, remember?: 5, open? } })`. No model: the user speaks into the mic, so they are louder than voices around them.

- Opens a second mic capture while hands-free listens (closed on stop); push-to-talk is never gated.
- Learns `userLevelDb` (state) as the median of the loud end (p95) of the last `lookbackMs` at each accepted hands-free utterance (last `remember`); never while the bot speaks or within `lookbackMs` after. Nothing is dropped before the first utterance.
- A transcript whose window is below `userLevelDb - gapDb` is background: with `scope: 'barge-in'` (default) only while the bot answers (no interrupt, no turn); with `'all'` always in hands-free. Finals dropped → `voice.decision` `{ kind: 'ignore', reason: 'background', levelDb, userLevelDb }`. Monitor failure → `error` `voice:level-gate`, listening continues ungated.
- Recommend `scope: 'all'` only after testing: a wrongly learned level keeps dropping the user. Raise `gapDb` if the user is cut when speaking softly; lower it if the TV still interrupts.
- Fails when the user speaks much softer or moves away, or the background is as loud as the user. With `webSpeechTTS` on speakers the bot's own voice is in the window (no echo cancellation for `speechSynthesis`); recommend headphones or a TTS played through the page. To know *who* speaks you need a speaker-conditioned model (Personal VAD), not this.
- `detectEndOfSpeech` (used by `httpSTT`) already tracks the noise floor (`margin: 3`, `floorMs: 3000`); `margin: 0` restores the fixed 0.015 RMS threshold.

### Debugging noise and the level gate

When voice misbehaves only in some places, ask for (or log) these before changing code; all are levels in dBFS, no audio:

- State: `noise`, `checkingNoise`, `noiseFallback`, `userLevelDb`.
- `voice.noise` `{ report, action? }`; `voice.level` (`monitor.open`/`close`, `learned` `{ levelDb, userLevelDb, gateDb }`, `learn.skipped` `{ reason: 'bot-speech' | 'no-audio' }`); `voice.decision` `background` and `interrupt` carry `levelDb`/`userLevelDb`; errors `voice:noise`, `voice:level-gate`. The `observability` plugin records all of them (`voice.noise`, `voice.level.<event>`).
- Read them: fallback to push-to-talk → `voice.noise` reasons/floor (thresholds too strict?). TV still interrupts → `interrupt` with `levelDb` near `userLevelDb` (TV as loud as the user, or bot voice in the window with `webSpeechTTS` on speakers); no levels → gate off or monitor failed. User ignored → `background` with `levelDb` far below a too-high learned `userLevelDb` (check `learned` events; raise `gapDb`). No `userLevelDb` → `learn.skipped` reasons.

## Pitfalls

- Don't build your own silence timer or "is the bot talking" flag on top of the plugin: use `phase`, `pauseSince`, `endOfTurnAt` and `endOfTurnCheckAt`.
- Don't call `voice.cancelSpeech()` before `h4b.interrupt()` in custom barge-in code: interrupt first, so the voice plugin can report how much was spoken.
- Don't send `partial` to the backend yourself; the plugin sends the turn.
- `bargeInChars` no longer exists; use `bargeIn: { minWords }`.
