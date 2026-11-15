# Estado explícito da conversa

Um registro pequeno e confiável da conversa, ao lado do histórico bruto: o assunto ativo, o objetivo de quem conversa, a profundidade atual, as entidades (com versões e datas), as decisões tomadas, os fatos já declarados com suas fontes e as pendências. Com ele, o backend retoma "o Terraform daquele projeto" sem buscar no histórico inteiro e sem confundir com outro projeto.

Não é um resumo. Um resumo que inventa um fato repete esse fato em toda requisição dali em diante. Por isso o estado é feito de **afirmações atômicas com fonte, data, escopo e confiança**, e só muda por operações que a página confere antes. Decisão e pesquisa: [ADR 0019](../adr/0019-estado-explicito-da-conversa.md), [referências](./references.md#estado-explícito-da-conversa).

## As três camadas de memória

| Camada | O quê | No H4B |
|---|---|---|
| (a) Mensagens brutas recentes | Os últimos turnos, como foram | O `memory` manda os últimos 20 turnos ([Persistência, memória e privacidade](./persistence.md)) |
| (b) Estado factual | Afirmações atômicas com fonte, data, escopo e confiança, reescritas com cuidado | **`conversation-state`** (esta página) |
| (c) Memória episódica | Conversas e documentos anteriores, recuperados quando preciso | O seu backend. O estado dá as âncoras: `scope`, ids de entidades, ids de mensagens |

O `memory.summary` dos turnos que saíram da janela continua indo. Ele é um apanhado grosseiro. O estado é o que o backend pode tomar como confiável.

## Instalação

```ts
import { createH4B } from '@handsforbots/core'
import { conversationState } from '@handsforbots/conversation-state'

const h4b = createH4B({
  plugins: [conversationState()], // seções padrão, atualizações junto com a resposta
})
```

A partir daí, toda requisição leva o sinal de contexto `conversation.state` num campo próprio, separado das mensagens:

- transporte HTTP: `context['conversation.state']`
- AG-UI: uma entrada de `context` cujo valor começa com `conversation.state: `
- outros transportes: um sinal de contexto com uma parte `data` chamada `conversation.state`

```json
{
  "revision": 4,
  "sections": {
    "topic": { "id": "topic", "text": "State do Terraform do projeto Acme", "origin": "user", "confidence": "high", "src": ["msg_12"] },
    "goal": null,
    "depth": { "id": "depth", "text": "passo a passo", "origin": "unsourced", "confidence": "low" },
    "entities": [
      { "id": "e1", "text": "Terraform", "scope": "acme", "attrs": { "version": "1.9" }, "origin": "user", "confidence": "high", "src": ["msg_12"], "stated": "2026-11-14T13:02:11.000Z" }
    ],
    "decisions": [],
    "facts": [
      { "id": "f1", "text": "A Acme faz deploy às quintas", "scope": "acme", "origin": "user", "confidence": "high", "src": ["msg_15"], "stated": "2026-11-14T13:05:40.000Z" }
    ],
    "pending": []
  },
  "rejected": [{ "index": 0, "reason": "quote-not-found", "op": "add", "section": "facts", "detail": "the quote is not in message msg_14" }]
}
```

O `rejected` vai uma vez, depois de uma atualização que teve problemas, para o modelo corrigir.

## Seções

| Seção | Tipo | Regras padrão |
|---|---|---|
| `topic` | valor | 160 caracteres; acompanha a conversa (`keepUserStated: false`) |
| `goal` | valor | 240 caracteres |
| `depth` | valor | 60 caracteres; acompanha a conversa |
| `entities` | lista | 20 itens, 120 caracteres; versões e datas em `attrs` |
| `decisions` | lista | 15 itens, 240 caracteres; pede um id de mensagem (`evidence: 'message'`) |
| `facts` | lista | 25 itens, 240 caracteres; pede um id de mensagem **e um trecho copiado dela** (`evidence: 'quote'`) |
| `pending` | lista | 15 itens, 200 caracteres |

Troque ou acrescente:

```ts
import { conversationState, DEFAULT_SECTIONS } from '@handsforbots/conversation-state'

conversationState({
  sections: {
    ...DEFAULT_SECTIONS,
    depth: { kind: 'value', description: 'Quão fundo estamos.', values: ['visao-geral', 'passo-a-passo', 'especialista'] },
    ambientes: { kind: 'list', description: 'Ambientes citados (dev, staging, prod), por projeto.', max: 10, maxChars: 80 },
  },
})
```

## Itens

Cada item é uma afirmação:

| Campo | |
|---|---|
| `id` | Estável dentro da seção (`f1`, ou o do backend) |
| `text` | A afirmação. Passou de `maxChars`, é **recusada, nunca cortada** |
| `attrs` | Até 8 atributos curtos: `version`, `date`, `project`… (texto, número, booleano) |
| `scope` | A que pertence (projeto, produto, conta). O mesmo texto em dois escopos são dois itens |
| `origin` | Vem da evidência, nunca da palavra do modelo: `user`, `tool`, `assistant`, `app` (a página) ou `unsourced` |
| `confidence` | `high`, `medium`, `low`: o que quem escreveu pediu, **limitado pela origem**. O usuário, uma ferramenta ou a página chegam a `high`, a própria mensagem do assistente a `medium`, e sem evidência fica `low` |
| `evidence` | Mensagens que sustentam o item (`messageId`, `quote`, `role`, `at`). O backend vê os ids em `src` e a data mais nova em `stated` |
| `locked` | Marcado pela página; o backend não muda |
| `rev`, `since`, `by`, `turnId`, `at` | Última mudança, criação, quem escreveu, turno e hora |

## Atualizar

O backend nunca manda um estado inteiro novo, só **operações**:

```json
{
  "base": 4,
  "ops": [
    { "op": "set", "section": "topic", "text": "Agenda de deploy da Acme", "evidence": [{ "messageId": "msg_15" }] },
    { "op": "add", "section": "facts", "text": "A Acme faz deploy às quintas", "scope": "acme",
      "evidence": [{ "messageId": "msg_15", "quote": "o deploy passou para as quintas" }] },
    { "op": "update", "section": "entities", "id": "e1", "attrs": { "version": "1.10" }, "evidence": [{ "messageId": "msg_16" }] },
    { "op": "remove", "section": "pending", "id": "p2", "reason": "respondido na msg_15" }
  ]
}
```

`set` vale para seções de valor, `add`/`update` para listas, e `remove` para as duas (`id` nas listas), sempre com `reason`. No `update`, os `attrs` são juntados (`null` remove um) e `scope: null` tira o escopo. `base` é a revisão que o backend leu.

De onde vêm as atualizações (`updates`):

- **`'response'`** (padrão). Junto com a resposta, de um destes dois jeitos:
  - um `ui.effect` chamado `conversation.state`, com a atualização no `value`. É aplicado no fim do turno, para que os trechos da resposta inteira possam ser conferidos. No AG-UI, é o evento CUSTOM `h4b.ui.effect`;
  - a ação `update_conversation_state`, para backends que só usam tool calling. O JSON Schema dela sai das seções, com `confirm: 'never'`, e ela fica exposta a `assistant` e `agent`. Devolve `{ revision, applied, rejected }` na hora. `action: false` desliga.
- **Um `StateUpdater`**: um canal à parte, chamado depois de cada turno concluído com o estado e as mensagens daquele turno. Roda fora da fila do kernel. A próxima requisição espera por ele até `wait` ms (2000) e depois segue com o estado que tem. Uma conversa nova o aborta. Sem `base`, vale a revisão que ele recebeu.

  ```ts
  import { conversationState, httpStateUpdater } from '@handsforbots/conversation-state'

  conversationState({ updates: httpStateUpdater({ url: '/api/h4b/state' }) })
  // POST { state, messages, threadId, turnId } → 200 { base?, ops } ou 204
  ```

- **`'manual'`**: só `h4b.get('conversationState').update(...)`, por exemplo vindo de um WebSocket do app.

A página escreve como `by: 'app'` (o padrão do `update()`). Não precisa de evidência, pode travar itens (`locked: true`) e pode mudar os travados e o que o usuário afirmou.

## Proteções

Cada operação é conferida sozinha. A ruim é recusada com um motivo e as outras passam. Duas checagens olham o resultado e recusam a atualização inteira.

| Motivo | Quando |
|---|---|
| `invalid`, `unknown-section`, `unknown-item`, `not-allowed-value` | Formato, seção ou id errados, ou valor fora de `values` |
| `too-long` | Texto acima de `maxChars` (nunca cortado) |
| `evidence-required` | A seção pede id de mensagem (ou trecho) e o backend não mandou |
| `evidence-not-found` | O id de mensagem não está nesta conversa |
| `quote-not-found` | O trecho não está naquela mensagem (ignorando maiúsculas, aspas tipográficas e espaços). **É a checagem contra fato inventado** |
| `user-stated` | Mudar ou remover o que o usuário afirmou sem evidência de uma mensagem do usuário (`keepUserStated`) |
| `locked` | A página travou o item |
| `stale` | O item mudou depois do `base` |
| `duplicate` | Mesmo texto no mesmo escopo (ou nenhuma mudança) |
| `section-full` | Passou do `max` da seção; remova ou junte antes, se quiser na mesma atualização |
| `reason-required` | `remove` sem motivo |
| `screened` | O seu `screen` recusou |
| `too-many-removals` | **Atualização inteira**: mais remoções que `maxRemovals` (3). É a cara de um modelo que "esqueceu" metade do estado |
| `over-budget` | **Atualização inteira**: os itens passam de `maxChars` (4000); o `detail` diz quanto liberar. Nada é compactado sozinho |

Além disso:

- O texto é limpo antes de ser guardado: saem caracteres de controle, invisíveis, bidi e tags Unicode, e os espaços se juntam. Depois o seu `screen(texto, { section, by })` pode reescrever o texto (tirar dados pessoais, por exemplo com o `redact` do `@handsforbots/consent`) ou devolver `false`. A limpeza é feita antes de guardar, não depois.
- Na mesma conversa, a revisão só anda para a frente. Uma restauração com revisão mais antiga (outra aba, um salvamento atrasado) é desfeita e emite `error` (`source: 'conversation-state'`).
- O diário (as últimas `journal`, 50, entradas) guarda cada mudança com o item antes e depois, e cada recusa. Ele é salvo com a conversa. `revert(revisão, motivo)` desfaz as mudanças pelo diário e registra uma revisão nova.

Um trecho conferido prova que o texto foi dito, não que é verdade: um usuário pode afirmar algo falso. A `origin` diz quem afirmou.

## Opções

| Opção | Padrão | |
|---|---|---|
| `sections` | `DEFAULT_SECTIONS` | |
| `updates` | `'response'` | `'response'`, `'manual'` ou um `StateUpdater` |
| `action` | `true` | Registra `update_conversation_state` (só com `'response'`) |
| `persist` | `true` | Salva com a conversa (`SessionSnapshot.conversationState`), e os storages guardam (criptografado com o `storage-local`). `false`: só nesta aba |
| `send` | `true` | Manda `conversation.state` em toda requisição. `false` se o backend guarda o estado do lado dele |
| `maxChars` | `4000` | Texto, escopo e atributos de todos os itens |
| `maxRemovals` | `3` | Por atualização do backend |
| `journal` | `50` | Entradas guardadas |
| `screen` | — | `(texto, { section, by }) => string \| false` |
| `wait` | `2000` | ms que uma requisição espera por um atualizador em andamento |

## Na página

```ts
const estado = h4b.get('conversationState')!
estado.getState() // { revision, items, size, pending, rejected }; o mesmo objeto até mudar
estado.subscribe(() => desenhar(estado.getState()))
estado.update({ ops: [{ op: 'set', section: 'goal', text: 'Migrar a Acme para OpenTofu', locked: true }] })
estado.history() // diário
estado.revert(3, 'o modelo se perdeu')
```

`getState`/`subscribe` funcionam com o `useStore` do `@handsforbots/react` e do `@handsforbots/vue`. Evento `conversation.state` `{ revision, reason: 'update' | 'revert' | 'restored' | 'reset', by?, applied, rejected }`.

## No backend

`@handsforbots/conversation-state/server` roda sem navegador e sem o core:

```ts
import { conversationStatePrompt, readConversationState, stateItems, stateUpdateSchema } from '@handsforbots/conversation-state/server'

const estado = readConversationState(body.context) // context do AG-UI, objeto de contexto do HTTP, sinais ou o próprio valor
const acme = stateItems(estado, { scope: 'acme' }) // só os itens desse projeto
const system = `${conversationStatePrompt()}\n\nEstado atual:\n${JSON.stringify(estado)}`
// saída estruturada para um atualizador à parte: stateUpdateSchema()
```

`readConversationState` nunca lança, descarta itens malformados e devolve `undefined` quando não há estado. O estado vem do navegador e quem usa a página pode editá-lo: use como contexto, nunca como autorização.
