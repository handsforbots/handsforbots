import { createH4B, definePlugin, type Stimulus, type Transport, type TurnRequest } from '@handsforbots/core'
import { describe, expect, it } from 'vitest'
import { a2ui, basicCatalog } from '../src/index.js'

function scripted(turns: Stimulus[][]) {
  const requests: TurnRequest[] = []
  let i = 0
  const transport: Transport = {
    name: 'scripted',
    async *run(request) {
      requests.push(request)
      for (const stimulus of turns[i++] ?? []) yield stimulus
    },
  }
  return {
    requests,
    plugin: definePlugin({
      name: 'test-transport',
      provides: ['transport'],
      apply: (ctx) => ctx.provide('transport', transport),
    })(),
  }
}

async function idle(h4b: ReturnType<typeof createH4B>) {
  await new Promise((r) => setTimeout(r, 0))
  const deadline = Date.now() + 5000
  while (h4b.busy && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2))
}

const createCardOp = (surfaceId: string, sendDataModel = false) => ({
  version: '1.0' as const,
  createSurface: {
    surfaceId,
    catalogId: basicCatalog.id,
    ...(sendDataModel ? { sendDataModel: true } : {}),
  },
})

const updateCardOp = (surfaceId: string, text: string) => ({
  version: '1.0' as const,
  updateComponents: {
    surfaceId,
    components: [
      { id: 'root', component: 'Text', text },
    ],
  },
})

describe('@handsforbots/a2ui', () => {
  it('processes A2UI 1.0 snapshots and JSON Patch deltas from ui.surface stimuli', async () => {
    const { plugin } = scripted([
      [
        {
          type: 'ui.surface',
          surfaceId: 'a2ui-surface-card',
          kind: 'a2ui',
          op: 'snapshot',
          payload: {
            content: {
              operations: [
                createCardOp('card-1'),
                updateCardOp('card-1', 'Initial'),
              ],
            },
            replace: true,
          },
        },
        {
          type: 'ui.surface',
          surfaceId: 'a2ui-surface-card',
          kind: 'a2ui',
          op: 'delta',
          payload: {
            patch: [
              { op: 'replace', path: '/operations/1/updateComponents/components/0/text', value: 'Updated' },
            ],
          },
        },
      ],
    ])

    const h4b = await createH4B({ plugins: [plugin, a2ui()] }).start()
    const svc = h4b.get('a2ui')!
    let notifications = 0
    svc.subscribe(() => { notifications++ })

    h4b.send('show card')
    await idle(h4b)

    const entry = svc.getSurface('card-1')
    expect(entry).toBeDefined()
    expect(entry?.model.componentsModel.get('root')?.properties.text).toBe('Updated')
    expect(notifications).toBeGreaterThan(0)
  })

  it('routes surface actions to allowlisted H4B actions or gui-event signals', async () => {
    const ran: unknown[] = []
    const { plugin, requests } = scripted([[], []])
    const h4b = await createH4B({
      plugins: [plugin, a2ui({ allowActions: ['filter_orders'] })],
      actions: [
        {
          name: 'filter_orders',
          description: 'Filter orders',
          exposeTo: ['agent'],
          handler: (args) => {
            ran.push(args)
            return { ok: true }
          },
        },
      ],
    }).start()

    const svc = h4b.get('a2ui')!
    await svc.dispatchAction({
      name: 'filter_orders',
      surfaceId: 'card-1',
      sourceComponentId: 'btn-1',
      context: { status: 'late' },
    })
    expect(ran).toEqual([{ status: 'late' }])
    expect(requests).toHaveLength(0)

    await svc.dispatchAction({
      name: 'confirm_booking',
      surfaceId: 'card-1',
      sourceComponentId: 'btn-2',
      context: { slot: '10:00' },
      userMessage: 'Confirm 10:00',
    })
    await idle(h4b)

    expect(requests).toHaveLength(1)
    const userMessage = requests[0]?.messages.at(-1)
    expect(userMessage).toMatchObject({
      role: 'user',
      modality: 'gui-event',
      source: 'a2ui',
      parts: [
        { type: 'text', text: 'Confirm 10:00' },
        {
          type: 'data',
          name: 'a2ui.action',
          value: expect.objectContaining({ name: 'confirm_booking', surfaceId: 'card-1', context: { slot: '10:00' } }),
        },
      ],
    })
  })

  it('reports active data models and optional capabilities on requests, and clears on reset', async () => {
    const { plugin, requests } = scripted([[]])
    const h4b = await createH4B({
      plugins: [plugin, a2ui({ reportCapabilities: true })],
    }).start()

    const svc = h4b.get('a2ui')!
    svc.process([
      createCardOp('form-1', true),
      { version: '1.0', updateDataModel: { surfaceId: 'form-1', path: '/city', value: 'Curitiba' } },
    ])

    h4b.send('next')
    await idle(h4b)

    const keys = requests[0]?.context.map((c) => c.key) ?? []
    expect(keys).toContain('a2ui.dataModel')
    expect(keys).toContain('a2ui.capabilities')

    await h4b.reset()
    expect(svc.getState().surfaces.size).toBe(0)
  })
})
