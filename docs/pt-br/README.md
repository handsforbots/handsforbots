<div align="center"><img src="../hands-for-bots-cover.png" alt="[•_•] Hands for Bots" style="max-width: 100%;width: 700px;margin: auto;display: block;"></div>

<div align="right">

[![pt-BR](https://img.shields.io/badge/pt-BR-white)](./README.md)
[![en-US](https://img.shields.io/badge/en-US-white)](../../README.md)

</div>

O **Hands for Bots** dá mãos aos assistentes: uma camada headless, baseada em plugins, entre as pessoas, a sua interface e qualquer agente.

- **Qualquer entrada vira um sinal**: teclado, voz (do navegador ou na nuvem), fotos, quadros de vídeo, arquivos, sensores, eventos da interface.
- **Qualquer backend responde com mensagens e/ou estímulos para a UI**: AG-UI, CopilotKit, Rasa, sua própria API HTTP, LLMs compatíveis com OpenAI.
- **As ações da sua interface são declaradas uma vez** e ficam disponíveis para o assistente do app (tool calls), para o usuário como comandos instantâneos (sem passar pelo LLM, mas no histórico) e para agentes do navegador (WebMCP), sob as mesmas regras de validação, confirmação e origem.

Não é uma janela de chat. Use o widget pronto `<h4b-chat>`, seus próprios componentes (há bindings para React e Vue) ou o chat do CopilotKit, e mantenha a colaboração na própria página: tours guiados, destaques, filtros, galerias.

```ts
import { createH4B } from '@handsforbots/core'
import { agui } from '@handsforbots/transport-agui'
import { voice, webSpeechSTT, webSpeechTTS } from '@handsforbots/voice'
import { menu } from '@handsforbots/menu'
import { widget } from '@handsforbots/widget'

const h4b = createH4B({
  plugins: [
    agui({ url: '/api/agent' }),
    voice({ stt: webSpeechSTT(), tts: webSpeechTTS(), language: 'pt-BR' }),
    menu({ language: 'pt-br', commands: [{ action: 'filter_orders', label: 'Pedidos atrasados', slash: 'atrasados', args: { status: 'late' } }] }),
    widget({ botName: 'Assistente', language: 'pt-br' }),
  ],
  actions: [{ name: 'filter_orders', description: 'Filtra pedidos por status', handler: ({ status }) => tabela.filtrar(status) }],
})
await h4b.start()
```

## Instalação

```bash
npm install @handsforbots/core@alpha @handsforbots/transport-agui@alpha @handsforbots/widget@alpha
```

Acrescente só os pacotes que a sua interface usa: [Pacotes](./packages.md) diz o que cada um faz, do que precisa e com o que funciona.

### O que dá para acrescentar

Além do kernel, de um transporte e de uma interface, cada capacidade é um pacote próprio:

| Para… | Pacotes | O que trazem |
|---|---|---|
| Falar e ouvir | [`voice`](https://www.npmjs.com/package/@handsforbots/voice) · [`voice-models`](https://www.npmjs.com/package/@handsforbots/voice-models) · [`voice-effects`](https://www.npmjs.com/package/@handsforbots/voice-effects) | fala de entrada e saída, mãos livres, interrupção por voz; vozes neurais na página; efeitos de voz |
| Rodar comandos sem o LLM | [`menu`](https://www.npmjs.com/package/@handsforbots/menu) · [`keyboard`](https://www.npmjs.com/package/@handsforbots/keyboard) | comandos com barra, frases, atalhos, segurar para falar, paleta |
| Mostrar e guiar na tela | [`guided`](https://www.npmjs.com/package/@handsforbots/guided) · [`cues`](https://www.npmjs.com/package/@handsforbots/cues) | tours, destaques, seções, galerias; estados de tom e cena que a página espelha |
| Receber mais que texto | [`inputs`](https://www.npmjs.com/package/@handsforbots/inputs) | câmera, arquivos, eventos da interface, inatividade, sensores |
| Abrir a página para outros agentes e apps | [`expose-webmcp`](https://www.npmjs.com/package/@handsforbots/expose-webmcp) · [`mcp-apps`](https://www.npmjs.com/package/@handsforbots/mcp-apps) | agentes do navegador (WebMCP), MCP Apps em iframes isolados |
| Lembrar e continuar | [`memory`](https://www.npmjs.com/package/@handsforbots/memory) · [`storage-local`](https://www.npmjs.com/package/@handsforbots/storage-local) · [`storage-backend`](https://www.npmjs.com/package/@handsforbots/storage-backend) · [`tab-sync`](https://www.npmjs.com/package/@handsforbots/tab-sync) · [`conversation-state`](https://www.npmjs.com/package/@handsforbots/conversation-state) | o que é enviado e guardado, armazenamento criptografado no navegador ou no servidor, abas, estado explícito da conversa |
| Respeitar a privacidade | [`consent`](https://www.npmjs.com/package/@handsforbots/consent) | regras de consentimento por lei e região, apagamento, anonimização |
| Medir | [`observability`](https://www.npmjs.com/package/@handsforbots/observability) · [`semantic-event-observability`](https://www.npmjs.com/package/@handsforbots/semantic-event-observability) | logs, métricas e traces semânticos (Grafana, OTel, Langfuse, LangSmith) |
| Testar | [`testkit`](https://www.npmjs.com/package/@handsforbots/testkit) | transportes roteirizados, conformidade de transportes |

### Skills para agentes

Agentes de código integram o H4B melhor com as [skills](../../skills/README.md) dele. No Claude Code:

```
/plugin marketplace add handsforbots/handsforbots
/plugin install handsforbots@handsforbots
```

## Documentação

- [Primeiros passos](./getting-started.md)
- [Conceitos](./concepts.md): sinais, turnos, estímulos, rotas, síncrono/assíncrono
- [Pacotes](./packages.md): para que serve cada pacote, do que precisa, com o que funciona
- [Plugins](./plugins.md): todos os pacotes e opções
- [Escrevendo plugins](./writing-plugins.md)
- [Histórico](./history.md): leitura, registro de decisões da interface, linha do tempo
- [Interrupção e conversa por voz](./conversation.md): mensagens enviadas enquanto o assistente responde, botões de parar, conversa com microfone aberto, modelos de fim de turno, barge-in
- [Fontes e citações](./sources.md): fontes nas mensagens do assistente, citações como trechos do texto, transportes, referências e lista no widget, agrupamento das seções de um artigo, URLs seguras
- [Síntese de voz e efeitos](./speech.md): a voz do navegador, um backend ou modelos na página (Piper, Kokoro, transformers.js), quando os modelos baixam e quem fala enquanto isso, efeitos em JSON, presets, exportação para SSML e FFmpeg
- [Persistência, memória e privacidade](./persistence.md): o que é enviado, guardado e armazenado, criptografia, retenção, abas
- [Estado explícito da conversa](./conversation-state.md): um registro pequeno e auditável de assunto, objetivo, entidades, decisões, fatos com fonte e pendências, com checagens contra fato inventado
- [Experimentos e atributos da conversa](./experiments.md): testes A/B, códigos presos à conversa, exposições, contadores, W3C `baggage` para o backend
- [Consentimento](./consent.md): trabalhar com a sua ferramenta de consentimento, regras por legislação e região, apagar ao revogar, anonimização para revisão humana
- [Segurança](./security.md)
- [Desenvolvimento](./development.md)
- [Migrando da v1](./migrating-from-v1.md)
- [Referências](./references.md): bibliotecas, serviços e artigos por trás das decisões
- [Projetos de terceiros](./NOTICE.md): pacotes e licenças
- [Roadmap](../../ROADMAP.md) (arquitetura, decisões, estado)

## Exemplos

- [`examples/react-agui`](../../examples/react-agui/README.md): painel em React em que o assistente trabalha na interface via AG-UI, com comandos diretos, voz, atalhos de teclado e WebMCP. Roda com um agente simulado: `pnpm install && pnpm --filter @handsforbots/example-react-agui dev`.
- [`examples/voice-lab`](../../examples/voice-lab/README.md): laboratório de síntese de voz: motores, fontes de modelo, políticas de carga e um editor de efeitos com exportação para SSML e FFmpeg: `pnpm --filter @handsforbots/example-voice-lab dev`.
- [`examples/vite`](../../examples/README.md): Rasa + widget `<h4b-chat>` + tours guiados + observabilidade (Docker).

## Agradecimentos

Aos autores [destes projetos de terceiros](./NOTICE.md).
