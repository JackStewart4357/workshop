import { beforeEach, describe, expect, it, vi } from 'vitest'
import { USERS, apiError, mockApi, session } from '../test/helpers.jsx'

const REFRESH_KEY = 'acme.refreshToken'

let auth
beforeEach(async () => {
  vi.resetModules()
  auth = await import('./authService.js')
})

describe('login', () => {
  it('returns the user and stores the session', async () => {
    const calls = mockApi({ 'POST /api/auth/login': () => ({ body: session(USERS.admin) }) })
    await expect(auth.login('admin@acme.inc', 'secret12')).resolves.toEqual(USERS.admin)
    expect(calls[0]).toMatchObject({ body: { email: 'admin@acme.inc', password: 'secret12' }, token: undefined })
    expect(window.localStorage.getItem(REFRESH_KEY)).toBe('refresh-1')
  })

  it('stores nothing when the credentials are wrong', async () => {
    mockApi({ 'POST /api/auth/login': () => apiError(401, 'invalid_credentials', 'Incorrect email or password') })
    await expect(auth.login('a@acme.inc', 'wrong')).rejects.toMatchObject({ message: 'Incorrect email or password' })
    expect(window.localStorage.getItem(REFRESH_KEY)).toBeNull()
  })
})

describe('register', () => {
  it('sends the fields under the names the API expects', async () => {
    const calls = mockApi({ 'POST /api/auth/register': () => ({ status: 201, body: session() }) })
    await expect(auth.register({ fullName: 'Alice Johnson', email: 'alice@acme.inc', password: 'passw0rd1' })).resolves.toEqual(
      USERS.employee,
    )
    expect(calls[0].body).toEqual({ full_name: 'Alice Johnson', email: 'alice@acme.inc', password: 'passw0rd1' })
  })
})

describe('restoreSession', () => {
  it('returns null without calling the API when nothing is stored', async () => {
    const calls = mockApi({})
    await expect(auth.restoreSession()).resolves.toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('signs back in with the stored refresh token', async () => {
    window.localStorage.setItem(REFRESH_KEY, 'refresh-1')
    mockApi({ 'POST /api/auth/refresh': () => ({ body: session(USERS.engineer, '2') }) })
    await expect(auth.restoreSession()).resolves.toEqual(USERS.engineer)
  })

  it('returns null when the stored session is no longer valid', async () => {
    window.localStorage.setItem(REFRESH_KEY, 'refresh-old')
    mockApi({ 'POST /api/auth/refresh': () => apiError(401, 'invalid_token', 'Your session is no longer valid') })
    await expect(auth.restoreSession()).resolves.toBeNull()
    expect(window.localStorage.getItem(REFRESH_KEY)).toBeNull()
  })
})

describe('logout', () => {
  it('revokes the session on the server and forgets it locally', async () => {
    const calls = mockApi({
      'POST /api/auth/login': () => ({ body: session() }),
      'POST /api/auth/logout': () => ({ status: 204 }),
    })
    await auth.login('alice@acme.inc', 'passw0rd1')
    await auth.logout()
    expect(calls[1]).toMatchObject({ path: '/api/auth/logout', token: 'access-1' })
    expect(window.localStorage.getItem(REFRESH_KEY)).toBeNull()
  })

  it('still signs out locally when the server cannot be reached', async () => {
    mockApi({ 'POST /api/auth/login': () => ({ body: session() }) })
    await auth.login('alice@acme.inc', 'passw0rd1')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(auth.logout()).resolves.toBeUndefined()
    expect(window.localStorage.getItem(REFRESH_KEY)).toBeNull()
  })
})
