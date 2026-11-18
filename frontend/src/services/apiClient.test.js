import { beforeEach, describe, expect, it, vi } from 'vitest'
import { USERS, apiError, mockApi, session } from '../test/helpers.jsx'

const REFRESH_KEY = 'acme.refreshToken'

// The client keeps the access token in a module variable, so each test loads a fresh copy.
let client
beforeEach(async () => {
  vi.resetModules()
  client = await import('./apiClient.js')
})

describe('api', () => {
  it('sends JSON and returns the parsed body', async () => {
    const calls = mockApi({ 'POST /api/things': () => ({ status: 201, body: { id: 7 } }) })
    await expect(client.api('/api/things', { method: 'POST', body: { name: 'x' }, auth: false })).resolves.toEqual({ id: 7 })
    expect(calls).toEqual([{ method: 'POST', path: '/api/things', body: { name: 'x' }, token: undefined }])
  })

  it('returns null for an empty response', async () => {
    mockApi({ 'DELETE /api/things/1': () => ({ status: 204 }) })
    await expect(client.api('/api/things/1', { method: 'DELETE', auth: false })).resolves.toBeNull()
  })

  it('attaches the access token to authenticated requests only', async () => {
    const calls = mockApi({ 'GET /api/private': () => ({ body: {} }), 'GET /api/public': () => ({ body: {} }) })
    client.storeTokens(session())
    await client.api('/api/private')
    await client.api('/api/public', { auth: false })
    expect(calls.map((call) => call.token)).toEqual(['access-1', undefined])
  })

  it('turns an API error into an ApiError with field messages', async () => {
    mockApi({
      'POST /api/things': () => apiError(400, 'validation_error', 'Some fields are invalid', { email: 'Email is required' }),
    })
    const error = await client.api('/api/things', { method: 'POST', body: {}, auth: false }).catch((e) => e)
    expect(error).toBeInstanceOf(client.ApiError)
    expect(error).toMatchObject({
      status: 400,
      code: 'validation_error',
      message: 'Some fields are invalid',
      fieldErrors: { email: 'Email is required' },
    })
  })

  it('copes with an error response that is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad gateway</html>', { status: 502 })))
    const error = await client.api('/api/things', { auth: false }).catch((e) => e)
    expect(error).toMatchObject({ status: 502, code: 'unknown_error', fieldErrors: {} })
    expect(error.message).toBe('Something went wrong. Please try again.')
  })

  it('reports a network failure in plain language', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const error = await client.api('/api/things', { auth: false }).catch((e) => e)
    expect(error).toMatchObject({ status: 0, code: 'network_error' })
    expect(error.message).toMatch(/cannot reach the server/i)
  })
})

describe('token storage', () => {
  it('keeps only the refresh token in localStorage', () => {
    client.storeTokens(session())
    expect(window.localStorage.getItem(REFRESH_KEY)).toBe('refresh-1')
    expect(JSON.stringify(window.localStorage)).not.toContain('access-1')
    expect(client.hasStoredSession()).toBe(true)
  })

  it('clearTokens forgets both tokens', async () => {
    const calls = mockApi({ 'GET /api/private': () => apiError(401, 'unauthorized', 'Authentication is required') })
    client.storeTokens(session())
    client.clearTokens()
    expect(client.hasStoredSession()).toBe(false)
    await client.api('/api/private').catch(() => {})
    expect(calls[0].token).toBeUndefined()
  })

  it('still works when localStorage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(() => client.storeTokens(session())).not.toThrow()
    expect(client.hasStoredSession()).toBe(false)
  })
})

describe('session renewal', () => {
  it('renews an expired access token once and repeats the request', async () => {
    const calls = mockApi({
      'GET /api/private': ({ token }) =>
        token === 'access-2' ? { body: { ok: true } } : apiError(401, 'token_expired', 'Your session has expired'),
      'POST /api/auth/refresh': () => ({ body: session(undefined, '2') }),
    })
    client.storeTokens(session())

    await expect(client.api('/api/private')).resolves.toEqual({ ok: true })
    expect(calls.map((call) => `${call.method} ${call.path} ${call.token ?? '-'}`)).toEqual([
      'GET /api/private access-1',
      'POST /api/auth/refresh -',
      'GET /api/private access-2',
    ])
    expect(calls[1].body).toEqual({ refresh_token: 'refresh-1' })
    expect(window.localStorage.getItem(REFRESH_KEY)).toBe('refresh-2')
  })

  it('uses the stored refresh token on the first call after a reload', async () => {
    window.localStorage.setItem(REFRESH_KEY, 'refresh-1') // as left behind by a previous page load
    const calls = mockApi({
      'POST /api/auth/refresh': () => ({ body: session(undefined, '2') }),
      'GET /api/private': () => ({ body: { ok: true } }),
    })
    await client.api('/api/private')
    expect(calls.map((call) => call.path)).toEqual(['/api/auth/refresh', '/api/private'])
    expect(calls[1].token).toBe('access-2')
  })

  it('shares one refresh between requests that expire together', async () => {
    const calls = mockApi({
      'GET /api/a': ({ token }) => (token === 'access-2' ? { body: 'a' } : apiError(401, 'token_expired', 'expired')),
      'GET /api/b': ({ token }) => (token === 'access-2' ? { body: 'b' } : apiError(401, 'token_expired', 'expired')),
      'POST /api/auth/refresh': () => ({ body: session(undefined, '2') }),
    })
    client.storeTokens(session())
    await expect(Promise.all([client.api('/api/a'), client.api('/api/b')])).resolves.toEqual(['a', 'b'])
    expect(calls.filter((call) => call.path === '/api/auth/refresh')).toHaveLength(1)
  })

  it('renews again the next time the access token expires', async () => {
    let valid = 'access-2'
    let renewals = 1
    const calls = mockApi({
      'GET /api/private': ({ token }) =>
        token === valid ? { body: { ok: true } } : apiError(401, 'token_expired', 'Your session has expired'),
      'POST /api/auth/refresh': () => ({ body: session(undefined, String(++renewals)) }),
    })
    const expired = vi.fn()
    client.onSessionExpired(expired)
    client.storeTokens(session())

    await expect(client.api('/api/private')).resolves.toEqual({ ok: true }) // access-1 -> access-2
    valid = 'access-3' // fifteen minutes later access-2 has expired too
    await expect(client.api('/api/private')).resolves.toEqual({ ok: true })

    const refreshes = calls.filter((call) => call.path === '/api/auth/refresh')
    expect(refreshes.map((call) => call.body.refresh_token)).toEqual(['refresh-1', 'refresh-2'])
    expect(expired).not.toHaveBeenCalled()
  })

  it('tries the refresh again once the network is back', async () => {
    window.localStorage.setItem(REFRESH_KEY, 'refresh-1')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(client.refreshSession()).rejects.toMatchObject({ code: 'network_error' })

    const calls = mockApi({ 'POST /api/auth/refresh': () => ({ body: session(undefined, '2') }) })
    await expect(client.refreshSession()).resolves.toMatchObject({ access_token: 'access-2' })
    expect(calls).toHaveLength(1)
  })

  it('reports who the renewed tokens belong to, and nothing when the renewal fails', async () => {
    window.localStorage.setItem(REFRESH_KEY, 'refresh-1')
    const refreshed = vi.fn()
    client.onSessionRefreshed(refreshed)

    mockApi({ 'POST /api/auth/refresh': () => ({ body: session(USERS.engineer, '2') }) })
    await client.refreshSession()
    expect(refreshed).toHaveBeenCalledExactlyOnceWith(USERS.engineer)

    mockApi({ 'POST /api/auth/refresh': () => apiError(401, 'invalid_token', 'Your session is no longer valid') })
    await expect(client.refreshSession()).rejects.toMatchObject({ status: 401 })
    expect(refreshed).toHaveBeenCalledTimes(1)
  })

  it('a renewal that finishes after signing out does not bring the session back', async () => {
    window.localStorage.setItem(REFRESH_KEY, 'refresh-1')
    let answer
    mockApi({ 'POST /api/auth/refresh': () => new Promise((resolve) => (answer = resolve)) })
    const refreshed = vi.fn()
    client.onSessionRefreshed(refreshed)

    const renewal = client.refreshSession()
    client.clearTokens() // signed out while the renewal was in flight
    answer({ body: session(undefined, '2') })

    await expect(renewal).rejects.toMatchObject({ status: 401 })
    expect(client.hasStoredSession()).toBe(false)
    expect(refreshed).not.toHaveBeenCalled()
  })

  it('ends the session when the refresh token is rejected', async () => {
    mockApi({
      'GET /api/private': () => apiError(401, 'token_expired', 'Your session has expired'),
      'POST /api/auth/refresh': () => apiError(401, 'invalid_token', 'Your session is no longer valid'),
    })
    const expired = vi.fn()
    client.onSessionExpired(expired)
    client.storeTokens(session())

    await expect(client.api('/api/private')).rejects.toMatchObject({ status: 401, code: 'invalid_token' })
    expect(expired).toHaveBeenCalledTimes(1)
    expect(client.hasStoredSession()).toBe(false)
  })

  it('does not loop when the repeated request is rejected again', async () => {
    const calls = mockApi({
      'GET /api/private': () => apiError(401, 'invalid_token', 'nope'),
      'POST /api/auth/refresh': () => ({ body: session(undefined, '2') }),
    })
    const expired = vi.fn()
    client.onSessionExpired(expired)
    client.storeTokens(session())
    await expect(client.api('/api/private')).rejects.toMatchObject({ status: 401 })
    expect(calls).toHaveLength(3)
    expect(expired).toHaveBeenCalledTimes(1)
  })

  it('keeps the session when the refresh fails only because the network is down', async () => {
    let online = true
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        if (!online) throw new TypeError('Failed to fetch')
        online = false
        expect(url).toContain('/api/private')
        return new Response(JSON.stringify({ error: { code: 'token_expired', message: 'expired' } }), { status: 401 })
      }),
    )
    const expired = vi.fn()
    client.onSessionExpired(expired)
    client.storeTokens(session())

    await expect(client.api('/api/private')).rejects.toMatchObject({ code: 'network_error' })
    expect(client.hasStoredSession()).toBe(true)
    expect(expired).not.toHaveBeenCalled()
  })

  it('does not try to renew for errors other than 401', async () => {
    const calls = mockApi({ 'GET /api/private': () => apiError(403, 'access_denied', 'No') })
    const expired = vi.fn()
    client.onSessionExpired(expired)
    client.storeTokens(session())
    await expect(client.api('/api/private')).rejects.toMatchObject({ status: 403 })
    expect(calls).toHaveLength(1)
    expect(expired).not.toHaveBeenCalled()
  })

  it('reports an expired session when signed out and the API says 401', async () => {
    mockApi({ 'GET /api/private': () => apiError(401, 'unauthorized', 'Authentication is required') })
    const expired = vi.fn()
    client.onSessionExpired(expired)
    await expect(client.api('/api/private')).rejects.toMatchObject({ status: 401 })
    expect(expired).toHaveBeenCalledTimes(1)
  })

  it('refreshSession without a stored token fails without calling the API', async () => {
    const calls = mockApi({})
    await expect(client.refreshSession()).rejects.toMatchObject({ status: 401 })
    expect(calls).toHaveLength(0)
  })
})
