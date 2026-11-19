// The one place the app talks to the backend.
//
// How a signed-in session works:
//   - Logging in returns two tokens. The ACCESS token proves who you are on each request
//     and lasts 15 minutes. The REFRESH token lasts 7 days and can only be swapped for a
//     new pair of tokens.
//   - The access token is kept in memory only, so it is gone when the tab closes. The
//     refresh token is kept in localStorage so a page reload can sign you back in.
//   - If a request is rejected with 401, the access token has probably expired: we swap
//     the refresh token for new tokens once, then repeat the request. If that also fails
//     the session is over and the app returns to the login page.

const API_URL = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '')
const REFRESH_TOKEN_KEY = 'acme.refreshToken'

let accessToken = null
let refreshInFlight = null
let sessionExpiredHandler = null
let sessionRefreshedHandler = null

/** An error response from the API (or a network failure, with status 0). */
export class ApiError extends Error {
  constructor({ status, code, message, details }) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    /** Per-field messages for validation errors, e.g. { email: 'Email is required' }. */
    this.fieldErrors = details || {}
  }
}

// localStorage can throw (private browsing, storage disabled); the app must still work,
// just without staying signed in across reloads.
function readRefreshToken() {
  try {
    return window.localStorage.getItem(REFRESH_TOKEN_KEY)
  } catch {
    return null
  }
}

function writeRefreshToken(token) {
  try {
    if (token) window.localStorage.setItem(REFRESH_TOKEN_KEY, token)
    else window.localStorage.removeItem(REFRESH_TOKEN_KEY)
  } catch {
    // nothing to do: the session simply will not survive a reload
  }
}

export function storeTokens({ access_token, refresh_token }) {
  accessToken = access_token
  writeRefreshToken(refresh_token)
}

export function clearTokens() {
  accessToken = null
  writeRefreshToken(null)
}

export function hasStoredSession() {
  return Boolean(readRefreshToken())
}

/** Register a callback for when the session can no longer be renewed. */
export function onSessionExpired(handler) {
  sessionExpiredHandler = handler
}

/**
 * Register a callback that receives the user each time the tokens are renewed. Tabs share
 * one refresh token, so a renewal can return a different account (signed in from another
 * tab) or a changed role: whoever displays the user must follow the tokens.
 */
export function onSessionRefreshed(handler) {
  sessionRefreshedHandler = handler
}

async function send(path, { method = 'GET', body, token } = {}) {
  const headers = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`

  let response, text
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    text = await response.text() // the connection can still drop while the body arrives
  } catch {
    throw new ApiError({
      status: 0,
      code: 'network_error',
      message: 'Cannot reach the server. Check your connection and try again.',
    })
  }

  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = null // e.g. an HTML error page from a proxy
    }
  }

  if (!response.ok) {
    const error = data?.error
    throw new ApiError({
      status: response.status,
      code: error?.code || 'unknown_error',
      message: error?.message || 'Something went wrong. Please try again.',
      details: error?.details,
    })
  }
  return data
}

/**
 * Swap the refresh token for a new session. Concurrent callers share one request, so a
 * burst of expired requests triggers a single refresh.
 */
export function refreshSession() {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const refreshToken = readRefreshToken()
      if (!refreshToken) {
        throw new ApiError({ status: 401, code: 'unauthorized', message: 'Please sign in.' })
      }
      try {
        const session = await send('/api/auth/refresh', { method: 'POST', body: { refresh_token: refreshToken } })
        // Signed out while this was in flight: the sign-out wins.
        if (!hasStoredSession()) throw new ApiError({ status: 401, code: 'unauthorized', message: 'Please sign in.' })
        storeTokens(session)
        sessionRefreshedHandler?.(session.user)
        return session
      } catch (error) {
        // Only a definite rejection ends the session. On a network failure keep the
        // refresh token, so the user is still signed in once the connection is back.
        if (error.status === 400 || error.status === 401) clearTokens()
        throw error
      }
    })().finally(() => {
      refreshInFlight = null
    })
  }
  return refreshInFlight
}

/**
 * Call the API. Pass { auth: false } for endpoints that need no sign-in.
 * Resolves with the parsed JSON body (null for an empty response); rejects with ApiError.
 */
export async function api(path, { auth = true, ...options } = {}) {
  if (!auth) return send(path, options)

  try {
    if (!accessToken && hasStoredSession()) await refreshSession() // e.g. first call after a reload
    return await send(path, { ...options, token: accessToken })
  } catch (error) {
    if (error.status !== 401 || !hasStoredSession()) {
      if (error.status === 401) sessionExpiredHandler?.()
      throw error
    }
  }

  // The access token was rejected: renew once and repeat the request.
  try {
    await refreshSession()
    return await send(path, { ...options, token: accessToken })
  } catch (error) {
    if (error.status === 401) sessionExpiredHandler?.()
    throw error
  }
}
