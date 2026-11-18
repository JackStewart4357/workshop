import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { USERS, apiError, mockApi, session } from '../test/helpers.jsx'

const REFRESH_KEY = 'acme.refreshToken'

// Fresh copies each test: the API client keeps tokens in module state.
let AuthProvider, useAuth, apiClient
beforeEach(async () => {
  vi.resetModules()
  ;({ default: AuthProvider } = await import('./AuthProvider.jsx'))
  ;({ useAuth } = await import('./AuthContext.js'))
  apiClient = await import('../services/apiClient.js')
})

function Probe() {
  const { user, status, login, register, logout } = useAuth()
  return (
    <div>
      <p>status: {status}</p>
      <p>user: {user ? `${user.full_name} (${user.role})` : 'nobody'}</p>
      <button onClick={() => login('alice@acme.inc', 'passw0rd1').catch(() => {})}>login</button>
      <button onClick={() => register({ fullName: 'Alice Johnson', email: 'alice@acme.inc', password: 'passw0rd1' })}>
        register
      </button>
      <button onClick={logout}>logout</button>
    </div>
  )
}

function renderProvider() {
  return render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  )
}

describe('AuthProvider', () => {
  it('starts in "loading" and settles on nobody when no session is stored', async () => {
    const calls = mockApi({})
    renderProvider()
    expect(screen.getByText('status: loading')).toBeInTheDocument()
    expect(await screen.findByText('status: ready')).toBeInTheDocument()
    expect(screen.getByText('user: nobody')).toBeInTheDocument()
    expect(calls).toHaveLength(0)
  })

  it('restores the previous session after a reload', async () => {
    window.localStorage.setItem(REFRESH_KEY, 'refresh-1')
    mockApi({ 'POST /api/auth/refresh': () => ({ body: session(USERS.engineer, '2') }) })
    renderProvider()
    expect(await screen.findByText('user: Priya Sharma (ENGINEER)')).toBeInTheDocument()
    expect(screen.getByText('status: ready')).toBeInTheDocument()
  })

  it('shows nobody when the stored session has been revoked', async () => {
    window.localStorage.setItem(REFRESH_KEY, 'refresh-old')
    mockApi({ 'POST /api/auth/refresh': () => apiError(401, 'invalid_token', 'Your session is no longer valid') })
    renderProvider()
    expect(await screen.findByText('status: ready')).toBeInTheDocument()
    expect(screen.getByText('user: nobody')).toBeInTheDocument()
  })

  it('login, register and logout update the signed-in user', async () => {
    const user = userEvent.setup()
    mockApi({
      'POST /api/auth/login': () => ({ body: session(USERS.admin) }),
      'POST /api/auth/register': () => ({ status: 201, body: session(USERS.employee, '2') }),
      'POST /api/auth/logout': () => ({ status: 204 }),
    })
    renderProvider()
    await screen.findByText('status: ready')

    await user.click(screen.getByRole('button', { name: 'login' }))
    expect(await screen.findByText('user: Facility Admin (ADMIN)')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'logout' }))
    expect(await screen.findByText('user: nobody')).toBeInTheDocument()
    expect(window.localStorage.getItem(REFRESH_KEY)).toBeNull()

    await user.click(screen.getByRole('button', { name: 'register' }))
    expect(await screen.findByText('user: Alice Johnson (EMPLOYEE)')).toBeInTheDocument()
  })

  it('stays signed out when login fails', async () => {
    const user = userEvent.setup()
    mockApi({ 'POST /api/auth/login': () => apiError(401, 'invalid_credentials', 'Incorrect email or password') })
    renderProvider()
    await screen.findByText('status: ready')
    await user.click(screen.getByRole('button', { name: 'login' }))
    await waitFor(() => expect(screen.getByText('user: nobody')).toBeInTheDocument())
  })

  it('signs the user out when the API reports the session is over', async () => {
    const user = userEvent.setup()
    mockApi({
      'POST /api/auth/login': () => ({ body: session(USERS.admin) }),
      'GET /api/private': () => apiError(401, 'invalid_token', 'Your session is no longer valid'),
      'POST /api/auth/refresh': () => apiError(401, 'invalid_token', 'Your session is no longer valid'),
    })
    renderProvider()
    await screen.findByText('status: ready')
    await user.click(screen.getByRole('button', { name: 'login' }))
    await screen.findByText('user: Facility Admin (ADMIN)')

    await act(async () => {
      await apiClient.api('/api/private').catch(() => {})
    })
    expect(screen.getByText('user: nobody')).toBeInTheDocument()
  })

  it('shows whoever the renewed tokens belong to, e.g. after another tab signed in as someone else', async () => {
    const user = userEvent.setup()
    mockApi({
      'POST /api/auth/login': () => ({ body: session(USERS.admin) }),
      'GET /api/private': ({ token }) =>
        token === 'access-2' ? { body: { ok: true } } : apiError(401, 'token_expired', 'Your session has expired'),
      // Tabs share the stored refresh token: here it now belongs to the employee
      'POST /api/auth/refresh': () => ({ body: session(USERS.employee, '2') }),
    })
    renderProvider()
    await screen.findByText('status: ready')
    await user.click(screen.getByRole('button', { name: 'login' }))
    await screen.findByText('user: Facility Admin (ADMIN)')

    await act(async () => {
      await apiClient.api('/api/private')
    })
    expect(screen.getByText('user: Alice Johnson (EMPLOYEE)')).toBeInTheDocument()
  })

  it('useAuth outside the provider explains the mistake', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Probe />)).toThrow('useAuth must be used inside <AuthProvider>')
  })
})
