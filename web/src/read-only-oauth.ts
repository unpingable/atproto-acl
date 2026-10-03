export function assertFreshCaptureSession(
  savedSession: unknown,
  now = Date.now(),
  minimumRemainingMs = 10 * 60 * 1000,
) {
  const value = savedSession as { tokenSet?: { expires_at?: unknown } }
  const expiry = Date.parse(String(value?.tokenSet?.expires_at ?? ''))
  if (!Number.isFinite(expiry) || expiry <= now + minimumRemainingMs) {
    throw new Error('existing OAuth access token is not fresh enough for a read-only capture; reconnect separately')
  }
  return expiry
}

export function withoutOAuthRefresh(fetchImplementation: typeof fetch): typeof fetch {
  return async (input, init) => {
    const body = init?.body
    if (typeof body === 'string' && new URLSearchParams(body).get('grant_type') === 'refresh_token') {
      throw new Error('read-only capture refuses OAuth refresh')
    }
    return fetchImplementation(input, init)
  }
}
