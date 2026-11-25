# 0020 — Legendas palavra por palavra: tempos por palavra no `voice`, um contrato para todas as fontes e o pacote `@handsforbots/captions`

**Contexto.** Quando o bot fala, a legenda deve acompanhar a voz palavra por palavra, como as letras sincronizadas dos players de música e podcast: palavras já ditas, a palavra atual com o progresso dela e as próximas. A fala sempre vem de um texto que já temos. O `voice` já sabe em que **frase** está: cada trecho de resposta sai em `voice.speech` com `messageId`, `from` e `to` (ADR [0018](./0018-deixas.md), "Sincronia com a voz"). Falta o tempo **dentro** do trecho. E ele chega de jeitos muito diferentes:

1. um TTS de terceiros que só devolve áudio, sem nenhuma marca de tempo;
2. um backend que gera o áudio e pode mandar os tempos junto (o próprio TTS na nuvem ou um alinhador forçado como WhisperX ou MFA);
3. a voz do navegador (`speechSynthesis`, no H4B o `webSpeechTTS`), que dispara `boundary` com a posição da palavra no texto, mas só em algumas vozes e navegadores, e só no começo de cada palavra;
4. Piper e Kokoro rodando na página (`@handsforbots/voice-models`), cujo modelo calcula a duração de cada fonema, mas só expõe isso no ONNX se o export incluir essa saída.

Se cada fonte trouxesse sua própria divisão em palavras, a legenda mudaria de forma conforme a voz escolhida. E o texto falado nem sempre é o texto escrito: o TTS lê "R$ 1.250" como "mil duzentos e cinquenta reais", e a legenda precisa marcar "R$ 1.250".

**Decisão.**

- **Os tempos por palavra ficam no `voice`.** É ele que sabe quando cada trecho começa, qual provedor falou, qual `playbackRate` o player usou e quando a fala foi cortada (barge-in, `interrupt`, `cancelSpeech`). Um pacote à parte que escutasse o player teria de refazer esse estado. O `voice` emite o evento `voice.word` e o serviço ganha `getSpeechPosition()` (posição ao vivo) e `wordsOf(texto)` (a tokenização). A legenda é outro pacote, `@handsforbots/captions`, que só lê isso.
- **Uma tokenização só.** Uma palavra é uma sequência máxima de caracteres que não são espaço (`/\S+/g`, então a pontuação fica grudada: `"Olá,"`). É a mesma para toda fonte e todo provedor, e é o `voice.wordsOf` que a aplica; a legenda nunca tokeniza por conta própria. Os tempos de cada fonte são **mapeados** para essas palavras, e não o contrário. Escritas sem espaço (chinês, japonês, tailandês) viram uma unidade por trecho; segmentar essas línguas fica em aberto.
- **O contrato.** Cada palavra de um trecho é `WordTiming`:
  - `text`: a palavra como está no texto da mensagem;
  - `start` e `end`: segundos desde o início do trecho, **no tempo ouvido** (já divididos pelo `playbackRate` do player);
  - `from` e `to`: posições UTF-16 no texto **original** da mensagem, coerentes com as do `voice.speech` (em `speak(texto)` sem mensagem, posições no próprio texto);
  - `quality`: `measured` (o motor informou o tempo daquela palavra), `aligned` (um alinhador forçado mediu o áudio contra o texto) ou `estimated` (distribuído por proporção);
  - `source`, separado da qualidade: `model`, `backend`, `boundary`, `asr` ou `estimate`. Uma fonte pode dar qualidades diferentes por palavra.

  O provedor devolve `SpeechAudio.words?: TimedWord[]` (o mesmo formato, com `end`, `from`, `to`, `quality` e `source` opcionais, posições no texto que **ele** recebeu). O `voice` alinha isso às palavras do texto e soma a posição do trecho.
- **Alinhamento com o texto original (`alignWords`).** Com `from`/`to`, cada palavra do texto pega os tempos que a cobrem. Sem eles (WebVTT, a saída de um alinhador), o texto de cada unidade é normalizado (minúsculas, sem acento, só letras e dígitos) e casado em ordem com o texto da mensagem pela maior subsequência comum. O que não casa entre duas âncoras (o número lido por extenso, a sigla soletrada) divide o intervalo entre as âncoras por tamanho e fica `estimated`. Uma unidade com várias palavras também é dividida por tamanho, e as partes ficam `estimated`. Palavras sem tempo nenhum são interpoladas. `end` ausente vira o `start` da próxima.
- **Os quatro cenários:**
  1. **Áudio sem sincronia:** estimativa proporcional (`estimateWords`) sobre a duração real do áudio, com o silêncio do começo e do fim aparado e pausas na pontuação. `estimated` / `estimate`. Alinhamento forçado (WhisperX, MFA) fica no backend e entra pelo caminho do cenário 2.
  2. **Backend:** o `httpTTS` aceita, além do áudio puro, uma resposta `application/json` `{ audio, words?, vtt? }` (`audio` em base64). `words` é o contrato acima, para quem precisa de `from`/`to`/`quality`; `vtt` é **WebVTT com timestamps inline por palavra** (o padrão do W3C para legendas karaokê), bom para guardar e reaproveitar fora do H4B. Os dois: JSON quando precisa de posições e qualidade, WebVTT para transporte e armazenamento. `parseWordVtt` e `toWordVtt` são exportados. Valores ausentes do backend viram `measured` / `backend`; um alinhador deve mandar `aligned` / `asr`. Tudo que vem do backend é limpo (números finitos, no máximo 2000 unidades, texto como texto).
  3. **`speechSynthesis`:** o `webSpeechTTS` repassa `boundary` (`name: 'word'`) por `SpeakOptions.onProgress`, com a posição convertida para o texto que recebeu (ele junta espaços e divide frases longas). O tempo é a hora de chegada do evento, porque o `elapsedTime` muda de unidade entre navegadores. O `boundary` só marca o início: o fim de uma palavra é o início da próxima. O trecho começa com a estimativa por caracteres por segundo (ajustada pelo `rate`) e passa para as marcas no primeiro `boundary`. Vozes que nunca disparam o evento (vozes de rede em alguns navegadores) ficam na estimativa até o fim.
  4. **Piper e Kokoro:** com a opção `durations`, o provedor lê a saída de durações do ONNX (por nome: `durations`, `duration`, `pred_dur` ou `w_ceil`, ou o nome dado), soma as durações dos fonemas de cada palavra (os espaços do fonemizador separam as palavras) e escala o total para o tamanho real do áudio. Se o número de palavras faladas bate com o de palavras com letras ou dígitos do texto, cada uma é `measured` / `model`; se não bate (números, siglas), o trecho inteiro é distribuído e fica `estimated`. Sem a saída no modelo, sem tempos: o `voice` estima. Os exports oficiais do Piper não trazem essa saída; o do Kokoro existe à parte (`Kokoro-82M-v1.0-ONNX-timestamped`).
- **O relógio é o do player.** `AudioPlayer.play` ganha `onStart(clock)`, chamado quando a fonte começa a tocar; o `webAudioPlayer` devolve `AudioContext.currentTime` desde esse instante. Um `AudioContext` suspenso para o relógio, e a legenda espera junto. Players que não chamam `onStart` usam o relógio da página desde o `play`. Provedores que tocam sozinhos (`speak`) usam o relógio da página desde o pedido, corrigido pelo `start` do provedor quando ele avisa.
- **O evento `voice.word`**, com o `messageId`/`from`/`to` do trecho e o `provider`:
  - `chunk` `{ words }` quando o trecho começa a tocar, com a previsão de todas as palavras (marcas do `boundary` corrigem depois);
  - `word` `{ index, word }` quando uma palavra começa;
  - `gap` `{ index }` quando a palavra `index` acabou e a próxima ainda não começou (pausa);
  - `end` `{ reason: 'done' | 'interrupted' | 'error' }` no fim do trecho, inclusive em barge-in, `interrupt` e `cancelSpeech`.

  O progresso de 0 a 1 não vira evento (seria um por quadro): `getSpeechPosition()` o calcula na hora, e quem desenha lê a cada quadro.
- **`@handsforbots/captions`.** Plugin `captions({ scope })` com o serviço `captions` (`getState()`, `subscribe()`, `progress()`): as palavras com `state` `spoken`, `active` ou `upcoming`, o `status` (`speaking`, `gap` ou `idle`) e o índice ativo. É a API headless para quem tem camada de apresentação própria. `scope: 'chunk'` (padrão) mostra o trecho falado, a frase, como uma linha de legenda; `scope: 'message'` mostra a mensagem inteira e destaca o trecho. O widget lê o serviço pelo formato (como as deixas), sem importar o plugin, e desenha `.captions` com uma `<span>` por palavra, `data-state` e `--progress` na ativa. A legenda é `aria-hidden`: o texto já está no histórico, que é o que o leitor de tela lê.

**Consequências.**

- Qualquer voz ganha legenda: a pior caso é estimada, e quem pode medir mede. A qualidade vai em cada palavra, então a página pode, por exemplo, só animar o progresso quando for `measured`.
- Provedores antigos seguem funcionando sem mudança: `words` e `onProgress` são opcionais.
- A estimativa erra. O fornecedor floravox afirma que estimativas pelo tamanho da palavra erram de 100 a 300 ms; o número é dele e **não foi medido por nós**.
- O `boundary` depende do navegador e da voz. O teste em navegador cobre o Chromium; Edge, Safari e Firefox ficam sem teste automatizado.
- **Em aberto:** segmentação de escritas sem espaço; um export de Piper com durações publicado e testado; alinhamento no próprio navegador; deixas por palavra; legendas para a fala do usuário (transcrição).

As fontes estão em [Referências → Legendas palavra por palavra](../en-us/references.md#word-by-word-captions); o guia é [Síntese de voz e efeitos → Legendas](../pt-br/speech.md#legendas-palavra-por-palavra).
