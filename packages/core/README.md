# @handsforbots/core

⭐ Start here. Hands for Bots kernel: users, the GUI and agents act on the same page through one action layer. Install this first, then one transport.

Part of [Hands for Bots](https://github.com/handsforbots/handsforbots), a headless multimodal and action layer between users, GUIs and agents.

## Install

```bash
npm install @handsforbots/core@alpha
```

## The pieces

| Step | Pick | Packages |
|---|---|---|
| 1 | This kernel | `@handsforbots/core` |
| 2 | **One** transport, by what your backend speaks | [`transport-agui`](https://www.npmjs.com/package/@handsforbots/transport-agui) · [`transport-http`](https://www.npmjs.com/package/@handsforbots/transport-http) · [`transport-ai-sdk`](https://www.npmjs.com/package/@handsforbots/transport-ai-sdk) · [`transport-rasa`](https://www.npmjs.com/package/@handsforbots/transport-rasa) |
| 3 | A UI, unless you draw your own | [`widget`](https://www.npmjs.com/package/@handsforbots/widget) · [`react`](https://www.npmjs.com/package/@handsforbots/react) · [`vue`](https://www.npmjs.com/package/@handsforbots/vue) · [`copilotkit`](https://www.npmjs.com/package/@handsforbots/copilotkit) · [`assistant-ui`](https://www.npmjs.com/package/@handsforbots/assistant-ui) |
| 4 | Only the capabilities you need | See below |

Every package's description starts with its role: **Transport**, **UI**, **Plugin**, **Add-on** (extends another package), **Standalone** (works without H4B) or **Dev**. Search npm for `keywords:h4b-plugin` (or `h4b-transport`, `h4b-ui`) to list one kind. The [package catalog](https://github.com/handsforbots/handsforbots/blob/main/docs/en-us/packages.md) says what each one does and needs.

## What you can add

Each capability is its own package; install only what the interface uses.

| To… | Packages | What they bring |
|---|---|---|
| Talk and listen | [`voice`](https://www.npmjs.com/package/@handsforbots/voice) · [`voice-models`](https://www.npmjs.com/package/@handsforbots/voice-models) · [`voice-effects`](https://www.npmjs.com/package/@handsforbots/voice-effects) · [`captions`](https://www.npmjs.com/package/@handsforbots/captions) | speech in and out, hands-free, barge-in; neural voices in the page; voice effects; word-by-word captions |
| Run commands without the LLM | [`menu`](https://www.npmjs.com/package/@handsforbots/menu) · [`keyboard`](https://www.npmjs.com/package/@handsforbots/keyboard) | slash commands, phrases, shortcuts, push-to-talk, palette |
| Show and guide on the page | [`guided`](https://www.npmjs.com/package/@handsforbots/guided) · [`cues`](https://www.npmjs.com/package/@handsforbots/cues) | tours, highlights, sections, galleries; tone and scene states the page mirrors |
| Take in more than text | [`inputs`](https://www.npmjs.com/package/@handsforbots/inputs) | camera, files, GUI events, idle, sensors |
| Open the page to other agents and apps | [`expose-webmcp`](https://www.npmjs.com/package/@handsforbots/expose-webmcp) · [`mcp-apps`](https://www.npmjs.com/package/@handsforbots/mcp-apps) | browser agents (WebMCP), MCP Apps in sandboxed iframes |
| Remember and continue | [`memory`](https://www.npmjs.com/package/@handsforbots/memory) · [`storage-local`](https://www.npmjs.com/package/@handsforbots/storage-local) · [`storage-backend`](https://www.npmjs.com/package/@handsforbots/storage-backend) · [`tab-sync`](https://www.npmjs.com/package/@handsforbots/tab-sync) · [`conversation-state`](https://www.npmjs.com/package/@handsforbots/conversation-state) | what is sent and kept, encrypted browser or server storage, tabs, explicit conversation state |
| Respect privacy | [`consent`](https://www.npmjs.com/package/@handsforbots/consent) | consent rules per law and region, erasure, anonymization |
| Measure | [`observability`](https://www.npmjs.com/package/@handsforbots/observability) · [`semantic-event-observability`](https://www.npmjs.com/package/@handsforbots/semantic-event-observability) | semantic logs, metrics and traces (Grafana, OTel, Langfuse, LangSmith) |
| Test | [`testkit`](https://www.npmjs.com/package/@handsforbots/testkit) | scripted transports, transport conformance |

## Documentation

- [This package](https://github.com/handsforbots/handsforbots/blob/main/docs/en-us/plugins.md#core)
- [Getting started](https://github.com/handsforbots/handsforbots/blob/main/docs/en-us/getting-started.md)
- [Documentação em português](https://github.com/handsforbots/handsforbots/blob/main/docs/pt-br/README.md)

## License

MIT
