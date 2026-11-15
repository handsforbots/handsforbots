# 0019 — Estado explícito da conversa: afirmações pequenas, com fonte, mudadas só por operações conferidas

**Contexto.** O histórico bruto cresce, e o `memory` ([ADR 0009](./0009-memoria.md)) corta a janela e junta o que sai num resumo. Esse resumo é texto corrido: não diz de onde veio cada coisa e é refeito a cada compactação. Para retomar "o Terraform daquele projeto" sem buscar no histórico inteiro e sem confundir com outro projeto, o backend precisa de outra coisa: uma representação pequena e confiável da conversa, com o assunto ativo, as entidades, versões e datas, o objetivo de quem conversa, as decisões, os fatos já declarados com as fontes, as pendências e a profundidade atual.

Esse registro precisa ser estruturado e auditável, e só pode ser atualizado com cautela. Uma memória resumida que inventa um fato propaga o erro indefinidamente: ele volta em toda requisição, e o modelo o trata como verdade porque "está no estado".

A orientação de memória do projeto pede três camadas: (a) as últimas mensagens brutas; (b) um resumo factual, reescrito com cuidado e com referências; (c) memória episódica recuperável. O resumo nunca deve inventar fatos, e para isso guarda afirmações atômicas com fonte, data, escopo e confiança. No H4B, a camada (a) é a janela do `memory`, a (b) é este pacote e a (c) é do backend (ROADMAP, seção 6, item 7).

O que foi estudado (detalhes e links em [referências](../pt-br/references.md#estado-explícito-da-conversa)):

- **Hermes Agent** (Nous Research): memória em dois arquivos pequenos com limite rígido de caracteres (2.200 e 1.375). A ferramenta só tem `add`, `patch` e `remove`, achados por um trecho único, e duplicatas exatas são ignoradas. O conteúdo é examinado antes de entrar no prompt (injeção, exfiltração, Unicode invisível). Passou do limite, a escrita é recusada com o que existe e quanto liberar; nada é compactado sozinho. Há opção de aprovar cada escrita.
- **OpenClaw**: um `MEMORY.md` curto e curado, notas diárias pesquisáveis e um "flush" antes da compactação. A promoção para a memória curta exige pontuação, frequência e diversidade, e arquivos não confiáveis ficam fora do contexto. Fatos de verdade vão num plugin com afirmações, evidências e contradições.
- **Letta**: blocos de memória com rótulo, descrição, limite e `read_only`.
- **Factory** (avaliação de compressão): o resumo estruturado e incremental (só o trecho novo é juntado) perdeu menos que o resumo refeito a cada vez, que deriva. Mas mesmo o melhor método rastreou mal artefatos, o que pede estado dedicado, não resumo.
- **Zep/Graphiti**: fatos com tempo de validade; um fato contradito é invalidado, não apagado, e a origem fica guardada.
- **Mem0**: começou com ADD/UPDATE/DELETE/NOOP decididos pelo modelo e passou a só adicionar, resolvendo conflitos na leitura. Deixar o modelo apagar é arriscado.
- **Contaminação de estado** (arXiv 2605.16746): conteúdo hostil comprimido num resumo passa pelos detectores e continua influenciando. Limpar antes de comprimir funciona; limpar só o resumo pronto não basta.
- **MemLineage** (arXiv 2605.14421): proveniência e linhagem por entrada; uma memória "lavada" pelo resumo parece legítima se só a assinatura for conferida.
- **ReacTOD** (TrustNLP 2026): um validador simbólico confere cada mudança de estado antes de aplicá-la. Erros de formato e alucinações do modelo viram ações erradas em cascata.

**Decisão.**

- **Pacote `@handsforbots/conversation-state`.** Plugin `conversationState(opções)` com o serviço `conversationState`. No core muda só uma coisa: o slot opaco `SessionSnapshot.conversationState` (e `Conversation.conversationState`), igual ao do `memory`. Ele é salvo, restaurado e levado entre abas com a conversa, e some no `reset()`.
- **Seções, não texto livre.** O padrão (`DEFAULT_SECTIONS`) tem `topic`, `goal` e `depth` (um valor cada) e as listas `entities`, `decisions`, `facts` e `pending`, cada uma com descrição, máximo de itens e de caracteres. O app troca ou acrescenta seções; uma seção pode ter vocabulário fechado (`values`). Assim a ferramenta serve a outros domínios sem ficar presa a um.
- **Item = afirmação atômica com proveniência.** Cada item tem `id`, `text` (sem cortes: texto longo demais é recusado, porque uma frase cortada pode dizer outra coisa), `attrs` (versão, data…), `scope` (o projeto, produto ou conta a que pertence), `origin`, `confidence` e `evidence`, além de `rev`/`since`/`by`/`turnId`/`at`.
- **Origem e confiança vêm da evidência, não da palavra do modelo.** A evidência aponta para ids de mensagem da conversa. A `origin` é o papel dessas mensagens (`user`, `tool`, `assistant`), `app` para a página ou `unsourced` sem evidência. A confiança pedida é limitada pela origem: o usuário, uma ferramenta ou a página chegam a `high`, a própria mensagem do assistente a `medium`, e sem evidência fica `low`. A data da fonte (`stated`) é a da mensagem.
- **A checagem contra fato inventado é determinística.** Uma seção com `evidence: 'quote'` (o padrão de `facts`) exige um id de mensagem **e** um trecho copiado dela. O plugin confere se o trecho está mesmo naquela mensagem (texto do usuário ou do assistente, ou resultado de ferramenta), ignorando maiúsculas, aspas tipográficas e espaços. Sem isso, a operação é recusada (`quote-not-found`, `evidence-not-found`). `decisions` pede um id de mensagem. Não é preciso um modelo para conferir.
- **Só operações, nunca um estado inteiro novo.** O backend manda `{ base?, ops }` com `set` (valores), `add`/`update` (listas) e `remove` (sempre com motivo). Reescrever tudo a cada vez é o que deriva (Factory) e o que deixa um modelo "esquecer" metade do estado.
- **Proteções contra degradação**, cada uma com um motivo de recusa que volta ao backend:
  - validação de forma, seção, vocabulário, atributos e tamanho por operação. Uma operação ruim é recusada e as outras passam;
  - `keepUserStated`: o que o usuário afirmou só muda com evidência de uma mensagem do usuário, ou pela página. O assistente não reescreve o que a pessoa disse. É desligado em `topic` e `depth`, que mudam a todo turno;
  - `locked`: itens que a página marcou não mudam pelo backend (como o `read_only` do Letta);
  - `base` e `stale`: uma operação sobre item mudado depois da revisão em que o backend se baseou é recusada. O atualizador separado usa a revisão que recebeu quando não manda `base`;
  - `maxRemovals` (padrão 3): mais remoções que isso numa atualização do backend recusa a atualização inteira;
  - `maxChars` (padrão 4000) e `max` por seção: passar do limite recusa a atualização inteira e diz quanto liberar. Nunca se compacta sozinho (Hermes);
  - duplicatas (mesmo texto no mesmo escopo) são ignoradas. O mesmo nome em outro `scope` é outra coisa;
  - texto limpo antes de entrar: sem caracteres de controle, invisíveis, bidi e tags Unicode. Depois vem o `screen(texto)` do app, que pode reescrever ou recusar, por exemplo com o `redact` do `consent` ou um filtro de instruções. Fica antes de guardar, não depois (contaminação de estado);
  - revisão monotônica: a mesma conversa nunca volta a uma revisão mais antiga (outra aba ou um salvamento atrasado), e isso emite `error`;
  - diário (`journal`, padrão 50 entradas) com o antes e o depois de cada mudança e cada recusa, salvo com a conversa. `revert(revisão, motivo)` desfaz pelo diário e registra uma revisão nova.
- **Duas formas de atualizar, à escolha de quem integra (`updates`):**
  - `'response'` (padrão): junto com a resposta. Pode vir como `ui.effect` `conversation.state`, aplicado no fim do turno, quando a resposta está completa e os trechos podem ser conferidos, ou pela ação `update_conversation_state` (JSON Schema gerado das seções, `confirm: 'never'`, `exposeTo` `assistant`/`agent`), que devolve o que valeu e o que foi recusado;
  - um `StateUpdater` (como `httpStateUpdater({ url })`): um canal à parte, chamado depois de cada turno concluído com o estado e as mensagens do turno. Roda fora da fila. A próxima requisição espera por ele até `wait` ms (padrão 2000) e depois segue com o estado que tem. Uma conversa nova o aborta;
  - `'manual'`: só `update()` do serviço (por exemplo, vindo de um WebSocket do app).
- **Enviado em campo próprio, separado das mensagens.** O estado vai em toda requisição como o sinal de contexto `conversation.state` (parte `data`): `{ revision, sections, rejected? }`, com `id`, `text`, `attrs`, `scope`, `origin`, `confidence`, `src` (ids) e `stated` por item. Os transportes já levam sinais de contexto sem mudar: no HTTP, `context['conversation.state']`; no AG-UI, uma entrada de `context` `conversation.state: {…}`. O `rejected` vai uma vez, para o modelo corrigir.
- **Guardar no front-end é opcional.** `persist` (padrão true) põe o estado no snapshot, e os storages o guardam (criptografado no `storage-local`). Com `persist: false`, ele vive só na aba. `send: false` não manda nada, para backends que guardam o estado do lado deles.
- **No servidor:** `@handsforbots/conversation-state/server` tem `readConversationState(origem)` (AG-UI, HTTP, sinais ou o próprio valor; nunca lança; descarta o malformado), `stateItems(view, { scope })` para filtrar por projeto, `stateUpdateSchema(seções)` para saída estruturada e `conversationStatePrompt(seções)` com as regras para o modelo. Sem core nem navegador.

**Consequências.**

- O backend recebe, em cada requisição, um estado pequeno com origem e confiança por item. Pode filtrar por `scope` antes de responder ou de buscar na memória episódica.
- O modelo precisa citar. Fatos sem trecho verificável não entram, e o modelo vê o motivo. É mais rígido que um resumo, e é de propósito: as seções sem exigência (`entities`, `pending`, `topic`) continuam livres, só com a confiança rebaixada.
- O estado vem do navegador e pode ser editado por quem usa a página. No backend, serve de contexto, nunca de autorização.
- A checagem do trecho prova que o texto foi dito, não que é verdade: um usuário pode afirmar algo falso. A `origin` diz quem afirmou.
- Com `tab-sync`, a última aba a salvar vence quando as revisões empatam; uma revisão menor é recusada.
- **Em aberto:** integrar com o `memory` (o resumo local poderia citar ids de itens do estado), validade no tempo (`validUntil`, como no Graphiti), aprovação de escritas pela pessoa (como o `write_approval` do Hermes) e eventos na `observability`.
