# References

Libraries, services, papers and products that informed Hands for Bots decisions, grouped by topic. Each section says which decision or page it supports and when the sources were accessed. Figures (latency, size, price, accuracy) are the vendors' or authors' own and were **not measured by us** unless stated. Third-party code bundled or adapted in the project is credited in [NOTICE](../../NOTICE.md).

When a decision relies on outside sources, add them here (both languages) in the same commit.

## Interruption, end of turn and barge-in

Supports [ADR 0011](../adr/0011-interrupcao-e-fim-de-turno.md) and [Interruption and voice conversation](./conversation.md). Accessed 2026-10-10 and 2026-10-11.

### End-of-turn detection

| Source | What it is | Notes |
|---|---|---|
| [LiveKit turn detector](https://docs.livekit.io/agents/logic/turns/turn-detector) · [blog: improved end-of-turn model](https://livekit.com/blog/improved-end-of-turn-model-cuts-voice-ai-interruptions-39) | Open-weights text model: reads the transcript of the last turns and predicts the probability of the end-of-turn token; works alongside VAD, with per-language thresholds | Multilingual model: ~400 MB RAM, ~25 ms per inference, built for Python servers. Plugin code Apache-2.0, model under the LiveKit Model License. Fits `httpEndOfTurn` behind your server |
| [Pipecat Smart Turn](https://github.com/pipecat-ai/smart-turn) · [docs](https://docs.pipecat.ai/server/utilities/turn-detection/smart-turn-overview) · [model card](https://huggingface.co/pipecat-ai/smart-turn-v3) · [ONNX build](https://huggingface.co/soniqo/Smart-Turn-v3.2-ONNX) · [v3.2 post](https://www.daily.co/blog/smart-turn-v3-2-handling-noisy-environments-and-short-responses/) | Audio model (Whisper Tiny encoder + linear classifier, ~8M parameters) over the last seconds of the waveform, run at each pause after a VAD | BSD-2, weights, data and training code released, 23 languages. Sizes differ by source: 8 MB int8 ONNX (Pipecat), 11 MB quantized (soniqo build). ~10–36 ms on fast CPUs per the vendors; slower CPUs take much longer. The only option we would consider in the browser (`onnxruntime-web`); not verified |
| [FireRedChat (arXiv 2509.06502)](https://arxiv.org/pdf/2509.06502) | Paper; trains a BERT end-of-turn classifier on ~830k partial vs complete utterances | Reference for text classifiers that can run locally or on a server |
| [AssemblyAI turn detection](https://www.assemblyai.com/docs/streaming/turn-detection) | Streaming STT with semantic end of turn plus a silence fallback | Defaults cited: confidence 0.4, 400 ms minimum silence. Our `turn.threshold` / `turn.minSilence` follow the same idea. Fits `capabilities.endOfTurn` |
| [Soniox endpoint detection](https://soniox.com/docs/stt/rt/endpoint-detection) | Streaming STT whose speech model emits an end token from intonation, pauses and context | Fits `capabilities.endOfTurn` |
| [OpenAI Realtime VAD](https://developers.openai.com/api/docs/guides/realtime-vad) | `server_vad` (silence) and `semantic_vad` (the model judges whether the utterance is complete), with `eagerness` | Shows the same split we adopted: silence alone vs a semantic channel |
| [Jev 1.13 on OpenRouter](https://openrouter.ai/models/typesafe/jev-1.13) | Hosted typed-decision model (returns a choice, not free text) through OpenRouter's Decisions API | Vendor figures: p50 ~0.13 s, US$ 0.042 per million input tokens. Beta, one provider, closed weights; Portuguese not documented. Key must stay on the server (`httpEndOfTurn`) |

### Browser APIs and libraries

| Source | Use in H4B |
|---|---|
| [Web Speech API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API) | `webSpeechSTT` / `webSpeechTTS`. Recognition is not offline in most browsers and gives no access to audio or microphone constraints |
| [`MediaTrackConstraints` (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints) | `echoCancellation`, `noiseSuppression`, `autoGainControl` in `openMicrophone` |
| [ONNX Runtime Web](https://www.npmjs.com/package/onnxruntime-web) | Candidate runtime for local end-of-turn models (Smart Turn) in a separate package; not a dependency |
| [vosk-browser](https://www.npmjs.com/package/vosk-browser) | Offline recognition in `voskBrowserSTT`; exposes audio, so it can feed audio end-of-turn models |

### Products and behavior

| Source | Notes |
|---|---|
| ChatGPT voice mode, Gemini Live | Open microphone, speech cuts the reply: the basis for `interrupt` as the default |
| ChatGPT text chat | Lets you type during a reply but requires stopping before sending; no native queue found. A third-party userscript adds one ([ChatGPT Message Queue](https://greasyfork.org/en/scripts/561517-chatgpt-message-queue)), a sign that people want it |

Also cited in the discussion that led to the ADR, without a specific page checked by us: Hamming, Picovoice, Coval, Dograh and WorkAdventure (voice agent evaluation and turn-taking write-ups).

### Telling the backend

Supports [ADR 0015](../adr/0015-retorno-da-interrupcao.md). Accessed 2026-11-06. Read from documentation and SDK types; not called by us.

| Source | What it is | Use in H4B |
|---|---|---|
| [OpenAI Realtime `conversation.item.truncate` (LangChain types)](https://v03.api.js.langchain.com/interfaces/_langchain_openai.OpenAIClient.Beta.Realtime.ConversationItemTruncateEvent.html) · [openai-agents-python #4122](https://github.com/openai/openai-agents-python/pull/4122) | Client event that tells the server how much of an assistant message's audio was played (`audio_end_ms`) when the user interrupts | Precedent: the side that plays the reply tells the side that wrote it where it stopped. H4B does it in characters (`kept`), in the next request |
| [Community thread on truncated transcripts](https://community.openai.com/t/realtime-api-interruptions-dont-properly-trim-the-transcript/1000703) | Users report the model guessing where it was interrupted when the history alone does not say | Reason to send the fact (`conversation.interrupted`) and not only the cut text |

## Microphone noise check

Supports `checkNoise`, `measureNoise`, the level gate (`levelGate`) and the noise floor in `detectEndOfSpeech` ([Noisy rooms](./conversation.md#noisy-rooms)). Accessed 2026-11-20. The measurement is our own (percentiles of frame levels); the sources below shaped it or are candidates for a model-based check. None is a dependency.

| Source | What it is | Use in H4B |
|---|---|---|
| [Martin, "Noise power spectral density estimation based on optimal smoothing and minimum statistics" (IEEE TSAP, 2001)](https://doi.org/10.1109/89.928915) | Classic noise estimator: the noise floor is the minimum of the smoothed power over a window, since speech always has pauses | The idea behind `noiseFloorTracker` (minimum RMS over `floorMs`) in `detectEndOfSpeech`, without the bias correction or per-band analysis |
| [`MediaTrackConstraints` (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints) · [Media Capture and Streams (W3C)](https://www.w3.org/TR/2025/CRD-mediacapture-streams-20250624/) | `noiseSuppression` / `autoGainControl` can be turned off per request | `checkNoise` measures with them off by default, since they hide or raise the floor |
| [Web Audio API 1.1, AudioNode lifetime](https://www.w3.org/TR/webaudio-1.1/) · [Media Capture and Streams, media flow](https://www.w3.org/TR/mediacapture-streams/) · [`MediaStreamTrack.enabled` (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/enabled) | A `MediaStreamAudioSourceNode` outputs silence unless its track is live, unmuted and enabled. A muted or disabled track delivers zero-information-content; for audio, every sample is 0 | The leading run `createNoiseMeter` sets aside. 0 is below `silentFloorDb`. The run ends at the first louder frame; the specs do not give it a duration |
| [voxtype, gate recording-start on device warm-up](https://github.com/peteonrails/voxtype/pull/497) | On PipeWire, a source waking from suspend delivered exact zeros for 0.3–0.9 s (cold) or 40–70 ms (warm). A live microphone has a noise floor; that resume silence is exact zeros. They wait for a non-zero sample, and give up after 1.5 s so a source that stays silent still starts | Evidence that the opening is device silence, and that its length varies. The 1.5 s timeout was not adopted: a capture that never rises above `silentFloorDb` reports the run |
| [Chrome: MediaStreamTrack audio stats](https://groups.google.com/a/chromium.org/g/blink-dev/c/xcGJyic7ttI) · [`voiceIsolation` constraint](https://groups.google.com/a/chromium.org/g/blink-dev/c/hPMvCu-3iPA) | Capture latency and dropped frames; OS voice isolation (ChromeOS first) | Checked and set aside: no noise measure in the stats; voice isolation is not widely available |
| [DNSMOS (arXiv 2010.15258)](https://arxiv.org/pdf/2010.15258) · [DNSMOS P.835 (arXiv 2110.01763)](https://arxiv.org/pdf/2110.01763) · [DNSMOS Pro (arXiv 2204.06616)](https://arxiv.org/pdf/2204.06616) | Non-intrusive speech quality models; P.835 gives a background-noise score (BAK) | Candidate for a model-based check with `onnxruntime-web`; not tested in the browser |
| [WhiSQA (arXiv 2508.02210)](https://www.arxiv.org/abs/2508.02210) | Quality model on Whisper encoder features; the authors report better domain adaptation than DNSMOS | Too heavy for the page; reference for server-side checks |
| [Semi-intrusive audio evaluation (arXiv 2409.14069)](https://arxiv.org/html/2409.14069) | Audio-language model tuned to predict MOS and SNR for arbitrary mixtures | Reference for SNR estimation without the clean signal |
| [Silero VAD in the browser (`@ricky0123/vad-web`)](https://github.com/ricky0123/vad) | Speech detection with ONNX Runtime Web | Candidate to tell nearby voices (which our level-based check reports as `fluctuating`) from the user; the README of a fork cites ~10 MB of model plus runtime |
| [Personal VAD (arXiv 1908.04284, Odyssey 2020)](https://arxiv.org/abs/1908.04284) | Small model (130K parameters per the authors) conditioned on an enrolled speaker's embedding; labels each frame as no speech, target speaker or other speaker | What actually tells the user from other voices. Not used: needs enrollment and a model we would have to port; the level gate is the no-model approximation |
| [Iwamoto et al., "How bad are artifacts?" (arXiv 2201.06685, Interspeech 2022)](https://arxiv.org/abs/2201.06685) | Shows that artifacts from single-channel speech enhancement are the main reason it often fails to improve ASR | Reason not to clean the audio with a denoising model before recognition, and to gate by level instead |

## Speech synthesis and effects

Supports [ADR 0013](../adr/0013-sintese-de-voz-e-efeitos.md) and [Speech synthesis and voice effects](./speech.md). Accessed 2026-10-16. Sizes and timings measured by us are marked; the others are the authors'.

### Standards behind the effects format

| Source | Use in H4B |
|---|---|
| [Web Audio API (W3C)](https://www.w3.org/TR/webaudio/) | Effect vocabulary: node types and parameter names (`BiquadFilterNode`, `DynamicsCompressorNode`, `DelayNode`, `ConvolverNode`, `WaveShaperNode`); Q in dB for low/high-pass. The player and the effects are built on it |
| [Web Audio Modules 2.0](https://www.webaudiomodules.com/docs/intro) · [API](https://github.com/webaudiomodules/api) | Parameter descriptors (`label`, `type`, `defaultValue`, `minValue`, `maxValue`, `discreteStep`, `exponent`, `choices`, `units`) so editors are generated. Hosting WAM plugins is not supported yet |
| [SSML 1.1 (W3C)](https://www.w3.org/TR/speech-synthesis11/) | Prosody units (`rate` as a percentage, `pitch` in semitones, `volume` in dB) and the `toSSML` export |
| [Amazon Polly `<prosody>`](https://docs.aws.amazon.com/polly/latest/dg/prosody-tag.html) · [Azure SSML voice and prosody](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-voice) · [Google Cloud TTS SSML](https://cloud.google.com/text-to-speech/docs/ssml) | What cloud engines accept: Polly takes pitch as a percentage, hence `toSSML({ pitch: '%' })` |
| [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html) | `toFFmpeg`: `highpass`, `equalizer`, `acompressor`, `alimiter`, `vibrato`, `tremolo`, `chorus`, `aecho`, `asoftclip`, `atempo`, `asetrate`, `aresample`. Every preset is checked against FFmpeg 7.1 in the tests |
| [JSON Schema 2020-12](https://json-schema.org/draft/2020-12) | `chainSchema()` |

### Engines and models

| Source | What it is | Notes |
|---|---|---|
| [Piper](https://github.com/rhasspy/piper) (archived; continued at [OHF-Voice/piper1-gpl](https://github.com/OHF-Voice/piper1-gpl)) · [voices](https://huggingface.co/rhasspy/piper-voices) | Fast VITS voices exported to ONNX, one language per voice, a `.onnx.json` with the phoneme map and inference settings | `piperTTS`, `piperVoice`. The original repository was MIT; the continuation is GPL. Voice licenses vary per `MODEL_CARD`. Measured by us: `pt_BR-faber-medium` + espeak data = 82 MB |
| [Kokoro 82M](https://huggingface.co/hexgrad/Kokoro-82M) · [ONNX build](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) | StyleTTS 2 based, 82M parameters, 24 kHz, several languages, Apache-2.0 | `kokoroTTS`, `kokoroModel`. ONNX files from 92 MB (q8) to 326 MB (fp32). Measured by us on one CPU thread: 8.2 s for 5.2 s of audio |
| [ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/) | Runs ONNX models in the browser (WebAssembly, WebGPU) | The runtime for Piper and Kokoro; passed by the app, not a dependency. Threads need cross-origin isolation; `env.wasm.proxy` moves only inference to a worker; `workerTTS` moves the whole provider |
| [transformers.js](https://huggingface.co/docs/transformers.js) | Hugging Face pipelines in the browser, including `text-to-speech` | `transformersTTS` adapts any of its TTS pipelines |
| [espeak-ng](https://github.com/espeak-ng/espeak-ng) · [piper-phonemize](https://github.com/rhasspy/piper-phonemize) · [@diffusionstudio/piper-wasm](https://github.com/diffusion-studio/piper-wasm) | Text to IPA phonemes; piper-phonemize wraps it as Piper expects; piper-wasm is a WebAssembly build | `espeakPhonemizer`. espeak-ng is GPL-3.0, so H4B does not ship it. The data file of that build is 17 MB |

### Browser APIs

| Source | Use in H4B |
|---|---|
| [`SpeechSynthesisUtterance` (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisUtterance) | `webSpeechTTS` prosody (`rate`, `pitch`, `volume`). Its audio cannot be routed into Web Audio, so effects do not apply |
| [Autoplay guide (MDN)](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay) | Why the player unlocks audio on the first gesture and `unlockAudio()` exists |
| [`CacheStorage` (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/CacheStorage) | Where downloaded models are kept (`h4b-voice-models`) |
| [`Worker()` with `type: 'module'` (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Worker/Worker) | `workerTTS`: the worker file imports the runtime on demand, so it must be a module worker (Chromium 80+, Firefox 114+, Safari 15+) |
| [Transferable objects (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects) | The synthesized samples come back from the worker by transferring their buffer, without a copy |
| [Vite: `worker.format`](https://vite.dev/config/worker-options) | `'es'` is needed for workers that import modules on demand; the default `iife` cannot |

## Recognition on the VPS (to be tested)

Supports open decision 10 in the [ROADMAP](../../ROADMAP.md). Accessed 2026-11-09. We have not run any of these models. Sizes and the language-switch behavior are the authors'.

| Source | What it is | Notes |
|---|---|---|
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | C/C++ port of Whisper, with a CLI, quantization and an example server | Candidate STT on the Hostinger VPS. If the test passes, H4B talks to it through `httpSTT` or `websocketSTT` |
| [Memory table and quantization](https://github.com/ggml-org/whisper.cpp#memory-usage) | Disk and RAM for the full models; `q5_0` quantization example | From the project, not measured by us: base 142 MiB / ~388 MB RAM; small 466 MiB / ~852 MB. The note that prompted the test cited those disk sizes as RAM |
| [ggml models](https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md) | Official list. No `.en` suffix means multilingual; `.en` is English-only. A `-q5_0` suffix is quantized | The test uses `base` or `small` without `.en`. The file `ggml-base.bin-q4_0` from the note is not on this list |
| [ggml-base-q5_1 and ggml-small-q5_1 on Hugging Face](https://huggingface.co/ggerganov/whisper.cpp/tree/main) | Preconverted quantized copies | Sizes published on 2026-10-26 by a third-party index of those files: base `q5_1` ~60 MB, small `q5_1` ~190 MB, and larger `q8_0` files. Check the file when downloading. Quantized RAM is not in the official table |
| [q5_0 quantization (issue 1103)](https://github.com/ggml-org/whisper.cpp/issues/1103#issuecomment-1634413142) | 2023 comment with disk size after quantizing | base `q5_0` ~60 MB, small `q5_0` ~190 MB, on disk. Not RAM |
| [`--prompt` (discussion 348)](https://github.com/ggml-org/whisper.cpp/discussions/348) | The flag already existed: it becomes `initial_prompt` and biases vocabulary (names, terms) | In the test, the list is the jargon we actually say. It is not a guarantee |
| [Language switching in one file (issue 3334)](https://github.com/ggml-org/whisper.cpp/issues/3334) · [issue 1800](https://github.com/ggerganov/whisper.cpp/issues/1800) | The model tends to pick one language per span and rewrites the other into it | The Claudinei effect from inside Whisper. Reason to compare with and without `--prompt`, with `-l pt` (transcribe, not `--translate`) |

## Agent frameworks and "browser hands"

Supports the "Relação com frameworks de agente e browser hands" section of the [ROADMAP](../../ROADMAP.md) (positioning, `realtime` transport moved to P1). Accessed 2026-11-04. Nothing here was tested by us.

| Source | What it is | Use in H4B |
|---|---|---|
| [Video from a series on multimodal agents](https://www.youtube.com/watch?v=dNGchf4InU0) | A series that builds an agent in layers (genai SDK → ADK → tools → hands → memory → eyes; "hear · talk · act · remember · see") | Prompted the review. Only the series diagram was checked, not the video |
| [Bidi-streaming (live) in ADK](https://google.github.io/adk-docs/streaming) · [codelab](https://codelabs.developers.google.com/intro-to-adk-live) | ADK agents with low-latency voice and video through the Gemini Live API: text, audio and video in, text and audio out, tools in the session | The path where audio goes straight from the browser to the agent: the overlap with `voice`, answered by the `realtime` transport |
| [Gemini Live API](https://ai.google.dev/gemini-api/docs/live) | Gemini's session-based speech-to-speech API | Candidate reference provider for `realtime` (open decision 7) |
| [`ag_ui_adk`](https://pypi.org/project/ag-ui-adk/) · [Google forum discussion](https://discuss.google.dev/t/integrating-google-adk-agents-with-modern-frontends-using-the-ag-ui-protocol/298415) | Python middleware that exposes an ADK agent over the AG-UI protocol, with client-side tools executed by the agent (`AGUIToolset`) | An ADK agent can use H4B actions through `transport-agui` without a new package; an example still has to confirm it |
| [The browser agent stack, explained (Lightpanda)](https://lightpanda.io/blog/posts/the-browser-agent-stack-explained) · [How browser agents work (Anchor)](https://anchorbrowser.io/guides/how-browser-agents-work-a-step-by-step-architectural-guide) | Describe the execution layer ("hands") of browser agents: Playwright, browser-use, Stagehand and similar acting in a browser the agent controls | Basis for telling apart hands that act from outside the page and H4B's declared actions, exposed through `expose-webmcp` |

## Sources and citations

Supports [ADR 0014](../adr/0014-fontes-e-citacoes.md) and [Sources and citations](./sources.md). Accessed 2026-11-06. Formats were read from documentation and SDK types; none of these APIs was called by us.

| Source | What it is | Use in H4B |
|---|---|---|
| [OpenAI web search (Responses API)](https://platform.openai.com/docs/guides/tools-web-search) · [Ably: OpenAI citations](https://ably.com/docs/ai-transport/guides/openai/openai-citations.md) · [Parallel: citations](https://docs.parallel.ai/responses-api/features/citations.md) | `url_citation` annotations on the output text with `url`, `title`, `start_index`, `end_index`; streamed as `response.output_text.annotation.added` | The model for `Citation`: an annotation with a position, not a marker in the text, and its own stimulus (`message.citations`) |
| [Anthropic citations](https://docs.anthropic.com/en/docs/build-with-claude/citations) · [Ably: Anthropic citations](https://ably.com/docs/ai-transport/guides/anthropic/anthropic-citations.md) | Text blocks with a `citations` array (`cited_text`, document index and title, location: `char_location`, `page_location`, `search_result_location`…) | Same direction: citations attached to text, sources separate. `excerpt` plays the role of `cited_text` |
| [Gemini `GroundingSupport` (Firebase AI)](https://firebase.google.com/docs/reference/js/ai.groundingsupport.md) · [Go types (eino)](https://pkg.go.dev/github.com/cloudwego/eino/schema/gemini) | `groundingChunks` (sources) and `groundingSupports` (a `segment` of the answer plus indices into the chunks); the Go types document segment offsets in bytes | Sources and links kept apart, and the reason for `utf8OffsetToIndex`: transports convert bytes to UTF-16 |
| [Perplexity: streaming citations](https://docs.perplexity.ai/docs/cookbook/articles/streaming-citations/README) | Numbered markers in the text (`[1]`, or `[web:1]` in another mode) mapped to `search_results` sent apart | The marker case: handled by `inlineCitations` in the backend or transport, never in the page |
| [AI SDK `ui-messages.ts`](https://app.unpkg.com/ai@6.0.99/files/src/ui/ui-messages.ts) | `source-url` (`sourceId`, `url`, `title`) and `source-document` parts; no link from a source to a span | `transport-ai-sdk` mapping; `id` and `title` follow the same roles |
| [AG-UI specification (draft)](https://docs.ag-ui.com/spec/draft) | Event protocol between agents and UIs, with namespaced CUSTOM events and no source event | `h4b.sources` and `h4b.citations` as CUSTOM events, next to `h4b.ui.effect` and `h4b.ui.render` |

## Experiments and conversation attributes

Supports [ADR 0017](../adr/0017-atributos-da-conversa.md) and [Experiments](./experiments.md). Accessed 2026-11-10.

| Source | What it is | Use in H4B |
|---|---|---|
| [W3C Baggage](https://www.w3.org/TR/baggage/) | Header `baggage` with `key=value` members (percent-encoded values, optional `;` properties), limits of 64 members and 8192 bytes | How conversation attributes reach the backend; `encodeBaggage`, `parseBaggage` and `mergeBaggage` follow it |
| [W3C Trace Context](https://www.w3.org/TR/trace-context/) | Header `traceparent` that joins the browser's spans to the backend's | Already sent by `getTraceHeaders()`; `baggage` goes next to it |
| [OpenTelemetry Baggage](https://opentelemetry.io/docs/concepts/signals/baggage/) | OTel's propagated key-value context; the docs warn that baggage is sent in plain text to every service downstream | Why only codes go in it, why the server keeps an allow list (`readConversationAttributes`), and why an existing `baggage` from the OTel propagator is merged, not replaced |
| [OpenTelemetry metrics API: Counter](https://opentelemetry.io/docs/specs/otel/metrics/api/#counter) | Monotonic sum instrument | `recordCounter()` and the experiment counters: totals that are not sampled and outlive trace retention |

## Menu: local semantic matcher

Supports open decision 4 in the [ROADMAP](../../ROADMAP.md) (in-browser embeddings vs. patterns only). Read on 2026-11-12. Nothing here was measured by us.

| Source | What it is | Use in H4B |
|---|---|---|
| `@alexlana/agent-intents` (the octopus backend, alexlana's private repository) | Fixed answers before the LLM: compares the message with example phrases for each intent and only answers when the score reaches `threshold` **and** beats the runner-up intent by `margin`; what it did not answer goes to an inbox that a person labels | Reference for the menu's semantic matcher: a wrong answer is worse than none (below both conditions, it goes to the LLM), and nothing users type becomes an example on its own |

## Explicit conversation state

Supports [ADR 0019](../adr/0019-estado-explicito-da-conversa.md) and [Explicit conversation state](./conversation-state.md). Accessed 2026-11-14. Read from documentation and papers; none of these systems was run by us, and numbers are the authors'.

| Source | What it is | Use in H4B |
|---|---|---|
| [Hermes Agent: memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory) (Nous Research) | Two small memory files with hard character limits; the tool only adds, patches and removes entries found by a unique snippet; exact duplicates are ignored; content is scanned (injection, exfiltration, invisible Unicode) before it reaches the prompt; past the limit the write is refused with what exists and how much to free | Operations instead of rewrites, `too-long` and `over-budget` instead of compaction, `duplicate`, cleaning before storing |
| [OpenClaw: memory](https://docs.openclaw.ai/concepts/memory) | A short curated `MEMORY.md`, searchable daily notes, a flush before compaction, and promotion to short memory only by score, frequency and diversity | Small state with limits per section; anything long or episodic stays with the backend (layer c) |
| [Letta: memory blocks](https://docs.letta.com/guides/agents/memory-blocks) | Labelled blocks with a description, a character limit and `read_only` | Sections with `description`, `max` and `maxChars`; `locked` items the backend can't change |
| [Factory: evaluating context compression](https://factory.ai/news/evaluating-compression) | Comparison of compression methods for long agent sessions: incremental structured summaries lost less than summaries rebuilt each time, and all methods tracked artifacts poorly | Why the backend sends operations, never a whole new state, and why a dedicated state sits next to the `memory` summary |
| [Zep: facts](https://help.getzep.com/facts) · [how Zep tracks provenance](https://blog.getzep.com/how-zep-tracks-provenance-in-agent-memory/) | Facts with validity times; a contradicted fact is invalidated, not deleted, and its source is kept | Evidence per item, the journal with before and after, and `validUntil` left open in the ADR |
| [Mem0 paper (arXiv 2504.19413)](https://arxiv.org/abs/2504.19413) · [Mem0 v2 → v3 migration](https://docs.mem0.ai/migration/oss-v2-to-v3) | Started with ADD/UPDATE/DELETE/NOOP decided by the model, then moved to adding only and resolving conflicts at read time | Removals always need a `reason` and are capped per update (`maxRemovals`) |
| [State contamination in agent memory (arXiv 2605.16746)](https://arxiv.org/abs/2605.16746) | Hostile content compressed into a summary slips past detectors and keeps steering the agent; cleaning before compression works, cleaning only the finished summary does not | `cleanText` and `screen` run before an item is stored |
| [MemLineage (arXiv 2605.14421)](https://arxiv.org/abs/2605.14421) | Provenance and lineage per memory entry; a memory "laundered" through a summary looks legitimate when only its signature is checked | `origin` worked out from the cited messages, never taken from the writer's word |
| [ReacTOD (TrustNLP 2026)](https://aclanthology.org/2026.trustnlp-main.21/) | A symbolic validator checks each dialogue-state change before applying it; format errors and model hallucinations otherwise cascade into wrong actions | Every operation is checked deterministically (shape, section, evidence, quote) and rejected with a reason the model sees |
| [Anthropic: effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | Structured note-taking kept outside the context window, alongside compaction | The state as notes the backend reads each turn, apart from the raw history |

## Distribution: packages and agent skills

Supports [Packages](./packages.md), the [skills](../../skills/README.md) and the plugin manifest in `.claude-plugin/`. Accessed 2026-11-16.

| Source | What it is | Use in H4B |
|---|---|---|
| [npm: scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages) | Scoped packages are private by default; publishing them public needs `--access public` or `publishConfig.access` | `publishConfig.access: public` in every package; the `@handsforbots` organization |
| [npm: `peerDependencies`](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#peerdependencies) and `peerDependenciesMeta` | Peers the host installs once; npm 7+ installs missing ones, `optional` marks those a package works without | Why `core` is a peer, why every install line names it, and why `voice` is optional for `keyboard` and `voice-effects`; `test/package-catalog.test.ts` checks the lines against them |
| [Agent Skills](https://agentskills.io) | Folder format (`SKILL.md` with `name` and `description`, plus references and scripts) read by coding agents | Format of the skills in `skills/` |
| [Claude Code: create a marketplace](https://code.claude.com/docs/en/plugin-marketplaces) · [host and maintain one](https://code.claude.com/docs/en/plugins/host-marketplace.md) | `.claude-plugin/marketplace.json` lists plugins; users run `/plugin marketplace add owner/repo`; a plugin without `version` follows the repository's commits | The repository root is both the marketplace and the `handsforbots` plugin, whose `skills/` are the integration skills; no `version`, so users get each skill update |

## Repository security: secrets and dependencies

Supports the security checks in [Development](./development.md), `.github/` and `.githooks/`. Accessed 2026-11-16.

| Source | What it is | Use in H4B |
|---|---|---|
| [Gitleaks](https://github.com/gitleaks/gitleaks) | Secret scanner for git history and staged changes (MIT) | `pre-commit` hook on staged changes and a full-history scan in CI, through the CLI image because `gitleaks-action` needs a license for organization repositories; `.gitleaksignore` for reviewed findings |
| [pnpm `audit`](https://pnpm.io/cli/audit) · [`overrides`](https://pnpm.io/settings#overrides) | Checks the lockfile against the npm advisory database; overrides force a version range anywhere in the tree | Blocking audit of production dependencies in CI; overrides with the advisory id as a temporary floor for transitive dependencies |
| [Dependabot: `cooldown`](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference#cooldown-) · [groups](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference#groups--) | Delays version updates for N days after a release; groups related updates in one PR | 7-day wait, so a malicious or broken publish is usually pulled before it reaches us; security updates are not delayed |
| [GitHub: security hardening for Actions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#using-third-party-actions) | Pinning third-party actions to a full commit SHA is the only immutable reference | Actions pinned by SHA, the Gitleaks image by digest, `permissions: contents: read`, `persist-credentials: false` |
| [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) · [`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust) | Publishing from CI with OIDC instead of a token; automatic provenance; per-package trusted publisher and dist-tag permission (accessed 2026-11-19) | `release.yml`, `scripts/publish.mjs`, `scripts/npm-trust.sh` ([Releasing](./development.md#releasing)). Requirements as the docs state them: npm 11.5.1+ to publish, 11.21+ for dist-tag, 11.15+ for `npm trust`; a new trusted publisher expires after 2 days without a publish |

## XSS review

Supports the XSS review in the ROADMAP (section 3), `packages/widget/test/xss.test.ts` and `.github/workflows/codeql.yml`. Accessed 2026-11-17.

| Source | What it is | Use in H4B |
|---|---|---|
| [OWASP XSS Filter Evasion Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/XSS_Filter_Evasion_Cheat_Sheet.html) · [XSS Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html) | Catalog of payloads that slip past filters; rules for encoding output per context | Shapes of the payloads in the widget's suite (handlers, entity-encoded schemes, control characters, mutation through `<math>`/`<noscript>`); escape-first rendering and URL allowlists |
| [PortSwigger XSS cheat sheet](https://portswigger.net/web-security/cross-site-scripting/cheat-sheet) | Event handlers, tags and URL schemes that run script, by browser | Which tags, attributes and schemes the suite forbids in rendered DOM |
| [fast-check](https://fast-check.dev) | Property-based testing for JavaScript (MIT) | Random mixes of Markdown and HTML fragments must render only the widget's own tags and safe links; checked to catch a planted `javascript:` link and a missing escape |
| [CodeQL](https://codeql.github.com/docs/codeql-language-guides/codeql-for-javascript/) · [`security-extended`](https://docs.github.com/en/code-security/code-scanning/managing-your-code-scanning-configuration/codeql-query-suites) | GitHub's static analysis; the extended suite adds lower-precision security queries, including DOM-based XSS | Runs on every push and pull request over `packages/`, results in code scanning; it does not see through our own escaping, which the tests cover |

## A2UI and MCP Apps

Supports [ADR 0020](../adr/0020-a2ui-e-mcp-apps.md) and the `transport-agui` A2UI activity mapping. Accessed 2026-11-26.

| Source | What it is | Use in H4B |
|---|---|---|
| [A2UI](https://github.com/google/A2UI) · [Introducing A2UI (Google Developers Blog)](https://developers.googleblog.com/introducing-a2ui-an-open-project-for-agent-driven-interfaces/) | Open declarative generative UI protocol (component tree, data model, bidirectional function calls; v1.0 released November 2026) | Target protocol for the planned `ui.surface` stimulus and `@handsforbots/a2ui` host runtime (ADR 0020), keeping `ui.render` as a lightweight secondary escape hatch |
| [`@a2ui/web_core`](https://github.com/google/A2UI) (Apache-2.0) | Framework-agnostic A2UI protocol parser, reactive surface/data model and schema definitions (including v1.0) | Chosen foundation for the planned `@handsforbots/a2ui` plugin so H4B does not reimplement the protocol engine |
| [`@ag-ui/a2ui-middleware`](https://github.com/ag-ui-protocol/ag-ui) | AG-UI middleware that streams A2UI surfaces over `ACTIVITY_SNAPSHOT` and `ACTIVITY_DELTA` events with `activityType: "a2ui-surface"` | Basis for `transport-agui` recognizing `a2ui-surface` activity events and emitting `a2ui.surface.snapshot` / `a2ui.surface.delta` |
| [MCP Apps (SEP-1865)](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp) · [spec 2026-01-26](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx) | MCP UI extension (`io.modelcontextprotocol/ui`) for sandboxed `ui://` HTML resources (`text/html;profile=mcp-app`) communicating over JSON-RPC/postMessage | Implemented by `@handsforbots/mcp-apps` as a web host; complementary to A2UI (A2UI renderers can also be packaged inside MCP Apps for third-party chat hosts) |
