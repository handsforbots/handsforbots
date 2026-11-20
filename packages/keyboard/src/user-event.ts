/** Whether the keyboard event should run global shortcuts (browser user activation). */
export function isTrustedKeyboardEvent(event: KeyboardEvent): boolean {
  return event.isTrusted
}