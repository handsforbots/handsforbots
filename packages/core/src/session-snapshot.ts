import { cleanAttributes } from './attributes.js'
import { isCitation } from './citations.js'
import type { AssistantMessage, Message, Part, SessionSnapshot, ToolCall, UserMessage } from './types.js'

const ROLES = new Set(['user', 'assistant', 'tool'])
const MODALITIES = new Set([
  'text',
  'audio',
  'transcript',
  'image',
  'video',
  'file',
  'sensor',
  'gui-event',
  'command',
])
const PART_TYPES = new Set(['text', 'image', 'audio', 'video', 'file', 'data', 'source'])
const MAX_SEEN_CALL_IDS = 1000

/** Validates an untrusted stored conversation before the kernel adopts it. */
export function parseSessionSnapshot(value: unknown): SessionSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.threadId !== 'string' || !raw.threadId) return undefined
  if (!Array.isArray(raw.messages)) return undefined
  const messages: Message[] = []
  for (const item of raw.messages) {
    const message = parseMessage(item)
    if (message) messages.push(message)
  }
  let seenCallIds: string[] | undefined
  if (raw.seenCallIds !== undefined) {
    if (!Array.isArray(raw.seenCallIds)) return undefined
    const ids = raw.seenCallIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    if (ids.length !== raw.seenCallIds.length) return undefined
    seenCallIds = ids.slice(-MAX_SEEN_CALL_IDS)
  }
  const snapshot: SessionSnapshot = {
    threadId: raw.threadId,
    messages,
    ...(raw.state === undefined ? {} : { state: raw.state }),
    ...(raw.memory === undefined ? {} : { memory: raw.memory }),
    ...(raw.conversationState === undefined ? {} : { conversationState: raw.conversationState }),
    ...(raw.attributes === undefined ? {} : { attributes: cleanAttributes(raw.attributes) }),
    ...(seenCallIds?.length ? { seenCallIds } : {}),
  }
  return snapshot
}

function parseMessage(value: unknown): Message | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || !ROLES.has(String(raw.role))) return undefined
  if (typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt)) return undefined
  const role = raw.role as Message['role']
  if (role === 'user') {
    if (!MODALITIES.has(String(raw.modality)) || typeof raw.source !== 'string') return undefined
    if (!Array.isArray(raw.parts)) return undefined
    const parts = raw.parts.filter(parsePart)
    if (!parts.length) return undefined
    const message: UserMessage = {
      id: raw.id,
      role: 'user',
      parts,
      modality: raw.modality as UserMessage['modality'],
      source: raw.source,
      createdAt: raw.createdAt,
      ...(typeof raw.turnId === 'string' ? { turnId: raw.turnId } : {}),
      ...(typeof raw.signalId === 'string' ? { signalId: raw.signalId } : {}),
      ...(typeof raw.route === 'string' ? { route: raw.route as UserMessage['route'] } : {}),
    }
    return message
  }
  if (role === 'assistant') {
    if (!Array.isArray(raw.parts)) return undefined
    const parts = raw.parts.filter(parsePart)
    const toolCalls = raw.toolCalls
    if (toolCalls !== undefined) {
      if (!Array.isArray(toolCalls)) return undefined
      for (const call of toolCalls) {
        if (!call || typeof call !== 'object' || Array.isArray(call)) return undefined
        const c = call as Record<string, unknown>
        if (typeof c.id !== 'string' || typeof c.name !== 'string') return undefined
      }
    }
    const message: AssistantMessage = {
      id: raw.id,
      role: 'assistant',
      parts,
      createdAt: raw.createdAt,
      ...(typeof raw.turnId === 'string' ? { turnId: raw.turnId } : {}),
      ...(typeof raw.route === 'string' ? { route: raw.route as AssistantMessage['route'] } : {}),
      ...(toolCalls ? { toolCalls: toolCalls as ToolCall[] } : {}),
      ...(raw.streaming === true ? { streaming: true } : {}),
      ...(raw.interrupted === true ? { interrupted: true } : {}),
    }
    return message
  }
  if (typeof raw.toolCallId !== 'string' || typeof raw.name !== 'string') return undefined
  return {
    id: raw.id,
    role: 'tool',
    toolCallId: raw.toolCallId,
    name: raw.name,
    createdAt: raw.createdAt,
    ...(raw.result !== undefined ? { result: raw.result } : {}),
    ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
    ...(typeof raw.turnId === 'string' ? { turnId: raw.turnId } : {}),
    ...(typeof raw.route === 'string' ? { route: raw.route as Message['route'] } : {}),
  }
}

function parsePart(value: unknown): value is Part {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  if (!PART_TYPES.has(String(raw.type))) return false
  switch (raw.type) {
    case 'text': {
      if (typeof raw.text !== 'string') return false
      if (raw.citations !== undefined) {
        if (!Array.isArray(raw.citations)) return false
        for (const citation of raw.citations) {
          if (!isCitation(citation)) return false
        }
      }
      return true
    }
    case 'source': {
      if (typeof raw.id !== 'string' || typeof raw.title !== 'string') return false
      if (raw.trail !== undefined) {
        if (!Array.isArray(raw.trail) || !raw.trail.every((t): t is string => typeof t === 'string')) return false
      }
      if (raw.url !== undefined && typeof raw.url !== 'string') return false
      if (raw.excerpt !== undefined && typeof raw.excerpt !== 'string') return false
      return true
    }
    case 'data': {
      if (typeof raw.name !== 'string') return false
      if (raw.name === 'surface') {
        const value = raw.value
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false
        const record = value as Record<string, unknown>
        if (typeof record.surfaceId !== 'string' || typeof record.kind !== 'string') return false
        if (record.component !== undefined && typeof record.component !== 'string') return false
      }
      return true
    }
    case 'image':
    case 'audio':
    case 'video':
    case 'file':
      return typeof raw.mimeType === 'string' && isSnapshotMediaSource(raw.source)
    default: {
      const _never: never = raw.type as never
      return _never
    }
  }
}

function isSnapshotMediaSource(source: unknown): boolean {
  if (typeof source === 'string') return true
  if (typeof Blob !== 'undefined' && source instanceof Blob) return true
  if (!source || typeof source !== 'object' || Array.isArray(source)) return false
  const record = source as Record<string, unknown>
  if (record.kind === 'url') return typeof record.url === 'string'
  if (record.kind === 'base64') return typeof record.data === 'string'
  if (record.kind === 'blob') return typeof Blob !== 'undefined' && record.blob instanceof Blob
  return false
}
