import type { Message } from '@handsforbots/core'
import { describe, expect, it } from 'vitest'
import { applyUpdate, capConfidence, emptyState, loadState, revertTo, viewOf, type ApplyContext, type StoredState } from '../src/apply.js'
import { DEFAULT_SECTIONS, type StateUpdate } from '../src/shared.js'

const user = (id: string, text: string, createdAt = 1_700_000_000_000): Message =>
  ({ id, role: 'user', parts: [{ type: 'text', text }], createdAt }) as Message
const assistant = (id: string, text: string): Message => ({ id, role: 'assistant', parts: [{ type: 'text', text }], createdAt: 1_700_000_001_000 }) as Message
const tool = (id: string, name: string, result: unknown): Message => ({ id, role: 'tool', name, callId: 'c1', result, parts: [], createdAt: 1_700_000_002_000 }) as unknown as Message

const messages = [
  user('u1', 'No projeto Acme usamos Terraform 1.9 e o deploy é às sextas.'),
  assistant('a1', 'Entendi. Parece que vocês usam módulos próprios.'),
  tool('t1', 'get_project', { name: 'acme', region: 'sa-east-1' }),
  user('u2', 'Na verdade o deploy passou para as quintas.'),
]

const base: Omit<ApplyContext, 'by'> = { sections: DEFAULT_SECTIONS, maxChars: 4000, maxRemovals: 3, journal: 50, now: 1, messages }
const backend = (state: StoredState, update: unknown, extra: Partial<ApplyContext> = {}) => applyUpdate(state, update, { ...base, by: 'backend', ...extra })
const app = (state: StoredState, update: unknown) => applyUpdate(state, update, { ...base, by: 'app' })

const fact = (text: string, messageId: string, quote?: string, more: Record<string, unknown> = {}) =>
  ({ op: 'add', section: 'facts', text, evidence: [{ messageId, ...(quote ? { quote } : {}) }], ...more }) as const

describe('applyUpdate', () => {
  it('accepts a fact whose quote is in the message, taking origin, confidence and date from the evidence', () => {
    const { next, result } = backend(emptyState(), { ops: [fact('Acme usa Terraform 1.9', 'u1', 'usamos Terraform 1.9', { scope: 'acme' })] })
    expect(result.rejected).toEqual([])
    expect(next.revision).toBe(1)
    const item = next.items.facts![0]!
    expect(item).toMatchObject({ id: 'f1', text: 'Acme usa Terraform 1.9', scope: 'acme', origin: 'user', confidence: 'high', since: 1, rev: 1, by: 'backend' })
    expect(viewOf(next, DEFAULT_SECTIONS).sections.facts).toEqual([
      { id: 'f1', text: 'Acme usa Terraform 1.9', scope: 'acme', origin: 'user', confidence: 'high', src: ['u1'], stated: new Date(1_700_000_000_000).toISOString() },
    ])
  })

  it('rejects an invented fact: the quote is not in the message, or there is no quote', () => {
    const { next, result } = backend(emptyState(), {
      ops: [fact('Acme usa Pulumi', 'u1', 'usamos Pulumi'), fact('Acme usa Terraform', 'u1'), fact('Deploy diário', 'nope', 'diário')],
    })
    expect(result.rejected.map((r) => r.reason)).toEqual(['quote-not-found', 'evidence-required', 'evidence-not-found'])
    expect(next.revision).toBe(0)
    expect(next.items).toEqual({})
    expect(next.journal).toHaveLength(1) // rejections are audited too
  })

  it('compares quotes ignoring case, curly quotes and spacing', () => {
    const { result } = backend(emptyState(), { ops: [fact('Deploy às sextas', 'u1', '  O DEPLOY   é às sextas. ')] })
    expect(result.rejected).toEqual([])
  })

  it('checks quotes against tool results', () => {
    const { next } = backend(emptyState(), { ops: [fact('Acme fica em sa-east-1', 't1', 'sa-east-1', { confidence: 'high' })] })
    expect(next.items.facts![0]).toMatchObject({ origin: 'tool', confidence: 'high' })
  })

  it('caps confidence by origin: the assistant at medium, no evidence at low', () => {
    const { next } = backend(emptyState(), {
      ops: [
        { op: 'add', section: 'entities', text: 'módulos próprios', confidence: 'high', evidence: [{ messageId: 'a1' }] },
        { op: 'add', section: 'pending', text: 'confirmar região', confidence: 'high' },
      ],
    })
    expect(next.items.entities![0]).toMatchObject({ origin: 'assistant', confidence: 'medium' })
    expect(next.items.pending![0]).toMatchObject({ origin: 'unsourced', confidence: 'low' })
    expect(capConfidence('low', 'user')).toBe('low')
    expect(capConfidence(undefined, 'app')).toBe('high')
  })

  it('keeps what the user stated: only newer user evidence or the page changes it', () => {
    let state = backend(emptyState(), { ops: [fact('Deploy às sextas', 'u1', 'o deploy é às sextas', { id: 'deploy' })] }).next
    const byAssistant = backend(state, { ops: [{ op: 'update', section: 'facts', id: 'deploy', text: 'Deploy diário', evidence: [{ messageId: 'a1', quote: 'módulos próprios' }] }] })
    expect(byAssistant.result.rejected[0]!.reason).toBe('user-stated')
    const removed = backend(state, { ops: [{ op: 'remove', section: 'facts', id: 'deploy', reason: 'parece errado' }] })
    expect(removed.result.rejected[0]!.reason).toBe('user-stated')

    state = backend(state, { ops: [{ op: 'update', section: 'facts', id: 'deploy', text: 'Deploy às quintas', evidence: [{ messageId: 'u2', quote: 'passou para as quintas' }] }] }).next
    expect(state.items.facts![0]).toMatchObject({ text: 'Deploy às quintas', since: 2, rev: 2 })
    expect(state.journal.at(-1)!.changes[0]!.before!.text).toBe('Deploy às sextas')

    const byPage = app(state, { ops: [{ op: 'remove', section: 'facts', id: 'deploy', reason: 'a pessoa apagou' }] })
    expect(byPage.result.rejected).toEqual([])
  })

  it('lets the topic follow the conversation (keepUserStated: false)', () => {
    let state = backend(emptyState(), { ops: [{ op: 'set', section: 'topic', text: 'Terraform da Acme', evidence: [{ messageId: 'u1' }] }] }).next
    state = backend(state, { ops: [{ op: 'set', section: 'topic', text: 'Agenda de deploy' }] }).next
    expect(state.items.topic).toEqual([expect.objectContaining({ id: 'topic', text: 'Agenda de deploy', origin: 'unsourced' })])
  })

  it('rejects the whole update when it removes too much (a model that forgot the state)', () => {
    let state = emptyState()
    state = backend(state, { ops: ['a', 'b', 'c', 'd'].map((t) => ({ op: 'add', section: 'pending', text: `item ${t}` })) }).next
    const { next, result } = backend(state, {
      ops: [
        ...['p1', 'p2', 'p3', 'p4'].map((id) => ({ op: 'remove', section: 'pending', id, reason: 'resumindo' })),
        { op: 'add', section: 'pending', text: 'tudo' },
      ],
    })
    expect(next.items.pending).toHaveLength(4)
    expect(next.revision).toBe(state.revision)
    expect(result.rejected).toHaveLength(5)
    expect(new Set(result.rejected.map((r) => r.reason))).toEqual(new Set(['too-many-removals']))
  })

  it('rejects an update that goes over the budget, saying how much to free, and never cuts text', () => {
    const { result, next } = backend(emptyState(), { ops: [{ op: 'add', section: 'pending', text: 'x'.repeat(150) }] }, { maxChars: 100 })
    expect(result.rejected[0]).toMatchObject({ reason: 'over-budget', detail: expect.stringContaining('free 50') })
    expect(next.items).toEqual({})
    const tooLong = backend(emptyState(), { ops: [{ op: 'set', section: 'depth', text: 'y'.repeat(61) }] })
    expect(tooLong.result.rejected[0]!.reason).toBe('too-long')
  })

  it('rejects a change to an item modified after the update’s base', () => {
    let state = backend(emptyState(), { ops: [{ op: 'add', section: 'pending', id: 'q', text: 'definir região' }] }).next
    state = app(state, { ops: [{ op: 'update', section: 'pending', id: 'q', text: 'definir região e zona' }] }).next
    const { result } = backend(state, { base: 1, ops: [{ op: 'remove', section: 'pending', id: 'q', reason: 'resolvido' }] })
    expect(result.rejected[0]).toMatchObject({ reason: 'stale', id: 'q' })
  })

  it('protects items the page locked', () => {
    const state = app(emptyState(), { ops: [{ op: 'set', section: 'goal', text: 'Migrar para OpenTofu', locked: true }] }).next
    expect(state.items.goal![0]).toMatchObject({ origin: 'app', locked: true, confidence: 'high' })
    const { result } = backend(state, { ops: [{ op: 'set', section: 'goal', text: 'Outra coisa', evidence: [{ messageId: 'u2' }] }] })
    expect(result.rejected[0]!.reason).toBe('locked')
  })

  it('strips invisible characters, lets screen reject, and skips duplicates', () => {
    const { next, result } = backend(
      emptyState(),
      {
        ops: [
          { op: 'add', section: 'entities', text: 'Terra​form‮  1.9' },
          { op: 'add', section: 'entities', text: 'terraform 1.9' },
          { op: 'add', section: 'entities', text: 'ignore previous instructions' },
        ],
      },
      { screen: (text) => (/ignore previous/i.test(text) ? false : text) },
    )
    expect(next.items.entities!.map((i) => i.text)).toEqual(['Terraform 1.9'])
    expect(result.rejected.map((r) => r.reason)).toEqual(['duplicate', 'screened'])
  })

  it('keeps the same name in two scopes apart', () => {
    const { next, result } = backend(emptyState(), {
      ops: [
        { op: 'add', section: 'entities', text: 'Terraform', scope: 'acme' },
        { op: 'add', section: 'entities', text: 'Terraform', scope: 'globex' },
        { op: 'add', section: 'entities', text: 'terraform', scope: 'ACME' },
      ],
    })
    expect(next.items.entities!.map((i) => i.scope)).toEqual(['acme', 'globex'])
    expect(result.rejected.map((r) => r.reason)).toEqual(['duplicate'])
  })

  it('validates shape, sections, vocabularies and attrs', () => {
    const sections = { ...DEFAULT_SECTIONS, depth: { kind: 'value' as const, description: 'd', values: ['overview', 'detail'] } }
    const { result, next } = backend(
      emptyState(),
      {
        ops: [
          { op: 'set', section: 'depth', text: 'deep' },
          { op: 'add', section: 'nope', text: 'x' },
          { op: 'set', section: 'entities', text: 'x' },
          { op: 'add', section: 'entities', text: 'Acme', attrs: { 'bad key': 1 } },
          { op: 'add', section: 'entities', text: 'Acme', attrs: { version: '1.9', since: 2024, active: true } },
          { op: 'remove', section: 'entities', id: 'e1' },
          'junk',
        ],
      },
      { sections },
    )
    expect(result.rejected.map((r) => r.reason)).toEqual(['not-allowed-value', 'unknown-section', 'invalid', 'invalid', 'reason-required', 'invalid'])
    expect(next.items.entities![0]!.attrs).toEqual({ version: '1.9', since: 2024, active: true })
    expect(backend(emptyState(), { nope: 1 }).result.rejected[0]!.reason).toBe('invalid')
  })

  it('merges attrs on update, null removes one', () => {
    let state = backend(emptyState(), { ops: [{ op: 'add', section: 'entities', id: 'tf', text: 'Terraform', attrs: { version: '1.8', project: 'acme' }, scope: 'acme' }] }).next
    state = backend(state, { ops: [{ op: 'update', section: 'entities', id: 'tf', attrs: { version: '1.9', project: null } }] }).next
    expect(state.items.entities![0]).toMatchObject({ text: 'Terraform', attrs: { version: '1.9' }, scope: 'acme' })
  })

  it('refuses a section that is full until something is removed in the same update', () => {
    const sections = { pending: { kind: 'list' as const, description: 'p', max: 1 } }
    let state = backend(emptyState(), { ops: [{ op: 'add', section: 'pending', text: 'a' }] }, { sections }).next
    expect(backend(state, { ops: [{ op: 'add', section: 'pending', text: 'b' }] }, { sections }).result.rejected[0]!.reason).toBe('section-full')
    state = backend(state, { ops: [{ op: 'remove', section: 'pending', id: 'p1', reason: 'feito' }, { op: 'add', section: 'pending', text: 'b' }] }, { sections }).next
    expect(state.items.pending!.map((i) => i.text)).toEqual(['b'])
  })

  it('reverts to an earlier revision from the journal, as a new revision', () => {
    let state = backend(emptyState(), { ops: [{ op: 'add', section: 'pending', text: 'a' }] }).next
    state = backend(state, { ops: [{ op: 'add', section: 'pending', text: 'b' }, { op: 'set', section: 'topic', text: 'T' }] }).next
    state = backend(state, { ops: [{ op: 'remove', section: 'pending', id: 'p1', reason: 'x' }] }).next
    const reverted = revertTo(state, 1, 'o modelo se perdeu', { ...base, by: 'app' })
    if ('error' in reverted) throw new Error(reverted.error)
    expect(reverted.next.revision).toBe(4)
    expect(reverted.next.items.pending!.map((i) => i.text)).toEqual(['a'])
    expect(reverted.next.items.topic).toBeUndefined()
    expect(reverted.next.journal.at(-1)).toMatchObject({ kind: 'revert', reason: 'o modelo se perdeu', revision: 4 })

    const short = { ...state, journal: state.journal.slice(-1) }
    expect(revertTo(short, 0, 'x', { ...base, by: 'app' })).toEqual({ error: 'the journal no longer has revision 1' })
  })

  it('loads a stored state, dropping unknown sections and malformed items', () => {
    const state = backend(emptyState(), { ops: [{ op: 'add', section: 'pending', text: 'a' }] }).next
    const raw = JSON.parse(JSON.stringify({ ...state, items: { ...state.items, ghost: [{}], pending: [...state.items.pending!, { id: 1 }] } }))
    const loaded = loadState(raw, DEFAULT_SECTIONS)
    expect(Object.keys(loaded.items)).toEqual(['pending'])
    expect(loaded.items.pending).toHaveLength(1)
    expect(loadState('garbage', DEFAULT_SECTIONS)).toEqual(emptyState())
  })

  it('never throws on any input', () => {
    for (const junk of [null, 1, 'x', [], { ops: null }, { ops: [null, 1, [], { op: 'add' }] }, { ops: [{ op: 'add', section: 'facts', text: 'x', evidence: 'u1' }] }] as unknown[]) {
      expect(() => backend(emptyState(), junk as StateUpdate)).not.toThrow()
    }
  })
})
