# Explicit conversation state

A small, reliable record of the conversation next to the raw history: the active topic, the user's goal, the current depth, the entities (with versions and dates), the decisions, the facts already stated with their sources, and what is still pending. With it, the backend can pick up "the Terraform of that project" without searching the whole history or mixing it up with another project.

It is not a summary. A summary that invents a fact repeats that fact in every request from then on. So this state is built from **atomic claims with a source, a date, a scope and a confidence**, and it changes only through operations the page checks first. Decision and research: [ADR 0019](../adr/0019-estado-explicito-da-conversa.md), [references](./references.md#explicit-conversation-state).

## The three memory layers

| Layer | What | In H4B |
|---|---|---|
| (a) Recent raw messages | The last turns, verbatim | `memory` sends the last 20 turns ([Persistence, memory and privacy](./persistence.md)) |
| (b) Factual state | Atomic claims with source, date, scope and confidence, rewritten with care | **`conversation-state`** (this page) |
| (c) Episodic memory | Earlier conversations and documents, retrieved on demand | Your backend. The state gives it anchors: `scope`, entity ids, message ids |

The `memory.summary` of turns that left the window is still sent. It is a rough recap. The state is what the backend can rely on.

## Setup

```ts
import { createH4B } from '@handsforbots/core'
import { conversationState } from '@handsforbots/conversation-state'

const h4b = createH4B({
  plugins: [conversationState()], // default sections, updates come with the reply
})
```

Every request now carries the context signal `conversation.state`, in a field of its own, apart from the messages:

- HTTP transport: `context['conversation.state']`
- AG-UI: a `context` entry whose value starts with `conversation.state: `
- other transports: a context signal with a `data` part named `conversation.state`

```json
{
  "revision": 4,
  "sections": {
    "topic": { "id": "topic", "text": "Terraform state of the Acme project", "origin": "user", "confidence": "high", "src": ["msg_12"] },
    "goal": null,
    "depth": { "id": "depth", "text": "step by step", "origin": "unsourced", "confidence": "low" },
    "entities": [
      { "id": "e1", "text": "Terraform", "scope": "acme", "attrs": { "version": "1.9" }, "origin": "user", "confidence": "high", "src": ["msg_12"], "stated": "2026-11-14T13:02:11.000Z" }
    ],
    "decisions": [],
    "facts": [
      { "id": "f1", "text": "Acme deploys on Thursdays", "scope": "acme", "origin": "user", "confidence": "high", "src": ["msg_15"], "stated": "2026-11-14T13:05:40.000Z" }
    ],
    "pending": []
  },
  "rejected": [{ "index": 0, "reason": "quote-not-found", "op": "add", "section": "facts", "detail": "the quote is not in message msg_14" }]
}
```

`rejected` is sent once, after an update that had problems, so the model can fix them.

## Sections

| Section | Kind | Default rules |
|---|---|---|
| `topic` | value | 160 characters; follows the conversation (`keepUserStated: false`) |
| `goal` | value | 240 characters |
| `depth` | value | 60 characters; follows the conversation |
| `entities` | list | 20 items, 120 characters; versions and dates as `attrs` |
| `decisions` | list | 15 items, 240 characters; needs a message id (`evidence: 'message'`) |
| `facts` | list | 25 items, 240 characters; needs a message id **and a verbatim quote** (`evidence: 'quote'`) |
| `pending` | list | 15 items, 200 characters |

Change them or add your own:

```ts
import { conversationState, DEFAULT_SECTIONS } from '@handsforbots/conversation-state'

conversationState({
  sections: {
    ...DEFAULT_SECTIONS,
    depth: { kind: 'value', description: 'How deep we are.', values: ['overview', 'step-by-step', 'expert'] },
    environments: { kind: 'list', description: 'Environments mentioned (dev, staging, prod), per project.', max: 10, maxChars: 80 },
  },
})
```

## Items

Each item is one claim:

| Field | |
|---|---|
| `id` | Stable within the section (`f1`, or the backend's own) |
| `text` | The claim. Longer than `maxChars` is **rejected, never cut** |
| `attrs` | Up to 8 short attributes: `version`, `date`, `project`… (strings, numbers, booleans) |
| `scope` | What it belongs to (a project, product, account). The same text in two scopes is two items |
| `origin` | Worked out from the evidence, never taken from the model's word: `user`, `tool`, `assistant`, `app` (the page) or `unsourced` |
| `confidence` | `high`, `medium`, `low`: what the writer asked, **capped by the origin**. The user, a tool or the page go up to `high`, the assistant's own message to `medium`, and no evidence means `low` |
| `evidence` | Messages that support it (`messageId`, `quote`, `role`, `at`). The backend sees the ids as `src` and the newest date as `stated` |
| `locked` | Set by the page; the backend can't change it |
| `rev`, `since`, `by`, `turnId`, `at` | Last change, creation, writer, turn and time |

## Updating

The backend never sends a whole new state, only **operations**:

```json
{
  "base": 4,
  "ops": [
    { "op": "set", "section": "topic", "text": "Acme deploy schedule", "evidence": [{ "messageId": "msg_15" }] },
    { "op": "add", "section": "facts", "text": "Acme deploys on Thursdays", "scope": "acme",
      "evidence": [{ "messageId": "msg_15", "quote": "the deploy moved to Thursdays" }] },
    { "op": "update", "section": "entities", "id": "e1", "attrs": { "version": "1.10" }, "evidence": [{ "messageId": "msg_16" }] },
    { "op": "remove", "section": "pending", "id": "p2", "reason": "answered in msg_15" }
  ]
}
```

`set` is for value sections, `add`/`update` for lists, and `remove` works on both (`id` for lists) and always needs a `reason`. In `update`, `attrs` are merged (`null` removes one) and `scope: null` removes the scope. `base` is the revision the backend read.

Where updates come from (`updates`):

- **`'response'`** (default). With the reply, in either of two ways:
  - a `ui.effect` named `conversation.state` whose `value` is the update. It is applied when the turn ends, so quotes from the whole reply can be checked. In AG-UI it is the CUSTOM event `h4b.ui.effect`;
  - the action `update_conversation_state`, for backends that only use tool calling. Its JSON Schema comes from the sections, `confirm: 'never'`, and it is exposed to `assistant` and `agent`. It returns `{ revision, applied, rejected }` right away. `action: false` turns it off.
- **A `StateUpdater`**: a channel of its own, called after each finished turn with the state and that turn's messages. It runs outside the kernel's queue. The next request waits for it for up to `wait` ms (2000), then goes with the state it has. A new conversation aborts it. Without `base`, the revision it was given is used.

  ```ts
  import { conversationState, httpStateUpdater } from '@handsforbots/conversation-state'

  conversationState({ updates: httpStateUpdater({ url: '/api/h4b/state' }) })
  // POST { state, messages, threadId, turnId } → 200 { base?, ops } or 204
  ```

- **`'manual'`**: only `h4b.get('conversationState').update(...)`, for example from a WebSocket of your app.

The page writes as `by: 'app'` (the default of `update()`). It needs no evidence, may lock items (`locked: true`) and may change locked ones and what the user stated.

## Protections

Each operation is checked on its own. A bad one is rejected with a reason and the others go through. Two checks look at the result and reject the whole update.

| Reason | When |
|---|---|
| `invalid`, `unknown-section`, `unknown-item`, `not-allowed-value` | Wrong shape, section, id or value outside `values` |
| `too-long` | Text over `maxChars` (never cut) |
| `evidence-required` | The section needs a message id (or a quote) and the backend sent none |
| `evidence-not-found` | The message id is not in this conversation |
| `quote-not-found` | The quote is not in that message (ignoring case, curly quotes and spacing). **This is the check against invented facts** |
| `user-stated` | Changing or removing what the user stated without evidence from a user message (`keepUserStated`) |
| `locked` | The page locked the item |
| `stale` | The item changed after `base` |
| `duplicate` | Same text in the same scope (or no change) |
| `section-full` | Over the section's `max`; remove or merge first, in the same update if you like |
| `reason-required` | `remove` without a reason |
| `screened` | Your `screen` refused it |
| `too-many-removals` | **Whole update**: more removals than `maxRemovals` (3), which is what a model that "forgot" half the state looks like |
| `over-budget` | **Whole update**: all items over `maxChars` (4000); `detail` says how much to free. Nothing is compacted on its own |

Also:

- Text is cleaned before it is stored: control, zero-width and bidi characters and Unicode tags are removed, and whitespace collapses. Then your `screen(text, { section, by })` can rewrite it (redact personal data, for example with `redact` from `@handsforbots/consent`) or return `false`. Cleaning happens before storing, not after.
- Within a conversation, the revision only goes forward. A restore with an older revision (another tab, a late save) is undone and emits `error` (`source: 'conversation-state'`).
- The journal (last `journal`, 50, entries) keeps every change with the item before and after, and every rejection. It is saved with the conversation. `revert(revision, reason)` undoes changes from the journal and records a new revision.

A verified quote proves the text was said, not that it is true: a user can state something false. `origin` says who stated it.

## Options

| Option | Default | |
|---|---|---|
| `sections` | `DEFAULT_SECTIONS` | |
| `updates` | `'response'` | `'response'`, `'manual'` or a `StateUpdater` |
| `action` | `true` | Registers `update_conversation_state` (only with `'response'`) |
| `persist` | `true` | Saves with the conversation (`SessionSnapshot.conversationState`); the storages keep it (encrypted with `storage-local`). `false`: this tab only |
| `send` | `true` | Sends `conversation.state` with every request. `false` if your backend keeps the state itself |
| `maxChars` | `4000` | All items' text, scope and attrs |
| `maxRemovals` | `3` | Per backend update |
| `journal` | `50` | Entries kept |
| `screen` | — | `(text, { section, by }) => string \| false` |
| `wait` | `2000` | ms a request waits for a running updater |

## In the page

```ts
const state = h4b.get('conversationState')!
state.getState() // { revision, items, size, pending, rejected }; same object until it changes
state.subscribe(() => render(state.getState()))
state.update({ ops: [{ op: 'set', section: 'goal', text: 'Migrate Acme to OpenTofu', locked: true }] })
state.history() // journal
state.revert(3, 'the model got lost')
```

`getState`/`subscribe` work with `useStore` from `@handsforbots/react` and `@handsforbots/vue`. Event `conversation.state` `{ revision, reason: 'update' | 'revert' | 'restored' | 'reset', by?, applied, rejected }`.

## In the backend

`@handsforbots/conversation-state/server` runs without the browser or the core:

```ts
import { conversationStatePrompt, readConversationState, stateItems, stateUpdateSchema } from '@handsforbots/conversation-state/server'

const state = readConversationState(body.context) // AG-UI context, HTTP context object, signals or the value
const acme = stateItems(state, { scope: 'acme' }) // only that project's items
const system = `${conversationStatePrompt()}\n\nCurrent state:\n${JSON.stringify(state)}`
// structured output for a separate updater: stateUpdateSchema()
```

`readConversationState` never throws, drops malformed items and returns `undefined` when there is no state. It keeps at most `maxSections` (64) sections, skips names such as `__proto__`, and rebuilds each rejection from its known fields (`detail` cut at 500 characters). The state comes from the browser and anyone using the page can edit it: use it as context, never as authorization.
