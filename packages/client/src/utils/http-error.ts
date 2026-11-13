function errorMessageText(error: unknown): string {
  if (typeof error === 'string') return error.trim()
  if (error == null) return ''
  if (typeof error !== 'object') return String(error).trim()

  if (Array.isArray(error)) {
    return error.map(errorMessageText).filter(Boolean).join('\n')
  }

  const record = error as Record<string, unknown>
  for (const key of ['message', 'error', 'detail', 'description', 'code']) {
    const text = errorMessageText(record[key])
    if (text) return text
  }

  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export async function responseErrorMessage(
  response: Response,
  fallbackPrefix = 'Request failed',
): Promise<string> {
  let detail = ''

  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    try {
      detail = errorMessageText(await response.clone().json())
    } catch {
      detail = ''
    }
  }

  if (!detail) {
    try {
      detail = (await response.clone().text()).trim()
    } catch {
      detail = ''
    }
  }

  const base = `${fallbackPrefix}: ${response.status}`
  return detail ? `${base} - ${detail}` : base
}
