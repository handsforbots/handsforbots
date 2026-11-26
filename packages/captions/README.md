# @handsforbots/captions

Plugin. Word-by-word captions and reading cadence for Hands for Bots: follows voice timings or drives text on its own, with a ready-made renderer and custom element.

Part of [Hands for Bots](https://github.com/handsforbots/handsforbots), a headless multimodal and action layer between users, GUIs and agents.

## Install

```bash
npm install @handsforbots/captions@alpha @handsforbots/core@alpha
```

Add `@handsforbots/voice@alpha` when you also want voice-synced timings.

## Subpaths

- `@handsforbots/captions` — the `captions()` plugin (`follow: 'auto' | 'voice' | 'text'`, `forMessage(id)`, `skip()`) and all re-exports.
- `@handsforbots/captions/cadence` — headless `createCadence()` reading cadence (standalone or streamed text).
- `@handsforbots/captions/element` — `renderCaption()` and `<h4b-caption>` (`mode: 'karaoke' | 'reveal'`, `aria: 'mirror' | 'standalone'`).

## Documentation

- [This package](https://github.com/handsforbots/handsforbots/blob/main/docs/en-us/plugins.md#captions)
- [Word-by-word captions guide](https://github.com/handsforbots/handsforbots/blob/main/docs/en-us/speech.md#word-by-word-captions)
- [Getting started](https://github.com/handsforbots/handsforbots/blob/main/docs/en-us/getting-started.md)
- [Documentação em português](https://github.com/handsforbots/handsforbots/blob/main/docs/pt-br/README.md)

## License

MIT
