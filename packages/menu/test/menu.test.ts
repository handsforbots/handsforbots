import { createH4B, textOf, type Transport, type TurnRequest } from '@handsforbots/core'
import { describe, expect, it, vi } from 'vitest'
import { CLARIFY_ACTION, createMenu, fuzzyBest, fuzzyRank, menu, normalize, similarity, type Command } from '../src/index.js'

describe('fuzzy', () => {
  it('normalizes case, accents and punctuation', () => {
    expect(normalize('  Próximo!!  PASSO ')).toBe('proximo passo')
  })

  it('tolerates typos and transpositions but not unrelated words', () => {
    expect(similarity('porximo', 'próximo')).toBeGreaterThan(0.8)
    expect(similarity('voltar', 'volta')).toBeGreaterThan(0.8)
    expect(similarity('cancelar', 'continuar')).toBeLessThan(0.7)
  })

  it('picks the best phrase, ignores long sentences and returns undefined below threshold', () => {
    const entries = [
      { phrase: 'próximo', value: 1 },
      { phrase: 'anterior', value: -1 },
      { phrase: 'pular guia', value: 0 },
    ]
    expect(fuzzyBest('proximo', entries)).toMatchObject({ value: 1, score: 1 })
    expect(fuzzyBest('pular gia', entries)).toMatchObject({ value: 0 })
    expect(fuzzyBest('xyz', entries)).toBeUndefined()
    expect(fuzzyBest('por favor me explica o próximo passo do relatório', entries)).toBeUndefined()
  })

  it('ranks each value once by its best phrase', () => {
    const ranked = fuzzyRank('proxim', [
      { phrase: 'próximo', value: 'next' },
      { phrase: 'avançar', value: 'next' },
      { phrase: 'anterior', value: 'prev' },
    ])
    expect(ranked.map((r) => [r.value, r.phrase])).toEqual([
      ['next', 'próximo'],
      ['prev', 'anterior'],
    ])
  })
})

const commands: Command[] = [
  {
    action: 'filter_orders',
    label: 'Filtrar pedidos',
    slash: ['pedidos', 'orders'],
    patterns: ['mostrar pedidos {status}', 'show {status} orders', /^pedidos? (?<status>abertos|fechados)$/i],
    phrases: { 'pt-br': ['ver pedidos'], en: ['see orders'] },
    args: ({ status, rest }: Record<string, string>) => ({ status: status ?? (rest || 'all') }),
    reply: (result) => `${result} pedidos.`,
  },
  {
    action: 'guide_next',
    phrases: { 'pt-br': ['próximo', 'avançar', 'entendi'], en: ['next', 'got it'] },
  },
]

describe('matchers', () => {
  const { matchExplicit, matchPattern, matchFuzzy } = createMenu({ commands, language: 'pt-BR' })
  const text = (t: string, modality: 'text' | 'transcript' = 'text') => ({
    id: 's',
    kind: 'trigger' as const,
    modality,
    source: 'test',
    timestamp: 0,
    parts: [{ type: 'text' as const, text: t }],
  })

  it('explicit: slash commands capture the rest of the line', () => {
    expect(matchExplicit(text('/pedidos abertos'))).toMatchObject({ action: 'filter_orders', args: { status: 'abertos' }, confidence: 1 })
    expect(matchExplicit(text('/orders'))).toMatchObject({ args: { status: 'all' } })
    expect(matchExplicit(text('/nada'))).toBeNull()
  })

  it('explicit: command signals from buttons or palettes', () => {
    const signal = { ...createMenu().api.commandSignal('filter_orders', { status: 'x' }, 'Filtrar X'), id: 's', timestamp: 0 }
    expect(matchExplicit(signal)).toMatchObject({ action: 'filter_orders', args: { status: 'x' } })
    expect(textOf(signal.parts)).toBe('Filtrar X')
  })

  it('pattern: templates are case/accent-insensitive; RegExps use named groups', () => {
    expect(matchPattern(text('Mostrar pedidos ABERTOS'))).toMatchObject({ args: { status: 'abertos' } })
    expect(matchPattern(text('show open orders'))).toMatchObject({ args: { status: 'open' } })
    expect(matchPattern(text('Pedidos fechados'))).toMatchObject({ args: { status: 'fechados' } })
    expect(matchPattern(text('mostrar pedidos'))).toBeNull()
  })

  it('fuzzy: uses phrases of the configured language and works with transcripts', () => {
    expect(matchFuzzy(text('porximo', 'transcript'))).toMatchObject({ action: 'guide_next' })
    expect(matchFuzzy(text('next'))).toBeNull() // English phrase, Portuguese menu
    expect(matchFuzzy(text('ver pedido'))?.confidence).toBeGreaterThan(0.8)
  })

  it('fuzzy: a negation the phrase lacks is not a command', () => {
    const { matchFuzzy } = createMenu({
      language: 'pt-br',
      commands: [
        { action: 'open_details', phrases: ['abrir detalhes do pedido'] },
        { action: 'dnd', phrases: ['não perturbe'] },
      ],
    })
    expect(matchFuzzy(text('abrir detalhes do pedido'))).toMatchObject({ action: 'open_details' })
    expect(matchFuzzy(text('não abrir detalhes do pedido'))).toBeNull()
    expect(matchFuzzy(text('nao abrir detalhes do pedido', 'transcript'))).toBeNull()
    expect(matchFuzzy(text('não perturbe'))).toMatchObject({ action: 'dnd' })
  })

  it('fuzzy: negations follow the language and can be replaced', () => {
    const commands: Command[] = [{ action: 'close', phrases: ['close the details modal'] }]
    expect(createMenu({ commands, language: 'en' }).matchFuzzy(text("don't close the details modal"))).toBeNull()
    expect(createMenu({ commands, language: 'en', negations: [] }).matchFuzzy(text('not close the details modal'))).toMatchObject({ action: 'close' })
  })

  it('fuzzy: typed questions go to the LLM; transcripts and typedQuestions: command still match', () => {
    expect(matchFuzzy(text('próximo?'))).toBeNull()
    expect(matchFuzzy(text('próximo?', 'transcript'))).toMatchObject({ action: 'guide_next' })
    expect(createMenu({ commands, language: 'pt-br', typedQuestions: 'command' }).matchFuzzy(text('próximo?'))).toMatchObject({
      action: 'guide_next',
    })
  })

  it('fuzzy: two commands too close to tell apart are uncertain', () => {
    const close: Command[] = [
      { action: 'tab_orders', phrases: ['aba pedidos'] },
      { action: 'tab_order', phrases: ['aba pedido'] },
    ]
    expect(createMenu({ commands: close }).matchFuzzy(text('aba pedidoz'))).toBeNull()
    expect(createMenu({ commands: close, fuzzyMargin: 0 }).matchFuzzy(text('aba pedidoz'))).not.toBeNull()
  })

  it("fuzzy: with uncertain: 'ask', the middle band asks which command, with quick replies", () => {
    const { matchFuzzy } = createMenu({ commands, language: 'pt-br', uncertain: 'ask' })
    const match = matchFuzzy(text('ver pdds'))!
    expect(match).toMatchObject({ action: CLARIFY_ACTION, confidence: 1 })
    expect(match.reply?.(undefined)).toBe('Você quis dizer "ver pedidos"?')
    expect(match.parts).toEqual([{ type: 'data', name: 'quick_replies', value: [{ label: 'ver pedidos' }] }])
    expect(matchFuzzy(text('xyz'))).toBeNull() // below askThreshold: LLM
    expect(createMenu({ commands, language: 'pt-br' }).matchFuzzy(text('ver pdds'))).toBeNull()
  })

  it('suggests commands for what is being typed', () => {
    const { api } = createMenu({ commands, language: 'pt-br' })
    expect(api.suggest('/ped')[0]?.command.action).toBe('filter_orders')
    expect(api.suggest('avan')[0]?.command.action).toBe('guide_next')
    expect(api.suggest('')).toHaveLength(2)
  })
})

describe('menu plugin with the kernel', () => {
  it('runs commands directly and lets everything else reach the transport', async () => {
    const requests: TurnRequest[] = []
    const transport: Transport = {
      name: 't',
      async *run(request) {
        requests.push(request)
        yield { type: 'message.delta', messageId: `m-${requests.length}`, delta: 'resposta do LLM' }
      },
    }
    const handler = vi.fn(({ status }: { status: string }) => (status === 'abertos' ? 3 : 0))
    const h4b = await createH4B({
      plugins: [menu({ commands, language: 'pt-br' })],
      actions: [{ name: 'filter_orders', description: 'Filtra pedidos', handler }],
    }).start()
    h4b.provide('transport', transport)

    const direct = await h4b.ask('mostrar pedidos abertos')
    expect(direct.status.route).toBe('direct')
    expect(textOf(direct.messages.at(-1)!)).toBe('3 pedidos.')
    expect(requests).toHaveLength(0)

    const viaLlm = await h4b.ask('quais pedidos estão atrasados há mais de uma semana?')
    expect(viaLlm.status.route).toBe('transport')
    expect(requests[0]!.messages.some((m) => m.role === 'tool' && m.result === 3)).toBe(true)
  })

  it("asks before acting on an uncertain input, and the chosen phrase runs the command", async () => {
    const requests: TurnRequest[] = []
    const handler = vi.fn(() => 2)
    const h4b = await createH4B({
      plugins: [menu({ commands, language: 'pt-br', uncertain: 'ask' })],
      actions: [{ name: 'filter_orders', description: 'Filtra pedidos', handler }],
    }).start()
    h4b.provide('transport', { name: 't', async *run(request) { requests.push(request) } })

    const asked = await h4b.ask('ver pdds')
    expect(asked.status.route).toBe('direct')
    const reply = asked.messages.at(-1)!
    expect(textOf(reply)).toBe('Você quis dizer "ver pedidos"?')
    expect(reply).toMatchObject({ role: 'assistant', parts: expect.arrayContaining([{ type: 'data', name: 'quick_replies', value: [{ label: 'ver pedidos' }] }]) })
    expect(handler).not.toHaveBeenCalled()

    expect((await h4b.ask('ver pedidos')).status.route).toBe('direct')
    expect(handler).toHaveBeenCalledOnce()
    expect(requests).toHaveLength(0)
  })

  it('skips commands whose action is not registered', async () => {
    const h4b = await createH4B({ plugins: [menu({ commands })] }).start()
    h4b.provide('transport', { name: 't', async *run() {} })
    expect((await h4b.ask('/pedidos')).status.route).toBe('transport')
  })
})
