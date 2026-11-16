# @handsforbots/core

⭐ Start here. Hands for Bots kernel: users, the GUI and agents act on the same page through one action layer. Install this first, then one transport.

Part of [Hands for Bots](https://github.com/handsforbots/handsforbots), a headless multimodal and action layer between users, GUIs and agents.

## Install

```bash
npm install @handsforbots/core@alpha
```

## What to add

| Step | Pick | Packages |
|---|---|---|
| 1 | This kernel | `@handsforbots/core` |
| 2 | **One** transport, by what your backend speaks | [`transport-agui`](https://www.npmjs.com/package/@handsforbots/transport-agui) · [`transport-http`](https://www.npmjs.com/package/@handsforbots/transport-http) · [`transport-ai-sdk`](https://www.npmjs.com/package/@handsforbots/transport-ai-sdk) · [`transport-rasa`](https://www.npmjs.com/package/@handsforbots/transport-rasa) |
| 3 | A UI, unless you draw your own | [`widget`](https://www.npmjs.com/package/@handsforbots/widget) · [`react`](https://www.npmjs.com/package/@handsforbots/react) · [`vue`](https://www.npmjs.com/package/@handsforbots/vue) · [`copilotkit`](https://www.npmjs.com/package/@handsforbots/copilotkit) · [`assistant-ui`](https://www.npmjs.com/package/@handsforbots/assistant-ui) |
| 4 | Only what you need | Plugins: [`voice`](https://www.npmjs.com/package/@handsforbots/voice), [`menu`](https://www.npmjs.com/package/@handsforbots/menu), [`guided`](https://www.npmjs.com/package/@handsforbots/guided), [`keyboard`](https://www.npmjs.com/package/@handsforbots/keyboard), [`inputs`](https://www.npmjs.com/package/@handsforbots/inputs), storage, consent and more |

Every package's description starts with its role: **Transport**, **UI**, **Plugin**, **Add-on** (extends another package), **Standalone** (works without H4B) or **Dev**. Search npm for `keywords:h4b-plugin` (or `h4b-transport`, `h4b-ui`) to list one kind. The [package catalog](https://github.com/handsforbots/handsforbots/blob/main/docs/en-us/packages.md) says what each one does and needs.

## Documentation

- [This package](https://github.com/handsforbots/handsforbots/blob/main/docs/en-us/plugins.md#core)
- [Getting started](https://github.com/handsforbots/handsforbots/blob/main/docs/en-us/getting-started.md)
- [Documentação em português](https://github.com/handsforbots/handsforbots/blob/main/docs/pt-br/README.md)

## License

MIT
