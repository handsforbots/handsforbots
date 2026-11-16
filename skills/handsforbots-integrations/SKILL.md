---
name: handsforbots-integrations
description: Connect Hands for Bots v2 (H4B) to a backend, an agent framework or another UI library - choose and wire a transport (AG-UI agents such as LangGraph, Mastra, PydanticAI or the CopilotKit runtime; your own HTTP API with the request and response formats it accepts; OpenAI-compatible APIs; a Vercel AI SDK route; Rasa with custom.h4b), drive the GUI from the backend (action calls, ui.effect, ui.render, shared state, sources), use H4B under CopilotKit (useCopilotKitBridge) or assistant-ui (useH4BAssistantRuntime), publish actions to browser agents with WebMCP (expose-webmcp) and render MCP Apps (ui:// resources) with mcp-apps. Use when code imports @handsforbots/transport-*, @handsforbots/copilotkit, @handsforbots/assistant-ui, @handsforbots/expose-webmcp or @handsforbots/mcp-apps, when writing the server endpoint an H4B page talks to, or when the task is "make my agent/chatbot control the page". Load together with the handsforbots skill.
---

# Hands for Bots v2 — transports, backends and other UIs

The `handsforbots` skill covers the kernel, actions and context. This one covers what sits on the other side of the wire and the libraries H4B plugs into. Package list, imports and peers: `handsforbots/references/packages.md`. Options: `docs/en-us/plugins.md` in https://github.com/handsforbots/handsforbots. When the installed code disagrees with this file, trust the code.

## Choosing the transport

Exactly one plugin provides `transport`. Pick by what the backend already speaks; don't write a new protocol when one of these fits.

| The backend is… | Plugin | Package |
|---|---|---|
| An agent framework that serves AG-UI (LangGraph, Mastra, PydanticAI, CopilotKit runtime…) | `agui({ url })` | `transport-agui` |
| An endpoint you write or already have | `http({ url, body?, parse?, parseChunk?, session? })` | `transport-http` |
| An OpenAI-compatible API (OpenAI, Ollama, vLLM, LiteLLM) | `openAICompatible({ baseUrl, model })`; key in the browser only for localhost, otherwise point `baseUrl` at your proxy | `transport-http` |
| The v1 UniversalLLM PHP/Laravel proxy | `universalLLM({ url, provider, model })` | `transport-http` |
| A Vercel AI SDK route (`streamText`) | `aiSdk({ url })` | `transport-ai-sdk` |
| Rasa | `rasa({ url })` | `transport-rasa` |
| CopilotKit already owns the agent | `useCopilotKitBridge()` (it provides the transport) | `copilotkit` |

Keys never go to the browser. Every transport takes `headers` as an object or a function (refresh tokens, `getTraceHeaders()` from `observability`).

## What every transport sends and expects

- **Sends**: the history the `memory` plugin lets through (default: last 20 turns + a summary in the context signal `memory.summary`), the context signals (what is on screen), and the actions exposed to `assistant` as tools with JSON Schema. Rasa is the exception: no history, no tools.
- **Expects**: assistant text (streamed or whole), tool calls for actions the page runs, and optionally effects, rich content, shared state, sources and citations.
- **Tool calls run on the page.** The page validates, confirms if `destructive`, runs the handler, records the call and its result in the history, and (by default) calls the backend again with the result in the history, up to `maxActionRoundtrips` (5) per turn. Give every tool call its own id: a repeated id is ignored (`error` with `source: 'action.call'`). Use the id as an idempotency key for server writes.
- **Effects on the page** arrive as the stimulus `ui.effect` `{ name, value }` and are not stored. Handle them in the host: `h4b.on('stimulus', ({ stimulus }) => { if (stimulus.type === 'ui.effect' && stimulus.name === 'scroll') … })` (React/Vue: `useStimulus`). Plugins also consume some by name (`cues`, `conversation.state`).
- **Rich content** arrives as `ui.render` `{ component, props, slot? }`; without `slot` it becomes part of the message and is stored. The widget draws it with `renderers: { name: (props) => HTMLElement }` (`gallery` built in; `mcp-app` with `mcp-apps`). Treat props as untrusted.

## AG-UI

```ts
import { agui } from '@handsforbots/transport-agui'
agui({ url: '/api/agent', headers: async () => ({ Authorization: `Bearer ${await token()}` }) })
// or any AG-UI agent object: agui({ agent: new HttpAgent({ url }) })  // HttpAgent from @ag-ui/client
```

Backend side (`RunAgentInput`): `messages` (with tool calls and `tool` results), `tools` (the H4B actions), `context` (one entry per context signal, `{ description, value }`), `state`. Emit standard AG-UI events: `TEXT_MESSAGE_*` for text, `TOOL_CALL_START/ARGS/END` for actions the page runs, `STATE_SNAPSHOT/DELTA` for shared state. H4B-specific events are `CUSTOM`:

| `name` | `value` | Becomes |
|---|---|---|
| `h4b.ui.effect` | `{ name, value }` | `ui.effect` |
| `h4b.ui.render` | `{ component, props, slot? }` | `ui.render` |
| `h4b.sources` | `{ messageId?, sources: [...] }` | sources of the message |
| `h4b.citations` | `{ messageId?, citations }` | citations into its text |

Sources are not sent back in the history.

## Your own HTTP endpoint

`http({ url })` POSTs, by default:

```json
{ "thread_id": "…", "session_id": "…", "turn_id": "…", "message": "last user text",
  "messages": [/* chat format: role, content, tool_calls, tool messages */],
  "context": { "orders.view": [{ "filter": "late" }] },
  "tools": [{ "type": "function", "function": { "name": "filter_orders", "description": "…", "parameters": { } } }],
  "state": { } }
```

It accepts, as JSON: a string; `{ response | content | text | message | output }`; an array of such messages (with `image`, `buttons` / `quick_replies`); `{ messages: [...] }`; a chat completion (`choices[0].message` with `tool_calls`); `tool_calls` on any message (OpenAI shape); `state` (shared state snapshot); `sources` and `citations`; `{ error }`. A `text/event-stream` response is streamed: OpenAI-style deltas (fragmented tool calls included) or `{ delta | content | response | text }` per event. Anything else: write `body(request, session)` and `parse(json)` / `parseChunk(data)` returning stimuli (that is also how an HTTP backend sends `ui.effect` or `ui.render`). `session: { url, method?, extract }` opens one backend session per thread. `sendToolResults: false` stops the follow-up call after client actions.

## Vercel AI SDK

```ts
// page
import { aiSdk } from '@handsforbots/transport-ai-sdk'
aiSdk({ url: '/api/chat' })

// route (Next.js app router)
export async function POST(req: Request) {
  const { messages, tools, context } = await req.json()
  return streamText({
    model,
    system: `Screen: ${JSON.stringify(context)}`,
    messages: await convertToModelMessages(messages),
    tools: Object.fromEntries(tools.map((t) => [t.name, tool({ description: t.description, inputSchema: jsonSchema(t.parameters) })])),
  }).toUIMessageStreamResponse()
}
```

Declare the tools **without `execute`** so the page runs them. Data parts `data-ui-effect`, `data-ui-render` and `data-state` become effects, rich content and shared state; `source-url` / `source-document` become sources; `data-citations` (`{ citations }`) becomes citations.

## Rasa

`rasa({ url: 'http://localhost:5005/webhooks/rest/webhook' })`. The thread id is the Rasa sender; context signals go as `metadata.h4b_context`; no history is sent (Rasa keeps its tracker) and actions are not tools. Text, images and buttons become bubbles and quick replies. The bot drives the page with `custom.h4b`:

```yaml
responses:
  utter_show_save:
  - text: Here it is!
    custom:
      h4b:
        action: { name: guided_highlight, args: { target: '#save_button', text: 'Save here' } }
        # effect: { name: scroll, value: '#top' }
        # render: { component: gallery, props: { images: [...] } }
```

`reportActionResults: (results) => '/action_done{…}'` sends the results back as a message; by default they are not reported.

## CopilotKit

For apps where CopilotKit owns the chat UI and the agent connection. Needs `@handsforbots/react` and `@copilotkit/react-core` 1.77+.

```tsx
import { CopilotKitBridge } from '@handsforbots/copilotkit'

<CopilotKitProvider /* your CopilotKit config */>
  <H4BProvider value={h4b}>
    <CopilotKitBridge />
    <App />
  </H4BProvider>
</CopilotKitProvider>
```

- H4B actions exposed to `assistant` become CopilotKit frontend tools (validation, interceptors and confirmation still apply); the list follows registrations, so `useAction` in components works.
- Context signals become agent context (`contextDescription` to word it).
- By default the CopilotKit agent becomes H4B's transport: voice, menu fallbacks and sensors reach it and its answers can be spoken. Don't add another transport plugin. `transport: false` when H4B has its own.
- Direct commands and browser-agent actions are mirrored into the agent's history.

## assistant-ui

assistant-ui draws the thread and composer; H4B does the rest, over any transport. Needs `@handsforbots/react` and `@assistant-ui/react` 0.15+.

```tsx
import { useH4BAssistantRuntime } from '@handsforbots/assistant-ui'

function Chat() {
  const runtime = useH4BAssistantRuntime() // inside <H4BProvider>
  return <AssistantRuntimeProvider runtime={runtime}><Thread /></AssistantRuntimeProvider>
}
```

Tool calls show with their results; rich content arrives as `data-h4b-ui` parts; cancel calls `h4b.abort()`.

## Browser agents (WebMCP)

`webmcp({ include?: 'explicit', prefix?, modelContext? })` from `@handsforbots/expose-webmcp` publishes actions through `document.modelContext` (Chrome origin trial; elsewhere `getState().supported` is false and nothing happens). Only actions whose `exposeTo` includes `'agent'` by default, so mark them on purpose and keep destructive ones behind a `confirm` service. Calls run with origin `agent`: same validation and confirmation, recorded in history with route `agent`. `prefix: 'shop.'` avoids clashes with other scripts.

## MCP Apps

Your backend, acting as MCP client, gets a `ui://` resource (`text/html;profile=mcp-app`) with a tool result and sends it as `ui.render` with component `mcp-app` and props `{ html, toolName?, input?, result?, csp?, title? }` (AG-UI: `CUSTOM h4b.ui.render`).

```ts
import { mcpAppRenderer, mountMcpApp } from '@handsforbots/mcp-apps'
widget({ renderers: { 'mcp-app': mcpAppRenderer({ allowTools: ['filter_orders'] }) } })
// own UI: element.append(mountMcpApp(h4b, props, { allowTools: ['filter_orders'] }))
```

The app runs in a sandboxed iframe (opaque origin) with a restrictive CSP built from `csp` (`connectDomains`, `resourceDomains`, `frameDomains`). `tools/call` from the app runs only the H4B actions in `allowTools` (none by default), with origin `agent`, recorded in history. `ui/message` adds a user message (`allowMessages: false` blocks it); `ui/open-link` opens http(s) only; `ui/update-model-context` becomes a context signal.

## Checklist

- [ ] One transport (or the CopilotKit bridge), chosen by what the backend speaks; keys on the server.
- [ ] The backend gives each tool call a unique id and treats tool results arriving in the history as the outcome.
- [ ] The backend reads the screen from the context signals, not from fake user messages.
- [ ] Every `ui.effect` name the backend sends has a handler on the page; every `ui.render` component has a renderer.
- [ ] Actions for browser agents and MCP Apps are allowed explicitly (`exposeTo: [..., 'agent']`, `allowTools`).
- [ ] Tested with `@handsforbots/testkit` (`scriptedTransport`, or `transportConformance` for a new transport).
