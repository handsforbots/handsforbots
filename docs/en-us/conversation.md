# Interruption and voice conversation

How Hands for Bots handles a message that arrives while the assistant is still answering, and how the voice plugin runs a continuous conversation: open microphone, end-of-turn detection and barge-in. Decision record: [ADR 0011](../adr/0011-interrupcao-e-fim-de-turno.md) (Portuguese). Sources: [References](./references.md).

## Input while busy

Turns run one at a time. What a typed or spoken message does when it arrives while a turn runs is the **input policy**, `whileBusy`:

| Policy | The new message… | The reply in progress… |
|---|---|---|
| `interrupt` (default) | becomes the next turn | stops; keeps what was shown, marked `interrupted: true` |
| `merge` | joins a message not answered yet, or waits | continues |
| `queue` | waits for everything before it | continues |

With `interrupt` and `merge`, a turn that has **produced nothing yet** is resumed instead: it is aborted, its user message leaves the history and it runs again with both inputs as one message. Messages sent in a quick sequence are joined the same way, so the backend gets one call instead of several. Typed messages are joined with a line break, speech with a space.

```ts
const h4b = createH4B({ plugins, input: { whileBusy: 'interrupt' } })

h4b.setInput({ whileBusy: 'queue' })                                   // at runtime, e.g. from a settings screen
h4b.setInput({ whileBusy: { text: 'merge', transcript: 'interrupt' } }) // per modality; missing ones use 'interrupt'
h4b.setInput({ whileBusy: (signal) => (signal.source === 'widget' ? 'merge' : 'interrupt') })
h4b.signal({ modality: 'text', parts, source: 'my-input', whileBusy: 'queue' }) // one signal

h4b.getSnapshot().input // the policy in force
```

Rules:

- Only `text`, `transcript` and `audio` triggers follow the policy. GUI events, commands, `runAction` and `push` always queue.
- Direct commands (menu) and captures are never joined: while a trigger is still being routed, new input only queues, and it is joined only if the route turns out to be the transport.
- `ask()` queues unless you pass `whileBusy`, because its result is awaited.
- A queued trigger with `queue` never absorbs others, and a running turn whose trigger has `queue` is never cut by the policy.

Events: `signal.merged` (`{ signal, from, resumed }`) and `turn.interrupted` (`{ turnId, messageId?, kept?, removed? }`). `getSnapshot().queued` shows the joined text, so the widget's dimmed pending message updates in place.

### Interrupting on demand

`h4b.interrupt()` is the stop button, Escape (the `keyboard` plugin uses it) and barge-in:

1. aborts the running job (transports and actions get the `AbortSignal`);
2. marks the assistant message of that turn `interrupted: true` and cuts its text where the `interrupt.before` interceptors say the user stopped getting it: by default, everything shown;
3. removes the message if nothing is left and it carries no tool calls;
4. emits `turn.interrupted` (with `by`, who cut it) and saves;
5. tells the backend on the next turn (see below).

When nothing is running, it only cuts the last reply if an interceptor says part of it was not delivered (the voice plugin reports what was spoken). `interrupt({ clearQueue: true })` also drops the queue; `interrupt({ by: 'stop-button' })` says who cut it (default `api`; typed input gives its modality, the voice plugin `voice`). `abort()` still exists and cancels without touching the history.

```ts
// A plugin that knows how much of a reply the user saw (e.g. a paced reveal):
ctx.intercept('interrupt.before', (point) => ({ ...point, keep: Math.min(point.keep, revealed(point.messageId)) }))
```

Deltas that arrive after the cut are ignored. The widget shows interrupted replies with a trailing "…" and a tooltip (`strings.interrupted`).

### What your backend must do

- **Stop generating when the request is aborted.** The kernel closes the stream (AG-UI SSE, HTTP), but only the server can stop the LLM call. Otherwise an interruption saves no tokens.
- **Use the history it receives.** Transports send the whole history on each run. A backend that keeps its own copy will diverge: it will not see joined messages, removed turns or cut replies.
- **Accept truncated assistant messages.** An interrupted reply ends mid-text.
- **Read what happened while it answered** ([ADR 0015](../adr/0015-retorno-da-interrupcao.md)). The next request carries one-turn context signals (`once: true`, removed after that request):
  - `conversation.interrupted`: `{ messageId, kept, total, by }`, after an interruption that cut a reply. `kept` is how many characters stayed (what was spoken or shown), `total` how long the reply was when cut, `by` who cut it. Off with `createH4B({ input: { reportInterruptions: false } })`.
  - `voice.reactions`: `{ messageId, reactions: [{ at, text }] }`, the backchannels heard while the bot spoke (see [Barge-in](#barge-in)). Treat them as a hint: browser recognition often misses or mishears short sounds.

  On the wire they look like any context signal: `context['conversation.interrupted'] = [{ … }]` in `http` and `aiSdk`; in `agui`, a `context` item with `description: 'gui-event from conversation.interrupted'` and `value: 'interrupted: {…}'` (`'transcript from voice.reactions'`, `'reactions: {…}'`). Tell the model in your system prompt what they mean, for example: "If the user interrupted you, do not repeat the part they did not hear unless asked." 

## Voice: continuous conversation

`mode: 'hands-free'` keeps the microphone open. Final results of the recognizer pile up in **one pending turn** and go out as one message when the turn ends.

```ts
import { voice, webSpeechSTT, webSpeechTTS, httpEndOfTurn } from '@handsforbots/voice'

voice({
  stt: webSpeechSTT(),
  tts: webSpeechTTS(),
  mode: 'hands-free',
  endOfTurn: httpEndOfTurn({ url: '/api/end-of-turn' }), // optional; silence alone without it
  turn: { silence: 800, minSilence: 300, maxSilence: 2000, threshold: 0.5, timeout: 600 },
  bargeIn: { minWords: 2 },
})
```

### When the turn ends

After each final result the plugin waits. Every pause counts from the **last words heard**, live transcripts included, not from when the recognizer delivers its final result (Chrome delivers it half a second or more after the user stops). If the final arrives after the wait is already over, the turn goes out at once:

- **No end-of-turn provider** (or it is loading, failed, slow or lacks consent): sends after `silence` ms of quiet.
- **With a provider:** asks it after `minSilence` ms. A probability ≥ `threshold` sends at once; anything lower waits up to `maxSilence` ms. If the answer takes longer than `timeout` ms, or fails, silence decides.
- **Recognizer that detects turns itself** (`capabilities.endOfTurn`, results marked `{ endOfTurn: true | false }`): sends on `endOfTurn: true`, at the latest after `maxSilence`; the provider is not called.

Speaking again before that keeps the turn open. If the recognizer shows words but never finalizes them, they are sent `maxSilence` after the last words, with no countdown in the state (the plugin cannot tell a pause from slow recognition until a final arrives). If the turn already went out and the reply has not started, the kernel joins the continuation to it (input policy above).

| Control | Call |
|---|---|
| Send now (skip the wait) | `voice.endTurn()`; words still being recognized go too |
| Trash, keep listening | `voice.discardTurn()` |
| Send and close the microphone | `voice.stop()` |
| Discard and close the microphone | `voice.cancel()` |
| Model on/off at runtime | `voice.setEndOfTurn(provider \| null)` |
| Timings and barge-in at runtime | `voice.configure({ turn, bargeIn })` |
| Replace or turn off the echo filter at runtime | `voice.setEcho(filter \| null)` |

### End-of-turn providers

A provider answers one question: did the user finish, or only pause? It returns a probability; turning it into a wait is the plugin's job, so any provider can be swapped without changing behavior.

```ts
type EndOfTurn = {
  name: string
  input: 'text' | 'audio'
  historyTurns?: number          // recent turns passed to predict; default 6
  remote?: boolean               // the text or audio leaves the page
  consent?: string               // consent purpose; skipped while not granted
  isSupported(): boolean | Promise<boolean>
  load?(): Promise<void>         // download a model on demand; silence decides until it resolves
  predict(input: { partial; history; language; audio? }, signal: AbortSignal): number | Promise<number>
}
```

Options, from the [References](./references.md#end-of-turn-detection):

| Kind | Examples | Input | Where | Cost |
|---|---|---|---|---|
| Text classifier | LiveKit turn-detector, BERT-style classifiers (FireRedChat) | transcript + recent turns | your server (`httpEndOfTurn`) or the browser | a request per pause, or none if local |
| Audio classifier | Pipecat Smart Turn (ONNX) | last seconds of audio | the browser (`onnxruntime-web`) or your server | none if local |
| Typed-decision or general LLM | a decision model, your backend's LLM | transcript + recent turns | your server (`httpEndOfTurn`) | tokens per pause |
| Recognizer with endpointing | AssemblyAI, Soniox, OpenAI Realtime (`semantic_vad`) | inside the STT | the provider | included in STT |

`httpEndOfTurn({ url, headers?, parse?, historyTurns?, consent?, fetch?, name? })` POSTs `{ partial, history, language }` and reads `{ probability }` or `{ done: boolean }` (change it with `parse`). Keys stay on your server:

```ts
// Server side (any framework): answer with the probability that the user finished.
app.post('/api/end-of-turn', async (req, res) => {
  const { partial, history, language } = req.body
  const probability = await myClassifier(partial, history, language) // your model or service
  res.json({ probability })
})
```

A local provider:

```ts
const smartTurn: EndOfTurn = {
  name: 'smart-turn',
  input: 'audio',
  isSupported: () => typeof WebAssembly === 'object',
  load: async () => { session = await loadSmartTurn() },   // e.g. onnxruntime-web
  predict: async ({ audio }) => runSmartTurn(session, audio!.samples, audio!.sampleRate),
}
```

Audio providers get the last `turn.audioSeconds` seconds (default 8) of the same microphone, only from recognizers with `capabilities.audio`: `websocketSTT`, `voskSTT` and `voskBrowserSTT`. Web Speech does not expose audio, so with `webSpeechSTT` use a text provider. Measure latency and accuracy in your language before choosing: the numbers vendors publish are theirs.

### Barge-in

Speech over the bot interrupts it when the bot is speaking or streaming a reply on screen. The plugin calls `h4b.interrupt()` before stopping the speech, so the reply keeps only the sentences already spoken:

- a live transcript needs `minWords` words (default 2); a final result always counts;
- backchannels never interrupt: "aham", "uhum", "tá", "ok", "uh-huh", "mhm"… (a list for pt, en and es; replace it with `bargeIn: { ignore: [...] }`). They are not lost: each goes to `voice.decision` (`reason: 'backchannel'`, with the `messageId` being spoken and `at`, how many of its characters had been spoken) and to the backend on the next turn as `voice.reactions`, so it knows which part caught the user's attention. `reactions: false` keeps them out of the backend. H4B does not guess what they mean ("hum." and "hum?" are the same text);
- pressing to talk while the bot answers also interrupts;
- while the bot is still thinking (nothing shown yet), speech does not interrupt: when the turn ends, the kernel resumes the turn with both messages.

`bargeIn: false` turns this off and pauses recognition while the bot speaks, so the microphone does not hear it.

### Echo filter

With speakers, the bot's voice comes back through the microphone, and the recognizer transcribes it as if the user had spoken: the bot interrupts or answers itself. Browser echo cancellation does not always help, because it only removes sound it knows was played: speech from `speechSynthesis` comes out of the operating system, outside the browser's audio path. This happens even on good hardware (a laptop's speakers sit a few centimeters from its microphone).

So the voice plugin passes everything heard while the bot speaks, and for a moment after (`tail`), through an **echo filter** before barge-in and the turn see it. The default, `textEchoFilter()`, compares words, not audio, so it works with any recognizer, Web Speech included:

- a text is echo when at least `threshold` (default 0.6) of its words repeat what the bot said, in runs of at least `minRun` (default 2) consecutive words in the same order; case, accents and punctuation are ignored, and words of 4 letters or more may have one wrong letter;
- the decision is all or nothing: echo is dropped (`voice.decision` `{ kind: 'ignore', reason: 'echo' }`), anything else is kept whole, so a user who quotes the bot while talking over it is never cut short;
- a single word always passes: it cannot be told apart from the user saying the same word;
- the bot's sentences count while spoken and for `tail` ms after (default 2000), because recognizers deliver results late; after that the user may repeat the bot freely.

It is a replaceable piece, like the end-of-turn provider:

```ts
import { voice, textEchoFilter, type EchoFilter } from '@handsforbots/voice'

voice({ stt, tts, mode: 'hands-free' })                                    // textEchoFilter() by default
voice({ stt, tts, mode: 'hands-free', echo: textEchoFilter({ threshold: 0.5, tail: 1500 }) })
voice({ stt, tts, mode: 'hands-free', echo: false })                       // off (e.g. headphones only)

const mine: EchoFilter = {
  name: 'mine',
  tail: 2000,
  // speech: the sentences being spoken and those that ended within `tail`, oldest first
  filter: ({ text, final, speech, language }) => (looksLikeTheBot(text, speech) ? '' : text),
}
h4b.get('voice').setEcho(mine) // or null to turn it off
```

`filter` returns what the user said: the text itself, a shorter text, or `''` when it was all echo. It runs on every live transcript, so it must be synchronous and fast; if it throws, the error goes to `h4b.on('error')` (`source: 'voice:echo:<name>'`) and the text is kept. `getState().echo` names the filter in use.

### Speech output

Replies are spoken **sentence by sentence as they stream**, so the bot starts talking before the reply ends, and an interruption knows which sentences were heard. Output follows input (`output: 'auto'`): spoken replies after speech, text after typing.

### State for your UI

`voice.getState()` (subscribe with `voice.subscribe()`):

| Field | Meaning |
|---|---|
| `phase` | `idle`, `listening`, `userSpeaking`, `waitingEndOfTurn`, `botSpeaking` |
| `partial` | in hands-free, the whole pending turn plus the words being recognized |
| `pauseSince` | when the last words of the pending turn were heard (epoch ms); the pause starts here |
| `endOfTurnAt` | the latest moment the pending turn will be sent if the user stays quiet (epoch ms) |
| `endOfTurnCheckAt` | when the end-of-turn provider is asked (epoch ms); present only while it may still send the turn **before** `endOfTurnAt` |
| `interrupted` | the user cut the last reply; cleared when the next reply starts |
| `endOfTurn` | name of the end-of-turn provider in use |
| `listening`, `speaking`, `error`, `stt`, `tts`, `lastInput`, `output`, `mode` | as before |

The three times are timestamps, not time left, so your UI renders when they change, not on every tick. To draw the pause, start a CSS animation when `pauseSince` changes, lasting `endOfTurnAt - pauseSince` ms, with a negative delay of `pauseSince - Date.now()` ms: the pause usually began before the state arrived, so the line starts partly gone. Hide it when `endOfTurnAt` is `undefined` (the user talks again or the turn is sent). `endOfTurnAt` can move:

- **No provider**, or a recognizer that decides: it does not move; the turn goes out at `endOfTurnAt`.
- **With a provider**, while `endOfTurnCheckAt` is set: nobody knows yet what the provider will answer, and the turn may go out at any moment from `endOfTurnCheckAt` on. Show that the wait may end early (a quicker or dashed line, say) instead of promising the whole countdown.
- The provider answers "not finished": `endOfTurnCheckAt` is cleared and `endOfTurnAt` is now exact.
- The provider is slow or fails: `endOfTurnCheckAt` is cleared and `endOfTurnAt` moves earlier, to `pauseSince + silence`. Keep the start, change the duration. With the defaults this deadline has usually passed when `timeout` runs out (the provider is asked at `minSilence`, and `minSilence + timeout` > `silence`), so the turn goes out at once; a later deadline only shows up when the provider fails quickly.

Every interruption, ignored backchannel or echo and end of turn is reported on `h4b.on('voice.decision', d => …)`: `{ kind: 'interrupt' | 'ignore' | 'end-of-turn' | 'end-of-turn-unavailable', … }`. Log it while tuning.

### Privacy and echo

- Providers declare whether audio or text leaves the page (`remote`). `webSpeechSTT` counts as remote: browsers such as Chrome send the audio to their speech service, and in hands-free that is continuous. Remote end-of-turn providers send the transcript to your server and from there to whoever runs the model.
- Give a provider a `consent` purpose and it is used only while the purpose is granted ([Consent](./consent.md)); the plugin falls back to the next recognizer, or to silence. Withdrawing it mid-session aborts listening at once (even before the recognizer finished opening) and drops what it heard. Showing the notice and storing the decision is your app's job.
- Recognizers that open the microphone (`httpSTT`, `websocketSTT`, `voskSTT`, `voskBrowserSTT`) use echo cancellation, noise suppression and automatic gain. Web Speech manages its own microphone; how well it ignores the bot's own voice depends on the device. The [echo filter](#echo-filter) covers what gets through. Test with and without headphones.
- Safari on iOS ends recognition sessions on its own; hands-free restarts them, but test long sessions on real devices.

### Noisy rooms

The browser has no API that says "this room is too noisy": the page has to measure the audio itself. `checkNoise()` opens the microphone for a moment, measures it and closes it, so you can warn the user before the first turn goes wrong:

```ts
import { checkNoise } from '@handsforbots/voice'

const report = await checkNoise({ durationMs: 1500 }) // ask the user to stay quiet meanwhile
if (report.verdict !== 'quiet') showHint(report.reasons) // e.g. "move somewhere quieter or use a headset"
```

`measureNoise(stream, options)` does the same on a stream you already opened, and `createNoiseMeter()` / `assessNoise()` work on samples or frame levels you have (a recognizer that exposes audio, a recording), with no microphone at all.

The report (`NoiseReport`) has the numbers and a verdict, `quiet`, `noisy` or `too-noisy`, with its `reasons`:

| Field | Meaning |
|---|---|
| `noiseFloorDb` | 10th percentile of the 20 ms frame levels, in dBFS (0 is full scale): the room's noise |
| `peakDb`, `dynamicRangeDb` | 95th percentile, and how far it sits above the floor |
| `snrDb` | estimated signal-to-noise ratio; present only when the range is wide enough (`speechRangeDb`, 12 dB) to be the user's speech |
| `fluctuationDb` | 75th minus 10th percentile: near 0 for steady noise (a fan), high for voices, TV or traffic |
| `clippingRatio` | share of samples at full scale |

| Reason | When (defaults) | Verdict |
|---|---|---|
| `loud-floor` | floor from -50 dBFS; from -35 dBFS | `noisy`; `too-noisy` |
| `fluctuating` | no speech found and `fluctuationDb` from 6 dB, with the floor above -60 dBFS | `noisy` |
| `low-snr` | speech found and `snrDb` under 15 dB, with the floor above -60 dBFS | `noisy` |
| `clipping` | `clippingRatio` from 0.001 (too much gain, or shouting into the microphone) | `noisy` |
| `silent-input` | `peakDb` at -90 dBFS or lower: muted microphone or wrong device | unchanged |

`createNoiseMeter` — and, through it, `checkNoise` and `measureNoise` — sets aside a leading run of frames at or below the dead-input floor (`silentFloorDb`, −90 dBFS) once a later frame rises above it. While a track is not producing, the capture delivers silence: every sample is 0, which sits below that floor. Counted in, that run is the quiet end of the sample, so the 10th percentile becomes the opening and a loud room is scored quiet. The run ends at the first frame above the floor. Its length is whatever the device emitted, inside the measurement window; published observations of exact leading zeros run from a few tens of milliseconds to about 0.9 s, and no browser defines the length. A capture that never rises above the floor reports the run, so `silent-input` still means a muted microphone or the wrong device. Silence after the first live frame stays in the measurement. The report's `durationMs` is the part that counted, so it can be shorter than the time the microphone stayed open. `assessNoise` judges the levels it is given.

Change any limit with `thresholds`. Treat the defaults as a starting point: dBFS is not sound pressure, and the same room reads differently on each microphone and gain, so calibrate with recordings from your users' devices. Fluctuating noise is the one to worry about: noise suppression removes a steady fan well, but not people talking nearby, and recognizers mistake them for the user.

By default `checkNoise()` measures the raw signal (`processing: false`): noise suppression would hide steady noise, and automatic gain raises the floor while nobody speaks. `processing: true` measures what the microphone recognizers hear. Web Speech opens its own microphone, so with it the check is always a separate measurement.

`timeoutMs` caps the wall-clock time of `checkNoise()` and `measureNoise()` (default `durationMs + 2000`; `0` disables), so a stalled or suspended audio graph throws `audio-capture` instead of hanging. The capture helpers (`captureFloat`, `capturePcm16`, `monitorLevel`) resume a suspended `AudioContext`, and `checkNoise()` creates and resumes its `AudioContext` before `getUserMedia` while user activation is still active.

#### Checking before hands-free

The voice plugin can run the check itself. Turn it on with the `noise` option (off by default, since it opens the microphone for a moment before listening):

```ts
voice({ stt, tts, mode: 'hands-free', noise: true })
voice({ stt, tts, mode: 'hands-free', noise: { tooNoisy: 'warn', maxAgeMs: 60_000, thresholds: { noisyFloorDb: -45 } } })
```

- With `check: 'hands-free'` (default), `listen()` in hands-free measures the room first and then starts listening. `getState().checkingNoise` stays `true` until `listening` becomes `true` (or the fallback, `stop()` or `cancel()` ends it), with no idle gap between them. After the built-in `checkNoise()` closes the microphone, the plugin waits `settleMs` ms (default `100`, `0` when `measure` is supplied; `0` disables) before starting the recognizer to avoid audio-device contention (CoreAudio, Bluetooth, mobile). `timeoutMs` is forwarded to `checkNoise()`. Push-to-talk is not checked.
- `too-noisy` with `tooNoisy: 'push-to-talk'` (default): the mode becomes `push-to-talk`, `noiseFallback` is `true` and listening does not start. An open microphone in a loud room interrupts the bot and never ends the turn; holding to talk does not have that problem. `noiseFallback` is cleared at the next `setMode()`. `tooNoisy: 'warn'` only reports.
- `noisy` (or `too-noisy` with `warn`): listening starts; the report is in `getState().noise` for the UI to warn the user.
- A report newer than `maxAgeMs` (5 minutes) is reused, so pausing and resuming does not measure again. Whenever no fresh check is needed (`noise` off, push-to-talk, `check: 'manual'`, or a cached report within `maxAgeMs`), `listen()` starts the recognizer synchronously inside the call, preserving browser user activation.
- `stop()`, `cancel()`, `toggle()` or disposing the app (`h4b.stop()`) during the check abort it, and nothing is heard. If the measurement fails (microphone denied, for example), the error goes to `h4b.on('error')` with `source: 'voice:noise'` and listening starts anyway: the recognizer reports its own microphone errors.
- Each finished check emits `voice.noise` `{ report, action? }`, with `action: 'push-to-talk'` when the mode changed. `voice.checkNoise()` measures on demand (also with `check: 'manual'`, which never measures before listening). With `webSpeechSTT` on Safari/iOS, waiting for `getUserMedia` and `durationMs` during `check: 'hands-free'` can outlive the browser's transient user activation for `SpeechRecognition.start()`: run `voice.checkNoise()` ahead of time (or use `check: 'manual'`) so the report is cached for `maxAgeMs` and `listen()` starts `SpeechRecognition` synchronously inside the user's click or tap.
- `measure(signal)` replaces the measurement (a model, your server, a test) and must return a `NoiseReport`; `assessNoise()` builds one from frame levels.

The widget shows the check: "Checking the background noise…" while it runs (the mic button has `aria-busy`), a hint while listening in a noisy room instead of "Listening…", and "Too noisy for hands-free. Hold the mic to talk." after the fallback. Change the texts with `strings: { noiseChecking, noiseHint, noiseTooLoud }`; style the hint with `.partial.noisy` through `::part()` or your own UI. A listening error replaces the hint.

`httpSTT` ends an utterance on silence with `detectEndOfSpeech`, which now also follows the room: speech is a level above `threshold` (0.015 RMS) **and** above `margin` (3, about 10 dB) times the noise floor of the last `floorMs` (3000 ms, the minimum level heard in that window). In a noisy room the old fixed threshold took the noise for speech and the utterance only ended on its time limit. `margin: 0` keeps the fixed threshold.

#### Voices nearby: the level gate

The noise check says the room is noisy; it does not keep a TV or a colleague from interrupting the bot. The level gate does, without a model: the user talks into the microphone, so their speech is usually well above the voices around them. The gate learns how loud the user's accepted utterances are and drops speech much quieter than that.

```ts
voice({ stt, tts, mode: 'hands-free', levelGate: true })
voice({ stt, tts, mode: 'hands-free', levelGate: { scope: 'all', gapDb: 12 } })
```

- Hands-free only. While listening it opens a second microphone capture (with the same processing as the recognizers) and reads its level every 50 ms; it closes when listening stops. Push-to-talk is never gated: the user is pressing.
- **Learning:** each hands-free utterance that joins a turn adds the loud end (95th percentile) of the last `lookbackMs` (3000) of audio; the user's level is the median of the last `remember` (5). Utterances heard while the bot speaks, or within `lookbackMs` after, are not learned from. Until the first one, nothing is dropped. `getState().userLevelDb` shows the learned level.
- **Judging:** when a transcript arrives, the loud end of the last `lookbackMs` is compared with `userLevelDb - gapDb` (10 dB). Below it, the speech is background.
- `scope: 'barge-in'` (default): background speech heard while the bot answers neither interrupts it nor becomes a turn. `scope: 'all'`: background speech is also dropped while the bot is quiet, so it never starts or grows a turn.
- Dropped finals go to `voice.decision` as `{ kind: 'ignore', reason: 'background', text, levelDb, userLevelDb }`. If the monitor cannot open, the error goes to `h4b.on('error')` with `source: 'voice:level-gate'` and listening goes on ungated.
- `open(onLevel)` replaces the monitor (tests, or audio you already capture); `createLevelGate()` is the same logic for your own code.

Limits, by design of a loudness rule:

- It drops the user too when they speak much softer than usual or move away from the microphone; and it lets background voices through when they are as loud as the user. With `scope: 'all'` a wrongly learned level can keep dropping the user, which is why the default only guards barge-in: after the bot finishes, the user is heard and the level is learned again.
- While the bot speaks through speakers, its voice is in the window too. Echo cancellation removes it when the bot plays through the page (`httpTTS`, the models in `voice-models`); `speechSynthesis` plays outside the browser's audio path, so with `webSpeechTTS` and speakers the bot's own voice can make a background voice look loud enough. Headphones avoid it.
- Recognizers deliver transcripts late, and the window is a few seconds: speech from the user just before a background voice can make it pass.
- Telling *who* speaks needs a model conditioned on the user's voice (see [references](./references.md#microphone-noise-check)); the gate only tells *how loud*.

#### Debugging noise and the level gate

Voice that "behaves strangely" in some places is often the room. Everything the noise check and the level gate decide is visible, with levels in dBFS and no audio:

| Where | What |
|---|---|
| `getState()` | `noise` (the last report), `checkingNoise`, `noiseFallback`, `userLevelDb` |
| `h4b.on('voice.noise', …)` | `{ report, action? }` after each check; `action: 'push-to-talk'` when the mode changed |
| `h4b.on('voice.level', …)` | `monitor.open` / `monitor.close`; `learned` `{ levelDb, userLevelDb, gateDb }` each time an utterance teaches the gate; `learn.skipped` `{ reason: 'bot-speech' \| 'no-audio' }` |
| `h4b.on('voice.decision', …)` | `ignore` with `reason: 'background'` and `levelDb` / `userLevelDb` for each dropped final; `interrupt` carries `levelDb` / `userLevelDb` too while the gate listens |
| `h4b.on('error', …)` | `source: 'voice:noise'` (the check failed), `voice:level-gate` (the monitor did not open: no gating) |
| `observability` | records all of the above (`voice.noise`, `voice.level.<event>`, `voice.decision` without the transcript unless `includeContent`) |

| Symptom | Look at |
|---|---|
| Hands-free turned into push-to-talk | `voice.noise` with `action: 'push-to-talk'`: its `reasons` and `noiseFloorDb`. If the room was fine, the thresholds are too strict for that microphone |
| The TV still interrupts the bot | the `interrupt` decision: `levelDb` near `userLevelDb` means the TV is as loud as the user (or the bot's own voice is in the window, with `webSpeechTTS` on speakers); no levels means the gate is off or its monitor failed |
| The user's words are ignored | `background` decisions: `levelDb` far below `userLevelDb`. Check the `learned` events: a high `userLevelDb` (the user shouted, or learned while the TV was loud) drops normal speech; raise `gapDb` |
| `userLevelDb` never appears | `learn.skipped` with `bot-speech` (the user only spoke over or right after the bot) or `no-audio` (the monitor is not reading), or a `voice:level-gate` error |

### Tuning

| Symptom | Try |
|---|---|
| Cuts people mid-sentence | raise `silence`, or add an end-of-turn provider and raise `threshold` |
| Feels slow to answer | lower `silence`; with a provider, lower `minSilence` and check its latency |
| Bot interrupts itself | check that `voice.decision` shows `reason: 'echo'`; lower `echo.threshold` or raise `echo.tail`; headphones, a microphone recognizer with echo cancellation, a higher `minWords`, or `bargeIn: false` |
| User speech dropped as echo | raise `echo.threshold` or `minRun`, lower `tail`, or `echo: false` with headphones |
| "ok"/"yes" interrupt the bot | add them to `bargeIn.ignore` |
| TV or people nearby interrupt the bot | `levelGate: true` (hands-free); `scope: 'all'` if they also start turns; headphones |
| Recognition fails in some places | run [`checkNoise()`](#noisy-rooms) and suggest a quieter spot or a headset when it is not `quiet` |
| Too many backend calls while thinking | keep `whileBusy` at `interrupt` or `merge` (resumption joins them) |
