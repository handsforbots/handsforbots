export type TransportThrownError = Error & { status?: number; detail?: string }

export function transportRouteError(message: string, status: number, detail?: string): TransportThrownError {
  const error = new Error(message) as TransportThrownError
  error.status = status
  if (detail) error.detail = detail.slice(0, 200)
  return error
}