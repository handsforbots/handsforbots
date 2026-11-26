# 0020 — A2UI e MCP Apps: H4B como runtime de host, estímulo ui.surface, papel do ui.render e ponte de ações

**Contexto.** O Google lançou o A2UI 1.0 em novembro de 2026 como protocolo declarativo de UI generativa: o agente envia uma árvore de componentes, um modelo de dados e chamadas de função bidirecionais entre cliente e agente. Em paralelo, o padrão MCP Apps (extensão `io.modelcontextprotocol/ui`, SEP-1865, especificação `2026-01-26`) padroniza UI HTML em iframe com sandbox em hosts MCP (Claude, ChatGPT e aplicações próprias via `@handsforbots/mcp-apps`).

No H4B v2, o núcleo tem hoje apenas `ui.render` e `ui.effect` — ainda não existe um estímulo próprio para superfícies declarativas (`ui.surface`). O `ui.render` (`{ component, props, slot? }`) funciona como um envelope simples e leve para desenvolvimento rápido ou componentes menores do host, sem dependências de protocolo de UI.

No lado de transporte, o `transport-agui` ainda não tratava eventos `ACTIVITY_SNAPSHOT` e `ACTIVITY_DELTA` com `activityType: 'a2ui-surface'` (emitidos pelo `@ag-ui/a2ui-middleware`), deixando superfícies A2UI caírem no `default` como `agui.ACTIVITY_*`.

**Decisão.**

- **H4B como runtime de host, nunca produtor de A2UI.** Quem gera a descrição da UI é o agente no backend (ADK, LangGraph, Rasa, Laravel…). O H4B roda no navegador como a camada que recebe a superfície, a integra ao histórico, persistência, abas e consentimento, conecta interações às ações registradas e soma voz, teclado e outras modalidades.
- **Novo estímulo `ui.surface` para superfícies declarativas (A2UI), independente de `ui.render`.** Quando o pacote `@handsforbots/a2ui` for implementado, o `@handsforbots/core` ganhará o estímulo `ui.surface` para criação, atualização incremental e remoção por `surfaceId`, com snapshot salvo no histórico. Nada no A2UI dependerá de `ui.render`.
- **`ui.render` segue como recurso secundário e leve.** Fica mantido para desenvolvimento rápido, componentes simples do host (`gallery`, `mcp-app`) e casos sem dependências extras; não será evoluído como linguagem de UI concorrente do A2UI.
- **Plugin headless `@handsforbots/a2ui` sobre `@a2ui/web_core` (Apache-2.0).** O H4B não cria renderers próprios nem catálogo concorrente do Basic Catalog: quem integra usa os renderers oficiais (React, Lit, Angular, Flutter) com o próprio catálogo. O plugin mantém o estado das superfícies, converte `action` do A2UI em sinal `trigger` (`gui-event`, levando `userMessage` quando presente) e converte `callRendererFunction` em `runAction` sob a política de segurança existente ([ADR 0005](./0005-acoes-e-seguranca.md): `exposeTo`, validação de schema, `confirm`, `callId` único). Ações registradas no H4B passam a gerar também definições de `functions` do catálogo A2UI ("declare uma vez": LLM, WebMCP, MCP Apps e A2UI). O alvo inicial é o A2UI 1.0, sem manter 0.8 ou 0.9.
- **Suporte imediato no `transport-agui`.** Antes da entrada de `ui.surface` no core, o `transport-agui` reconhece `ACTIVITY_SNAPSHOT` e `ACTIVITY_DELTA` com `activityType: 'a2ui-surface'` (`A2UI_ACTIVITY_TYPE`) e emite os estímulos `custom` nomeados `a2ui.surface.snapshot` e `a2ui.surface.delta` (`A2UI_STIMULI`). Outros `activityType` continuam no fallback `agui.ACTIVITY_*`.
- **Complementaridade com MCP Apps e CopilotKit.** O `@handsforbots/mcp-apps` segue como host de recursos `ui://` dentro da página do app. Para aparecer em hosts de terceiros (Claude, ChatGPT) sem frontend próprio, o caminho é o servidor MCP do próprio backend, fora do escopo do H4B. No modo A do CopilotKit (CopilotKit dono do chat), o CopilotKit já inclui renderers de A2UI e MCP Apps; o H4B não duplica renderização e entra com voz, menu, ações e WebMCP.

**Consequências.**

- Fica clara a fronteira entre `ui.render` (envelope leve e secundário), `ui.surface` (superfícies declarativas como A2UI) e `mcp-apps` (iframes `ui://`).
- Adotar `@a2ui/web_core` evita reimplementar parser e validador do protocolo, mas traz uma dependência externa (Apache-2.0; registrar em `NOTICE.md` quando o pacote `@handsforbots/a2ui` for criado) e exposição à evolução da especificação 1.0.
- O `transport-agui` passa a preservar superfícies A2UI vindas do `@ag-ui/a2ui-middleware` de forma explícita.
- **Em aberto:** contrato exato de `ui.surface` no `@handsforbots/core` e no `SessionSnapshot`, sincronia de voz com o modelo de dados da superfície ativa, e avaliação do SDK oficial de host de MCP Apps (`ext-apps`).
- Fontes em [Referências → A2UI e MCP Apps](../pt-br/references.md#a2ui-e-mcp-apps).
