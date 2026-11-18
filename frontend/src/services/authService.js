// Account operations, on top of the API client. Each returns the signed-in user
// ({ id, email, full_name, role, created_at }) or null.
import { api, clearTokens, hasStoredSession, refreshSession, storeTokens } from './apiClient.js'

export async function login(email, password) {
  const session = await api('/api/auth/login', { method: 'POST', body: { email, password }, auth: false })
  storeTokens(session)
  return session.user
}

export async function register({ fullName, email, password }) {
  const session = await api('/api/auth/register', {
    method: 'POST',
    body: { full_name: fullName, email, password },
    auth: false,
  })
  storeTokens(session)
  return session.user
}

/** Sign back in after a page reload, if a refresh token is stored. */
export async function restoreSession() {
  if (!hasStoredSession()) return null
  try {
    const session = await refreshSession()
    return session.user
  } catch {
    return null // expired, revoked or offline: show the login page
  }
}

/** Revoke the session on the server, then forget it locally whatever the outcome. */
export async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST' })
  } catch {
    // already signed out or offline: the local sign-out below is what matters
  } finally {
    clearTokens()
  }
}
