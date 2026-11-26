# 0021 — Legendas independentes da voz: cadência de leitura, apresentador compartilhado e modo texto

**Contexto.** O ADR [0020](./0020-legendas-palavra-por-palavra.md) criou `@handsforbots/captions` como um leitor fino de `voice.word`, com dependência obrigatória em `@handsforbots/voice` e com o desenho preso dentro do `@handsforbots/widget` (uma única faixa `.captions` global, sempre `aria-hidden`).

Na prática, o mesmo efeito palavra por palavra serve muito bem **sem voz** — por exemplo, no lugar de um balão de fala de um personagem, em respostas em modo texto, ou para suavizar a chegada irregular de tokens em streaming. E quem constrói a própria interface precisa poder combinar:
- só a cadência headless (`createCadence`) com o seu próprio componente;
- ou um componente de apresentação pronto (`renderCaption` / `<h4b-caption>`) ligado à cadência ou ao plugin `captions` (com ou sem voz).

A revisão do desenho do ADR 0020 também mostrou lacunas: `scope: 'message'` chamava `voice.wordsOf` (não funcionava sem voz) e não anexava deltas que chegassem durante o primeiro trecho; após um corte, palavras não ditas ficavam `upcoming` para sempre; `ended: 'done'` saía por frase sem indicar se a resposta inteira terminou; e uma única `.captions` `aria-hidden` não atendia balões por mensagem nem leitores de tela sem histórico.

**Decisão.**

- **Tokenização única no core.** `splitWords` e `WordSpan` passam para `@handsforbots/core` (utilidade pura de texto e offsets UTF-16); `@handsforbots/voice` os reexporta. Tipos de temporização (`WordTiming`, `WordQuality`, `WordSource`) ficam em `voice` e `captions`, sem poluir o core. `@handsforbots/voice` passa a ser peer **opcional** (`peerDependenciesMeta.optional: true`) de `@handsforbots/captions`.
- **Cadência headless (`@handsforbots/captions/cadence`).** `createCadence(options)` gera um `CaptionStore` (`getState`, `subscribe`, `progress`) sobre texto puro ou streaming (`setText`, `append`, `finish`, `pause`, `resume`, `skip`, `cut`, `reset`, `shown`, `dispose`), com ritmo de leitura configurável (`wordsPerMinute`, `minWordMs`, pausas de pontuação, `catchUp` para streaming rápido, ou função por palavra), relógio/agendador injetáveis e política `reducedMotion` (`'auto' | 'instant' | 'words'`). Durante `append`, a última palavra aberta (sem espaço no fim) é retida até chegar espaço ou `finish()`.
- **Apresentação compartilhada (`@handsforbots/captions/element`).** `renderCaption(container, store, { mode, aria, animateProgress })` e o custom element `<h4b-caption>` desenham qualquer `CaptionStore` reutilizando nós `.word` em streaming, sem `innerHTML`. Dois modos visuais (`mode: 'karaoke' | 'reveal'`, onde `reveal` oculta `upcoming` com `visibility: hidden` para não causar pulo de layout e esconde `skipped`) e dois papéis de acessibilidade (`aria: 'mirror' | 'standalone'`, onde `standalone` anuncia o texto completo uma vez em região `aria-live="polite"` ao terminar, omitindo `skipped`). O `@handsforbots/widget` passa a usar `renderCaption` (e aceita `captions: boolean | { mode }`).
- **Plugin `captions` com modo texto, `forMessage` e correções.**
  - `follow: 'auto' | 'voice' | 'text'` (padrão `'auto'`): segue `voice.word` quando `voice` fala a resposta (`voice.track` / `willSpeakReplies`), e cai para cadência de texto quando `voice` não está instalado ou não vai falar a resposta.
  - `forMessage(messageId)`: devolve um `CaptionStore` estável por resposta (hidratando mensagens já concluídas no histórico), para balões por mensagem.
  - `cutOnInterrupt` (padrão `true`): no modo texto, intercepta `interrupt.before` para cortar a mensagem no que já apareceu (`cadence.shown()`), alinhado ao comportamento da voz.
  - Estado `skipped` para palavras após um corte (voz ou texto), `replyEnded: true` quando a resposta inteira termina (não só um trecho), `driver: 'voice' | 'text'`, e atualização em tempo real de `scope: 'message'` em `message.delta`.
- **React e Vue.** `useCaption(store)` em `@handsforbots/react` e `@handsforbots/vue` aceita qualquer `CaptionStore` pelo formato (`getState`, `subscribe`, `progress`) e atualiza `progress` a cada quadro enquanto `status === 'speaking'`.

**Consequências.**

- `@handsforbots/captions` funciona sozinho (com `@handsforbots/core`) ou integrado ao `@handsforbots/voice`, sem duplicar o renderizador entre widget e apps próprios.
- Substitui a restrição "precisa do `voice`" do ADR [0020](./0020-legendas-palavra-por-palavra.md); todo o contrato de tempos de fala do `voice` (cenários 1–4, `alignWords`, WebVTT, `whisperAligner`) permanece inalterado.
