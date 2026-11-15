import { definePlugin, textOf, type Match, type Signal } from '@handsforbots/core'
import { fuzzyRank, normalize, similarity, type FuzzyEntry, type FuzzyResult } from './fuzzy.js'

export { distance, fuzzyBest, fuzzyRank, normalize, similarity, type FuzzyEntry, type FuzzyOptions, type FuzzyResult } from './fuzzy.js'

export type CommandArgs = unknown | ((captured: Record<string, string>) => unknown)

export type Command = {
  /** Registered action this command runs. */
  action: string
  /** Label for palettes and suggestions. */
  label?: string
  /** `/name` triggers; the rest of the line is captured as `rest`. */
  slash?: string | string[]
  /**
   * Full-sentence patterns. Strings use `{name}` placeholders
   * ("mostrar pedidos {status}"); RegExps use named groups.
   */
  patterns?: (string | RegExp)[]
  /** Short phrases matched with typo tolerance, optionally per language. */
  phrases?: string[] | Record<string, string[]>
  /** Static args, or built from captured placeholders / `rest`. */
  args?: CommandArgs
  /** Confirmation shown (and spoken) after the action runs. */
  reply?: (result: unknown, args: unknown) => string | undefined
}

export type MenuOptions = {
  commands?: Command[]
  /** Picks per-language phrases, e.g. 'pt-br' (falls back to 'pt', then all). */
  language?: string
  /** Minimum fuzzy similarity. Default 0.8. */
  fuzzyThreshold?: number
  /** Longer inputs skip fuzzy matching. Default 6 words. */
  maxFuzzyWords?: number
  /**
   * The best command must beat the runner-up (a different command) by this
   * much; otherwise the input is uncertain. Default 0.05.
   */
  fuzzyMargin?: number
  /**
   * What to do with uncertain inputs: a fuzzy score between `askThreshold`
   * and `fuzzyThreshold`, or two commands within `fuzzyMargin`.
   * `'llm'` (default) sends them to the transport; `'ask'` replies
   * "did you mean…?" with the candidates as quick replies, without the LLM.
   */
  uncertain?: 'llm' | 'ask'
  /** Lowest fuzzy score that still asks (with `uncertain: 'ask'`). Default 0.6. */
  askThreshold?: number
  /** Text of the "did you mean…?" reply. Default per `language` (pt, es, en). */
  askText?: (phrases: string[]) => string
  /**
   * Words that make a short input a non-command ("não abrir detalhes"): when
   * the input has one that the matched phrase lacks, fuzzy matching skips it.
   * Default per `language` (pt, es, en; all of them without a language).
   */
  negations?: string[]
  /**
   * Typed text ending in "?" ("fechar modal?") is a question, not a command:
   * `'llm'` (default) skips fuzzy matching for it; `'command'` matches it.
   * Transcripts are never affected (recognizers add "?" on their own).
   */
  typedQuestions?: 'llm' | 'command'
}

/** Action the menu runs to ask "did you mean…?" for uncertain inputs. */
export const CLARIFY_ACTION = 'menu.clarify'

const NEGATIONS: Record<string, string[]> = {
  pt: ['não', 'nunca', 'jamais', 'nem'],
  es: ['no', 'nunca', 'jamás', 'ni'],
  en: ['not', 'never', "don't", 'dont', "doesn't", "didn't", "won't", 'no'],
}

const ASK_TEXT: Record<string, (or: string) => string> = {
  pt: (list) => `Você quis dizer ${list}?`,
  es: (list) => `¿Quisiste decir ${list}?`,
  en: (list) => `Did you mean ${list}?`,
}
const OR: Record<string, string> = { pt: 'ou', es: 'o', en: 'or' }

export type Suggestion = { command: Command; label: string; score: number }

export type MenuService = {
  add(command: Command): () => void
  list(): Command[]
  /** Ranked commands for what the user is typing or saying (palettes, autocomplete). */
  suggest(text: string, limit?: number): Suggestion[]
  /**
   * Builds a signal that runs a command explicitly (buttons, palette, quick
   * replies). The label is kept as text so history reads naturally.
   */
  commandSignal(action: string, args?: unknown, label?: string): Omit<Signal, 'id' | 'timestamp'>
}

declare module '@handsforbots/core' {
  interface Services {
    menu: MenuService
  }
}

export const menu = definePlugin<MenuOptions | undefined>({
  name: 'menu',
  provides: ['menu'],
  apply(ctx, options = {}) {
    const service = createMenu(options)
    ctx.provide('menu', service.api)
    ctx.addMatcher({ name: 'menu.explicit', priority: -30, match: service.matchExplicit })
    ctx.addMatcher({ name: 'menu.pattern', priority: -20, match: service.matchPattern })
    ctx.addMatcher({ name: 'menu.fuzzy', priority: -10, match: service.matchFuzzy })
    if (options.uncertain === 'ask') {
      ctx.registerAction({
        name: CLARIFY_ACTION,
        description: 'Asks the user which command they meant.',
        confirm: 'never',
        exposeTo: ['user'],
        handler: (args: unknown) => args,
      })
    }
  },
})

export function createMenu(options: MenuOptions = {}) {
  let commands: Command[] = [...(options.commands ?? [])]

  const phrasesOf = (command: Command): string[] => {
    if (!command.phrases) return []
    if (Array.isArray(command.phrases)) return command.phrases
    const language = options.language?.toLowerCase()
    const byLanguage = command.phrases
    if (language && byLanguage[language]) return byLanguage[language]!
    const base = language?.split('-')[0]
    if (base && byLanguage[base]) return byLanguage[base]!
    return Object.values(byLanguage).flat()
  }

  const slashesOf = (command: Command) =>
    (Array.isArray(command.slash) ? command.slash : command.slash ? [command.slash] : []).map((s) =>
      normalize(s.replace(/^\//, '')),
    )

  const base = options.language?.toLowerCase().split('-')[0]
  const negationWords = (options.negations ?? (base && NEGATIONS[base] ? NEGATIONS[base]! : [
    ...new Set(Object.values(NEGATIONS).flat().filter((w) => w !== 'no')),
  ])).map(normalize).filter(Boolean)
  const padded = (text: string) => ` ${normalize(text)} `
  /** A negation in the input that the phrase does not have ("não abrir" vs "abrir"). */
  const negates = (input: string, phrase: string) =>
    negationWords.some((word) => padded(input).includes(` ${word} `) && !padded(phrase).includes(` ${word} `))

  const askText = (phrases: string[]) => {
    if (options.askText) return options.askText(phrases)
    const lang = base && ASK_TEXT[base] ? base : 'en'
    const quoted = phrases.map((p) => `"${p}"`)
    const list = quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} ${OR[lang]} ${quoted.at(-1)}` : quoted[0]!
    return ASK_TEXT[lang]!(list)
  }

  const resolveArgs = (command: Command, captured: Record<string, string>) =>
    typeof command.args === 'function' ? (command.args as (c: Record<string, string>) => unknown)(captured) : (command.args ?? captured)

  const toMatch = (command: Command, captured: Record<string, string>, confidence: number): Match => {
    const args = resolveArgs(command, captured)
    return {
      action: command.action,
      args,
      confidence,
      reply: command.reply ? (result) => command.reply!(result, args) : undefined,
    }
  }

  const textInput = (signal: Signal): string | undefined =>
    signal.modality === 'text' || signal.modality === 'transcript' ? textOf(signal.parts).trim() : undefined

  const matchExplicit = (signal: Signal): Match | null => {
    if (signal.modality === 'command') {
      const data = signal.parts.find((p) => p.type === 'data' && p.name === 'command')
      if (data?.type !== 'data') return null
      const { action, args } = data.value as { action: string; args?: unknown }
      const command = commands.find((c) => c.action === action)
      return { action, args: args ?? {}, confidence: 1, reply: command?.reply && ((r) => command.reply!(r, args)) }
    }
    const text = textInput(signal)
    if (!text?.startsWith('/')) return null
    const [head = '', ...rest] = text.slice(1).split(/\s+/)
    const name = normalize(head)
    const command = commands.find((c) => slashesOf(c).includes(name))
    return command ? toMatch(command, { rest: rest.join(' ') }, 1) : null
  }

  type Compiled = { regexp: RegExp; template: boolean }
  const compiled = new WeakMap<Command, Compiled[]>()
  const patternsOf = (command: Command): Compiled[] => {
    let list = compiled.get(command)
    if (!list) {
      list = (command.patterns ?? []).map((p) =>
        typeof p === 'string' ? { regexp: templateToRegExp(p), template: true } : { regexp: p, template: false },
      )
      compiled.set(command, list)
    }
    return list
  }

  const matchPattern = (signal: Signal): Match | null => {
    const text = textInput(signal)
    if (!text) return null
    const normalized = normalize(text)
    for (const command of commands) {
      for (const { regexp, template } of patternsOf(command)) {
        // Templates match normalized text (case/accent-insensitive, so captures are normalized too).
        const found = template ? regexp.exec(normalized) : (regexp.exec(text) ?? regexp.exec(normalized))
        if (found) return toMatch(command, { ...found.groups }, 1)
      }
    }
    return null
  }

  const matchFuzzy = (signal: Signal): Match | null => {
    const text = textInput(signal)
    if (!text || text.startsWith('/')) return null
    if (signal.modality === 'text' && text.endsWith('?') && options.typedQuestions !== 'command') return null
    const entries: FuzzyEntry<Command>[] = commands.flatMap((command) =>
      phrasesOf(command).map((phrase) => ({ phrase, value: command })),
    )
    const ranked = fuzzyRank(text, entries, { maxWords: options.maxFuzzyWords }).filter((r) => !negates(text, r.phrase))
    const [best, second] = ranked
    if (!best) return null
    const threshold = options.fuzzyThreshold ?? 0.8
    const close = second !== undefined && best.score - second.score < (options.fuzzyMargin ?? 0.05)
    if (best.score >= threshold && !close) return toMatch(best.value, {}, best.score)
    if (options.uncertain !== 'ask') return null
    const askFrom = Math.min(options.askThreshold ?? 0.6, threshold)
    const candidates = ranked.filter((r) => r.score >= askFrom && best.score - r.score < 0.2).slice(0, 3)
    return candidates.length ? clarify(candidates) : null
  }

  /** "Did you mean…?" reply; each quick reply is a phrase, so choosing it (or saying it) matches exactly. */
  const clarify = (candidates: FuzzyResult<Command>[]): Match => {
    const choices = candidates.map((c) => ({ action: c.value.action, phrase: c.phrase, score: c.score }))
    const phrases = candidates.map((c) => c.phrase)
    return {
      action: CLARIFY_ACTION,
      args: { options: choices },
      confidence: 1,
      reply: () => askText(phrases),
      parts: [{ type: 'data', name: 'quick_replies', value: phrases.map((label) => ({ label })) }],
    }
  }

  const api: MenuService = {
    add(command) {
      commands = [...commands, command]
      return () => {
        commands = commands.filter((c) => c !== command)
      }
    },
    list: () => commands,
    suggest(input, limit = 5) {
      const text = normalize(input.replace(/^\//, ''))
      const scored: Suggestion[] = []
      for (const command of commands) {
        const candidates = [...slashesOf(command), ...phrasesOf(command).map(normalize), normalize(command.label ?? '')].filter(Boolean)
        let score = 0
        for (const candidate of candidates) {
          if (!text) score = Math.max(score, 0.1)
          else if (candidate.startsWith(text)) score = Math.max(score, 0.9 + text.length / candidate.length / 10)
          else if (candidate.includes(text)) score = Math.max(score, 0.7)
          else score = Math.max(score, similarity(text, candidate.slice(0, Math.max(text.length, 1))) * 0.8)
        }
        if (score >= 0.5 || !text) {
          scored.push({ command, label: command.label ?? phrasesOf(command)[0] ?? `/${slashesOf(command)[0] ?? command.action}`, score })
        }
      }
      return scored.sort((a, b) => b.score - a.score).slice(0, limit)
    },
    commandSignal: (action, args, label) => ({
      kind: 'trigger',
      modality: 'command',
      source: 'menu',
      parts: [
        ...(label ? [{ type: 'text' as const, text: label }] : []),
        { type: 'data', name: 'command', value: { action, args } },
      ],
    }),
  }

  return { api, matchExplicit, matchPattern, matchFuzzy }
}

/** "mostrar pedidos {status}" → /^mostrar pedidos (?<status>.+?)$/ over normalized text. */
function templateToRegExp(template: string): RegExp {
  const names: string[] = []
  const marked = template.replace(/\{(\w+)\}/g, (_, name: string) => ` h4bslot${names.push(name) - 1} `)
  const source = normalize(marked)
    .split(' ')
    .map((token) => {
      const slot = /^h4bslot(\d+)$/.exec(token)
      return slot ? `(?<${names[Number(slot[1])]}>.+?)` : token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join(' ')
  return new RegExp(`^${source}$`, 'u')
}
