# Pacotes

O Hands for Bots é dividido em pacotes pequenos para você instalar só o que a sua interface usa. Esta página diz o que cada um faz, do que precisa e com o que funciona. As opções de cada pacote estão em [Plugins](./plugins.md).

> **Sobre as ideias desta página.** Cada pacote traz algumas ideias do que as capacidades dele facilitam. Elas servem para puxar as suas, não para marcar limites: os pacotes descrevem o que *fazem* (mandar um turno para um backend, rodar um comando sem o LLM, apontar um elemento na tela), e qualquer problema que precise disso serve, seja qual for o produto.

## Como as peças se encaixam

- **`@handsforbots/core`** está sempre presente. Ele guarda a conversa, as ações que a sua interface expõe, a fila de turnos e o sistema de plugins. Não tem interface.
- **Um transporte** liga o core ao seu backend ou agente: AG-UI, Rasa, sua própria API HTTP, uma API compatível com OpenAI, o Vercel AI SDK ou o CopilotKit. Turno sem transporte falha; comandos diretos continuam funcionando.
- **Uma interface, se você quiser**: a janela pronta `<h4b-chat>`, seus próprios componentes com os bindings de React ou Vue, ou uma biblioteca de chat que você já usa (CopilotKit, assistant-ui).
- **Capacidades** que você soma uma a uma: voz, comandos diretos, atalhos de teclado, câmera e arquivos, tours guiados, agentes do navegador, MCP Apps, deixas.
- **Infraestrutura** que muda o que é guardado e enviado: memória (ligada por padrão), estado explícito da conversa, armazenamento no navegador ou no servidor, sincronia entre abas, consentimento, observabilidade, ajudantes de teste.

Os plugins não importam uns aos outros em tempo de execução: eles encontram os serviços uns dos outros quando os dois estão instalados. O widget, por exemplo, só mostra o microfone quando o `voice` está montado. Por isso, pôr ou tirar um pacote nunca quebra os outros.

## Instalação

```bash
npm install @handsforbots/core@alpha @handsforbots/transport-http@alpha @handsforbots/widget@alpha
```

- Os pacotes do H4B têm uma versão só e saem com a tag `alpha` enquanto a v2 está em alpha: acrescente `@alpha` (ou fixe `2.0.0-alpha.2`).
- A maioria dos pacotes declara `@handsforbots/core` como dependência par (peer): instale-o você, uma vez. A linha de instalação de cada pacote abaixo já inclui os pacotes `@handsforbots` de que ele precisa.
- Módulos ES com tipos TypeScript incluídos. Rodam no navegador; as entradas `/server` (`cues`, `conversation-state`, `observability`) e o `voice-effects` rodam no Node também.
- Os esquemas das ações aceitam qualquer biblioteca [Standard Schema](https://standardschema.dev) (Zod, Valibot, ArkType) ou JSON Schema puro. Nenhuma é obrigatória.

## Escolha pelo que você precisa

| Quero… | Pacote |
|---|---|
| Falar com o meu agente ou backend | um transporte: [`transport-agui`](#handsforbotstransport-agui), [`transport-http`](#handsforbotstransport-http), [`transport-ai-sdk`](#handsforbotstransport-ai-sdk), [`transport-rasa`](#handsforbotstransport-rasa) ou [`copilotkit`](#handsforbotscopilotkit) |
| Uma janela de conversa sem construir uma | [`widget`](#handsforbotswidget) |
| Minha própria interface em React ou Vue | [`react`](#handsforbotsreact), [`vue`](#handsforbotsvue) |
| Manter a biblioteca de chat que já uso | [`copilotkit`](#handsforbotscopilotkit), [`assistant-ui`](#handsforbotsassistant-ui) |
| Que as pessoas falem e ouçam as respostas | [`voice`](#handsforbotsvoice), mais [`voice-models`](#handsforbotsvoice-models) e [`voice-effects`](#handsforbotsvoice-effects) para a voz do bot |
| Rodar comandos conhecidos na hora, sem o LLM | [`menu`](#handsforbotsmenu) |
| Atalhos para falar, parar e abrir uma paleta de comandos | [`keyboard`](#handsforbotskeyboard) |
| Fotos, arquivos, o que está na tela, lembretes por inatividade, sensores | [`inputs`](#handsforbotsinputs) |
| Apontar coisas na página, tours passo a passo | [`guided`](#handsforbotsguided) |
| Deixar agentes do navegador usarem minhas ações | [`expose-webmcp`](#handsforbotsexpose-webmcp) |
| Mostrar apps interativos enviados por um servidor MCP | [`mcp-apps`](#handsforbotsmcp-apps) |
| Fazer a página reagir à conversa (humor, cenário, urgência) | [`cues`](#handsforbotscues) |
| Manter certos os fatos e as decisões de uma conversa longa | [`conversation-state`](#handsforbotsconversation-state) |
| Controlar quanto histórico é enviado e guardado | [`memory`](#handsforbotsmemory) |
| Sobreviver a recarregar a página | [`storage-local`](#handsforbotsstorage-local) ou [`storage-backend`](#handsforbotsstorage-backend) |
| Várias abas abertas ao mesmo tempo | [`tab-sync`](#handsforbotstab-sync) |
| Seguir um banner de consentimento, LGPD, GDPR, CCPA | [`consent`](#handsforbotsconsent) |
| Ver latência, erros e uso no Grafana, Langfuse ou LangSmith | [`observability`](#handsforbotsobservability) |
| Testar meu plugin, transporte ou integração | [`testkit`](#handsforbotstestkit) |

## Kernel

### `@handsforbots/core`

O runtime headless. Entradas viram sinais, sinais viram turnos, o backend responde com estímulos (mensagens, chamadas de ação, efeitos na interface, estado compartilhado). Sua interface declara as **ações** uma vez e elas ficam disponíveis para o assistente (tool calls), para a pessoa (comandos diretos) e para agentes do navegador, com as mesmas regras de validação, confirmação e origem. Também tem interceptadores, consentimento, fontes e citações e atributos da conversa para experimentos.

- **Precisa de:** nada. O `@handsforbots/memory` vem junto e é montado por padrão.
- **Instalação:**

  ```bash
  npm install @handsforbots/core@alpha
  ```

- **Funciona com:** todo o resto; é o único pacote presente em toda configuração.
- **Por exemplo:** um assistente que filtra uma tabela e abre registros chamando suas ações; botões que rodam as mesmas ações e aparecem na conversa; um backend que avisa "seu relatório está pronto" na conversa fora de um turno.
- Guias: [Primeiros passos](./getting-started.md), [Conceitos](./concepts.md).

## Transportes

Instale um. Todos enviam o histórico, os sinais de contexto da tela e as suas ações como ferramentas (menos o Rasa, veja abaixo), e transformam o que o backend responde em mensagens, chamadas de ação e efeitos na interface.

### `@handsforbots/transport-agui`

Fala [AG-UI](https://docs.ag-ui.com), o protocolo de eventos que muitos frameworks de agentes já servem (runtime do CopilotKit, LangGraph, Mastra, PydanticAI…). HTTP POST + SSE para uma URL, ou qualquer objeto de agente AG-UI.

- **Precisa de:** `@handsforbots/core`. O `@ag-ui/core` vem junto; o `@ag-ui/client` só se você passar seu próprio `HttpAgent`.
- **Instalação:**

  ```bash
  npm install @handsforbots/transport-agui@alpha @handsforbots/core@alpha
  ```

- **Funciona com:** um framework de agentes que sirva AG-UI; o `copilotkit` o usa por dentro.
- **Por exemplo:** um agente LangGraph que conduz um painel; um agente no próprio processo para testes ou demonstrações.

### `@handsforbots/transport-http`

Três plugins para backends HTTP: `http` (sua própria API de turnos: sessões, respostas em texto ou JSON, streaming SSE, tool calls, ganchos `parse` e `body`), `universalLLM` (o formato do proxy UniversalLLM da v1) e `openAICompatible` (`/chat/completions` com ferramentas nativas).

- **Precisa de:** `@handsforbots/core`.
- **Instalação:**

  ```bash
  npm install @handsforbots/transport-http@alpha @handsforbots/core@alpha
  ```

- **Funciona com:** qualquer servidor que você escreva; servidores compatíveis com OpenAI (OpenAI, Ollama, vLLM, LiteLLM). As chaves ficam no servidor: `openAICompatible` com chave no navegador é só para desenvolvimento local.
- **Por exemplo:** um endpoint pequeno na frente do seu provedor de LLM; a API de um chatbot que já existe; um modelo local pelo Ollama durante o desenvolvimento.

### `@handsforbots/transport-ai-sdk`

Conversa com uma rota do [Vercel AI SDK](https://ai-sdk.dev) que devolve `streamText(...).toUIMessageStreamResponse()`: a mesma requisição do `DefaultChatTransport`, mais as suas ações como ferramentas e o contexto da tela.

- **Precisa de:** `@handsforbots/core`; o AI SDK roda no seu servidor.
- **Instalação:**

  ```bash
  npm install @handsforbots/transport-ai-sdk@alpha @handsforbots/core@alpha
  ```

- **Funciona com:** Next.js, SvelteKit, Nuxt ou qualquer servidor onde o AI SDK rode.
- **Por exemplo:** acrescentar ações na interface e voz a um app que já tem uma rota de chat com o AI SDK.

### `@handsforbots/transport-rasa`

O canal REST do Rasa. Texto, imagens e botões viram balões e respostas rápidas; `custom.h4b` numa resposta roda uma ação, um efeito ou conteúdo rico na página.

- **Precisa de:** `@handsforbots/core`, um servidor Rasa.
- **Instalação:**

  ```bash
  npm install @handsforbots/transport-rasa@alpha @handsforbots/core@alpha
  ```

- **Funciona com:** assistentes Rasa que já existem. O Rasa guarda o próprio tracker, então o histórico não é enviado e as ações não são oferecidas como ferramentas: o bot conduz a interface pelo `custom.h4b`.
- **Por exemplo:** dar voz, um widget e controle da página a um bot Rasa sem reescrevê-lo.

## Interfaces

### `@handsforbots/widget`

`<h4b-chat>`, uma janela de conversa pronta como Web Component (shadow DOM): flutuante, lateral ou embutida; Markdown seguro, imagens, respostas rápidas, cartões de ação, fontes e citações, saudações com variantes A/B, painel de privacidade. Mostra os botões de microfone, anexo e câmera quando esses pacotes estão instalados. Estilize com variáveis CSS ou `::part()`.

- **Precisa de:** `@handsforbots/core`.
- **Instalação:**

  ```bash
  npm install @handsforbots/widget@alpha @handsforbots/core@alpha
  ```

- **Funciona com:** qualquer página ou framework (HTML puro, React, Vue, Svelte…); `voice`, `inputs`, `menu`, `cues`, `guided`, `mcp-apps` para controles e conteúdos mais ricos.
- **Por exemplo:** um assistente de ajuda num site com um script; um copiloto lateral numa ferramenta interna; um totem com a janela sempre aberta.

### `@handsforbots/react`

Bindings para React: `<H4BProvider>`, hooks para mensagens, o turno em andamento, estado compartilhado e serviços, `useAction` (uma ação registrada enquanto um componente está montado) e `useContextSignal` (o que o componente mostra, enviado como contexto).

- **Precisa de:** `@handsforbots/core`, `react` 18+. Traz o `@handsforbots/widget` junto.
- **Instalação:**

  ```bash
  npm install @handsforbots/react@alpha @handsforbots/core@alpha
  ```

- **Funciona com:** seus próprios componentes, ou o widget dentro de um app React; `copilotkit` e `assistant-ui` são construídos sobre ele.
- **Por exemplo:** um painel de conversa feito no seu design system; uma página cujos componentes registram as ações que sabem fazer.

### `@handsforbots/vue`

O mesmo para Vue 3.3+: plugin `h4bVue`, composables que devolvem refs somente leitura, `useAction`, `useContextSignal`, `useService`, `v-text-focus`.

- **Precisa de:** `@handsforbots/core`, `vue` 3.3+. Traz o `@handsforbots/widget` junto.
- **Instalação:**

  ```bash
  npm install @handsforbots/vue@alpha @handsforbots/core@alpha
  ```

- **Funciona com:** apps Vue e Nuxt, seus componentes ou o widget.

### `@handsforbots/copilotkit`

Para apps em que o [CopilotKit](https://copilotkit.ai) já cuida do chat e do agente: suas ações do H4B viram ferramentas de frontend do CopilotKit, os sinais de contexto viram contexto do agente e (a menos que `transport: false`) o agente do CopilotKit vira o transporte do H4B, então voz, comandos diretos e sensores chegam a ele.

- **Precisa de:** `@handsforbots/core`, `@handsforbots/react`, `@copilotkit/react-core` 1.77+, `react` 18+.
- **Instalação:**

  ```bash
  npm install @handsforbots/copilotkit@alpha @handsforbots/core@alpha @handsforbots/react@alpha
  ```

- **Funciona com:** `voice`, `menu`, `keyboard`, `expose-webmcp` por cima da interface do CopilotKit.

### `@handsforbots/assistant-ui`

Um runtime do [assistant-ui](https://www.assistant-ui.com) apoiado no H4B: o assistant-ui desenha a conversa e a caixa de texto, o H4B faz o resto (qualquer transporte, ações, voz, menu). Tool calls aparecem com os resultados; cancelar aborta o turno.

- **Precisa de:** `@handsforbots/core`, `@handsforbots/react`, `@assistant-ui/react` 0.15+, `react` 18+.
- **Instalação:**

  ```bash
  npm install @handsforbots/assistant-ui@alpha @handsforbots/core@alpha @handsforbots/react@alpha
  ```

- **Funciona com:** qualquer transporte.

## Entrada e saída

### `@handsforbots/voice`

Fala na entrada e na saída com provedores que você escolhe e encadeia: as APIs de fala do navegador, o seu backend (HTTP ou WebSocket, chaves no servidor), Vosk num servidor ou offline na página. Clicar para falar, segurar para falar, conversa contínua com detecção de fim de turno, interrupção pela fala (barge-in), filtro de eco, respostas faladas frase a frase.

- **Precisa de:** `@handsforbots/core`. `vosk-browser` só para reconhecimento offline na página.
- **Instalação:**

  ```bash
  npm install @handsforbots/voice@alpha @handsforbots/core@alpha
  ```

- **Funciona com:** o widget (botões de microfone e alto-falante), `keyboard` (segurar para falar), `menu` (comandos falados), `voice-models` e `voice-effects` (a voz do bot), `cues` (no tempo da fala).
- **Por exemplo:** uso sem as mãos enquanto se cozinha, se dirige uma empilhadeira ou se segura uma ferramenta; ditar um texto longo; acessibilidade para quem não pode digitar.
- Guias: [Interrupção e conversa por voz](./conversation.md), [Síntese de voz](./speech.md).

### `@handsforbots/voice-models`

Provedores de fala que rodam modelos neurais na página: Piper, Kokoro e qualquer pipeline de texto para fala do transformers.js. Modelos do Hugging Face, de qualquer URL ou de um arquivo local, baixados com progresso, guardados em cache e, se quiser, rodando num Web Worker.

- **Precisa de:** `@handsforbots/core`, `@handsforbots/voice`. O seu app fornece o runtime pesado: `onnxruntime-web` (Piper, Kokoro), um build de fonemizador como o piper-phonemize (espeak-ng, GPL-3.0) ou `@huggingface/transformers`.
- **Instalação:**

  ```bash
  npm install @handsforbots/voice-models@alpha @handsforbots/core@alpha @handsforbots/voice@alpha
  ```

- **Por exemplo:** uma voz melhor que a do navegador sem conta na nuvem; fala que funciona offline; uma voz igual em todos os aparelhos.

### `@handsforbots/voice-effects`

Efeitos para a fala sintetizada escritos em JSON (nomes e unidades do Web Audio): filtros, compressor, reverb, chorus, modulação em anel e outros, presets como `radio`, `robot` ou `telephone`, renderização offline e exportação para SSML e para filtergraphs do FFmpeg.

- **Precisa de:** nada em tempo de execução. O `@handsforbots/voice` é opcional (os tipos dele); cadeias, SSML e exportação para FFmpeg também funcionam fora do H4B, num script de build ou num servidor.
- **Instalação:**

  ```bash
  npm install @handsforbots/voice-effects@alpha
  ```

- **Por exemplo:** um personagem com voz própria num jogo ou numa história; um locutor com cara de rádio; o mesmo efeito renderizado no servidor com FFmpeg.

### `@handsforbots/menu`

Comandos diretos que rodam no aparelho sem o LLM: comandos com barra (`/atrasados`), padrões (`mostrar pedidos {status}`) e frases tolerantes a erros de digitação por idioma, boas para a fala. Negações, perguntas digitadas e empates vão para o LLM; se quiser, o menu pergunta "Você quis dizer…?". Sugestões enquanto a pessoa digita.

- **Precisa de:** `@handsforbots/core`.
- **Instalação:**

  ```bash
  npm install @handsforbots/menu@alpha @handsforbots/core@alpha
  ```

- **Funciona com:** suas ações (cada comando roda uma), o widget (sugestões), `voice` (comandos falados), `keyboard` (paleta).
- **Por exemplo:** respostas instantâneas para os comandos mais usados; uma paleta de comandos; continuar funcionando quando o LLM está lento ou fora do ar.

### `@handsforbots/keyboard`

Atalhos: segurar uma tecla para falar, uma tecla para interromper o bot, uma tecla que abre a sua paleta de comandos.

- **Precisa de:** `@handsforbots/core`. O `@handsforbots/voice` é opcional: o atalho de falar precisa dele; interromper e a paleta funcionam sem ele.
- **Instalação:**

  ```bash
  npm install @handsforbots/keyboard@alpha @handsforbots/core@alpha
  ```

### `@handsforbots/inputs`

Quatro plugins: `camera` (fotos, quadros periódicos como contexto), `files` (escolher ou anexar arquivos; o widget acrescenta colar e arrastar), `gui` (a rota atual como contexto, o texto selecionado se pedido, atributos `data-h4b-say` / `data-h4b-command` / `data-h4b-context` no seu HTML com `declarative: true`, um lembrete depois de um tempo parado) e `sensors` (geolocalização, orientação, rede, só com opt-in).

- **Precisa de:** `@handsforbots/core`.
- **Instalação:**

  ```bash
  npm install @handsforbots/inputs@alpha @handsforbots/core@alpha
  ```

- **Funciona com:** o widget (botões de anexo e câmera), seus próprios botões.
- **Por exemplo:** "explique o parágrafo que selecionei"; a foto de uma peça quebrada; um botão em qualquer lugar da página que pergunta algo ao assistente; um assistente que sabe em que página a pessoa está.

### `@handsforbots/guided`

Tours guiados e destaques que o assistente, a pessoa ou o seu código podem iniciar: um passo aponta um elemento (também dentro de shadow roots) ou mostra um cartão centralizado. "Próximo", "voltar" e "pular", digitados ou falados, navegam por ele. Ações opcionais para rolar até seções da página e mostrar as imagens da página na conversa.

- **Precisa de:** `@handsforbots/core`. O `@handsforbots/menu` vem junto.
- **Instalação:**

  ```bash
  npm install @handsforbots/guided@alpha @handsforbots/core@alpha
  ```

- **Por exemplo:** onboarding; o assistente responder "onde troco minha senha?" apontando o campo; um passo a passo narrado com `voice`.

### `@handsforbots/expose-webmcp`

Publica as suas ações para agentes do navegador pelo [WebMCP](https://github.com/webmachinelearning/webmcp) (`document.modelContext`). Por padrão, só as ações marcadas com `exposeTo: ['agent']`. As chamadas passam pela mesma validação, confirmação e histórico de tudo o mais.

- **Precisa de:** `@handsforbots/core`; um navegador com WebMCP.
- **Instalação:**

  ```bash
  npm install @handsforbots/expose-webmcp@alpha @handsforbots/core@alpha
  ```

- **Por exemplo:** deixar o agente do próprio navegador da pessoa preencher seu formulário ou aplicar um filtro com segurança, com registro na conversa.

### `@handsforbots/mcp-apps`

Renderiza [MCP Apps](https://modelcontextprotocol.io) (recursos `ui://`) que o seu backend, como cliente MCP, manda numa resposta. Cada app roda num iframe isolado (sandbox) com uma política de conteúdo restrita; o H4B é o hospedeiro e liga as chamadas de ferramenta do app às ações que você permitir.

- **Precisa de:** `@handsforbots/core`.
- **Instalação:**

  ```bash
  npm install @handsforbots/mcp-apps@alpha @handsforbots/core@alpha
  ```

- **Funciona com:** o widget (`renderers`) ou a sua interface (`mountMcpApp`).
- **Por exemplo:** um gráfico ou um formulário que um servidor MCP devolve, dentro da conversa.

### `@handsforbots/cues`

Categorias de apresentação com vocabulário fechado às quais a página reage: o humor de um personagem, o cenário, a urgência de uma conversa, um modo mais rígido. Os valores vêm do backend, de uma ação que o modelo pode chamar ou de regras sobre as fontes e ações da resposta; contagens e políticas tratam a repetição. Com voz, a mudança acontece quando a voz chega àquela resposta.

- **Precisa de:** `@handsforbots/core`.
- **Instalação:**

  ```bash
  npm install @handsforbots/cues@alpha @handsforbots/core@alpha
  ```

- **Por exemplo:** um avatar que fica confuso depois de mal-entendidos repetidos; um fundo que acompanha o assunto; uma borda vermelha quando um atendimento fica urgente.

## Conversa, memória e armazenamento

### `@handsforbots/conversation-state`

Um registro explícito e auditável da conversa (assunto, objetivo, entidades, decisões, fatos com a fonte, pendências) enviado em toda requisição. O backend só o muda por operações que a página confere: um fato precisa de um trecho encontrado na mensagem que ele cita.

- **Precisa de:** `@handsforbots/core`. O `@handsforbots/conversation-state/server` o lê no seu backend.
- **Instalação:**

  ```bash
  npm install @handsforbots/conversation-state@alpha @handsforbots/core@alpha
  ```

- **Por exemplo:** conversas longas em que o modelo não pode esquecer o que foi decidido; passar uma conversa a uma pessoa com um resumo confiável.
- Guia: [Estado explícito da conversa](./conversation-state.md).

### `@handsforbots/memory`

Quantos turnos vão para o backend e ficam na página, e como os turnos mais antigos viram um resumo. O `createH4B` o monta por padrão; instale você mesmo só para importar os ajudantes dele (`httpSummarizer`, `localSummary`).

- **Precisa de:** `@handsforbots/core` (que já depende dele).
- **Instalação:**

  ```bash
  npm install @handsforbots/memory@alpha @handsforbots/core@alpha
  ```

### `@handsforbots/storage-local`

Guarda a conversa no navegador entre recargas, criptografada por padrão com uma chave que expira (num cookie ou no seu servidor), para que nada legível fique depois do prazo.

- **Precisa de:** `@handsforbots/core`.
- **Instalação:**

  ```bash
  npm install @handsforbots/storage-local@alpha @handsforbots/core@alpha
  ```

### `@handsforbots/storage-backend`

Guarda a conversa no seu servidor (`GET`/`PUT`/`DELETE` numa URL); o seu servidor aplica a retenção.

- **Precisa de:** `@handsforbots/core`.
- **Instalação:**

  ```bash
  npm install @handsforbots/storage-backend@alpha @handsforbots/core@alpha
  ```

- **Por exemplo:** continuar uma conversa em outro aparelho; guardar conversas para revisão humana com consentimento.
- Guia: [Persistência, memória e privacidade](./persistence.md).

### `@handsforbots/tab-sync`

Várias abas compartilham uma conversa, ou cada uma tem a sua e fica sabendo o que as outras fizeram, ou ficam isoladas.

- **Precisa de:** `@handsforbots/core`.
- **Instalação:**

  ```bash
  npm install @handsforbots/tab-sync@alpha @handsforbots/core@alpha
  ```

## Privacidade, observabilidade e testes

### `@handsforbots/consent`

Conjuntos de regras iniciais para o `createH4B({ consent })` por legislação (LGPD, GDPR, CCPA, opt-in) em JSON ou YAML, ajudantes para descobrir a região do visitante e anonimização do que é guardado (e-mails, telefones, CPF, CNPJ, cartões, mídia). O mecanismo de consentimento em si fica no `core`.

- **Precisa de:** `@handsforbots/core`; um parser de YAML só para regras em YAML.
- **Instalação:**

  ```bash
  npm install @handsforbots/consent@alpha @handsforbots/core@alpha
  ```

- Guia: [Consentimento](./consent.md).

### `@handsforbots/observability`

Turnos, rotas, ações, sinais e fala como telemetria semântica, com a latência percebida por rota, para Grafana (Faro, OpenTelemetry), Langfuse e LangSmith; atributos da conversa nos spans e como `baggage` para experimentos; um painel de depuração para celulares. O `@handsforbots/observability/server` lê os atributos no seu backend.

- **Precisa de:** `@handsforbots/core`. O `@handsforbots/semantic-event-observability` vem junto; cada exportador precisa da própria biblioteca (`@grafana/faro-web-sdk`, `@opentelemetry/api`, `@langfuse/tracing`, `langsmith`, `web-vitals`), todas opcionais.
- **Instalação:**

  ```bash
  npm install @handsforbots/observability@alpha @handsforbots/core@alpha
  ```

- Guia: [Experimentos](./experiments.md).

### `@handsforbots/semantic-event-observability`

A biblioteca por baixo do `observability`: logs, métricas e traces semânticos para qualquer sistema de eventos assíncronos, com exportadores opcionais. Não depende do H4B e tem versão própria.

- **Precisa de:** nada; as bibliotecas dos exportadores são peers opcionais.
- **Instalação:**

  ```bash
  npm install @handsforbots/semantic-event-observability
  ```

### `@handsforbots/testkit`

Para quem escreve plugins, transportes e integrações: um transporte roteirizado, `reply` e `citedReply`, `eventually` e `waitForIdle` (esperam condições, nunca atrasos fixos) e `transportConformance`, a suíte Vitest que todo transporte do repositório passa.

- **Precisa de:** `@handsforbots/core`, `vitest` 3+.
- **Instalação:**

  ```bash
  npm install -D @handsforbots/testkit@alpha @handsforbots/core@alpha
  ```

## Pontos de partida

Combinações que cobrem muitos projetos. Misture à vontade.

| Ponto de partida | Pacotes |
|---|---|
| Uma janela de conversa em qualquer site, falando com a sua API | `core`, `transport-http`, `widget`, `storage-local` |
| Sua própria interface React sobre um agente AG-UI | `core`, `transport-agui`, `react`, `menu` |
| Voz em primeiro lugar | `core`, um transporte, `voice`, `keyboard`, `widget` ou a sua interface; `voice-models` para uma voz offline |
| Um app com CopilotKit ou assistant-ui ganhando voz e comandos diretos | `core`, `react`, `copilotkit` ou `assistant-ui`, `voice`, `menu` |
| Um bot Rasa existente numa página nova | `core`, `transport-rasa`, `widget`, `guided` |
| Produção com consentimento e métricas | acrescente `consent`, `storage-backend` ou `storage-local`, `observability` |
