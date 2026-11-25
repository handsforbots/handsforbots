export {
  voice,
  createVoice,
  type BargeInOptions,
  type InputModality,
  type ListenOptions,
  type OutputPreference,
  type SpeechLoadStart,
  type SpeechLoading,
  type SpeechWhileLoading,
  type TtsStatus,
  type TurnTiming,
  type VoiceDecision,
  type VoiceMode,
  type VoicePhase,
  type VoiceOptions,
  type VoiceService,
  type VoiceSpeechEvent,
  type VoiceTtsEvent,
  type VoiceNoiseEvent,
  type VoiceNoiseOptions,
  type VoiceLevelEvent,
  type VoiceLevelReading,
  type VoiceState,
} from './voice.js'
export {
  webSpeechSTT,
  webSpeechTTS,
  splitSentences,
  utteranceProsody,
  type WebSpeechSTTOptions,
  type WebSpeechTTSOptions,
} from './providers/webspeech.js'
export { httpSTT, httpTTS, decodeAudio, type HttpSTTOptions, type HttpTTSJsonReply, type HttpTTSOptions } from './providers/http.js'
export { webAudioPlayer, planProsody, encodeWav, type ProsodyPlan, type WebAudioPlayerOptions } from './player.js'
export { websocketSTT, voskSTT, type StreamingResult, type WebSocketSTTOptions } from './providers/websocket.js'
export { voskBrowserSTT, type VoskBrowserModule, type VoskBrowserOptions } from './providers/vosk-browser.js'
export { httpEndOfTurn, type HttpEndOfTurnOptions } from './providers/end-of-turn.js'
export { textEchoFilter, echoCoverage, type TextEchoFilterOptions } from './providers/echo.js'
export {
  captureFloat,
  capturePcm16,
  detectEndOfSpeech,
  noiseFloorTracker,
  openMicrophone,
  speechThreshold,
} from './providers/media.js'
export {
  assessNoise,
  checkNoise,
  createNoiseMeter,
  measureNoise,
  type CheckNoiseOptions,
  type MeasureNoiseOptions,
  type NoiseMeter,
  type NoiseReason,
  type NoiseReport,
  type NoiseThresholds,
  type NoiseVerdict,
} from './providers/noise.js'
export { createLevelGate, monitorLevel, type LevelGate, type LevelGateOptions, type LevelVerdict } from './providers/level.js'
export {
  alignWords,
  cleanTimedWords,
  decodeVttText,
  estimateWords,
  formatVttTime,
  normalizeWord,
  parseVttTime,
  parseWordVtt,
  splitWords,
  toWordVtt,
  voicedSpan,
  CHARS_PER_SECOND,
  MAX_TIMED_WORDS,
  type AlignOptions,
  type TimedWord,
  type WordQuality,
  type WordSource,
  type WordSpan,
  type WordTiming,
} from './words.js'
export type { ChunkRange, SpeechPosition, VoiceWordEvent } from './word-run.js'
export * from './types.js'
