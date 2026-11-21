# Interrupção e conversa por voz

Como o Hands for Bots trata uma mensagem que chega enquanto o assistente ainda responde, e como o plugin de voz conduz uma conversa contínua: microfone aberto, detecção de fim de turno e barge-in. Registro da decisão: [ADR 0011](../adr/0011-interrupcao-e-fim-de-turno.md). Fontes: [Referências](./references.md).

## Entrada com o assistente ocupado

Os turnos rodam um por vez. O que uma mensagem digitada ou falada faz quando chega com um turno rodando é a **política de entrada**, `whileBusy`:

| Política | A mensagem nova… | A resposta em andamento… |
|---|---|---|
| `interrupt` (padrão) | vira o próximo turno | para; fica com o que foi exibido, marcada com `interrupted: true` |
| `merge` | junta-se a uma mensagem ainda não respondida, ou espera | continua |
| `queue` | espera tudo o que veio antes | continua |

Com `interrupt` e `merge`, um turno que **ainda não produziu nada** é retomado: é abortado, a mensagem do usuário sai do histórico e ele roda de novo com as duas entradas numa mensagem só. Mensagens enviadas em sequência rápida são unidas do mesmo jeito, então o backend recebe uma chamada em vez de várias. Mensagens digitadas são unidas com quebra de linha; fala, com espaço.

```ts
const h4b = createH4B({ plugins, input: { whileBusy: 'interrupt' } })

h4b.setInput({ whileBusy: 'queue' })                                   // em runtime, ex.: de uma tela de configurações
h4b.setInput({ whileBusy: { text: 'merge', transcript: 'interrupt' } }) // por modalidade; as ausentes usam 'interrupt'
h4b.setInput({ whileBusy: (signal) => (signal.source === 'widget' ? 'merge' : 'interrupt') })
h4b.signal({ modality: 'text', parts, source: 'meu-input', whileBusy: 'queue' }) // um sinal

h4b.getSnapshot().input // a política em vigor
```

Regras:

- Só triggers `text`, `transcript` e `audio` seguem a política. Eventos de GUI, comandos, `runAction` e `push` sempre entram na fila.
- Comandos diretos (menu) e capturas nunca são unidos: enquanto um trigger ainda está sendo roteado, a entrada nova só entra na fila, e é unida apenas se a rota for o transporte.
- O `ask()` entra na fila, a não ser que você passe `whileBusy`, porque o resultado dele é aguardado.
- Um trigger na fila com `queue` nunca absorve outros, e um turno cujo trigger tem `queue` nunca é cortado pela política.

Eventos: `signal.merged` (`{ signal, from, resumed }`) e `turn.interrupted` (`{ turnId, messageId?, kept?, removed? }`). O `getSnapshot().queued` mostra o texto unido, então a mensagem pendente esmaecida do widget se atualiza no lugar.

### Interromper sob demanda

`h4b.interrupt()` é o botão de parar, o Escape (o plugin `keyboard` usa) e o barge-in:

1. aborta o job em andamento (transportes e ações recebem o `AbortSignal`);
2. marca a mensagem do assistente daquele turno com `interrupted: true` e corta o texto onde os interceptadores `interrupt.before` disserem que a pessoa parou de recebê-lo: por padrão, tudo o que foi exibido;
3. remove a mensagem se não sobrar nada e ela não tiver tool calls;
4. emite `turn.interrupted` (com `by`, quem cortou) e salva;
5. avisa o backend no turno seguinte (veja abaixo).

Sem nada rodando, só corta a última resposta se um interceptador disser que parte dela não chegou (o plugin de voz informa o que foi falado). `interrupt({ clearQueue: true })` também esvazia a fila; `interrupt({ by: 'botao-parar' })` diz quem cortou (padrão `api`; entrada digitada dá a sua modalidade, o plugin de voz, `voice`). O `abort()` continua existindo e cancela sem mexer no histórico.

```ts
// Um plugin que sabe quanto da resposta a pessoa viu (ex.: revelação gradual):
ctx.intercept('interrupt.before', (point) => ({ ...point, keep: Math.min(point.keep, revelado(point.messageId)) }))
```

Deltas que chegam depois do corte são ignorados. O widget mostra respostas interrompidas com "…" no fim e uma dica (`strings.interrupted`).

### O que o seu backend precisa fazer

- **Parar de gerar quando a requisição é abortada.** O kernel fecha o stream (SSE do AG-UI, HTTP), mas só o servidor consegue parar a chamada ao LLM. Sem isso, a interrupção não economiza tokens.
- **Usar o histórico que recebe.** Os transportes enviam o histórico inteiro a cada execução. Um backend que guarda a própria cópia vai divergir: não verá mensagens unidas, turnos removidos nem respostas cortadas.
- **Aceitar mensagens do assistente truncadas.** Uma resposta interrompida termina no meio.
- **Ler o que aconteceu enquanto ele respondia** ([ADR 0015](../adr/0015-retorno-da-interrupcao.md)). A requisição seguinte leva sinais de contexto de um turno só (`once: true`, removidos depois dela):
  - `conversation.interrupted`: `{ messageId, kept, total, by }`, depois de uma interrupção que cortou uma resposta. `kept` é quantos caracteres ficaram (o que foi falado ou exibido), `total` o tamanho da resposta quando foi cortada, `by` quem cortou. Desligue com `createH4B({ input: { reportInterruptions: false } })`.
  - `voice.reactions`: `{ messageId, reactions: [{ at, text }] }`, os backchannels ouvidos enquanto o bot falava (veja [Barge-in](#barge-in)). Trate como pista: o reconhecimento do navegador costuma perder ou errar sons curtos.

  No fio eles aparecem como qualquer sinal de contexto: `context['conversation.interrupted'] = [{ … }]` no `http` e no `aiSdk`; no `agui`, um item de `context` com `description: 'gui-event from conversation.interrupted'` e `value: 'interrupted: {…}'` (`'transcript from voice.reactions'`, `'reactions: {…}'`). Diga ao modelo no prompt de sistema o que significam, por exemplo: "Se o usuário te interrompeu, não repita a parte que ele não ouviu, a menos que ele peça." 

## Voz: conversa contínua

`mode: 'hands-free'` mantém o microfone aberto. Os resultados finais do reconhecedor se acumulam em **um turno pendente** e saem como uma mensagem quando o turno termina.

```ts
import { voice, webSpeechSTT, webSpeechTTS, httpEndOfTurn } from '@handsforbots/voice'

voice({
  stt: webSpeechSTT(),
  tts: webSpeechTTS(),
  mode: 'hands-free',
  endOfTurn: httpEndOfTurn({ url: '/api/fim-de-turno' }), // opcional; sem ele, só silêncio
  turn: { silence: 800, minSilence: 300, maxSilence: 2000, threshold: 0.5, timeout: 600 },
  bargeIn: { minWords: 2 },
})
```

### Quando o turno termina

Depois de cada resultado final, o plugin espera. Toda pausa conta a partir das **últimas palavras ouvidas**, incluindo resultados parciais, e não de quando o reconhecedor entrega o resultado final (o Chrome entrega meio segundo ou mais depois que a pessoa para). Se o final chega com a espera já vencida, o turno sai na hora:

- **Sem provedor de fim de turno** (ou carregando, com falha, lento ou sem consentimento): envia depois de `silence` ms de silêncio.
- **Com provedor:** consulta depois de `minSilence` ms. Probabilidade ≥ `threshold` envia na hora; abaixo disso, espera até `maxSilence` ms. Se a resposta demora mais que `timeout` ms, ou falha, o silêncio decide.
- **Reconhecedor que detecta o turno sozinho** (`capabilities.endOfTurn`, resultados marcados com `{ endOfTurn: true | false }`): envia em `endOfTurn: true`, no máximo depois de `maxSilence`; o provedor não é chamado.

Voltar a falar antes disso mantém o turno aberto. Se o reconhecedor mostra palavras mas nunca as finaliza, elas são enviadas `maxSilence` depois das últimas palavras, sem contagem no estado (o plugin não distingue uma pausa de um reconhecimento lento até chegar um final). Se o turno já saiu e a resposta ainda não começou, o kernel junta a continuação a ele (política de entrada acima).

| Controle | Chamada |
|---|---|
| Enviar agora (pular a espera) | `voice.endTurn()`; palavras ainda sendo reconhecidas vão junto |
| Lixeira, continuar ouvindo | `voice.discardTurn()` |
| Enviar e fechar o microfone | `voice.stop()` |
| Descartar e fechar o microfone | `voice.cancel()` |
| Ligar/desligar o modelo em runtime | `voice.setEndOfTurn(provedor \| null)` |
| Tempos e barge-in em runtime | `voice.configure({ turn, bargeIn })` |
| Trocar ou desligar o filtro de eco em runtime | `voice.setEcho(filtro \| null)` |

### Provedores de fim de turno

Um provedor responde uma pergunta: a pessoa terminou ou só fez uma pausa? Ele devolve uma probabilidade; transformar isso em espera é trabalho do plugin, então qualquer provedor pode ser trocado sem mudar o comportamento.

```ts
type EndOfTurn = {
  name: string
  input: 'text' | 'audio'
  historyTurns?: number          // turnos recentes passados ao predict; padrão 6
  remote?: boolean               // o texto ou o áudio sai da página
  consent?: string               // finalidade de consentimento; pulado enquanto não concedida
  isSupported(): boolean | Promise<boolean>
  load?(): Promise<void>         // baixa um modelo sob demanda; o silêncio decide até resolver
  predict(input: { partial; history; language; audio? }, signal: AbortSignal): number | Promise<number>
}
```

Opções, das [Referências](./references.md#detecção-de-fim-de-turno):

| Tipo | Exemplos | Entrada | Onde | Custo |
|---|---|---|---|---|
| Classificador de texto | turn-detector da LiveKit, classificadores estilo BERT (FireRedChat) | transcrição + turnos recentes | seu servidor (`httpEndOfTurn`) ou o navegador | uma requisição por pausa, ou nada se local |
| Classificador de áudio | Smart Turn da Pipecat (ONNX) | últimos segundos de áudio | o navegador (`onnxruntime-web`) ou seu servidor | nada se local |
| Modelo de decisão tipada ou LLM geral | um modelo de decisão, o LLM do seu backend | transcrição + turnos recentes | seu servidor (`httpEndOfTurn`) | tokens por pausa |
| Reconhecedor com endpointing | AssemblyAI, Soniox, OpenAI Realtime (`semantic_vad`) | dentro do STT | o provedor | incluído no STT |

`httpEndOfTurn({ url, headers?, parse?, historyTurns?, consent?, fetch?, name? })` faz POST de `{ partial, history, language }` e lê `{ probability }` ou `{ done: boolean }` (mude com `parse`). As chaves ficam no seu servidor:

```ts
// No servidor (qualquer framework): responda com a probabilidade de a pessoa ter terminado.
app.post('/api/fim-de-turno', async (req, res) => {
  const { partial, history, language } = req.body
  const probability = await meuClassificador(partial, history, language) // seu modelo ou serviço
  res.json({ probability })
})
```

Um provedor local:

```ts
const smartTurn: EndOfTurn = {
  name: 'smart-turn',
  input: 'audio',
  isSupported: () => typeof WebAssembly === 'object',
  load: async () => { sessao = await carregarSmartTurn() },   // ex.: onnxruntime-web
  predict: async ({ audio }) => rodarSmartTurn(sessao, audio!.samples, audio!.sampleRate),
}
```

Provedores de áudio recebem os últimos `turn.audioSeconds` segundos (padrão 8) do mesmo microfone, só de reconhecedores com `capabilities.audio`: `websocketSTT`, `voskSTT` e `voskBrowserSTT`. O Web Speech não expõe o áudio; com `webSpeechSTT`, use um provedor de texto. Meça latência e acerto no seu idioma antes de escolher: os números publicados são dos fornecedores.

### Barge-in

Falar por cima do bot o interrompe quando ele está falando ou exibindo uma resposta que ainda chega. O plugin chama `h4b.interrupt()` antes de parar a fala, então a resposta fica só com as frases já faladas:

- uma transcrição parcial precisa de `minWords` palavras (padrão 2); um resultado final sempre conta;
- backchannels nunca interrompem: "aham", "uhum", "tá", "ok", "uh-huh", "mhm"… (uma lista para pt, en e es; troque com `bargeIn: { ignore: [...] }`). Eles não se perdem: cada um vai para o `voice.decision` (`reason: 'backchannel'`, com o `messageId` que estava sendo falado e `at`, quantos caracteres dele já tinham sido falados) e para o backend no turno seguinte como `voice.reactions`, para ele saber que trecho chamou a atenção. `reactions: false` deixa o backend sem eles. O H4B não tenta adivinhar o significado ("hum." e "hum?" viram o mesmo texto);
- apertar para falar enquanto o bot responde também interrompe;
- enquanto o bot ainda está pensando (nada exibido), a fala não interrompe: quando o turno termina, o kernel retoma o turno com as duas mensagens.

`bargeIn: false` desliga isso e pausa o reconhecimento enquanto o bot fala, para o microfone não ouvi-lo.

### Filtro de eco

Com alto-falante, a voz do bot volta pelo microfone e o reconhecedor a transcreve como se fosse a pessoa: o bot se interrompe ou responde a si mesmo. O cancelamento de eco do navegador nem sempre ajuda, porque só remove o som que ele sabe que tocou: a fala do `speechSynthesis` sai pelo sistema operacional, fora do caminho de áudio do navegador. Isso acontece mesmo em equipamento bom (o alto-falante de um notebook fica a poucos centímetros do microfone).

Por isso o plugin de voz passa tudo o que ouve enquanto o bot fala, e por um instante depois (`tail`), por um **filtro de eco** antes do barge-in e do turno. O padrão, `textEchoFilter()`, compara palavras, não áudio, então funciona com qualquer reconhecedor, inclusive o Web Speech:

- um texto é eco quando pelo menos `threshold` (padrão 0,6) das palavras repetem o que o bot disse, em sequências de pelo menos `minRun` (padrão 2) palavras seguidas na mesma ordem; maiúsculas, acentos e pontuação são ignorados, e palavras de 4 letras ou mais podem ter uma letra errada;
- a decisão é tudo ou nada: o eco é descartado (`voice.decision` `{ kind: 'ignore', reason: 'echo' }`) e o resto passa inteiro, então quem cita o bot enquanto fala por cima dele nunca é cortado;
- uma palavra sozinha sempre passa: não dá para distinguir da pessoa dizendo a mesma palavra;
- as frases do bot contam enquanto são faladas e por `tail` ms depois (padrão 2000), porque os reconhecedores entregam resultados atrasados; depois disso a pessoa pode repetir o bot à vontade.

É uma peça substituível, como o provedor de fim de turno:

```ts
import { voice, textEchoFilter, type EchoFilter } from '@handsforbots/voice'

voice({ stt, tts, mode: 'hands-free' })                                    // textEchoFilter() por padrão
voice({ stt, tts, mode: 'hands-free', echo: textEchoFilter({ threshold: 0.5, tail: 1500 }) })
voice({ stt, tts, mode: 'hands-free', echo: false })                       // desligado (ex.: só com fone)

const meuFiltro: EchoFilter = {
  name: 'meu-filtro',
  tail: 2000,
  // speech: as frases sendo faladas e as que terminaram dentro de `tail`, da mais antiga para a mais nova
  filter: ({ text, final, speech, language }) => (pareceOBot(text, speech) ? '' : text),
}
h4b.get('voice').setEcho(meuFiltro) // ou null para desligar
```

`filter` devolve o que a pessoa disse: o próprio texto, um texto menor, ou `''` quando era tudo eco. Ele roda a cada transcrição parcial, então precisa ser síncrono e rápido; se lançar um erro, o erro vai para `h4b.on('error')` (`source: 'voice:echo:<nome>'`) e o texto é mantido. `getState().echo` traz o nome do filtro em uso.

### Saída falada

As respostas são faladas **frase a frase enquanto chegam**, então o bot começa a falar antes de a resposta terminar, e uma interrupção sabe quais frases foram ouvidas. A saída segue a entrada (`output: 'auto'`): resposta falada depois de fala, texto depois de digitação.

### Estado para a sua interface

`voice.getState()` (assine com `voice.subscribe()`):

| Campo | Significado |
|---|---|
| `phase` | `idle`, `listening`, `userSpeaking`, `waitingEndOfTurn`, `botSpeaking` |
| `partial` | no mãos-livres, o turno pendente inteiro mais as palavras sendo reconhecidas |
| `pauseSince` | quando as últimas palavras do turno pendente foram ouvidas (epoch ms); a pausa começa aqui |
| `endOfTurnAt` | o momento mais tarde em que o turno pendente será enviado se a pessoa ficar quieta (epoch ms) |
| `endOfTurnCheckAt` | quando o provedor de fim de turno é consultado (epoch ms); só existe enquanto ele ainda pode enviar o turno **antes** de `endOfTurnAt` |
| `interrupted` | a pessoa cortou a última resposta; volta a `false` quando a próxima começa |
| `endOfTurn` | nome do provedor de fim de turno em uso |
| `listening`, `speaking`, `error`, `stt`, `tts`, `lastInput`, `output`, `mode` | como antes |

Os três são horários, não tempo restante, então a interface só renderiza quando eles mudam, não a cada instante. Para desenhar a pausa, comece uma animação CSS quando `pauseSince` mudar, com duração de `endOfTurnAt - pauseSince` ms e atraso negativo de `pauseSince - Date.now()` ms: a pausa costuma ter começado antes de o estado chegar, então a linha já começa andada. Esconda quando `endOfTurnAt` for `undefined` (a pessoa voltou a falar ou o turno saiu). `endOfTurnAt` pode mudar:

- **Sem provedor**, ou com reconhecedor que decide sozinho: não muda; o turno sai em `endOfTurnAt`.
- **Com provedor**, enquanto `endOfTurnCheckAt` existe: ninguém sabe ainda o que o provedor vai responder, e o turno pode sair a qualquer momento a partir de `endOfTurnCheckAt`. Mostre que a espera pode acabar antes (uma linha mais rápida ou tracejada, por exemplo) em vez de prometer a contagem inteira.
- O provedor responde "não terminou": `endOfTurnCheckAt` some e `endOfTurnAt` passa a ser exato.
- O provedor demora ou falha: `endOfTurnCheckAt` some e `endOfTurnAt` fica mais cedo, em `pauseSince + silence`. Mantenha o começo e mude a duração. Com os padrões, esse prazo quase sempre já passou quando o `timeout` acaba (o provedor é consultado em `minSilence`, e `minSilence + timeout` > `silence`), então o turno sai na hora; um prazo ainda à frente só aparece quando o provedor falha rápido.

Toda interrupção, backchannel ou eco ignorado e fim de turno é informado em `h4b.on('voice.decision', d => …)`: `{ kind: 'interrupt' | 'ignore' | 'end-of-turn' | 'end-of-turn-unavailable', … }`. Registre isso enquanto ajusta.

### Privacidade e eco

- Provedores declaram se o áudio ou o texto saem da página (`remote`). O `webSpeechSTT` conta como remoto: navegadores como o Chrome mandam o áudio para o serviço de fala deles, e no mãos-livres isso é contínuo. Provedores remotos de fim de turno mandam a transcrição para o seu servidor e, de lá, para quem roda o modelo.
- Dê a um provedor uma finalidade `consent` e ele só é usado enquanto ela está concedida ([Consentimento](./consent.md)); o plugin passa ao próximo reconhecedor, ou ao silêncio. Retirá-la no meio da sessão aborta a escuta na hora (mesmo antes de o reconhecedor terminar de abrir) e descarta o que ele ouviu. Mostrar o aviso e guardar a decisão é do seu app.
- Reconhecedores que abrem o microfone (`httpSTT`, `websocketSTT`, `voskSTT`, `voskBrowserSTT`) usam cancelamento de eco, supressão de ruído e ganho automático. O Web Speech cuida do próprio microfone; o quanto ele ignora a voz do bot depende do aparelho. O [filtro de eco](#filtro-de-eco) cobre o que passar. Teste com e sem fone.
- O Safari no iOS encerra as sessões de reconhecimento sozinho; o mãos-livres as reinicia, mas teste sessões longas em aparelhos reais.

### Ambientes com ruído

O navegador não tem uma API que diga "este ambiente tem ruído demais": a página precisa medir o áudio. O `checkNoise()` abre o microfone por um instante, mede e fecha, para você avisar a pessoa antes que o primeiro turno dê errado:

```ts
import { checkNoise } from '@handsforbots/voice'

const relatorio = await checkNoise({ durationMs: 1500 }) // peça silêncio à pessoa enquanto isso
if (relatorio.verdict !== 'quiet') mostrarDica(relatorio.reasons) // ex.: "vá para um lugar mais quieto ou use fone"
```

O `measureNoise(stream, opções)` faz o mesmo num stream que você já abriu, e o `createNoiseMeter()` / `assessNoise()` trabalham com amostras ou níveis de frame que você já tem (um reconhecedor que expõe o áudio, uma gravação), sem microfone nenhum.

O relatório (`NoiseReport`) traz os números e um veredito, `quiet`, `noisy` ou `too-noisy`, com os motivos em `reasons`:

| Campo | Significado |
|---|---|
| `noiseFloorDb` | percentil 10 dos níveis dos frames de 20 ms, em dBFS (0 é a escala cheia): o ruído do ambiente |
| `peakDb`, `dynamicRangeDb` | percentil 95, e quanto ele fica acima do piso |
| `snrDb` | relação sinal-ruído estimada; só aparece quando a faixa é larga o bastante (`speechRangeDb`, 12 dB) para ser a fala da pessoa |
| `fluctuationDb` | percentil 75 menos o 10: perto de 0 para ruído constante (ventilador), alto para vozes, TV ou trânsito |
| `clippingRatio` | fração das amostras na escala cheia |

| Motivo | Quando (padrões) | Veredito |
|---|---|---|
| `loud-floor` | piso a partir de -50 dBFS; a partir de -35 dBFS | `noisy`; `too-noisy` |
| `fluctuating` | sem fala detectada e `fluctuationDb` a partir de 6 dB, com piso acima de -60 dBFS | `noisy` |
| `low-snr` | com fala e `snrDb` abaixo de 15 dB, com piso acima de -60 dBFS | `noisy` |
| `clipping` | `clippingRatio` a partir de 0,001 (ganho alto demais, ou grito no microfone) | `noisy` |
| `silent-input` | `peakDb` em -90 dBFS ou menos: microfone mudo ou aparelho errado | não muda |

Mude qualquer limite com `thresholds`. Os padrões são um ponto de partida: dBFS não é pressão sonora, e o mesmo ambiente mede diferente em cada microfone e ganho, então calibre com gravações dos aparelhos de quem usa. O ruído que flutua é o que preocupa: a supressão de ruído tira bem um ventilador, mas não gente conversando por perto, e os reconhecedores confundem essas vozes com a da pessoa.

Por padrão o `checkNoise()` mede o sinal cru (`processing: false`): a supressão de ruído esconderia o ruído constante, e o ganho automático sobe o piso enquanto ninguém fala. `processing: true` mede o que os reconhecedores de microfone ouvem. O Web Speech abre o próprio microfone, então com ele o teste é sempre uma medição à parte.

`timeoutMs` limita o tempo total de relógio do `checkNoise()` e do `measureNoise()` (padrão `durationMs + 2000`; `0` desliga), para que um grafo de áudio travado ou suspenso lance `audio-capture` em vez de pendurar. Os auxiliares de captura (`captureFloat`, `capturePcm16`, `monitorLevel`) retomam um `AudioContext` suspenso, e o `checkNoise()` cria e retoma o `AudioContext` antes do `getUserMedia`, enquanto o gesto da pessoa ainda vale.

#### Teste antes do mãos-livres

O plugin de voz pode rodar o teste sozinho. Ligue com a opção `noise` (desligada por padrão, porque abre o microfone por um instante antes de ouvir):

```ts
voice({ stt, tts, mode: 'hands-free', noise: true })
voice({ stt, tts, mode: 'hands-free', noise: { tooNoisy: 'warn', maxAgeMs: 60_000, thresholds: { noisyFloorDb: -45 } } })
```

- Com `check: 'hands-free'` (padrão), o `listen()` no mãos-livres mede o ambiente primeiro e depois começa a ouvir. `getState().checkingNoise` permanece `true` até `listening` virar `true` (ou até a troca de modo, `stop()` ou `cancel()`), sem um intervalo ocioso entre os dois. Depois que o `checkNoise()` embutido fecha o microfone, o plugin espera `settleMs` ms (padrão `100`, `0` quando `measure` é passado; `0` desliga) antes de iniciar o reconhecedor, evitando disputa pelo dispositivo de áudio (CoreAudio, Bluetooth, celular). `timeoutMs` é repassado ao `checkNoise()`. O push-to-talk não é testado.
- `too-noisy` com `tooNoisy: 'push-to-talk'` (padrão): o modo vira `push-to-talk`, `noiseFallback` fica `true` e a escuta não começa. Microfone aberto num ambiente barulhento interrompe o bot e nunca encerra o turno; segurar para falar não tem esse problema. O `noiseFallback` some no próximo `setMode()`. `tooNoisy: 'warn'` só informa.
- `noisy` (ou `too-noisy` com `warn`): a escuta começa; o relatório fica em `getState().noise` para a interface avisar a pessoa.
- Um relatório mais novo que `maxAgeMs` (5 minutos) é reaproveitado, então pausar e voltar não mede de novo. Sempre que não for preciso medir agora (`noise` desligado, push-to-talk, `check: 'manual'` ou relatório em cache dentro de `maxAgeMs`), o `listen()` inicia o reconhecedor de forma síncrona na própria chamada, preservando a ativação por gesto do navegador.
- `stop()`, `cancel()`, `toggle()` ou desmontar o app (`h4b.stop()`) durante o teste o abortam, e nada é ouvido. Se a medição falhar (microfone negado, por exemplo), o erro vai para o `h4b.on('error')` com `source: 'voice:noise'` e a escuta começa assim mesmo: o reconhecedor informa os próprios erros de microfone.
- Cada teste terminado emite `voice.noise` `{ report, action? }`, com `action: 'push-to-talk'` quando o modo mudou. O `voice.checkNoise()` mede quando você pedir (também com `check: 'manual'`, que nunca mede antes de ouvir). Com `webSpeechSTT` no Safari/iOS, esperar o `getUserMedia` e o `durationMs` durante `check: 'hands-free'` pode ultrapassar a ativação transitória do gesto exigida pelo `SpeechRecognition.start()`: rode `voice.checkNoise()` antes (ou use `check: 'manual'`) para manter o relatório em cache por `maxAgeMs` e deixar o `listen()` iniciar o `SpeechRecognition` de forma síncrona dentro do clique ou toque.
- `measure(signal)` substitui a medição (um modelo, o seu servidor, um teste) e deve devolver um `NoiseReport`; o `assessNoise()` monta um a partir dos níveis dos frames.

O widget mostra o teste: "Verificando o ruído do ambiente…" enquanto ele roda (o botão do microfone fica com `aria-busy`), um aviso no lugar de "Ouvindo…" quando há ruído, e "Ruído demais para o mãos-livres. Segure o microfone para falar." depois da troca de modo. Mude os textos com `strings: { noiseChecking, noiseHint, noiseTooLoud }`; estilize o aviso com `.partial.noisy` via `::part()` ou na sua própria interface. Um erro de escuta substitui o aviso.

O `httpSTT` encerra a fala por silêncio com o `detectEndOfSpeech`, que agora também acompanha o ambiente: é fala o nível acima de `threshold` (0,015 RMS) **e** acima de `margin` (3, cerca de 10 dB) vezes o piso de ruído dos últimos `floorMs` (3000 ms, o menor nível ouvido nessa janela). Num ambiente barulhento o limite fixo antigo tomava o ruído por fala, e a fala só acabava no limite de tempo. `margin: 0` mantém o limite fixo.

#### Vozes por perto: o portão de nível

O teste de ruído diz que o ambiente é barulhento; ele não impede que uma TV ou um colega interrompam o bot. O portão de nível impede, sem modelo: a pessoa fala no microfone, então a voz dela costuma ficar bem acima das vozes em volta. O portão aprende o volume das falas aceitas da pessoa e descarta fala bem mais baixa que isso.

```ts
voice({ stt, tts, mode: 'hands-free', levelGate: true })
voice({ stt, tts, mode: 'hands-free', levelGate: { scope: 'all', gapDb: 12 } })
```

- Só no mãos-livres. Enquanto ouve, abre uma segunda captura do microfone (com o mesmo processamento dos reconhecedores) e lê o nível a cada 50 ms; fecha quando a escuta para. O push-to-talk nunca passa pelo portão: a pessoa está apertando o botão.
- **Aprendizado:** cada fala do mãos-livres que entra num turno acrescenta o topo (percentil 95) dos últimos `lookbackMs` (3000) de áudio; o nível da pessoa é a mediana das últimas `remember` (5). Falas ouvidas enquanto o bot fala, ou até `lookbackMs` depois, não entram no aprendizado. Antes da primeira, nada é descartado. `getState().userLevelDb` mostra o nível aprendido.
- **Julgamento:** quando chega uma transcrição, o topo dos últimos `lookbackMs` é comparado com `userLevelDb - gapDb` (10 dB). Abaixo disso, a fala é de fundo.
- `scope: 'barge-in'` (padrão): fala de fundo ouvida enquanto o bot responde não o interrompe nem vira turno. `scope: 'all'`: a fala de fundo também é descartada com o bot calado, então nunca abre nem aumenta um turno.
- Finais descartados vão ao `voice.decision` como `{ kind: 'ignore', reason: 'background', text, levelDb, userLevelDb }`. Se a captura não abrir, o erro vai para o `h4b.on('error')` com `source: 'voice:level-gate'` e a escuta segue sem portão.
- `open(onLevel)` substitui a captura (testes, ou áudio que você já captura); `createLevelGate()` é a mesma lógica para o seu código.

Limites, por ser uma regra de volume:

- Descarta a pessoa também quando ela fala bem mais baixo que o normal ou se afasta do microfone; e deixa passar vozes de fundo tão altas quanto a dela. Com `scope: 'all'`, um nível aprendido errado pode continuar descartando a pessoa, e por isso o padrão só protege o barge-in: depois que o bot termina, a pessoa é ouvida e o nível é aprendido de novo.
- Enquanto o bot fala pelo alto-falante, a voz dele também entra na janela. O cancelamento de eco a remove quando o bot toca pela página (`httpTTS`, os modelos do `voice-models`); o `speechSynthesis` toca fora do caminho de áudio do navegador, então com `webSpeechTTS` e alto-falante a própria voz do bot pode fazer uma voz de fundo parecer alta o bastante. Fone resolve.
- Os reconhecedores entregam a transcrição com atraso, e a janela tem alguns segundos: uma fala da pessoa logo antes de uma voz de fundo pode fazê-la passar.
- Saber *quem* fala exige um modelo condicionado à voz da pessoa (veja as [referências](./references.md#teste-de-ruído-do-microfone)); o portão só sabe *quão alto*.

#### Depurando o ruído e o portão de nível

Voz que "se comporta de um jeito estranho" em alguns lugares muitas vezes é o ambiente. Tudo o que o teste de ruído e o portão de nível decidem fica visível, com níveis em dBFS e sem áudio:

| Onde | O quê |
|---|---|
| `getState()` | `noise` (o último relatório), `checkingNoise`, `noiseFallback`, `userLevelDb` |
| `h4b.on('voice.noise', …)` | `{ report, action? }` depois de cada teste; `action: 'push-to-talk'` quando o modo mudou |
| `h4b.on('voice.level', …)` | `monitor.open` / `monitor.close`; `learned` `{ levelDb, userLevelDb, gateDb }` a cada fala que ensina o portão; `learn.skipped` `{ reason: 'bot-speech' \| 'no-audio' }` |
| `h4b.on('voice.decision', …)` | `ignore` com `reason: 'background'` e `levelDb` / `userLevelDb` para cada final descartado; o `interrupt` também traz `levelDb` / `userLevelDb` enquanto o portão escuta |
| `h4b.on('error', …)` | `source: 'voice:noise'` (o teste falhou), `voice:level-gate` (a captura não abriu: sem portão) |
| `observability` | grava tudo isso (`voice.noise`, `voice.level.<evento>`, `voice.decision` sem a transcrição, a não ser com `includeContent`) |

| Sintoma | Olhe |
|---|---|
| O mãos-livres virou push-to-talk | `voice.noise` com `action: 'push-to-talk'`: os `reasons` e o `noiseFloorDb`. Se o ambiente estava bom, os limites estão rígidos demais para aquele microfone |
| A TV ainda interrompe o bot | a decisão `interrupt`: `levelDb` perto do `userLevelDb` quer dizer que a TV está tão alta quanto a pessoa (ou que a voz do próprio bot está na janela, com `webSpeechTTS` no alto-falante); sem níveis, o portão está desligado ou a captura falhou |
| As palavras da pessoa são ignoradas | decisões `background`: `levelDb` bem abaixo do `userLevelDb`. Veja os eventos `learned`: um `userLevelDb` alto (a pessoa gritou, ou aprendeu com a TV alta) descarta fala normal; aumente o `gapDb` |
| O `userLevelDb` nunca aparece | `learn.skipped` com `bot-speech` (a pessoa só falou por cima do bot ou logo depois dele) ou `no-audio` (a captura não está lendo), ou um erro `voice:level-gate` |

### Ajustes

| Sintoma | Tente |
|---|---|
| Corta a pessoa no meio da frase | aumentar `silence`, ou adicionar um provedor de fim de turno e aumentar `threshold` |
| Demora para responder | diminuir `silence`; com provedor, diminuir `minSilence` e verificar a latência dele |
| O bot interrompe a si mesmo | ver se o `voice.decision` mostra `reason: 'echo'`; diminuir `echo.threshold` ou aumentar `echo.tail`; fone, um reconhecedor de microfone com cancelamento de eco, `minWords` maior, ou `bargeIn: false` |
| Fala da pessoa descartada como eco | aumentar `echo.threshold` ou `minRun`, diminuir `tail`, ou `echo: false` com fone |
| "ok"/"sim" interrompem o bot | acrescentá-los a `bargeIn.ignore` |
| TV ou gente por perto interrompe o bot | `levelGate: true` (mãos-livres); `scope: 'all'` se também abrem turnos; fone |
| O reconhecimento falha em alguns lugares | rode o [`checkNoise()`](#ambientes-com-ruído) e sugira um lugar mais quieto ou fone quando não der `quiet` |
| Muitas chamadas ao backend enquanto ele pensa | manter `whileBusy` em `interrupt` ou `merge` (a retomada as une) |
