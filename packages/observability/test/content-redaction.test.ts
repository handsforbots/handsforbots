import { createH4B } from '@handsforbots/core'
import type { Exporter, SemanticEvent } from '@handsforbots/semantic-event-observability'
import { describe, expect, it } from 'vitest'
import { observability } from '../src/index.js'

const CANARY_SSN = 'my SSN is 123-45-6789'
const CANARY_IBAN = 'DE89370400440532013000'
const CANARY_TOKEN = '?token=sk_live_ABC'
const CANARIES = [CANARY_SSN, CANARY_IBAN, CANARY_TOKEN]

function assertNoCanaries(text: string) {
  for (const canary of CANARIES) {
    expect(text).not.toContain(canary)
  }
}

describe('content redaction (includeContent false)', () => {
  it('strips canaries from timeline and exporter payload previews on every leak path', async () => {
    const exported: SemanticEvent[] = []
    const captureExporter: Exporter = {
      id: 'capture',
      onEvent(event) {
        exported.push(event)
      },
    }

    const h4b = await createH4B({
      plugins: [
        observability({
          environment: 'test',
          exporters: [],
          customExporters: [captureExporter],
        }),
      ],
      actions: [
        {
          name: 'leak',
          description: 'Leak',
          handler: () => {
            throw Object.assign(new Error(CANARY_SSN), { code: 'fail', stage: 'handler' })
          },
        },
      ],
    }).start()

    h4b.provide('transport', {
      name: 'err',
      async *run() {
        yield { type: 'error', message: CANARY_IBAN }
      },
    })

    const emit = h4b.emit.bind(h4b) as (event: string, payload: unknown) => void
    emit('voice.speech', {
      phase: 'error',
      provider: 'piper',
      code: 'synthesis-failed',
      message: CANARY_SSN,
      text: CANARY_TOKEN,
      url: `https://evil.example/${CANARY_TOKEN}`,
    })
    emit('voice.tts', {
      provider: 'piper',
      event: 'load.error',
      ms: 10,
      message: CANARY_IBAN,
      file: `/secret/${CANARY_SSN}`,
    })
    emit('cue.changed', {
      channel: 'tone',
      value: 'ok',
      note: CANARY_SSN,
      streak: 1,
      count: 1,
      level: 1,
      from: 'backend',
    })

    h4b.emit('error', {
      error: Object.assign(new Error(CANARY_TOKEN), { code: 'x', stage: 'y' }),
      source: 'voice:tts:test',
    })

    await h4b.ask(CANARY_SSN)
    await h4b.runAction('leak', { secret: CANARY_TOKEN }, { origin: 'agent' })

    const timeline = h4b.get('observability')!.getTimeline()
    const blob = JSON.stringify(timeline)
    assertNoCanaries(blob)
    assertNoCanaries(JSON.stringify(exported))

    const previews = exported.map((e) => JSON.stringify(e.payloadSummary))
    assertNoCanaries(previews.join('\n'))

    const turnError = timeline.find((e) => e.name === 'turn.error')
    expect(turnError?.payload).toBeDefined()
    expect(JSON.stringify(turnError?.payload)).not.toContain(CANARY_SSN)

    const actionFailed = timeline.find((e) => e.name === 'action.failed')
    expect(actionFailed?.payload).toMatchObject({ action: 'leak', origin: 'agent' })
    expect(JSON.stringify(actionFailed?.payload)).not.toContain(CANARY_SSN)

    const speech = timeline.find((e) => e.name === 'voice.speech.error')
    expect(speech?.payload).toMatchObject({ phase: 'error', provider: 'piper', code: 'synthesis-failed' })
    expect(JSON.stringify(speech?.payload)).not.toContain(CANARY_SSN)

    const kernel = timeline.find((e) => e.name === 'kernel.error')
    expect(kernel?.payload).toMatchObject({ source: 'voice:tts:test', code: 'x', stage: 'y' })
    expect(JSON.stringify(kernel?.payload)).not.toContain(CANARY_TOKEN)
  })

  it('still redacts sensitive patterns in errors when includeContent is true', async () => {
    const h4b = await createH4B({ plugins: [observability({ includeContent: true, environment: 'test' })] }).start()
    h4b.emit('error', { error: new Error(CANARY_SSN), source: 'test' })
    const preview = h4b
      .get('observability')!
      .getTimeline()
      .find((e) => e.name === 'kernel.error')?.payloadSummary as { preview?: string } | undefined
    expect(preview?.preview).toBeDefined()
    assertNoCanaries(preview!.preview!)
  })

  it('strips reason from voice.decision when includeContent is false', async () => {
    const exported: SemanticEvent[] = []
    const captureExporter: Exporter = {
      id: 'capture',
      onEvent(event) {
        exported.push(event)
      },
    }
    const h4b = await createH4B({
      plugins: [
        observability({
          environment: 'test',
          exporters: [],
          customExporters: [captureExporter],
        }),
      ],
    }).start()
    const emit = h4b.emit.bind(h4b) as (event: string, payload: unknown) => void
    emit('voice.decision', {
      kind: 'end-of-turn-unavailable',
      provider: 'model',
      reason: 'failed to load ?token=sk_live_ABC',
      text: 'secret transcript',
    })
    const timeline = h4b.get('observability')!.getTimeline()
    const decision = timeline.find((e) => e.name === 'voice.decision')
    expect(decision).toBeDefined()
    const payload = decision!.payload as Record<string, unknown>
    expect(payload.kind).toBe('end-of-turn-unavailable')
    expect(payload.provider).toBe('model')
    expect(payload).not.toHaveProperty('reason')
    expect(payload).not.toHaveProperty('text')
  })
})