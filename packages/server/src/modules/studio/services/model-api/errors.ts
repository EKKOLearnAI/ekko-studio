export class ModelApiError extends Error {
  constructor(message: string, readonly status = 400, readonly param: string | null = null, readonly code: string | null = null) {
    super(message)
  }
}

export function modelApiErrorBody(error: unknown) {
  const status = error instanceof ModelApiError ? error.status : 502
  return {
    status,
    body: { error: {
      message: error instanceof ModelApiError ? error.message : 'The model provider request failed.',
      type: status === 429 ? 'insufficient_quota' : status < 500 ? 'invalid_request_error' : 'server_error',
      param: error instanceof ModelApiError ? error.param : null,
      code: error instanceof ModelApiError && error.code ? error.code : status === 404 ? 'model_not_found' : status === 501 ? 'unsupported_api_mode' : null,
    } },
  }
}
