# Síntese de voz e efeitos

Como o assistente fala: a voz do navegador, uma voz do seu backend ou um modelo neural que roda na página, com uma cadeia de efeitos por cima. Três pacotes dividem o trabalho:

| Pacote | O que traz |
|---|---|
| [`@handsforbots/voice`](./plugins.md#voice) | O plugin `voice`: fala as respostas frase a frase, escolhe o provedor, decide quando os modelos baixam e quem fala enquanto isso, toca o áudio pelo Web Audio. Provedores `webSpeechTTS` e `httpTTS` |
| [`@handsforbots/voice-models`](./plugins.md#voice-models) | Modelos na página: `piperTTS`, `kokoroTTS`, `transformersTTS`, e `workerTTS` para rodar qualquer um deles num Worker. Arquivos do Hugging Face, de qualquer URL, de uma pasta que você serve ou de bytes que o app já tem, baixados com progresso e guardados em cache |
| [`@handsforbots/voice-effects`](./plugins.md#voice-effects) | Efeitos em JSON: filtros, dinâmica, modulação, eco, reverb, distorção; presets; renderização offline; exportação para SSML e FFmpeg |

Teste tudo no laboratório: `pnpm --filter @handsforbots/example-voice-lab dev` ([examples/voice-lab](../../examples/voice-lab/README.md)).

## Começo rápido

```ts
import * as ort from 'onnxruntime-web/wasm'
import { createH4B } from '@handsforbots/core'
import { voice, webSpeechSTT, webSpeechTTS } from '@handsforbots/voice'
import { espeakPhonemizer, piperTTS, piperVoice } from '@handsforbots/voice-models'
import { voiceEffects } from '@handsforbots/voice-effects'

const piper = piperTTS({
  ...piperVoice('pt_BR-faber-medium'), // rhasspy/piper-voices no Hugging Face
  phonemizer: espeakPhonemizer({ module: () => import('./vendor/piper_phonemize.js'), wasm: '/vendor/piper_phonemize.wasm', data: '/vendor/piper_phonemize.data' }),
  runtime: ort,
})

const h4b = createH4B({
  plugins: [
    voice({
      stt: webSpeechSTT(),
      tts: [piper, webSpeechTTS()], // o modelo, e a voz do navegador enquanto ele baixa
      language: 'pt-BR',
      load: { start: 'idle', whileLoading: 'fallback' },
      effects: voiceEffects('radio'),
    }),
  ],
})
await h4b.start()
```

Nada mais muda: o widget, o barge-in, o filtro de eco e os `tracks` funcionam igual com qualquer provedor.

## De onde vem a voz

| Provedor | Onde roda | Download | Qualidade | Efeitos | Observações |
|---|---|---|---|---|---|
| `webSpeechTTS()` | O navegador / o sistema | nenhum | depende do sistema; robótica em muitos Androids | só prosódia | Grátis, instantâneo, offline na maioria dos sistemas. O áudio nunca passa pela página |
| `httpTTS({ url })` | Seu backend (OpenAI, Azure, Google, Polly, ElevenLabs, seu próprio Piper…) | nenhum | a melhor disponível | todos | As chaves ficam no servidor. Latência de rede por frase. O texto sai da página (`remote: true`) |
| `piperTTS(...)` | A página (ONNX, WebAssembly) | 15–115 MB por voz + fonemizador | boa, clara | todos | Rápido em CPU, um idioma por voz, dezenas de idiomas. Licenças variam por voz |
| `kokoroTTS(...)` | A página (ONNX) | 92–326 MB + fonemizador | muito natural | todos | Vários idiomas, 24 kHz, pesado: mais lento que o tempo real numa thread de CPU (veja [Desempenho](#desempenho)) |
| `transformersTTS(...)` | A página ([transformers.js](https://huggingface.co/docs/transformers.js)) | depende do modelo | depende | todos | Qualquer pipeline `text-to-speech` (MMS, SpeechT5, VITS…); o transformers.js baixa e guarda em cache sozinho |

Regra prática: comece com `webSpeechTTS` (custo zero), acrescente `httpTTS` quando a qualidade importa e um servidor serve, acrescente um modelo na página quando o áudio não pode sair do aparelho, ou para ter a mesma voz em todo lugar sem pagar por caractere.

Os provedores são uma lista: o primeiro utilizável fala; os seguintes são reservas (sem suporte, ainda baixando ou com falha). `setTTS(lista)` troca a lista em runtime (a pessoa escolheu outra voz).

## Arquivos de modelo: de onde vêm

Todo arquivo de modelo é um `ModelSource`:

```ts
import { huggingFace } from '@handsforbots/voice-models'

huggingFace('rhasspy/piper-voices', 'pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx', { revision: 'a1b2c3…' }) // o Hub
'/models/pt_BR-faber-medium.onnx'           // uma pasta que seu servidor ou CDN serve
{ url: '/models/pt_BR-faber-medium.onnx', sha256: '<hex>' } // qualquer URL fixada por SHA-256
'https://cdn.exemplo.com/vozes/x.onnx'      // qualquer URL (o CORS precisa liberar sua origem)
fileInput.files[0]                          // um Blob que a pessoa escolheu, ou que você guardou no OPFS
new Uint8Array(bytes)                       // bytes que você já tem
async () => fetch('/api/voz', { headers })  // qualquer coisa: URL assinada, rota autenticada…
```

- Helpers montam os caminhos do Hub: `piperVoice('pt_BR-faber-medium')` → `{ model, config }`, `kokoroModel({ dtype: 'q8', voices: ['pf_dora'] })` → `{ model, tokenizer, voices }`.
- **Fixe uma revisão** (um hash de commit) em produção, e o digest do arquivo: `huggingFace(repo, arquivo, { revision: '<commit>', sha256: '<hex>' })` ou `{ url: '/models/voz.onnx', sha256: '<hex>' }`. `main` pode mudar sem aviso; com `sha256`, um arquivo trocado ou envenenado (na rede ou no Cache Storage) é recusado. Os ids de voz são conferidos (`pt_BR-faber-medium`, `pf_dora`).
- **Uma pasta sua**: espelhe os arquivos e aponte as fontes para ela. Arquivos na mesma origem evitam CORS e a dependência de terceiros. Um espelho do Hub inteiro funciona com `huggingFace(repo, file, { endpoint })`.
- **Cache**: os downloads ficam no Cache Storage (`h4b-voice-models`) e vêm de lá da próxima vez. Respostas HTML (como o fallback 200 de uma SPA), corpos vazios, JSON inválido e `.wasm` inválido são recusados antes de gravar no cache; se uma entrada envenenada já estiver gravada, ou se o ONNX/WebAssembly falhar ao abrir o arquivo, ela é apagada. `cache: false` desliga, `cache: meuCache` substitui (`{ match, put, delete? }`), `clearModelCache()` apaga (um botão "liberar espaço").
- **Progresso**: `fetchModel` lê o stream e informa `{ loaded, total, file }`. Uma transferência comprimida (`Content-Encoding`) deixa o total desconhecido; declare o `size` do provedor para mostrar porcentagem mesmo assim.

## Quando o download começa e quem fala enquanto isso

```ts
voice({
  tts: [kokoro, webSpeechTTS()],
  load: { start: 'first-use', whileLoading: 'fallback' }, // o padrão
})
```

`load.start`:

| Valor | O modelo começa a baixar… | Bom para |
|---|---|---|
| `'first-use'` (padrão) | quando a pessoa liga a voz do bot (`setOutput('voice')` ou `setOutput('auto')`, como faz o botão de alto-falante do widget) ou o bot fala pela primeira vez, o que vier primeiro; ao montar, se você definir `output: 'voice'`. O microfone sozinho não baixa nada | sites onde poucos visitantes falam com o bot |
| `'eager'` | quando o plugin monta | apps em que a voz é o principal |
| `'idle'` | quando a página fica ociosa (`requestIdleCallback`, no máximo 5 s depois) | baixar cedo sem disputar com o carregamento da página |
| `'manual'` | só quando você chama `voice.loadSpeech()` | perguntar antes ("Baixar uma voz melhor, 82 MB?"), só no Wi-Fi, depois do consentimento |

`load.whileLoading`:

| Valor | Enquanto o modelo não está pronto… |
|---|---|
| `'fallback'` (padrão) | o próximo provedor pronto da lista fala (em geral `webSpeechTTS`), e o modelo assume frase a frase quando fica pronto |
| `'wait'` | a fala espera um download em andamento (a resposta aparece na tela). Sem nada baixando (`manual` antes do `loadSpeech()`), nada é dito |
| `'silent'` | o bot não fala até o modelo ficar pronto |

Estado e controle:

```ts
const voz = h4b.get('voice')
voz.getState().ttsStatus
// { kokoro: { state: 'loading', loaded: 31_000_000, total: 111_000_000 }, webspeech: { state: 'ready' } }
await voz.loadSpeech()          // true quando pronto, false se falhou (o erro fica em ttsStatus e no evento `error`)
voz.getState().synthesizing     // uma frase está sendo sintetizada (mostre "…" antes de a voz começar)
```

- `state` é `unloaded`, `loading`, `ready` ou `failed`. Chamar `loadSpeech()` de novo depois de uma falha tenta outra vez.
- Um provedor que falha ao carregar informa o erro (`source: 'voice:tts:<nome>'`) e, quando o download era desejado, o próximo modelo da lista começa.
- Provedores declaram `size` (bytes), para você perguntar antes de um download `manual`.
- Uma frase cuja síntese falha é falada pelo próximo provedor pronto.

## Reprodução

Os provedores ou tocam sozinhos (`speak`: a voz do navegador, `httpTTS({ playback: 'element' })`) ou devolvem áudio (`synthesize` → `{ samples, sampleRate }`) para o plugin tocar pelo Web Audio. O segundo tipo ganha efeitos, tempo exato para o barge-in e síntese da próxima frase enquanto a atual toca.

- **Autoplay.** Safari e Firefox só começam áudio depois de um gesto da pessoa. O plugin libera o áudio no primeiro toque, clique ou tecla na página, e quando a escuta começa. Se a fala puder começar muito depois de qualquer gesto (uma resposta que leva minutos), chame `voz.unlockAudio()` dentro de um clique. Provedores que precisam de um gesto próprio também o recebem (o `webSpeechTTS()` fala um enunciado mudo, exigência do Safari no iOS). Se o navegador ainda bloquear, a frase não é falada e `getState().error` é `{ code: 'output-blocked', stage: 'speak' }`: mostre um botão "toque para ouvir" que chama `unlockAudio()`. Quando o Safari no iOS nem fala nem informa erro, o `webSpeechTTS({ startTimeout })` (padrão 5000 ms) transforma o silêncio em `synthesis-failed`.
- `webAudioPlayer({ context?, output? })` é o player padrão: passe seu próprio `AudioContext` (para dividir com o app) ou `output: (ctx) => node` (para mandar a fala para o seu mixer, ou para um `AnalyserNode` que mexe a boca de um personagem). Implemente `AudioPlayer` para qualquer outra coisa.
- `encodeWav(audio)` transforma áudio sintetizado num `Blob` WAV (download, upload, cache de frases fixas).

## Prosódia: velocidade, altura, volume

A prosódia faz parte da cadeia de efeitos (`prosody: { rate?: 1, pitch?: 0, volume?: 0 }`; altura em semitons, volume em dB) e cada provedor recebe o que consegue aplicar:

| Provedor | Velocidade | Altura | Volume |
|---|---|---|---|
| `webSpeechTTS` | `utterance.rate` | `utterance.pitch` (±12 st vira 0,5–2) | `utterance.volume` (cortado em 0 dB) |
| `piperTTS` | `length_scale` (o modelo fala mais devagar ou mais rápido, mesma voz) | player (velocidade de reprodução, com o modelo compensando o andamento) | ganho do player |
| `kokoroTTS` | entrada `speed` | player | ganho do player |
| `httpTTS({ prosody: true })` | seu backend (vai no corpo; veja [SSML](#ssml)) | seu backend | seu backend |
| qualquer outro provedor com `synthesize` | player | player | ganho do player |

Quando o player muda a altura, ele muda a velocidade de reprodução (altura e andamento juntos, como uma fita) e pede ao modelo o andamento oposto, então só a altura muda. A velocidade nunca é imitada pela velocidade de reprodução: sem um modelo que a aceite, ela fica como está em vez de mexer na altura.

## Efeitos

Uma cadeia de efeitos é JSON puro. Os tipos de efeito e os nomes dos parâmetros seguem a Web Audio API (`frequency`, `Q`, `gain` do `BiquadFilterNode`; `threshold`, `knee`, `ratio`, `attack`, `release` do `DynamicsCompressorNode`; `delayTime` do `DelayNode`), então o vocabulário é o que quem trabalha com áudio já conhece:

```json
{
  "version": 1,
  "name": "walkie-talkie",
  "prosody": { "rate": 1.05 },
  "effects": [
    { "type": "highpass", "frequency": 500, "Q": 0 },
    { "type": "lowpass", "frequency": 2800, "Q": 0 },
    { "type": "distortion", "amount": 0.3 },
    { "type": "compressor", "threshold": -30, "ratio": 8, "id": "comp" },
    { "type": "limiter" }
  ]
}
```

- Os efeitos rodam em ordem. Parâmetros omitidos usam o padrão; valores fora da faixa são recusados pelo `validateChain` (o `set` lança com todos os problemas listados).
- Limites: prosódia `rate` de 0,25 a 4, `pitch` de −24 a 24 semitons, `volume` de −24 a 24 dB; no máximo 32 efeitos por cadeia (`MAX_CHAIN_EFFECTS`) e 1024 estágios de `dispersion` no total (`MAX_DISPERSION_STAGES_TOTAL`). O player de voz aplica os mesmos limites de prosódia ao que chega a ele (valores são limitados, não-números descartados), então uma cadeia ou resposta que pulou a validação não estoura o volume.
- `bypass: true` mantém um efeito na cadeia, mas desligado; `id` permite endereçá-lo.
- Mude a cadeia enquanto o bot fala: `fx.set(cadeia | 'preset')`, `fx.update('comp', { ratio: 4 })`, `fx.update(0, { bypass: true })`, `fx.setProsody({ pitch: -3 })`. A próxima frase já usa.
- `fx.definitions()` descreve cada tipo de efeito e parâmetro (rótulo, faixa, padrão, unidade, curva do slider), então um editor pode ser gerado em vez de escrito. O laboratório faz exatamente isso.
- `chainSchema()` devolve um JSON Schema (2020-12) das cadeias, para validá-las num CMS, numa API ou na saída estruturada de um LLM.

### Efeitos disponíveis

| Tipo | Parâmetros (padrão) | Observações |
|---|---|---|
| `highpass`, `lowpass` | `frequency` (100 / 4000 Hz), `Q` (1 dB) | `Q` é ressonância em dB, como no Web Audio: 0 é plano, negativo é mais suave |
| `bandpass`, `notch`, `allpass` | `frequency` (1000 Hz), `Q` (1) | |
| `peaking` | `frequency` (1500 Hz), `Q` (1), `gain` (0 dB) | |
| `lowshelf`, `highshelf` | `frequency` (200 / 4000 Hz), `gain` (0 dB) | |
| `gain` | `gain` (0 dB) | |
| `compressor` | `threshold` (-24 dB), `knee` (30 dB), `ratio` (12), `attack` (0,003 s), `release` (0,25 s) | `DynamicsCompressorNode` |
| `limiter` | `threshold` (-2 dB), `release` (0,15 s), `output` (-2 dB) | Um compressor com razão 20; termine com ele as cadeias que somam ganho |
| `gate` | `threshold` (-40 dB), `reduction` (30 dB) | Nas amostras: abaixa as pausas (o chiado de modelos quantizados) |
| `varispeed` | `rate` (1) | Velocidade de fita: altura e andamento juntos |
| `vibrato` | `rate` (5 Hz), `depth` (0,0025 s) | Altura oscilando (atraso modulado) |
| `tremolo` | `rate` (5 Hz), `depth` (0,6) | Volume oscilando |
| `chorus` | `depth` (0,004 s), `mix` (0,5) | Duas vozes moduladas em velocidades fixas |
| `delay` | `delayTime` (0,25 s), `feedback` (0,35), `mix` (0,4) | Eco |
| `reverb` | `time` (1,2 s), `mix` (0,3), `seed` (1) | Convolução com uma sala gerada (determinística por `seed`) |
| `distortion` | `amount` (0,2) | Saturação suave (`tanh`) |
| `ringmod` | `frequency` (40 Hz), `mix` (0,8) | O robô clássico |
| `dispersion` | `stages` (88), `frequency` (1750 Hz), `Q` (0,6), `feedback` (0,7), `mix` (0,85) | Uma cascata de filtros passa-tudo: o "piu" de uma pedra jogada no gelo, ou um reverb de mola |

### Presets

`clean`, `denoise` (para modelos quantizados que chiam), `radio`, `telephone`, `megaphone`, `robot`, `underwater`, `cave`, `ice`, `chipmunk` e `giant` (só prosódia no `chipmunk`, que por isso funciona também com a voz do navegador). São cadeias comuns em `presets`: copie uma e mude.

### Seus próprios efeitos

```ts
import { defineEffect, voiceEffects } from '@handsforbots/voice-effects'

const bitcrusher = defineEffect({
  type: 'bitcrusher',
  label: 'Bitcrusher',
  params: { bits: { label: 'Bits', type: 'int', defaultValue: 6, minValue: 1, maxValue: 16 } },
  process(audio, p) {
    const steps = 2 ** (p.bits! - 1)
    return { ...audio, samples: audio.samples.map((s) => Math.round(s * steps) / steps) }
  },
  ffmpeg: (p) => `acrusher=bits=${p.bits}`,
})

const fx = voiceEffects({ version: 1, effects: [{ type: 'bitcrusher', bits: 4 }] }, { effects: [bitcrusher] })
```

Um efeito tem `process` (amostras entram, amostras saem, antes de tocar), `build` (nós Web Audio: devolva `{ input, output, dispose? }`; pode mudar `source.playbackRate`), ou os dois. `tail(params)` diz quanto tempo ele soa depois que a voz acaba (eco, reverb), `speed(params)` como muda a duração, `ffmpeg(params)` o equivalente no FFmpeg.

### Renderização offline

`fx.render(audio)` roda a cadeia num `OfflineAudioContext`, com as caudas: pré-renderize falas fixas ("Olá! Como posso ajudar?"), deixe a pessoa baixar o que o bot disse (`encodeWav`) ou teste uma cadeia sem tocá-la.

### A voz do navegador e os efeitos

O `speechSynthesis` toca dentro do navegador ou do sistema: o áudio nunca chega à página, então nenhum filtro, reverb ou distorção alcança. Ele recebe só a prosódia da cadeia. Se os efeitos importam, use um modelo ou um backend. O laboratório mostra os dois lado a lado.

## Padrões: por que este formato, e as pontes

Não existe um padrão único de mercado para "uma cadeia de efeitos de voz". O formato reaproveita as peças que são padrão:

- **Web Audio API** (W3C) para o vocabulário dos efeitos: tipos de nó e nomes de parâmetros, unidades e significados (Q em dB no passa-baixa e no passa-alta, por exemplo). Uma cadeia se lê como o grafo que alguém que usa Web Audio montaria.
- **Web Audio Modules 2.0** para os descritores de parâmetros: todo parâmetro tem `label`, `type`, `defaultValue`, `minValue`, `maxValue`, `discreteStep`, `exponent`, `choices`, `units`, os campos que plugins WAM publicam para os hosts montarem controles. Hospedar plugins WAM de terceiros (efeitos em WebAssembly do ecossistema WAM) ainda não é suportado.
- **SSML 1.1** (W3C) para a prosódia: `rate` como fator (100% = 1), `pitch` em semitons, `volume` em dB, as unidades do `<prosody>`.

Duas exportações alcançam as ferramentas que já existem:

### SSML

```ts
import { toSSML } from '@handsforbots/voice-effects'

toSSML('Olá, tudo bem?', fx.get().prosody, { language: 'pt-BR' })
// <speak version="1.1" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="pt-BR"><prosody rate="110%" pitch="+2st">Olá, tudo bem?</prosody></speak>
```

Para motores na nuvem por trás de `httpTTS({ prosody: true, body })`: Azure, Google e Polly aceitam `<prosody>`. O Polly não aceita semitons: `{ pitch: '%' }` escreve porcentagens. `fragment: true` devolve só o elemento `<prosody>`, para pôr no seu próprio `<speak>`. O texto é escapado. Os outros efeitos não têm equivalente em SSML; aplique-os na página (o padrão) ou no servidor com FFmpeg.

### FFmpeg

```ts
import { execFile } from 'node:child_process'
import { toFFmpeg } from '@handsforbots/voice-effects'

const { filter, args, warnings } = toFFmpeg(fx.get(), { sampleRate: 22050 })
execFile('ffmpeg', args('entrada.wav', 'saida.wav')) // ['-nostdin', '-n', '-i', 'entrada.wav', '-af', 'highpass=f=500:t=q:w=1,…', 'saida.wav']
```

O `toFFmpeg` valida a cadeia antes e lança com todos os problemas listados, então uma cadeia vinda de uma requisição não consegue enfiar filtros no grafo. Rode o FFmpeg com `args(entrada, saída)` (os argumentos: `['-nostdin', '-n', '-i', entrada, '-af', filtro, saída]`) e `execFile`/`spawn`, **nunca por um shell**. Caminhos que começam com `-` ou usam prefixo de protocolo (`http:`, `concat:`, `pipe:`, …) são recusados (escreva `./-arquivo` para um hífen). O `args` inclui `-nostdin` e `-n` para o FFmpeg não ler stdin e não sobrescrever o arquivo de saída. O `command(entrada, saída)` está obsoleto: põe aspas para um shell POSIX, mas aqui um shell não acrescenta nada. O `ffmpeg(params)` dos seus efeitos deve devolver um único filtro: vírgulas, ponto e vírgula, colchetes, aspas e quebras de linha são recusados.

A mesma cadeia num servidor: pré-renderizar áudio, processar arquivos de um motor no backend ou conferir uma cadeia com as ferramentas de quem trabalha com som. Todo efeito embutido tem filtros FFmpeg correspondentes (`highpass`, `equalizer`, `acompressor`, `alimiter`, `vibrato`, `tremolo`, `chorus`, `aecho`, `asoftclip`…); a altura usa `asetrate` + `aresample`, a velocidade usa `atempo`. Onde o FFmpeg só se aproxima do resultado do Web Audio (o compressor dele mede o nível de outro jeito, o reverb vira um conjunto de ecos), `warnings` avisa; `ringmod` não tem filtro no FFmpeg e é pulado com um aviso. Os testes passam todos os presets por um FFmpeg de verdade.

## Fonemizadores e licenças

Piper e Kokoro leem fonemas, não letras. `espeakPhonemizer` roda o espeak-ng (compilado para WebAssembly pelo piper-phonemize), o fonemizador com que as vozes do Piper foram treinadas.

- **O espeak-ng é GPL-3.0.** O H4B não o distribui: você passa o build (`module`, `wasm`, `data`). Servi-lo numa página é distribuí-lo; veja o que isso significa para o seu produto. [`@diffusionstudio/piper-wasm`](https://github.com/diffusion-studio/piper-wasm) é um build (o wrapper é MIT, o espeak-ng dentro é GPL).
- O arquivo de dados (cerca de 17 MB, todos os idiomas do espeak) é a maior peça. Um build só com os seus idiomas fica bem menor.
- `Phonemizer` é um contrato pequeno (`phonemize(texto, idioma) → string[]`): plugue outro fonemizador (um léxico, um endpoint no servidor, uma biblioteca de um idioma) para evitar o espeak, ao custo de a pronúncia não bater exatamente com o treino da voz.
- As licenças dos modelos são outra coisa: o Kokoro é Apache-2.0; cada voz do Piper tem um `MODEL_CARD` com a licença do seu dataset (algumas são não comerciais).

## Desempenho

- **Threads.** O `onnxruntime-web` roda numa thread a menos que a página esteja isolada entre origens (`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`), o que também exige que todo arquivo de outra origem (Hugging Face incluído) permita isso. Uma thread é o padrão seguro.
- **Worker.** A síntese trava a thread em que roda. Rode o provedor num Worker com `workerTTS` ([abaixo](#rodando-o-modelo-num-worker)) e a página nunca congela. `ort.env.wasm.proxy = true` leva só a inferência: o fonemizador e a criação do modelo continuam na página.
- **Frases em sequência.** O plugin sintetiza a próxima frase enquanto a atual toca; depois da primeira frase, a espera some quando o modelo é mais rápido que o tempo real.
- **Medido no laboratório** (um Mac Apple Silicon, Chrome, uma thread, arquivos do Hugging Face; os seus números vão variar): o Piper `pt_BR-faber-medium` baixou 82 MB (voz + dados do espeak) em 11 s e falou 4,4 s de áudio sem espera perceptível; o Kokoro q8 baixou 112 MB em 11 s e levou 8,2 s para produzir 5,2 s de áudio. O Kokoro numa thread é mais lento que o tempo real: use com `whileLoading: 'fallback'`, frases curtas ou um backend.
- **Modelos quantizados chiam** nas pausas mais que os fp32. O preset `denoise` (um gate e um passa-alta) esconde quase tudo.

## Rodando o modelo num Worker

A síntese trava a thread em que roda: o fonemizador, o modelo e o laço pelos trechos da frase. Na página, o maior intervalo entre frames do laboratório enquanto o Piper falava foi de 950 ms (a página congelou por cerca de um segundo); com o modelo num Worker, foi de 33 ms, e a fala levou o mesmo tempo. Animações, cenas 3D e a digitação na página sofrem do mesmo jeito. `serveTTS` e `workerTTS` levam o provedor inteiro para um Worker.

O arquivo do Worker é seu, porque é ele que escolhe o fonemizador, o runtime e os arquivos do modelo:

```ts
// voz.worker.ts
import { espeakPhonemizer, piperTTS, piperVoice, serveTTS } from '@handsforbots/voice-models'

const phonemizer = espeakPhonemizer({ module: () => import('./vendor/piper_phonemize.js'), wasm: '/vendor/piper_phonemize.wasm', data: '/vendor/piper_phonemize.data' })

serveTTS((config: { voz: string }) =>
  piperTTS({ ...piperVoice(config.voz), phonemizer, runtime: () => import('onnxruntime-web/wasm') }),
)
```

A página recebe um provedor comum:

```ts
import { workerTTS } from '@handsforbots/voice-models'

const piper = workerTTS({
  worker: () => new Worker(new URL('./voz.worker.ts', import.meta.url), { type: 'module' }),
  config: { voz: 'pt_BR-faber-medium' },
  name: 'piper',
  size: 82_000_000,
  prosody: { rate: true },
})

voice({ tts: [piper, webSpeechTTS()], load: { start: 'idle', whileLoading: 'fallback' } })
```

- **Funções não atravessam para o Worker.** O fonemizador e o runtime são montados no arquivo do Worker. O `config` leva dados (clone estruturado: textos, números, objetos, bytes, Blobs) para a fábrica do `serveTTS`; o `serveTTS(provedor)` também aceita um provedor direto.
- **Quando começa.** O Worker é criado no primeiro `load` ou `synthesize`, então o `load.start` continua decidindo quando o modelo baixa.
- **O que a página sabe antes.** O `name` é fixo na página (padrão `'worker'`; o `ttsStatus` e o `loadSpeech(nome)` usam ele). `size` e `prosody` valem antes de o Worker responder; depois, vale a prosódia do provedor no Worker.
- **Cancelamento.** Os sinais do `load` e de cada frase são repassados ao Worker, e a página rejeita na hora.
- **O áudio** volta sem cópia (o buffer é transferido). Amostras que são uma vista de um buffer maior (memória do WebAssembly) são copiadas, para nunca desanexar a memória do motor.
- **Falha.** Um Worker que não inicia (navegador sem Worker de módulo, arquivo ausente, erro de sintaxe) ou uma fábrica que lança fazem o `load` rejeitar: o provedor fica `failed`, o evento `error` dispara e o próximo provedor fala. A próxima chamada cria um Worker novo.
- **`terminate()`** para o Worker e rejeita o que estiver pendente (o usuário desligou a voz); a próxima chamada cria outro.
- **Aperto de mão.** O `serveTTS` avisa `ready` quando começa a ouvir. A página segura `load` e `synthesize` até lá e reenvia a configuração, então um navegador que perde mensagens enviadas enquanto o Worker de módulo carrega (o WebKit já fez isso) ainda recebe a configuração. Uma segunda configuração não muda nada.
- **Depuração.** `piper.trace(listener)` informa cada passo, numerado por Worker: `worker.created`, `worker.init` (`attempt` 1 na criação, 2 no `ready`), `worker.ready`, `worker.info` (`inits`: configurações que chegaram ao Worker; 1 depois de duas tentativas quer dizer que uma se perdeu), `request` (`type`, `chars`), `reply` (`ms`), `request.error` (`message`), `request.aborted`, `reply.stale` (resposta de um Worker já substituído), `worker.error`, `worker.terminated`. O plugin de voz emite esses passos como `voice.tts`, e a `observability` os registra. Um pedido que chega ao Worker antes da configuração falha com `serveTTS got a <load|synthesize> request before its config (...)`.
- **O Cache Storage funciona no Worker**: arquivos guardados pela página são reaproveitados, e o `clearModelCache()` na página apaga.
- **Não ligue o `ort.env.wasm.proxy`** dentro do Worker: ele já está fora da página.

**Bundlers.** Escreva a linha `new Worker(new URL('./arquivo', import.meta.url), { type: 'module' })` no seu app, como acima, para o bundler achar e gerar o arquivo (Vite, webpack 5 e Parcel reconhecem). No Vite, ponha `worker: { format: 'es' }`: o Worker importa o runtime sob demanda, o que o formato padrão `iife` não faz.

**Navegadores.** Worker de módulo existe no Chrome, Edge e Opera (Chromium 80+), Firefox 114+ e Safari 15+. Testado no laboratório com o Piper no Chrome 129 e no Opera 115 (Chromium 130). Navegadores mais antigos falham no `load` e passam para o próximo provedor.

## Legendas palavra por palavra

A voz informa quando cada palavra é dita, e uma legenda pode acompanhá-la como letra sincronizada: palavras já ditas, a palavra atual com o progresso dela, as próximas (ADR [0020](../adr/0020-legendas-palavra-por-palavra.md)). Instale `@handsforbots/captions` e o widget desenha:

```ts
import { voice, webSpeechTTS } from '@handsforbots/voice'
import { captions } from '@handsforbots/captions'
import { widget } from '@handsforbots/widget'

createH4B({ plugins: [voice({ tts: webSpeechTTS(), output: 'voice' }), captions(), widget()] })
```

**De onde vêm os tempos.** Toda fonte termina no mesmo contrato, mapeado para as mesmas palavras (sequências de caracteres que não são espaço, com a pontuação: `voice.wordsOf(texto)`):

| Sua voz | Tempos | `quality` / `source` |
|---|---|---|
| Áudio sem tempos (TTS de terceiros) | distribuídos na parte com som do áudio pelo tamanho das palavras, com pausas na pontuação | `estimated` / `estimate` |
| Qualquer áudio sintetizado, com um alinhador (`voice({ align: whisperAligner(...) })`) | o Whisper ouve o áudio na página e dá o tempo de cada palavra que reconheceu | `aligned` / `asr`; palavras ouvidas errado ficam `estimated` entre as que ele acertou |
| Seu backend manda (resposta JSON do `httpTTS`) | como vieram; texto normalizado pelo TTS volta para as palavras escritas | `measured` / `backend` por padrão; um alinhador forçado deve mandar `aligned` / `asr` |
| A voz do navegador (`webSpeechTTS`) | eventos `boundary`: cada palavra começa quando o evento chega e termina onde a próxima começa | `measured` / `boundary`; vozes que nunca disparam o evento ficam `estimated` |
| Piper ou Kokoro na página com `durations: true` | as durações de fonema do modelo, agrupadas em palavras | `measured` / `model`; `estimated` onde palavras faladas e escritas não batem |

Cada palavra é `{ text, start, end, from, to, quality, source }`: segundos desde o início do trecho (a frase) no tempo ouvido (já divididos pela velocidade de reprodução do player), e posições UTF-16 na mensagem, as mesmas do `voice.speech`. Tempos estimados erram; um fornecedor (floravox) diz que estimativas pelo tamanho da palavra erram de 100 a 300 ms, número que não medimos.

**Do seu backend.** Responda ao pedido do `httpTTS` com `application/json` em vez do áudio puro:

```json
{
  "audio": "<o arquivo WAV/MP3/Ogg em base64>",
  "words": [
    { "text": "Custa", "start": 0, "end": 0.32, "from": 0, "to": 5 },
    { "text": "mil", "start": 0.32, "end": 0.5 }
  ]
}
```

ou com `"vtt"`: WebVTT com um timestamp inline antes de cada palavra (estilo karaokê), bom para guardar e reaproveitar fora do H4B:

```
WEBVTT

00:00:00.000 --> 00:00:01.900
Custa <00:00:00.320>mil <00:00:00.500>duzentos <00:00:00.800>e <00:00:00.850>cinquenta <00:00:01.200>reais
```

As posições (`from`/`to`) são no texto que o backend recebeu; sem elas, as palavras são casadas pelo texto, sem diferenciar maiúsculas nem acentos, e "R$ 1.250" divide o tempo de "mil duzentos e cinquenta reais". No WebVTT, várias palavras entre dois timestamps são uma unidade: dividem o tempo dela pelo tamanho e ficam `estimated`. Referências de caractere (`&amp;`, `&lt;`) são decodificadas e tags (`<c>`, `<v>`) descartadas. Os tempos começam em 0 a cada pedido; `toWordVtt(palavras, { offset })` e `parseWordVtt(vtt)` convertem. Use JSON quando precisar de posições ou qualidade. Tudo que o backend manda é limpo (tempos finitos, no máximo 2000 unidades).

**Piper e Kokoro.** Passe `durations: true` ao `piperTTS` ou ao `kokoroTTS`. Precisa de um modelo exportado com uma saída de durações (`durations`, `duration`, `pred_dur` ou `w_ceil`; `durations: { output: 'nome' }` para outro nome). No Kokoro, `kokoroModel({ repo: 'onnx-community/Kokoro-82M-v1.0-ONNX-timestamped', voices })`; as vozes oficiais do Piper não têm. Sem a saída não há tempos, e a voz estima.

**Medindo áudio que não tem tempos.** Um alinhador ouve o áudio sintetizado e dá o tempo de cada palavra. O `whisperAligner` (no `@handsforbots/voice-models`) roda o Whisper com tempos por palavra pelo transformers.js, na página:

```ts
import { env, pipeline } from '@huggingface/transformers'
import { whisperAligner, transformersProgress } from '@handsforbots/voice-models'

env.backends.onnx.wasm.proxy = true // inferência fora do thread principal, para a legenda não engasgar
const align = whisperAligner({
  pipeline: (progress) =>
    pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny_timestamped', {
      dtype: 'q8',
      progress_callback: transformersProgress(progress),
    }),
})
voice({ tts: meuTTS, align })
```

Ele precisa de um modelo exportado com atenção cruzada (os repositórios `_timestamped`; o `whisper-tiny_timestamped` em `q8` tem cerca de 40 MB, baixados na primeira frase). A voz só o chama para áudio sem tempos ou só com tempos estimados, uma frase por vez, enquanto a anterior toca, e mapeia o que ele ouviu para o texto como as palavras de um backend: uma palavra ouvida errado fica `estimated` entre as que ele acertou. A fala não espera por padrão: uma frase que começa antes do alinhamento toca com a estimativa e, quando o alinhamento chega, o `voice.word` emite `chunk` de novo com `revised: true` e as palavras até o ponto atual começam de novo nos tempos medidos. `align: { aligner, waitMs: 400 }` deixa a frase esperar até esse limite. Um alinhador que falha vira `error` com `source: 'voice:align:<nome>'` e a frase fica na estimativa. Os tempos de palavra do Whisper vêm da atenção (DTW), não de alinhamento forçado por fonemas: melhores que a estimativa, mais grossos que um MFA no seu servidor. Passe `language: false` para modelos só em inglês (`.en`). Qualquer outro `WordAligner` (`align(audio, texto, { language, signal })` devolvendo `{ text, start, end? }[]`) funciona igual.

**Sua própria interface.** O serviço `captions` é headless: `getState()` dá `{ status: 'speaking' | 'gap' | 'idle', messageId?, from?, to?, words, active, ended? }`, cada palavra com `state` `spoken`, `active` ou `upcoming`; `subscribe()` avisa quando uma palavra muda; `progress()` é quanto da palavra ativa já foi dito (0 a 1), pelo relógio do player: leia a cada quadro de animação. `captions({ scope: 'message' })` mantém a resposta inteira com a frase falada em destaque, em vez de uma frase por vez. Mais abaixo, a voz emite `voice.word` (`chunk`, de novo com `revised: true` depois de um alinhamento atrasado, `word`, `gap`, `end` com `done`, `interrupted` ou `error`) e `voice.getSpeechPosition()` dá a posição ao vivo.

**No widget.** `.captions` (part `captions`) tem um `.word` por palavra com `data-state` e `data-quality`, `--progress` na ativa e `data-status` na caixa (`idle` nas pausas e no fim). É `aria-hidden`: o leitor de tela lê a mensagem no histórico. `widget({ captions: false })` desliga.

**Relógio e pausas.** O relógio é o do player: o `webAudioPlayer` usa o `AudioContext.currentTime` desde o início da frase, então um contexto suspenso para a legenda junto. Um `AudioPlayer` próprio chama `onStart(relógio)` no `play`; sem isso, o relógio da página conta desde o `play`. Barge-in, `interrupt()` e `cancelSpeech()` terminam a frase como `interrupted`.

**Navegadores.** O `boundary` depende do navegador e da voz: vozes de rede de alguns navegadores nunca disparam o evento, e a legenda fica estimada. Nosso teste em navegador cobre o Chromium; Edge, Safari e Firefox não têm teste automatizado.

## Escrevendo um provedor

```ts
import type { TextToSpeech } from '@handsforbots/voice'

const meuTTS: TextToSpeech = {
  name: 'meu-motor',
  remote: false,              // o texto sai da página?
  size: 40_000_000,           // bytes a baixar, se houver
  prosody: { rate: true },    // o que ele aplica sozinho; o player faz o resto
  isSupported: () => typeof WebAssembly === 'object',
  async load(onProgress, signal) { /* baixe, informe { loaded, total }, respeite o signal */ },
  async synthesize(text, { language, voice, prosody, signal }) {
    return { samples: new Float32Array(/* mono */), sampleRate: 24000 }
  },
}
```

Implemente `speak(text, options)` em vez de `synthesize` para motores que tocam sozinhos (eles não recebem efeitos). `cancel()` os interrompe. Para legendas, o `synthesize` pode devolver `words` (veja [Legendas palavra por palavra](#legendas-palavra-por-palavra)), e o `speak` pode chamar `options.onProgress({ type: 'start' })` e `options.onProgress({ type: 'boundary', from, to? })` com posições no texto que recebeu. Motores ONNX podem reaproveitar `fetchModel`, `loadRuntime` e `chunkText` do `@handsforbots/voice-models`, e qualquer provedor com `synthesize` roda num Worker pelo `serveTTS`.

Fontes: [Referências → Síntese de voz](./references.md#síntese-de-voz-e-efeitos), [Legendas palavra por palavra](./references.md#legendas-palavra-por-palavra). Decisões: [ADR 0013](../adr/0013-sintese-de-voz-e-efeitos.md), [ADR 0020](../adr/0020-legendas-palavra-por-palavra.md).
