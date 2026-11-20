# Hands for Bots v2 — packages, imports and dependencies

Checked against each package's `package.json` and `src/index.ts`. When the installed version disagrees with this file, trust the installed package (`node_modules/@handsforbots/<name>/package.json` and its `dist/index.d.ts`). Human-oriented version with ideas per package: `docs/en-us/packages.md`.

## Installing

- Published on npm under `@handsforbots/*`. While v2 is in alpha, install with the `alpha` tag: `npm install @handsforbots/core@alpha`. Use the project's package manager (`pnpm add`, `yarn add`, `bun add`): look at the lockfile first.
- Inside the H4B monorepo itself, packages resolve through the pnpm workspace: don't install them there.
- `@handsforbots/core` is a **peer** of almost every package: install it once, explicitly. Install the other `@handsforbots` peers listed below too; npm 7+ installs missing peers on its own, pnpm and yarn may only warn.
- `@handsforbots/testkit` goes in `devDependencies`.
- ES modules only, types included. Browser by default; `/server` entry points and `voice-effects` also run in Node.
- Action schemas: any Standard Schema library (Zod, Valibot, ArkType) through `input`, or JSON Schema through `parameters`. Don't add Zod just for H4B if the project uses another one.

## Match on capability, not on the listed examples

The docs give ideas per package. They are illustrations, not the supported cases. Pick a package when the project needs what it **does**: a package for "guided tours" is also the way to point at any element from a reply; `menu` serves any command that should run without the LLM; `cues` serves any closed set of states the page should mirror. If nothing fits, the project can write a plugin (`definePlugin`, `docs/en-us/writing-plugins.md`).

## Catalog

"Needs" lists the `@handsforbots` peers to install with the package, then anything else the app must provide. "Comes with" are regular dependencies installed automatically.

| Package | Import | Needs | Comes with | Capability |
|---|---|---|---|---|
| `core` | `createH4B`, `definePlugin`, `withConsent`, `pickVariant`, source helpers | — | `memory` | Kernel: conversation, actions, queue, router, interceptors, consent, sources |
| `transport-agui` | `agui({ url \| agent, headers?, forwardedProps?, maxEventBytes? })` | `core` | `@ag-ui/core` | AG-UI agents (HTTP + SSE or an agent object) |
| `transport-http` | `http(...)`, `universalLLM(...)`, `openAICompatible(...)` | `core` | — | Your HTTP API, the v1 UniversalLLM format, `/chat/completions` |
| `transport-ai-sdk` | `aiSdk({ url, headers?, body?, fetch?, maxEventBytes?, maxResponseBytes? })` | `core` | — | A Vercel AI SDK UI message stream route |
| `transport-rasa` | `rasa({ url, sender?, metadata?, reportActionResults? })` | `core` | — | Rasa REST channel; no history, no tools |
| `widget` | `widget({...})`, `pickGreeting`, `bindTextFocus` | `core` | — | `<h4b-chat>` Web Component |
| `react` | `H4BProvider`, `useH4B`, `useMessages`, `useAction`, `useContextSignal`, `useStore`, `useStimulus`, `useSources`, `useTextFocus` | `core`; `react` 18+ | `widget` | React bindings |
| `vue` | `h4bVue`, `provideH4B`, same composables as React, `useService`, `v-text-focus` | `core`; `vue` 3.3+ | `widget` | Vue bindings |
| `copilotkit` | `useCopilotKitBridge(opts)`, `<CopilotKitBridge />` | `core`, `react`; `@copilotkit/react-core` 1.77+, `react` 18+ | `transport-agui` | CopilotKit owns chat and agent; H4B adds actions, context, voice, menu |
| `assistant-ui` | `useH4BAssistantRuntime(opts?)` | `core`, `react`; `@assistant-ui/react` 0.15+, `react` 18+ | — | assistant-ui draws the thread over any H4B transport |
| `menu` | `menu({ commands, language?, sources?, ... })`, type `Command` | `core` | — | Direct commands without the LLM; typed input only from `sources` (default: chat surfaces, voice, shortcuts, `host`) |
| `voice` | `voice({...})`, `webSpeechSTT`, `webSpeechTTS`, `httpSTT`, `httpTTS`, `websocketSTT`, `voskSTT`, `voskBrowserSTT`, `httpEndOfTurn`, `textEchoFilter`, `checkNoise`, `measureNoise`, `createLevelGate` | `core`; `vosk-browser` only for `voskBrowserSTT` | — | Speech in and out |
| `voice-models` | `piperTTS`, `kokoroTTS`, `transformersTTS`, `workerTTS`, `serveTTS`, `espeakPhonemizer`, `piperVoice`, `kokoroModel`, `huggingFace`, `fetchModel` | `core`, `voice`; the app supplies `onnxruntime-web`, a phonemizer build or `@huggingface/transformers` | — | Neural TTS in the page |
| `voice-effects` | `voiceEffects`, `presets`, `defineEffect`, `validateChain`, `toSSML`, `toFFmpeg` | — (`voice` optional, types only) | — | Effects chains for speech, also outside H4B |
| `keyboard` | `keyboard({ talk?, interrupt?, palette?, target? })` | `core` (`voice` optional: the talk shortcut needs it) | — | Hold-to-talk, interrupt, palette event |
| `inputs` | `camera(...)`, `files(...)`, `gui(...)`, `sensors(...)` | `core` | — | Camera, files, route (path only by default), selection and declarative HTML (both opt-in), idle, sensors |
| `guided` | `guided({ tours?, autoStart?, sectionsAttribute?, gallery?, targetsAttribute?, allowAssistantSelectors?, ... })` | `core` | `menu` | Tours, highlights, `show_section`, `image_gallery`; the assistant targets `data-h4b-target` names |
| `expose-webmcp` | `webmcp({ include?, prefix?, modelContext? })` | `core` | — | Actions for browser agents (WebMCP) |
| `mcp-apps` | `mcpAppRenderer({ allowTools? })`, `mountMcpApp(h4b, props, opts)` | `core` | — | Host for MCP Apps (`ui://`) in sandboxed iframes |
| `cues` | `cues({ channels, rules?, classify?, report?, action?, sync? })`; `/server`: `readCuesState` | `core` | — | Closed-vocabulary presentation states |
| `conversation-state` | `conversationState({...})`, `httpStateUpdater`; `/server`: `readConversationState`, `stateUpdateSchema`, `conversationStatePrompt` | `core` | — | Checked, sourced conversation state |
| `memory` | `memory({...})`, `httpSummarizer`, `localSummary`, `groupTurns` | `core` | — | Turns sent and kept, compaction (mounted by default) |
| `storage-local` | `storageLocal({...})`, `cookieKey`, `backendKey` | `core` | — | Encrypted browser persistence |
| `storage-backend` | `storageBackend({ url, ... })` | `core` | — | Server persistence |
| `tab-sync` | `tabSync({ mode?, channel?, ... })` | `core` | — | Tabs: sync, notify, off |
| `consent` | `lgpd`, `gdpr`, `ccpa`, `optIn`, `presets`, `loadConsentRules`, `regionFromMeta`, `regionFromUrl`, `redact` | `core`; a YAML parser only for YAML rules | — | Rule sets, region, anonymization |
| `observability` | `observability({...})`; `/server`: `readConversationAttributes` | `core`; exporter libraries optional (`@grafana/faro-web-sdk`, `@opentelemetry/api`, `@langfuse/tracing`, `langsmith`, `web-vitals`) | `semantic-event-observability` | Semantic telemetry, experiment counters |
| `semantic-event-observability` | `createObservability` and exporters | — | — | The standalone library under `observability`; own version, no `@alpha` tag needed |
| `testkit` | `scriptedTransport`, `reply`, `citedReply`, `eventually`, `waitForIdle`, `transportConformance` | `core`; `vitest` 3+ | — | Test helpers (dev dependency) |

## Picking packages for a task

1. Always `core` + one transport (or `copilotkit`, which brings its own). Which transport: the backend decides — see the `handsforbots-integrations` skill.
2. UI: the `widget` for a ready window; `react`/`vue` for the project's own components; `copilotkit` or `assistant-ui` when the project already uses them. Don't add the widget to an app that draws its own chat.
3. Capabilities only when the task asks for them: `voice` (+ `keyboard`), `menu`, `inputs`, `guided`, `expose-webmcp`, `mcp-apps`, `cues`.
4. Infrastructure on purpose: storage and tabs (skill `handsforbots-persistence`), consent (skill `handsforbots-consent`), `observability`, `conversation-state`. `memory` is already on.
5. Every plugin goes in `createH4B({ plugins: [...] })`; each service has one provider, so never two transports or two storages.
