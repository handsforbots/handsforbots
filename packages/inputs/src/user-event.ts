/** Whether the event should run declarative GUI handlers (browser user activation). */
export function isTrustedPointerEvent(event: Event): boolean {
  return event instanceof MouseEvent && event.isTrusted
}