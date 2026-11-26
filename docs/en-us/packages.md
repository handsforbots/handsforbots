# Packages

Hands for Bots is split into small packages so you install only what your interface uses. This page says what each one does, what it needs and what it works with. Options for each package are in [Plugins](./plugins.md).

> **About the ideas on this page.** Each package lists a few ideas of what its capabilities make easy. They are there to spark your own, not to mark the edges: the packages describe what they *do* (send a turn to a backend, run a command without the LLM, point at an element on the screen), and any problem that needs that is a fit, whatever the product.

## How the pieces fit

- **`@handsforbots/core`** is always there. It holds the conversation, the actions your GUI exposes, the queue of turns and the plugin system. It has no UI.
- **One transport** connects it to your backend or agent: AG-UI, Rasa, your own HTTP API, an OpenAI-compatible API, the Vercel AI SDK or CopilotKit. A turn without a transport fails; direct commands still work.
- **An interface, if you want one**: the ready-made `<h4b-chat>` widget, your own components with the React or Vue bindings, or a chat library you already use (CopilotKit, assistant-ui).
- **Capabilities** you add one by one: voice, direct commands, keyboard shortcuts, camera and files, guided tours, browser agents, MCP Apps, cues.
- **Infrastructure** that changes what is kept and sent: memory (on by default), explicit conversation state, browser or server storage, tab sync, consent, observability, test helpers.

Plugins don't import each other at runtime: they find each other's services when both are installed. The widget, for instance, shows a microphone only when `voice` is mounted. So adding or removing a package never breaks the others.

## Installing

```bash
npm install @handsforbots/core@alpha @handsforbots/transport-http@alpha @handsforbots/widget@alpha
```

- The H4B packages share one version and are published with the `alpha` tag while v2 is in alpha: add `@alpha` (or pin `2.0.0-alpha.4`). `@handsforbots/voice` is `2.0.0-alpha.4.2` and `@handsforbots/voice-models` is `2.0.0-alpha.4.1` until the next shared release.
- Most packages declare `@handsforbots/core` as a peer dependency: install it yourself, once. The install line of each package below already includes the `@handsforbots` packages it needs.
- ES modules with TypeScript types included. They run in the browser; the `/server` entry points (`cues`, `conversation-state`, `observability`) and `voice-effects` run in Node too.
- Action schemas accept any [Standard Schema](https://standardschema.dev) library (Zod, Valibot, ArkType) or plain JSON Schema. None is required.

## Pick by what you need

| I want to… | Package |
|---|---|
| Talk to my agent or backend | a transport: [`transport-agui`](#handsforbotstransport-agui), [`transport-http`](#handsforbotstransport-http), [`transport-ai-sdk`](#handsforbotstransport-ai-sdk), [`transport-rasa`](#handsforbotstransport-rasa), or [`copilotkit`](#handsforbotscopilotkit) |
| A chat window without building one | [`widget`](#handsforbotswidget) |
| My own UI in React or Vue | [`react`](#handsforbotsreact), [`vue`](#handsforbotsvue) |
| Keep the chat library I already use | [`copilotkit`](#handsforbotscopilotkit), [`assistant-ui`](#handsforbotsassistant-ui) |
| Let people talk and hear answers | [`voice`](#handsforbotsvoice), plus [`voice-models`](#handsforbotsvoice-models) and [`voice-effects`](#handsforbotsvoice-effects) for the bot's voice |
| Run known commands instantly, without the LLM | [`menu`](#handsforbotsmenu) |
| Shortcuts for talking, stopping and a command palette | [`keyboard`](#handsforbotskeyboard) |
| Photos, files, what is on screen, idle nudges, sensors | [`inputs`](#handsforbotsinputs) |
| Point at things on the page, step-by-step tours | [`guided`](#handsforbotsguided) |
| Let browser agents use my actions | [`expose-webmcp`](#handsforbotsexpose-webmcp) |
| Show interactive apps sent by an MCP server | [`mcp-apps`](#handsforbotsmcp-apps) |
| Make the page react to the conversation (mood, scenery, urgency) | [`cues`](#handsforbotscues) |
| Captions that follow the bot's voice word by word | [`captions`](#handsforbotscaptions) |
| Keep the facts and decisions of a long conversation straight | [`conversation-state`](#handsforbotsconversation-state) |
| Control how much history is sent and kept | [`memory`](#handsforbotsmemory) |
| Survive reloads | [`storage-local`](#handsforbotsstorage-local) or [`storage-backend`](#handsforbotsstorage-backend) |
| Several tabs open at once | [`tab-sync`](#handsforbotstab-sync) |
| Follow a consent banner, LGPD, GDPR, CCPA | [`consent`](#handsforbotsconsent) |
| See latency, errors and usage in Grafana, Langfuse or LangSmith | [`observability`](#handsforbotsobservability) |
| Test my plugin, transport or integration | [`testkit`](#handsforbotstestkit) |

## Kernel

### `@handsforbots/core`

The headless runtime. Inputs become signals, signals become turns, the backend answers with stimuli (messages, action calls, effects on the GUI, shared state). Your interface declares **actions** once and they become available to the assistant (tool calls), to the user (direct commands) and to browser agents, under the same validation, confirmation and origin rules. It also has interceptors, consent, sources and citations, conversation attributes for experiments.

- **Needs:** nothing. `@handsforbots/memory` comes with it and is mounted by default.
- **Install:**

  ```bash
  npm install @handsforbots/core@alpha
  ```

- **Works with:** everything else; it is the only package every setup has.
- **For instance:** an assistant that filters a table and opens records by calling your actions; buttons that run the same actions and show up in the conversation; a backend that pushes "your report is ready" into the conversation outside a turn.
- Guides: [Getting started](./getting-started.md), [Concepts](./concepts.md).

## Transports

Install one. They all send the history, the context signals of the screen and your actions as tools (Rasa excepted, see below), and turn what the backend answers into messages, action calls and GUI effects.

### `@handsforbots/transport-agui`

Speaks [AG-UI](https://docs.ag-ui.com), the event protocol many agent frameworks already serve (CopilotKit runtime, LangGraph, Mastra, PydanticAI…). HTTP POST + SSE to a URL, or any AG-UI agent object.

- **Needs:** `@handsforbots/core`. `@ag-ui/core` comes with it; `@ag-ui/client` only if you pass your own `HttpAgent`.
- **Install:**

  ```bash
  npm install @handsforbots/transport-agui@alpha @handsforbots/core@alpha
  ```

- **Works with:** an agent framework that serves AG-UI; `copilotkit` uses it internally.
- **For instance:** a LangGraph agent that drives a dashboard; an in-process agent for tests or demos.

### `@handsforbots/transport-http`

Three plugins for HTTP backends: `http` (your own turn API: sessions, plain or JSON answers, SSE streaming, tool calls, `parse` and `body` hooks), `universalLLM` (the v1 UniversalLLM proxy format) and `openAICompatible` (`/chat/completions` with native tools).

- **Needs:** `@handsforbots/core`.
- **Install:**

  ```bash
  npm install @handsforbots/transport-http@alpha @handsforbots/core@alpha
  ```

- **Works with:** any server you write; OpenAI-compatible servers (OpenAI, Ollama, vLLM, LiteLLM). Keys stay on the server: `openAICompatible` with a key in the browser is for local development only.
- **For instance:** a small endpoint in front of your LLM provider; an existing chatbot API; a local model through Ollama while developing.

### `@handsforbots/transport-ai-sdk`

Talks to a [Vercel AI SDK](https://ai-sdk.dev) route that returns `streamText(...).toUIMessageStreamResponse()`: same request shape as `DefaultChatTransport`, plus your actions as tools and the screen context.

- **Needs:** `@handsforbots/core`; the AI SDK runs on your server.
- **Install:**

  ```bash
  npm install @handsforbots/transport-ai-sdk@alpha @handsforbots/core@alpha
  ```

- **Works with:** Next.js, SvelteKit, Nuxt or any server where the AI SDK runs.
- **For instance:** adding GUI actions and voice to an app that already has an AI SDK chat route.

### `@handsforbots/transport-rasa`

The Rasa REST channel. Text, images and buttons become bubbles and quick replies; `custom.h4b` in a response runs an action, an effect or rich content on the page.

- **Needs:** `@handsforbots/core`, a Rasa server.
- **Install:**

  ```bash
  npm install @handsforbots/transport-rasa@alpha @handsforbots/core@alpha
  ```

- **Works with:** existing Rasa assistants. Rasa keeps its own tracker, so the history is not sent and actions are not offered as tools: the bot drives the GUI through `custom.h4b`.
- **For instance:** giving a Rasa bot voice, a widget and control over the page without rewriting it.

## Interfaces

### `@handsforbots/widget`

`<h4b-chat>`, a ready-made conversation window as a Web Component (shadow DOM): floating, sidebar or inline; safe Markdown, images, quick replies, action cards, sources and citations, greetings with A/B variants, privacy panel. It shows microphone, attach and camera buttons when those packages are installed. Styled with CSS variables or `::part()`.

- **Needs:** `@handsforbots/core`.
- **Install:**

  ```bash
  npm install @handsforbots/widget@alpha @handsforbots/core@alpha
  ```

- **Works with:** any page or framework (plain HTML, React, Vue, Svelte…); `voice`, `inputs`, `menu`, `cues`, `guided`, `mcp-apps` for richer controls and content.
- **For instance:** a help assistant on a site with one script; a sidebar copilot in an internal tool; a kiosk with the window always open.

### `@handsforbots/react`

React bindings: `<H4BProvider>`, hooks for messages, the running turn, shared state and services, `useAction` (an action registered while a component is mounted) and `useContextSignal` (what the component shows, sent as context).

- **Needs:** `@handsforbots/core`, `react` 18+. It pulls in `@handsforbots/widget`.
- **Install:**

  ```bash
  npm install @handsforbots/react@alpha @handsforbots/core@alpha
  ```

- **Works with:** your own components, or the widget inside a React app; `copilotkit` and `assistant-ui` build on it.
- **For instance:** a chat panel designed in your design system; a page whose components register the actions they can perform.

### `@handsforbots/vue`

The same for Vue 3.3+: `h4bVue` plugin, composables returning read-only refs, `useAction`, `useContextSignal`, `useService`, `v-text-focus`.

- **Needs:** `@handsforbots/core`, `vue` 3.3+. It pulls in `@handsforbots/widget`.
- **Install:**

  ```bash
  npm install @handsforbots/vue@alpha @handsforbots/core@alpha
  ```

- **Works with:** Vue and Nuxt apps, your components or the widget.

### `@handsforbots/copilotkit`

For apps where [CopilotKit](https://copilotkit.ai) already owns the chat and the agent: your H4B actions become CopilotKit frontend tools, context signals become agent context, and (unless `transport: false`) the CopilotKit agent becomes H4B's transport, so voice, direct commands and sensors reach it.

- **Needs:** `@handsforbots/core`, `@handsforbots/react`, `@copilotkit/react-core` 1.77+, `react` 18+.
- **Install:**

  ```bash
  npm install @handsforbots/copilotkit@alpha @handsforbots/core@alpha @handsforbots/react@alpha
  ```

- **Works with:** `voice`, `menu`, `keyboard`, `expose-webmcp` on top of the CopilotKit UI.

### `@handsforbots/assistant-ui`

An [assistant-ui](https://www.assistant-ui.com) runtime backed by H4B: assistant-ui draws the thread and composer, H4B does the rest (any transport, actions, voice, menu). Tool calls show with their results; cancel aborts the turn.

- **Needs:** `@handsforbots/core`, `@handsforbots/react`, `@assistant-ui/react` 0.15+, `react` 18+.
- **Install:**

  ```bash
  npm install @handsforbots/assistant-ui@alpha @handsforbots/core@alpha @handsforbots/react@alpha
  ```

- **Works with:** any transport.

## Input and output

### `@handsforbots/voice`

Speech in and out with providers you choose and chain: the browser's speech APIs, your backend (HTTP or WebSocket, keys on the server), Vosk on a server or offline in the page. Push-to-talk, hold-to-talk, hands-free conversation with end-of-turn detection, barge-in, echo filter, replies spoken sentence by sentence.

- **Needs:** `@handsforbots/core`. `vosk-browser` only for offline recognition in the page.
- **Install:**

  ```bash
  npm install @handsforbots/voice@alpha @handsforbots/core@alpha
  ```

- **Works with:** the widget (microphone and speaker buttons), `keyboard` (hold to talk), `menu` (spoken commands), `voice-models` and `voice-effects` (the bot's voice), `cues` (timed to speech), `captions` (word by word).
- **For instance:** hands-free use while cooking, driving a forklift or holding a tool; dictating a long text; accessibility for people who can't type.
- Guides: [Interruption and voice conversation](./conversation.md), [Speech synthesis](./speech.md).

### `@handsforbots/voice-models`

Speech providers that run neural models in the page: Piper, Kokoro and any transformers.js text-to-speech pipeline. Models from Hugging Face, any URL or a local file, downloaded with progress, cached, optionally run in a Web Worker.

- **Needs:** `@handsforbots/core`, `@handsforbots/voice`. Your app supplies the heavy runtime: `onnxruntime-web` (Piper, Kokoro), a phonemizer build such as piper-phonemize (espeak-ng, GPL-3.0) or `@huggingface/transformers`.
- **Install:**

  ```bash
  npm install @handsforbots/voice-models@alpha @handsforbots/core@alpha @handsforbots/voice@alpha
  ```

- **For instance:** a better voice than the browser's without a cloud bill; speech that works offline; a voice that sounds the same on every device.

### `@handsforbots/voice-effects`

Effects for synthesized speech written as JSON (Web Audio names and units): filters, compressor, reverb, chorus, ring modulation and more, presets such as `radio`, `robot` or `telephone`, offline rendering, and export to SSML and FFmpeg filter graphs.

- **Needs:** nothing at runtime. `@handsforbots/voice` is optional (its types); chains, SSML and FFmpeg export also work outside H4B, in a build script or a server.
- **Install:**

  ```bash
  npm install @handsforbots/voice-effects@alpha
  ```

- **For instance:** a character with its own voice in a game or a story; a radio-style announcer; the same effect rendered on the server with FFmpeg.

### `@handsforbots/menu`

Direct commands that run on the device without the LLM: slash commands (`/late`), patterns (`show {status} orders`) and typo-tolerant phrases per language, good for speech. Negations, typed questions and close calls go to the LLM; optionally the menu asks "Did you mean…?". Suggestions while typing.

- **Needs:** `@handsforbots/core`.
- **Install:**

  ```bash
  npm install @handsforbots/menu@alpha @handsforbots/core@alpha
  ```

- **Works with:** your actions (each command runs one), the widget (suggestions), `voice` (spoken commands), `keyboard` (palette).
- **For instance:** instant answers for the commands people use most; a command palette; working when the LLM is slow or down.

### `@handsforbots/keyboard`

Shortcuts: hold a key to talk, a key to interrupt the bot, a key that opens your command palette.

- **Needs:** `@handsforbots/core`. `@handsforbots/voice` is optional: the talk shortcut needs it; interrupt and palette work without it.
- **Install:**

  ```bash
  npm install @handsforbots/keyboard@alpha @handsforbots/core@alpha
  ```

### `@handsforbots/inputs`

Four plugins: `camera` (photos, periodic frames as context), `files` (pick or attach files; the widget adds paste and drop), `gui` (current route as context, text selection on request, `data-h4b-say` / `data-h4b-command` / `data-h4b-context` attributes in your HTML with `declarative: true`, a nudge after inactivity) and `sensors` (geolocation, orientation, network, opt-in).

- **Needs:** `@handsforbots/core`.
- **Install:**

  ```bash
  npm install @handsforbots/inputs@alpha @handsforbots/core@alpha
  ```

- **Works with:** the widget (attach and camera buttons), your own buttons.
- **For instance:** "explain the paragraph I selected"; a photo of a broken part; a button anywhere on the page that asks the assistant something; an assistant that knows which page the user is on.

### `@handsforbots/guided`

Guided tours and highlights the assistant, the user or your code can start: a step points at an element (also inside shadow roots) or shows a centered card. "Next", "back" and "skip", typed or spoken, navigate it. Optional actions to scroll to sections of the page and to show the page's images in the conversation.

- **Needs:** `@handsforbots/core`. `@handsforbots/menu` comes with it.
- **Install:**

  ```bash
  npm install @handsforbots/guided@alpha @handsforbots/core@alpha
  ```

- **For instance:** onboarding; the assistant answering "where do I change my password?" by pointing at the field; a narrated walkthrough with `voice`.

### `@handsforbots/expose-webmcp`

Publishes your actions to browser agents through [WebMCP](https://github.com/webmachinelearning/webmcp) (`document.modelContext`). By default only actions marked `exposeTo: ['agent']`. Calls go through the same validation, confirmation and history as everything else.

- **Needs:** `@handsforbots/core`; a browser with WebMCP.
- **Install:**

  ```bash
  npm install @handsforbots/expose-webmcp@alpha @handsforbots/core@alpha
  ```

- **For instance:** letting the user's own browser agent fill your form or apply a filter safely, with a trace in the conversation.

### `@handsforbots/mcp-apps`

Renders [MCP Apps](https://modelcontextprotocol.io) (`ui://` resources) that your backend, as an MCP client, sends in a reply. Each app runs in a sandboxed iframe with a strict content policy; H4B is its host and maps its tool calls to the actions you allow.

- **Needs:** `@handsforbots/core`.
- **Install:**

  ```bash
  npm install @handsforbots/mcp-apps@alpha @handsforbots/core@alpha
  ```

- **Works with:** the widget (`renderers`) or your own UI (`mountMcpApp`).
- **For instance:** a chart or a form an MCP server returns, inside the conversation.

### `@handsforbots/cues`

Presentation categories with a closed vocabulary that the page reacts to: a character's mood, the scenery, a conversation's urgency, a stricter mode. Values come from the backend, from an action the model can call, or from rules on the reply's sources and actions; counts and policies handle repetition. With voice, the change happens when the voice reaches that reply.

- **Needs:** `@handsforbots/core`.
- **Install:**

  ```bash
  npm install @handsforbots/cues@alpha @handsforbots/core@alpha
  ```

- **For instance:** an avatar that looks confused after repeated misunderstandings; a background that follows the topic; a red outline when a support case becomes urgent.

### `@handsforbots/captions`

Word-by-word captions and reading cadence: follows the bot's voice when it speaks (`voice.word`), or drives assistant replies with a smooth reading cadence when voice is absent or silent. Includes a headless cadence (`@handsforbots/captions/cadence`) and a ready-made renderer and `<h4b-caption>` custom element (`@handsforbots/captions/element`) with `karaoke` and `reveal` (speech-bubble) modes.

- **Needs:** `@handsforbots/core` (`@handsforbots/voice` is optional).
- **Install:**

  ```bash
  npm install @handsforbots/captions@alpha @handsforbots/core@alpha
  ```

- **Works with:** the widget (`.captions`, `captions: { mode: 'reveal' }`), `<h4b-caption>`, React and Vue (`useCaption` / `useStore`), `voice` + `voice-models` (`durations: true`, `whisperAligner`).
- **For instance:** a speech bubble replacing a chat box with word-by-word reveal; a talking avatar with podcast-style captions; following along in a noisy room or with hearing loss.
- Guide: [Word-by-word captions](./speech.md#word-by-word-captions).

## Conversation, memory and storage

### `@handsforbots/conversation-state`

An explicit, auditable record of the conversation (topic, goal, entities, decisions, facts with their source, pending items) sent with every request. The backend changes it only through operations the page checks: a fact needs a quote found in the message it cites.

- **Needs:** `@handsforbots/core`. `@handsforbots/conversation-state/server` reads it on your backend.
- **Install:**

  ```bash
  npm install @handsforbots/conversation-state@alpha @handsforbots/core@alpha
  ```

- **For instance:** long conversations where the model must not forget what was decided; handing a conversation to a person with a summary they can trust.
- Guide: [Explicit conversation state](./conversation-state.md).

### `@handsforbots/memory`

How many turns are sent to the backend and kept on the page, and how older turns are folded into a summary. `createH4B` mounts it by default; install it yourself only to import its helpers (`httpSummarizer`, `localSummary`).

- **Needs:** `@handsforbots/core` (which already depends on it).
- **Install:**

  ```bash
  npm install @handsforbots/memory@alpha @handsforbots/core@alpha
  ```

### `@handsforbots/storage-local`

Keeps the conversation in the browser across reloads, encrypted by default with a key that expires (in a cookie or on your server), so nothing readable is left after the deadline.

- **Needs:** `@handsforbots/core`.
- **Install:**

  ```bash
  npm install @handsforbots/storage-local@alpha @handsforbots/core@alpha
  ```

### `@handsforbots/storage-backend`

Keeps the conversation on your server (`GET`/`PUT`/`DELETE` on one URL); your server enforces the retention.

- **Needs:** `@handsforbots/core`.
- **Install:**

  ```bash
  npm install @handsforbots/storage-backend@alpha @handsforbots/core@alpha
  ```

- **For instance:** continuing a conversation on another device; keeping conversations for human review with consent.
- Guide: [Persistence, memory and privacy](./persistence.md).

### `@handsforbots/tab-sync`

Several tabs share one conversation, or each keeps its own and hears about what the others did, or they stay isolated.

- **Needs:** `@handsforbots/core`.
- **Install:**

  ```bash
  npm install @handsforbots/tab-sync@alpha @handsforbots/core@alpha
  ```

## Privacy, observability and tests

### `@handsforbots/consent`

Starting rule sets for `createH4B({ consent })` per legislation (LGPD, GDPR, CCPA, opt-in) in JSON or YAML, helpers to find the visitor's region, and anonymization of what is stored (emails, phone numbers, CPF, CNPJ, cards, media). The consent mechanism itself is in `core`.

- **Needs:** `@handsforbots/core`; a YAML parser only for YAML rules.
- **Install:**

  ```bash
  npm install @handsforbots/consent@alpha @handsforbots/core@alpha
  ```

- Guide: [Consent](./consent.md).

### `@handsforbots/observability`

Turns, routes, actions, signals and speech as semantic telemetry, with perceived latency per route, for Grafana (Faro, OpenTelemetry), Langfuse and LangSmith; conversation attributes on spans and as `baggage` for experiments; a debug panel for phones. `@handsforbots/observability/server` reads the attributes on your backend.

- **Needs:** `@handsforbots/core`. `@handsforbots/semantic-event-observability` comes with it; each exporter needs its own library (`@grafana/faro-web-sdk`, `@opentelemetry/api`, `@langfuse/tracing`, `langsmith`, `web-vitals`), all optional.
- **Install:**

  ```bash
  npm install @handsforbots/observability@alpha @handsforbots/core@alpha
  ```

- Guide: [Experiments](./experiments.md).

### `@handsforbots/semantic-event-observability`

The library under `observability`: semantic logs, metrics and traces for any asynchronous event system, with optional exporters. It does not depend on H4B and is versioned on its own.

- **Needs:** nothing; exporter libraries are optional peers.
- **Install:**

  ```bash
  npm install @handsforbots/semantic-event-observability
  ```

### `@handsforbots/testkit`

For plugin, transport and integration authors: a scripted transport, `reply` and `citedReply`, `eventually` and `waitForIdle` (wait for conditions, never fixed delays), and `transportConformance`, the Vitest suite every transport in the repository passes.

- **Needs:** `@handsforbots/core`, `vitest` 3+.
- **Install:**

  ```bash
  npm install -D @handsforbots/testkit@alpha @handsforbots/core@alpha
  ```

## Starting points

Combinations that cover many projects. Mix them freely.

| Starting point | Packages |
|---|---|
| A chat window on any site, talking to your API | `core`, `transport-http`, `widget`, `storage-local` |
| Your own React UI over an AG-UI agent | `core`, `transport-agui`, `react`, `menu` |
| Voice first | `core`, a transport, `voice`, `keyboard`, `widget` or your UI; `voice-models` for an offline voice |
| An existing CopilotKit or assistant-ui app gaining voice and direct commands | `core`, `react`, `copilotkit` or `assistant-ui`, `voice`, `menu` |
| An existing Rasa bot on a new page | `core`, `transport-rasa`, `widget`, `guided` |
| Production with consent and metrics | add `consent`, `storage-backend` or `storage-local`, `observability` |
