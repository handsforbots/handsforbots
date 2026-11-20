const ERROR_CODE = /^[A-Za-z][\w.:-]{0,63}$/

export function stimulusErrorCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return ERROR_CODE.test(trimmed) ? trimmed : undefined
}

export type TransportThrownError = Error & { status?: number; detail?: string }

export function transportRouteError(message: string, status: number, detail?: string): TransportThrownError {
  const error = new Error(message) as TransportThrownError
  error.status = status
  if (detail) error.detail = detail.slice(0, 200)
  return error
}