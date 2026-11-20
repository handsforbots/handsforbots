import { EventType, type BaseEvent } from '@ag-ui/core'
import { transportConformance } from '@handsforbots/testkit'
import { createAguiTransport, type AguiRunner } from '../src/index.js'

const ev = (type: EventType, fields: Record<string, unknown> = {}) => ({ type, ...fields }) as BaseEvent

/** In-process AG-UI agent following the conformance scenarios. */
function agent(scenario: string): AguiRunner {
  return {
    run(input) {
      return {
        subscribe(observer) {
          let closed = false
          queueMicrotask(() => {
            if (scenario === 'hang') return // never completes; the transport unsubscribes on abort
            const last = input.messages.at(-1)
            const events: BaseEvent[] = [ev(EventType.RUN_STARTED, { threadId: input.threadId, runId: input.runId })]
            if (scenario === 'error') events.push(ev(EventType.RUN_ERROR, { message: 'agent failed' }))
            else if ((scenario === 'tool' || scenario === 'duplicateCall') && last?.role === 'user') {
              const id = scenario === 'duplicateCall' ? 'dup' : 'c1'
              const toolCall = [
                ev(EventType.TOOL_CALL_START, { toolCallId: id, toolCallName: 'conformance_echo' }),
                ev(EventType.TOOL_CALL_ARGS, { toolCallId: id, delta: '{"value":"ping"}' }),
                ev(EventType.TOOL_CALL_END, { toolCallId: id }),
              ]
              events.push(...toolCall, ...(scenario === 'duplicateCall' ? toolCall : []))
            } else {
              const text = last?.role === 'tool' ? `echo returned ${last.content}` : 'hello'
              events.push(ev(EventType.TEXT_MESSAGE_CHUNK, { messageId: 'm', delta: text }))
            }
            events.push(ev(EventType.RUN_FINISHED, { threadId: input.threadId, runId: input.runId }))
            for (const e of events) if (!closed) observer.next(e)
            if (!closed) observer.complete()
          })
          return { unsubscribe: () => void (closed = true) }
        },
      }
    },
  }
}

transportConformance('agui', { create: (scenario) => createAguiTransport({ agent: agent(scenario) }) })
