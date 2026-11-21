import { SpeechError } from '../types.js'

export async function openMicrophone(): Promise<MediaStream> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new SpeechError('not-supported', 'Microphone capture is not available')
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: false,
    })
  } catch (error) {
    const name = (error as DOMException)?.name
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new SpeechError('not-allowed', 'Microphone permission denied')
    throw new SpeechError('audio-capture', (error as Error)?.message)
  }
}

export function closeStream(stream: MediaStream) {
  for (const track of stream.getTracks()) track.stop()
}

/** Resumes a suspended `AudioContext` so capture nodes start delivering audio. */
export async function resumeAudioContext(context: AudioContext, timeoutMs = 1000): Promise<void> {
  if (context.state === 'closed') throw new SpeechError('audio-capture', 'Audio capture context is closed')
  if (context.state !== 'suspended' || typeof context.resume !== 'function') return
  let timer: ReturnType<typeof setTimeout> | undefined
  const resumed = await Promise.race([
    context.resume().then(
      () => true,
      () => false,
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
  if (!resumed || (context.state as AudioContextState) !== 'running') {
    throw new SpeechError('audio-capture', 'Audio capture context is suspended')
  }
}

const WORKLET = `
class H4BPcm extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) this.port.postMessage(channel.slice(0))
    return true
  }
}
registerProcessor('h4b-pcm', H4BPcm)
`

/** Streams microphone audio as 16-bit PCM chunks (~100 ms) at `sampleRate`. */
export async function capturePcm16(
  stream: MediaStream,
  sampleRate: number,
  onChunk: (chunk: ArrayBuffer) => void,
): Promise<() => Promise<void>> {
  const context = new AudioContext()
  try {
    await resumeAudioContext(context)
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
    try {
      await context.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    const source = context.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(context, 'h4b-pcm')
    const ratio = context.sampleRate / sampleRate
    const batch = Math.round(sampleRate / 10)
    let pending: number[] = []
    let carry = 0

    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const input = event.data
      // Average-based decimation to the target rate.
      for (let position = carry; position < input.length; position += ratio) {
        const start = Math.floor(position)
        const end = Math.min(input.length, Math.floor(position + ratio))
        let sum = 0
        for (let i = start; i < end; i++) sum += input[i]!
        pending.push(sum / Math.max(1, end - start))
        carry = position + ratio - input.length
      }
      if (pending.length >= batch) {
        const pcm = new Int16Array(pending.length)
        pending.forEach((s, i) => (pcm[i] = Math.max(-1, Math.min(1, s)) * 0x7fff))
        pending = []
        onChunk(pcm.buffer)
      }
    }
    source.connect(node)
    return async () => {
      node.port.onmessage = null
      source.disconnect()
      node.disconnect()
      await context.close()
    }
  } catch (error) {
    void context.close().catch(() => {})
    throw error
  }
}

/**
 * Minimum-statistics noise floor: the lowest RMS among the last `window`
 * readings. Speech has pauses and stops, so the minimum follows the noise and
 * not the voice; a steady new noise is picked up after one window.
 */
export function noiseFloorTracker(window: number) {
  const ring: number[] = []
  return {
    push(rms: number) {
      ring.push(rms)
      if (ring.length > window) ring.shift()
      return Math.min(...ring)
    },
    get floor() {
      return ring.length ? Math.min(...ring) : 0
    },
  }
}

/** Speech threshold for one RMS reading: fixed, or raised over the tracked noise floor. */
export function speechThreshold(floor: number, { threshold = 0.015, margin = 3 } = {}) {
  return margin > 0 ? Math.max(threshold, floor * margin) : threshold
}

/**
 * Minimal energy-based voice activity detection: calls `onSilence` after the
 * user spoke and then stayed quiet for `silenceMs`. Speech is RMS above
 * `threshold` and above `margin` times the noise floor of the last `floorMs`
 * (`margin: 0` keeps the fixed threshold), so steady room noise does not
 * count as speech.
 */
export function detectEndOfSpeech(
  stream: MediaStream,
  onSilence: () => void,
  { silenceMs = 1200, threshold = 0.015, margin = 3, floorMs = 3000 } = {},
): () => void {
  const context = new AudioContext()
  if (context.state === 'suspended') void context.resume?.().catch(() => {})
  const analyser = context.createAnalyser()
  analyser.fftSize = 1024
  context.createMediaStreamSource(stream).connect(analyser)
  const data = new Float32Array(analyser.fftSize)
  const tick = 50
  const floor = noiseFloorTracker(Math.max(1, Math.round(floorMs / tick)))
  let spoke = false
  let quietSince = 0
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(data)
    let sum = 0
    for (const v of data) sum += v * v
    const rms = Math.sqrt(sum / data.length)
    const now = Date.now()
    if (rms > speechThreshold(floor.push(rms), { threshold, margin })) {
      spoke = true
      quietSince = now
    } else if (spoke && now - quietSince > silenceMs) {
      spoke = false
      onSilence()
    }
  }, tick)
  return () => {
    clearInterval(timer)
    void context.close()
  }
}

/** Streams microphone audio as Float32 frames at the AudioContext rate (for in-browser recognizers). */
export async function captureFloat(
  stream: MediaStream,
  onFrame: (frame: Float32Array, sampleRate: number) => void,
  options?: { context?: AudioContext; resumeTimeoutMs?: number },
): Promise<() => Promise<void>> {
  const context = options?.context ?? new AudioContext()
  try {
    await resumeAudioContext(context, options?.resumeTimeoutMs)
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
    try {
      await context.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    const source = context.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(context, 'h4b-pcm')
    node.port.onmessage = (event: MessageEvent<Float32Array>) => onFrame(event.data, context.sampleRate)
    source.connect(node)
    return async () => {
      node.port.onmessage = null
      source.disconnect()
      node.disconnect()
      await context.close()
    }
  } catch (error) {
    void context.close().catch(() => {})
    throw error
  }
}
