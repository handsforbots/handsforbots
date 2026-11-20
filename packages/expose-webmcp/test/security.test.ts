// @vitest-environment jsdom
import { createH4B } from '@handsforbots/core'
import { afterEach, describe, expect, it } from 'vitest'
import { webmcp, type ModelContext, type ModelContextTool } from '../src/index.js'

function fakeModelContext() {
  const tools = new Map<string, ModelContextTool>()
  const waiters = new Map<string, { resolve: () => void; reject: (e: Error) => void; tool: ModelContextTool }>()
  const mc: ModelContext & {
    tools: typeof tools
    call(name: string, input: object): Promise<string>
    complete(name: string): void
  } = {
    tools,
    registerTool(tool, options) {
      return new Promise<void>((resolve, reject) => {
        waiters.set(tool.name, {
          tool,
          resolve: () => {
            tools.set(tool.name, tool)
            waiters.delete(tool.name)
            resolve()
          },
          reject: (error) => {
            waiters.delete(tool.name)
            reject(error)
          },
        })
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    },
    complete(name) {
      waiters.get(name)?.resolve()
    },
    call: (name, input) => tools.get(name)!.execute(input as Record<string, unknown>, {}),
  }
  return mc
}

afterEach(() => {
  delete (document as any).modelContext
})

describe('expose-webmcp security', () => {
  it('does not drop a newer registration when an older registerTool promise rejects', async () => {
    const mc = fakeModelContext()
    const h4b = createH4B()
    await h4b.use(webmcp({ modelContext: mc, include: 'all' }))
    const removeV1 = h4b.actions.register({ name: 'flip', description: 'Flip', exposeTo: ['agent'], handler: () => 'v1' })
    removeV1()
    h4b.actions.register({ name: 'flip', description: 'Flip', exposeTo: ['agent'], handler: () => 'v3' })
    await new Promise((r) => setTimeout(r, 0))
    mc.complete('flip')
    await new Promise((r) => setTimeout(r, 0))
    expect(mc.tools.has('flip')).toBe(true)
    expect(h4b.get('webmcp')!.getState().tools).toEqual(['flip'])
    expect(await mc.call('flip', {})).toBe('v3')
  })

  it('refuses execute when the action is no longer exposed to agents', async () => {
    const mc = fakeModelContext()
    const h4b = createH4B()
    await h4b.use(webmcp({ modelContext: mc, include: 'all' }))
    const remove = h4b.actions.register({ name: 'secret', description: 'Secret', exposeTo: ['agent'], handler: () => 'leaked' })
    mc.complete('secret')
    const stale = mc.tools.get('secret')!
    remove()
    h4b.actions.register({ name: 'secret', description: 'Secret', exposeTo: ['user'], handler: () => 'user-only' })
    mc.complete('secret')
    await new Promise((r) => setTimeout(r, 0))
    await expect(stale.execute({}, {})).rejects.toThrow(/no longer available/)
  })
})