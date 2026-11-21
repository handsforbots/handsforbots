# Referências

Bibliotecas, serviços, artigos e produtos que embasaram decisões do Hands for Bots, agrupados por tema. Cada seção diz qual decisão ou página apoia e quando as fontes foram acessadas. Números (latência, tamanho, preço, acerto) são dos fornecedores ou autores e **não foram medidos por nós**, a não ser quando indicado. Código de terceiros incluído ou adaptado no projeto tem crédito no [NOTICE](./NOTICE.md).

Quando uma decisão se apoiar em fontes externas, acrescente-as aqui (nos dois idiomas) no mesmo commit.

## Interrupção, fim de turno e barge-in

Apoia o [ADR 0011](../adr/0011-interrupcao-e-fim-de-turno.md) e [Interrupção e conversa por voz](./conversation.md). Acessadas em 2026-10-10 e 2026-10-11.

### Detecção de fim de turno

| Fonte | O que é | Observações |
|---|---|---|
| [Turn detector da LiveKit](https://docs.livekit.io/agents/logic/turns/turn-detector) · [post: modelo de fim de turno melhorado](https://livekit.com/blog/improved-end-of-turn-model-cuts-voice-ai-interruptions-39) | Modelo de texto com pesos abertos: lê a transcrição dos últimos turnos e prevê a probabilidade do token de fim de turno; funciona junto com VAD, com limiares por idioma | Modelo multilíngue: ~400 MB de RAM, ~25 ms por inferência, feito para servidores Python. Código do plugin Apache-2.0, modelo sob a LiveKit Model License. Encaixa no `httpEndOfTurn` atrás do seu servidor |
| [Smart Turn da Pipecat](https://github.com/pipecat-ai/smart-turn) · [docs](https://docs.pipecat.ai/server/utilities/turn-detection/smart-turn-overview) · [ficha do modelo](https://huggingface.co/pipecat-ai/smart-turn-v3) · [versão ONNX](https://huggingface.co/soniqo/Smart-Turn-v3.2-ONNX) · [post da v3.2](https://www.daily.co/blog/smart-turn-v3-2-handling-noisy-environments-and-short-responses/) | Modelo de áudio (encoder do Whisper Tiny + classificador linear, ~8M parâmetros) sobre os últimos segundos do sinal, rodado a cada pausa depois de um VAD | BSD-2, pesos, dados e código de treino publicados, 23 idiomas. O tamanho varia por fonte: 8 MB em ONNX int8 (Pipecat), 11 MB quantizado (versão soniqo). ~10–36 ms em CPUs rápidas segundo os fornecedores; CPUs mais fracas levam bem mais. A única opção que cogitamos rodar no navegador (`onnxruntime-web`); não verificado |
| [FireRedChat (arXiv 2509.06502)](https://arxiv.org/pdf/2509.06502) | Artigo; treina um classificador BERT de fim de turno com ~830 mil exemplos de frase parcial contra completa | Referência para classificadores de texto que rodam localmente ou no servidor |
| [Detecção de turno da AssemblyAI](https://www.assemblyai.com/docs/streaming/turn-detection) | STT em streaming com fim de turno semântico mais fallback por silêncio | Padrões citados: confiança 0.4, silêncio mínimo de 400 ms. Nossos `turn.threshold` / `turn.minSilence` seguem a mesma ideia. Encaixa em `capabilities.endOfTurn` |
| [Endpoint detection da Soniox](https://soniox.com/docs/stt/rt/endpoint-detection) | STT em streaming cujo modelo de fala emite um token de fim a partir de entonação, pausas e contexto | Encaixa em `capabilities.endOfTurn` |
| [VAD do OpenAI Realtime](https://developers.openai.com/api/docs/guides/realtime-vad) | `server_vad` (silêncio) e `semantic_vad` (o modelo julga se a fala está completa), com `eagerness` | Mostra a mesma divisão que adotamos: só silêncio contra um canal semântico |
| [Jev 1.13 na OpenRouter](https://openrouter.ai/models/typesafe/jev-1.13) | Modelo hospedado de decisão tipada (devolve uma escolha, não texto livre) pela API de Decisions da OpenRouter | Números do fornecedor: p50 ~0,13 s, US$ 0,042 por milhão de tokens de entrada. Beta, um único provedor, pesos fechados; português não documentado. A chave fica no servidor (`httpEndOfTurn`) |

### APIs do navegador e bibliotecas

| Fonte | Uso no H4B |
|---|---|
| [Web Speech API (MDN)](https://developer.mozilla.org/pt-BR/docs/Web/API/Web_Speech_API) | `webSpeechSTT` / `webSpeechTTS`. O reconhecimento não é offline na maioria dos navegadores e não dá acesso ao áudio nem às restrições do microfone |
| [`MediaTrackConstraints` (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints) | `echoCancellation`, `noiseSuppression`, `autoGainControl` no `openMicrophone` |
| [ONNX Runtime Web](https://www.npmjs.com/package/onnxruntime-web) | Runtime candidato para modelos locais de fim de turno (Smart Turn) num pacote à parte; não é dependência |
| [vosk-browser](https://www.npmjs.com/package/vosk-browser) | Reconhecimento offline no `voskBrowserSTT`; expõe o áudio, então pode alimentar modelos de fim de turno de áudio |

### Produtos e comportamento

| Fonte | Observações |
|---|---|
| Modo de voz do ChatGPT, Gemini Live | Microfone aberto, a fala corta a resposta: a base para `interrupt` ser o padrão |
| Chat de texto do ChatGPT | Deixa digitar durante a resposta, mas exige parar antes de enviar; não achamos fila nativa. Um userscript de terceiros acrescenta uma ([ChatGPT Message Queue](https://greasyfork.org/en/scripts/561517-chatgpt-message-queue)), sinal de que as pessoas querem isso |

Também citados na discussão que levou ao ADR, sem uma página específica conferida por nós: Hamming, Picovoice, Coval, Dograh e WorkAdventure (textos sobre avaliação de agentes de voz e troca de turnos).

### Avisando o backend

Apoia o [ADR 0015](../adr/0015-retorno-da-interrupcao.md). Acessado em 2026-11-06. Lido na documentação e nos tipos dos SDKs; não chamado por nós.

| Fonte | O que é | Uso no H4B |
|---|---|---|
| [`conversation.item.truncate` do OpenAI Realtime (tipos do LangChain)](https://v03.api.js.langchain.com/interfaces/_langchain_openai.OpenAIClient.Beta.Realtime.ConversationItemTruncateEvent.html) · [openai-agents-python #4122](https://github.com/openai/openai-agents-python/pull/4122) | Evento do cliente que diz ao servidor quanto do áudio de uma mensagem do assistente foi tocado (`audio_end_ms`) quando o usuário interrompe | Precedente: quem toca a resposta avisa quem a escreveu onde ela parou. O H4B faz isso em caracteres (`kept`), na requisição seguinte |
| [Discussão na comunidade sobre transcrições cortadas](https://community.openai.com/t/realtime-api-interruptions-dont-properly-trim-the-transcript/1000703) | Usuários relatam o modelo adivinhando onde foi interrompido quando só o histórico não diz | Motivo para mandar o fato (`conversation.interrupted`), e não só o texto cortado |

## Teste de ruído do microfone

Base do `checkNoise`, do `measureNoise`, do portão de nível (`levelGate`) e do piso de ruído do `detectEndOfSpeech` ([Ambientes com ruído](./conversation.md#ambientes-com-ruído)). Acesso em 2026-11-20. A medição é nossa (percentis dos níveis dos frames); as fontes abaixo a orientaram ou são candidatas a um teste com modelo. Nenhuma é dependência.

| Fonte | O que é | Uso no H4B |
|---|---|---|
| [Martin, "Noise power spectral density estimation based on optimal smoothing and minimum statistics" (IEEE TSAP, 2001)](https://doi.org/10.1109/89.928915) | Estimador clássico: o piso de ruído é o mínimo da potência suavizada numa janela, porque a fala sempre tem pausas | A ideia do `noiseFloorTracker` (menor RMS em `floorMs`) no `detectEndOfSpeech`, sem a correção de viés nem a análise por banda |
| [`MediaTrackConstraints` (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints) · [Media Capture and Streams (W3C)](https://www.w3.org/TR/2025/CRD-mediacapture-streams-20250624/) | `noiseSuppression` / `autoGainControl` podem ser desligados por pedido | O `checkNoise` mede com eles desligados por padrão, porque escondem ou sobem o piso |
| [Web Audio API 1.1, vida do AudioNode](https://www.w3.org/TR/webaudio-1.1/) · [Media Capture and Streams, fluxo de mídia](https://www.w3.org/TR/mediacapture-streams/) · [`MediaStreamTrack.enabled` (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/enabled) | Um `MediaStreamAudioSourceNode` emite silêncio enquanto a faixa não está `live`, sem mute e habilitada. Faixa muda ou desabilitada entrega conteúdo sem informação; no áudio, cada amostra vale 0 | A abertura que o `createNoiseMeter` deixa de fora. 0 fica abaixo de `silentFloorDb`. A abertura acaba no primeiro frame mais alto; as especificações não dão duração |
| [voxtype, segurar o aviso de gravação até o aparelho aquecer](https://github.com/peteonrails/voxtype/pull/497) | No PipeWire, uma fonte saindo de suspensão entregou zeros exatos por 0,3–0,9 s (fria) ou 40–70 ms (quente). Microfone vivo tem piso de ruído; esse silêncio de retomada é zero exato. Eles esperam uma amostra diferente de zero e desistem depois de 1,5 s, para uma fonte que continua em silêncio ainda começar | Evidência de que a abertura é silêncio do aparelho, e de que a duração varia. O teto de 1,5 s não foi adotado: uma captura que nunca passa de `silentFloorDb` relata a abertura |
| [Chrome: estatísticas de áudio do MediaStreamTrack](https://groups.google.com/a/chromium.org/g/blink-dev/c/xcGJyic7ttI) · [restrição `voiceIsolation`](https://groups.google.com/a/chromium.org/g/blink-dev/c/hPMvCu-3iPA) | Latência de captura e frames perdidos; isolamento de voz do sistema (ChromeOS primeiro) | Vistos e deixados de lado: as estatísticas não medem ruído; o isolamento de voz não está disponível em geral |
| [DNSMOS (arXiv 2010.15258)](https://arxiv.org/pdf/2010.15258) · [DNSMOS P.835 (arXiv 2110.01763)](https://arxiv.org/pdf/2110.01763) · [DNSMOS Pro (arXiv 2204.06616)](https://arxiv.org/pdf/2204.06616) | Modelos de qualidade de fala sem referência; o P.835 dá uma nota de ruído de fundo (BAK) | Candidato a teste com modelo via `onnxruntime-web`; não testado no navegador |
| [WhiSQA (arXiv 2508.02210)](https://www.arxiv.org/abs/2508.02210) | Modelo de qualidade sobre o encoder do Whisper; os autores relatam adaptação de domínio melhor que a do DNSMOS | Pesado demais para a página; referência para testes no servidor |
| [Avaliação de áudio semi-intrusiva (arXiv 2409.14069)](https://arxiv.org/html/2409.14069) | Modelo de áudio e linguagem ajustado para prever MOS e SNR em misturas quaisquer | Referência para estimar SNR sem o sinal limpo |
| [Silero VAD no navegador (`@ricky0123/vad-web`)](https://github.com/ricky0123/vad) | Detecção de fala com ONNX Runtime Web | Candidato para separar vozes por perto (que o nosso teste por nível chama de `fluctuating`) da voz da pessoa; o README de um fork cita ~10 MB de modelo mais runtime |
| [Personal VAD (arXiv 1908.04284, Odyssey 2020)](https://arxiv.org/abs/1908.04284) | Modelo pequeno (130 mil parâmetros, segundo os autores) condicionado ao embedding de um falante cadastrado; marca cada frame como sem fala, falante-alvo ou outro falante | O que de fato separa a pessoa de outras vozes. Não usado: exige cadastro da voz e um modelo que teríamos de portar; o portão de nível é a aproximação sem modelo |
| [Iwamoto et al., "How bad are artifacts?" (arXiv 2201.06685, Interspeech 2022)](https://arxiv.org/abs/2201.06685) | Mostra que os artefatos da melhoria de fala de um canal são o principal motivo de ela muitas vezes não melhorar o reconhecimento | Motivo para não limpar o áudio com um modelo de redução de ruído antes do reconhecimento, e filtrar por nível |

## Síntese de voz e efeitos

Apoia o [ADR 0013](../adr/0013-sintese-de-voz-e-efeitos.md) e [Síntese de voz e efeitos](./speech.md). Acessado em 2026-10-16. Tamanhos e tempos medidos por nós estão marcados; os outros são dos autores.

### Padrões por trás do formato de efeitos

| Fonte | Uso no H4B |
|---|---|
| [Web Audio API (W3C)](https://www.w3.org/TR/webaudio/) | Vocabulário dos efeitos: tipos de nó e nomes de parâmetros (`BiquadFilterNode`, `DynamicsCompressorNode`, `DelayNode`, `ConvolverNode`, `WaveShaperNode`); Q em dB no passa-baixa e no passa-alta. O player e os efeitos são feitos com ela |
| [Web Audio Modules 2.0](https://www.webaudiomodules.com/docs/intro) · [API](https://github.com/webaudiomodules/api) | Descritores de parâmetros (`label`, `type`, `defaultValue`, `minValue`, `maxValue`, `discreteStep`, `exponent`, `choices`, `units`) para gerar editores. Hospedar plugins WAM ainda não é suportado |
| [SSML 1.1 (W3C)](https://www.w3.org/TR/speech-synthesis11/) | Unidades da prosódia (`rate` em porcentagem, `pitch` em semitons, `volume` em dB) e a exportação `toSSML` |
| [`<prosody>` do Amazon Polly](https://docs.aws.amazon.com/polly/latest/dg/prosody-tag.html) · [SSML de voz e prosódia do Azure](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-voice) · [SSML do Google Cloud TTS](https://cloud.google.com/text-to-speech/docs/ssml) | O que os motores na nuvem aceitam: o Polly recebe a altura em porcentagem, por isso `toSSML({ pitch: '%' })` |
| [Filtros do FFmpeg](https://ffmpeg.org/ffmpeg-filters.html) | `toFFmpeg`: `highpass`, `equalizer`, `acompressor`, `alimiter`, `vibrato`, `tremolo`, `chorus`, `aecho`, `asoftclip`, `atempo`, `asetrate`, `aresample`. Todos os presets são conferidos com o FFmpeg 7.1 nos testes |
| [JSON Schema 2020-12](https://json-schema.org/draft/2020-12) | `chainSchema()` |

### Motores e modelos

| Fonte | O que é | Observações |
|---|---|---|
| [Piper](https://github.com/rhasspy/piper) (arquivado; continua em [OHF-Voice/piper1-gpl](https://github.com/OHF-Voice/piper1-gpl)) · [vozes](https://huggingface.co/rhasspy/piper-voices) | Vozes VITS rápidas exportadas para ONNX, um idioma por voz, um `.onnx.json` com o mapa de fonemas e os parâmetros de inferência | `piperTTS`, `piperVoice`. O repositório original era MIT; a continuação é GPL. As licenças das vozes variam conforme o `MODEL_CARD`. Medido por nós: `pt_BR-faber-medium` + dados do espeak = 82 MB |
| [Kokoro 82M](https://huggingface.co/hexgrad/Kokoro-82M) · [build ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) | Baseado em StyleTTS 2, 82M parâmetros, 24 kHz, vários idiomas, Apache-2.0 | `kokoroTTS`, `kokoroModel`. Arquivos ONNX de 92 MB (q8) a 326 MB (fp32). Medido por nós numa thread de CPU: 8,2 s para 5,2 s de áudio |
| [ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/) | Roda modelos ONNX no navegador (WebAssembly, WebGPU) | O runtime do Piper e do Kokoro; passado pelo app, não é dependência. Threads exigem isolamento entre origens; `env.wasm.proxy` leva só a inferência para um worker; `workerTTS` leva o provedor inteiro |
| [transformers.js](https://huggingface.co/docs/transformers.js) | Pipelines do Hugging Face no navegador, incluindo `text-to-speech` | `transformersTTS` adapta qualquer pipeline de TTS dele |
| [espeak-ng](https://github.com/espeak-ng/espeak-ng) · [piper-phonemize](https://github.com/rhasspy/piper-phonemize) · [@diffusionstudio/piper-wasm](https://github.com/diffusion-studio/piper-wasm) | Texto para fonemas IPA; o piper-phonemize o embrulha como o Piper espera; o piper-wasm é um build em WebAssembly | `espeakPhonemizer`. O espeak-ng é GPL-3.0, por isso o H4B não o distribui. O arquivo de dados desse build tem 17 MB |

### APIs do navegador

| Fonte | Uso no H4B |
|---|---|
| [`SpeechSynthesisUtterance` (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisUtterance) | Prosódia do `webSpeechTTS` (`rate`, `pitch`, `volume`). O áudio dele não pode ser levado ao Web Audio, então os efeitos não se aplicam |
| [Guia de autoplay (MDN)](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay) | Por que o player libera o áudio no primeiro gesto e por que existe `unlockAudio()` |
| [`CacheStorage` (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/CacheStorage) | Onde os modelos baixados ficam (`h4b-voice-models`) |
| [`Worker()` com `type: 'module'` (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Worker/Worker) | `workerTTS`: o arquivo do Worker importa o runtime sob demanda, então precisa ser um Worker de módulo (Chromium 80+, Firefox 114+, Safari 15+) |
| [Objetos transferíveis (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects) | As amostras sintetizadas voltam do Worker transferindo o buffer, sem cópia |
| [Vite: `worker.format`](https://vite.dev/config/worker-options) | `'es'` é necessário para Workers que importam módulos sob demanda; o `iife` padrão não faz isso |

## Reconhecimento na VPS (a testar)

Apoia a decisão em aberto 10 do [ROADMAP](../../ROADMAP.md). Acessado em 2026-11-09. Nenhum modelo foi rodado por nós. Tamanhos e o comportamento de troca de idioma são dos autores.

| Fonte | O que é | Observações |
|---|---|---|
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | Porta em C/C++ do Whisper, com CLI, quantização e um servidor de exemplo | Candidato a STT na VPS da Hostinger. Se o teste passar, o H4B fala com ele pelo `httpSTT` ou `websocketSTT` |
| [Tabela de memória e quantização](https://github.com/ggml-org/whisper.cpp#memory-usage) | Disco e RAM dos modelos inteiros; exemplo de quantização `q5_0` | Do projeto, não medido por nós: base 142 MiB / ~388 MB de RAM; small 466 MiB / ~852 MB. A nota do teste citava esses tamanhos de disco como RAM |
| [Modelos ggml](https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md) | Lista oficial. Sem sufixo `.en`, o modelo é multilíngue; com `.en`, só inglês. Sufixo `-q5_0` é quantizado | O teste usa `base` ou `small` sem `.en`. O arquivo `ggml-base.bin-q4_0` da nota não aparece nessa lista |
| [ggml-base-q5_1 e ggml-small-q5_1 no Hugging Face](https://huggingface.co/ggerganov/whisper.cpp/tree/main) | Cópias quantizadas já convertidas | Tamanhos publicados em 2026-10-26 por um índice de terceiros desses arquivos: base `q5_1` ~60 MB, small `q5_1` ~190 MB, e os `q8_0` maiores. Conferir o arquivo na hora de baixar. RAM quantizada não está na tabela oficial |
| [Quantização q5_0 (issue 1103)](https://github.com/ggml-org/whisper.cpp/issues/1103#issuecomment-1634413142) | Comentário de 2023 com o tamanho em disco depois de quantizar | base `q5_0` ~60 MB, small `q5_0` ~190 MB, no disco. Não é RAM |
| [`--prompt` (discussão 348)](https://github.com/ggml-org/whisper.cpp/discussions/348) | O argumento já existia: vira o `initial_prompt` e puxa o vocabulário (nomes, termos) | No teste, a lista é o jargão que a gente fala. Não é garantia de acerto |
| [Troca de idioma no áudio (issue 3334)](https://github.com/ggml-org/whisper.cpp/issues/3334) · [issue 1800](https://github.com/ggerganov/whisper.cpp/issues/1800) | O modelo tende a um idioma por trecho e reescreve o outro nesse idioma | É o efeito Claudinei visto de dentro do Whisper. Motivo para comparar com e sem `--prompt`, com `-l pt` (transcrever, não `--translate`) |

## Frameworks de agente e "browser hands"

Apoia a seção "Relação com frameworks de agente e browser hands" do [ROADMAP](../../ROADMAP.md) (posicionamento, transporte `realtime` em P1). Acessado em 2026-11-04. Nada aqui foi testado por nós.

| Fonte | O que é | Uso no H4B |
|---|---|---|
| [Vídeo de uma série sobre agentes multimodais](https://www.youtube.com/watch?v=dNGchf4InU0) | Série que monta um agente em camadas (genai SDK → ADK → tools → hands → memory → eyes; "hear · talk · act · remember · see") | Motivou a revisão. Só o diagrama da série foi conferido, não o vídeo |
| [Bidi-streaming (live) no ADK](https://google.github.io/adk-docs/streaming) · [codelab](https://codelabs.developers.google.com/intro-to-adk-live) | Agentes do ADK com voz e vídeo de baixa latência pela Gemini Live API: entrada de texto, áudio e vídeo, saída de texto e áudio, ferramentas na sessão | Caminho em que o áudio vai direto do navegador ao agente: o atrito com o `voice`, respondido pelo transporte `realtime` |
| [Gemini Live API](https://ai.google.dev/gemini-api/docs/live) | API fala-a-fala do Gemini, por sessão | Candidata a provedor de referência do `realtime` (decisão em aberto 7) |
| [`ag_ui_adk`](https://pypi.org/project/ag-ui-adk/) · [discussão no fórum do Google](https://discuss.google.dev/t/integrating-google-adk-agents-with-modern-frontends-using-the-ag-ui-protocol/298415) | Middleware Python que expõe um agente do ADK pelo protocolo AG-UI, com ferramentas do cliente executadas no agente (`AGUIToolset`) | Um agente do ADK pode usar as ações do H4B pelo `transport-agui` sem pacote novo; falta um exemplo que confirme |
| [The browser agent stack, explained (Lightpanda)](https://lightpanda.io/blog/posts/the-browser-agent-stack-explained) · [How browser agents work (Anchor)](https://anchorbrowser.io/guides/how-browser-agents-work-a-step-by-step-architectural-guide) | Descrevem a camada de execução ("mãos") dos agentes de navegador: Playwright, browser-use, Stagehand e afins agindo num navegador controlado pelo agente | Base da distinção entre mãos que agem de fora da página e as ações declaradas do H4B, expostas pelo `expose-webmcp` |

## Fontes e citações

Apoia o [ADR 0014](../adr/0014-fontes-e-citacoes.md) e [Fontes e citações](./sources.md). Acessado em 2026-11-06. Os formatos foram lidos na documentação e nos tipos dos SDKs; nenhuma dessas APIs foi chamada por nós.

| Fonte | O que é | Uso no H4B |
|---|---|---|
| [OpenAI web search (Responses API)](https://platform.openai.com/docs/guides/tools-web-search) · [Ably: citações da OpenAI](https://ably.com/docs/ai-transport/guides/openai/openai-citations.md) · [Parallel: citations](https://docs.parallel.ai/responses-api/features/citations.md) | Anotações `url_citation` no texto de saída com `url`, `title`, `start_index`, `end_index`; no streaming, pelo evento `response.output_text.annotation.added` | O modelo da `Citation`: anotação com posição, não marcador no texto, e um estímulo próprio (`message.citations`) |
| [Citações da Anthropic](https://docs.anthropic.com/en/docs/build-with-claude/citations) · [Ably: citações da Anthropic](https://ably.com/docs/ai-transport/guides/anthropic/anthropic-citations.md) | Blocos de texto com um array `citations` (`cited_text`, índice e título do documento, localização: `char_location`, `page_location`, `search_result_location`…) | Mesma direção: citações presas ao texto, fontes à parte. O `excerpt` cumpre o papel do `cited_text` |
| [`GroundingSupport` do Gemini (Firebase AI)](https://firebase.google.com/docs/reference/js/ai.groundingsupport.md) · [tipos em Go (eino)](https://pkg.go.dev/github.com/cloudwego/eino/schema/gemini) | `groundingChunks` (fontes) e `groundingSupports` (um `segment` da resposta mais índices dos chunks); os tipos em Go documentam as posições do segmento em bytes | Fontes e ligações separadas, e o motivo do `utf8OffsetToIndex`: os transportes convertem bytes para UTF-16 |
| [Perplexity: streaming de citações](https://docs.perplexity.ai/docs/cookbook/articles/streaming-citations/README) | Marcadores numerados no texto (`[1]`, ou `[web:1]` em outro modo) ligados a `search_results` enviados à parte | O caso do marcador: tratado pelo `inlineCitations` no backend ou no transporte, nunca na página |
| [`ui-messages.ts` do AI SDK](https://app.unpkg.com/ai@6.0.99/files/src/ui/ui-messages.ts) | Partes `source-url` (`sourceId`, `url`, `title`) e `source-document`; nada liga uma fonte a um trecho | Mapeamento do `transport-ai-sdk`; `id` e `title` seguem os mesmos papéis |
| [Especificação do AG-UI (rascunho)](https://docs.ag-ui.com/spec/draft) | Protocolo de eventos entre agentes e interfaces, com eventos CUSTOM com namespace e nenhum evento de fonte | `h4b.sources` e `h4b.citations` como eventos CUSTOM, ao lado de `h4b.ui.effect` e `h4b.ui.render` |

## Experimentos e atributos da conversa

Apoia o [ADR 0017](../adr/0017-atributos-da-conversa.md) e [Experimentos](./experiments.md). Acesso em 2026-11-10.

| Fonte | O que é | Uso na H4B |
|---|---|---|
| [W3C Baggage](https://www.w3.org/TR/baggage/) | Cabeçalho `baggage` com membros `chave=valor` (valores com percent-encoding, propriedades opcionais após `;`), limites de 64 membros e 8192 bytes | Como os atributos da conversa chegam ao backend; `encodeBaggage`, `parseBaggage` e `mergeBaggage` seguem a especificação |
| [W3C Trace Context](https://www.w3.org/TR/trace-context/) | Cabeçalho `traceparent`, que liga os spans do navegador aos do backend | Já enviado pelo `getTraceHeaders()`; o `baggage` vai ao lado |
| [OpenTelemetry Baggage](https://opentelemetry.io/docs/concepts/signals/baggage/) | Contexto chave-valor propagado do OTel; a documentação avisa que o baggage vai em texto aberto a todo serviço seguinte | Por que só códigos entram, por que o servidor usa lista de chaves permitidas (`readConversationAttributes`) e por que um `baggage` que o propagador do OTel já pôs é juntado, não substituído |
| [API de métricas do OpenTelemetry: Counter](https://opentelemetry.io/docs/specs/otel/metrics/api/#counter) | Instrumento de soma monotônica | `recordCounter()` e os contadores de experimento: totais sem amostragem que duram mais que a retenção dos traces |

## Menu: matcher semântico local

Apoia a decisão em aberto 4 do [ROADMAP](../../ROADMAP.md) (embeddings no navegador vs. só padrões). Lido em 2026-11-12. Nada aqui foi medido por nós.

| Fonte | O que é | Uso no H4B |
|---|---|---|
| `@alexlana/agent-intents` (backend do polvo, repositório privado do alexlana) | Respostas fixas antes do LLM: compara a mensagem com frases de exemplo de cada intent e só responde quando a pontuação passa do `threshold` **e** vence a segunda intent pela `margin`; o que não respondeu vai a uma caixa de entrada que uma pessoa classifica | Referência para o matcher semântico do menu: resposta errada é pior que nenhuma (abaixo das duas condições, vai ao LLM) e nada do que o usuário escreve vira exemplo sozinho |

## Estado explícito da conversa

Apoia o [ADR 0019](../adr/0019-estado-explicito-da-conversa.md) e [Estado explícito da conversa](./conversation-state.md). Acesso em 2026-11-14. Lido em documentação e artigos; nenhum desses sistemas foi rodado por nós, e os números são dos autores.

| Fonte | O que é | Uso no H4B |
|---|---|---|
| [Hermes Agent: memória](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory) (Nous Research) | Dois arquivos de memória pequenos com limite rígido de caracteres; a ferramenta só acrescenta, corrige e remove entradas achadas por um trecho único; duplicatas exatas são ignoradas; o conteúdo é examinado (injeção, exfiltração, Unicode invisível) antes de entrar no prompt; passou do limite, a escrita é recusada com o que existe e quanto liberar | Operações em vez de reescrita, `too-long` e `over-budget` em vez de compactação, `duplicate`, limpeza antes de guardar |
| [OpenClaw: memória](https://docs.openclaw.ai/concepts/memory) | Um `MEMORY.md` curto e curado, notas diárias pesquisáveis, um "flush" antes da compactação e promoção para a memória curta só por pontuação, frequência e diversidade | Estado pequeno com limite por seção; o que é longo ou episódico fica com o backend (camada c) |
| [Letta: blocos de memória](https://docs.letta.com/guides/agents/memory-blocks) | Blocos com rótulo, descrição, limite de caracteres e `read_only` | Seções com `description`, `max` e `maxChars`; itens `locked` que o backend não muda |
| [Factory: avaliação de compressão de contexto](https://factory.ai/news/evaluating-compression) | Comparação de métodos de compressão para sessões longas de agente: o resumo estruturado e incremental perdeu menos que o refeito a cada vez, e todos rastrearam mal os artefatos | Por que o backend manda operações, nunca um estado inteiro novo, e por que há um estado dedicado ao lado do resumo do `memory` |
| [Zep: fatos](https://help.getzep.com/facts) · [como o Zep guarda a proveniência](https://blog.getzep.com/how-zep-tracks-provenance-in-agent-memory/) | Fatos com tempo de validade; um fato contradito é invalidado, não apagado, e a fonte fica guardada | Evidência por item, o diário com o antes e o depois, e o `validUntil` deixado em aberto no ADR |
| [Artigo do Mem0 (arXiv 2504.19413)](https://arxiv.org/abs/2504.19413) · [migração do Mem0 v2 → v3](https://docs.mem0.ai/migration/oss-v2-to-v3) | Começou com ADD/UPDATE/DELETE/NOOP decididos pelo modelo e passou a só adicionar, resolvendo conflitos na leitura | Remoções sempre pedem `reason` e têm teto por atualização (`maxRemovals`) |
| [Contaminação de estado na memória de agentes (arXiv 2605.16746)](https://arxiv.org/abs/2605.16746) | Conteúdo hostil comprimido num resumo passa pelos detectores e continua guiando o agente; limpar antes de comprimir funciona, limpar só o resumo pronto não | `cleanText` e `screen` rodam antes de o item ser guardado |
| [MemLineage (arXiv 2605.14421)](https://arxiv.org/abs/2605.14421) | Proveniência e linhagem por entrada de memória; uma memória "lavada" pelo resumo parece legítima quando só a assinatura é conferida | `origin` deduzida das mensagens citadas, nunca tirada da palavra de quem escreve |
| [ReacTOD (TrustNLP 2026)](https://aclanthology.org/2026.trustnlp-main.21/) | Um validador simbólico confere cada mudança de estado do diálogo antes de aplicá-la; sem isso, erros de formato e alucinações do modelo viram ações erradas em cascata | Cada operação é conferida de forma determinística (forma, seção, evidência, trecho) e recusada com um motivo que o modelo vê |
| [Anthropic: engenharia de contexto eficaz para agentes](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | Anotações estruturadas guardadas fora da janela de contexto, ao lado da compactação | O estado como anotações que o backend lê a cada turno, separadas do histórico bruto |

## Distribuição: pacotes e skills para agentes

Apoia [Pacotes](./packages.md), as [skills](../../skills/README.md) e o manifesto de plugin em `.claude-plugin/`. Acesso em 2026-11-16.

| Fonte | O que é | Uso no H4B |
|---|---|---|
| [npm: pacotes públicos com escopo](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages) | Pacotes com escopo são privados por padrão; publicar como públicos exige `--access public` ou `publishConfig.access` | `publishConfig.access: public` em todo pacote; a organização `@handsforbots` |
| [npm: `peerDependencies`](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#peerdependencies) e `peerDependenciesMeta` | Peers que o hospedeiro instala uma vez; o npm 7+ instala os que faltam, `optional` marca os que o pacote dispensa | Por que o `core` é peer, por que toda linha de instalação o cita e por que o `voice` é opcional para `keyboard` e `voice-effects`; o `test/package-catalog.test.ts` confere as linhas contra eles |
| [Agent Skills](https://agentskills.io) | Formato de pasta (`SKILL.md` com `name` e `description`, mais referências e scripts) lido por agentes de código | Formato das skills em `skills/` |
| [Claude Code: criar um marketplace](https://code.claude.com/docs/en/plugin-marketplaces) · [hospedar e manter](https://code.claude.com/docs/en/plugins/host-marketplace.md) | `.claude-plugin/marketplace.json` lista plugins; quem usa roda `/plugin marketplace add dono/repo`; um plugin sem `version` acompanha os commits do repositório | A raiz do repositório é ao mesmo tempo o marketplace e o plugin `handsforbots`, cujas `skills/` são as skills de integração; sem `version`, quem usa recebe cada atualização das skills |

## Segurança do repositório: segredos e dependências

Apoia as verificações de segurança em [Desenvolvimento](./development.md), `.github/` e `.githooks/`. Acesso em 2026-11-16.

| Fonte | O que é | Uso no H4B |
|---|---|---|
| [Gitleaks](https://github.com/gitleaks/gitleaks) | Detector de segredos no histórico do git e nas mudanças preparadas (MIT) | Hook de `pre-commit` nas mudanças preparadas e varredura do histórico inteiro no CI, pela imagem da CLI porque a `gitleaks-action` exige licença em repositórios de organização; `.gitleaksignore` para achados já revisados |
| [pnpm `audit`](https://pnpm.io/cli/audit) · [`overrides`](https://pnpm.io/settings#overrides) | Confere o lockfile contra a base de alertas do npm; overrides forçam uma faixa de versão em qualquer ponto da árvore | Auditoria bloqueante das dependências de produção no CI; overrides com o id do alerta como piso temporário para dependências transitivas |
| [Dependabot: `cooldown`](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference#cooldown-) · [grupos](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference#groups--) | Atrasa atualizações de versão por N dias depois de uma publicação; agrupa atualizações relacionadas num PR | Espera de 7 dias, para que uma publicação maliciosa ou quebrada costume ser retirada antes de chegar a nós; atualizações de segurança não esperam |
| [GitHub: endurecimento de segurança do Actions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#using-third-party-actions) | Fixar actions de terceiros no SHA completo do commit é a única referência imutável | Actions fixadas por SHA, a imagem do Gitleaks por digest, `permissions: contents: read`, `persist-credentials: false` |
| [Trusted publishing do npm](https://docs.npmjs.com/trusted-publishers) · [`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust) | Publicação pela CI com OIDC em vez de token; proveniência automática; trusted publisher e permissão de dist-tag por pacote (acesso em 2026-11-19) | `release.yml`, `scripts/publish.mjs`, `scripts/npm-trust.sh` ([Publicando](./development.md#publicando)). Requisitos segundo a documentação: npm 11.5.1+ para publicar, 11.21+ para dist-tag, 11.15+ para o `npm trust`; um trusted publisher novo expira depois de 2 dias sem publicar |

## Revisão de XSS

Apoia a revisão de XSS do ROADMAP (seção 3), o `packages/widget/test/xss.test.ts` e o `.github/workflows/codeql.yml`. Acesso em 2026-11-17.

| Fonte | O que é | Uso no H4B |
|---|---|---|
| [OWASP XSS Filter Evasion Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/XSS_Filter_Evasion_Cheat_Sheet.html) · [XSS Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html) | Catálogo de payloads que escapam de filtros; regras de codificação da saída por contexto | Formatos dos payloads da suíte do widget (handlers, esquemas com entidades, caracteres de controle, mutação por `<math>`/`<noscript>`); renderização que escapa primeiro e listas de URLs permitidas |
| [PortSwigger XSS cheat sheet](https://portswigger.net/web-security/cross-site-scripting/cheat-sheet) | Handlers de evento, tags e esquemas de URL que executam script, por navegador | Quais tags, atributos e esquemas a suíte proíbe no DOM renderizado |
| [fast-check](https://fast-check.dev) | Testes por propriedades em JavaScript (MIT) | Misturas aleatórias de trechos de Markdown e HTML só podem gerar as tags do próprio widget e links seguros; conferido contra um link `javascript:` e um escape faltando plantados de propósito |
| [CodeQL](https://codeql.github.com/docs/codeql-language-guides/codeql-for-javascript/) · [`security-extended`](https://docs.github.com/en/code-security/code-scanning/managing-your-code-scanning-configuration/codeql-query-suites) | Análise estática do GitHub; a suíte estendida acrescenta consultas de segurança de menor precisão, inclusive XSS no DOM | Roda a cada push e pull request sobre `packages/`, com resultados no code scanning; não enxerga através do nosso próprio escape, que os testes cobrem |
