// End-to-end through the real router, auth provider and API client; only fetch is faked.
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '@mui/material/styles'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { USERS, apiError, mockApi, session } from './test/helpers.jsx'
import theme from './theme.js'

const REFRESH_KEY = 'acme.refreshToken'

let App, AuthProvider
beforeEach(async () => {
  vi.resetModules()
  ;({ default: App } = await import('./App.jsx'))
  ;({ default: AuthProvider } = await import('./context/AuthProvider.jsx'))
})

function renderApp(route = '/') {
  render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  )
  return userEvent.setup()
}

describe('App', () => {
  it('a visitor is sent to sign in, signs in, sees their dashboard and signs out', async () => {
    const calls = mockApi({
      'POST /api/auth/login': ({ body }) =>
        body.password === 'Password123'
          ? { body: session(USERS.engineer) }
          : apiError(401, 'invalid_credentials', 'Incorrect email or password'),
      'POST /api/auth/logout': () => ({ status: 204 }),
    })
    const user = renderApp('/')

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()

    await user.type(screen.getByLabelText(/email/i), 'priya@acme.inc')
    await user.type(screen.getByLabelText(/^password/i), 'wrong-password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect email or password')

    await user.clear(screen.getByLabelText(/^password/i))
    await user.type(screen.getByLabelText(/^password/i), 'Password123')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('heading', { name: 'Welcome, Priya Sharma' })).toBeInTheDocument()
    expect(screen.getByText(/incidents assigned to you/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(calls.at(-1)).toMatchObject({ path: '/api/auth/logout', token: 'access-1' })
    expect(window.localStorage.getItem(REFRESH_KEY)).toBeNull()
  })

  it('a new employee registers and lands on their dashboard', async () => {
    const calls = mockApi({ 'POST /api/auth/register': () => ({ status: 201, body: session(USERS.employee) }) })
    const user = renderApp('/register')

    await user.type(await screen.findByLabelText(/full name/i), 'Alice Johnson')
    await user.type(screen.getByLabelText(/work email/i), 'alice@acme.inc')
    await user.type(screen.getByLabelText(/^password/i), 'passw0rd1')
    await user.type(screen.getByLabelText(/confirm password/i), 'passw0rd1')
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await screen.findByRole('heading', { name: 'Welcome, Alice Johnson' })).toBeInTheDocument()
    expect(screen.getByText(/report facility and workplace technology issues/i)).toBeInTheDocument()
    expect(calls[0].body).toEqual({ full_name: 'Alice Johnson', email: 'alice@acme.inc', password: 'passw0rd1' })
  })

  it('a returning user stays signed in after a reload', async () => {
    window.localStorage.setItem(REFRESH_KEY, 'refresh-1')
    mockApi({ 'POST /api/auth/refresh': () => ({ body: session(USERS.admin, '2') }) })
    renderApp('/')
    expect(await screen.findByRole('heading', { name: 'Welcome, Facility Admin' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument()
  })

  it('an unknown address shows "page not found" inside the app', async () => {
    window.localStorage.setItem(REFRESH_KEY, 'refresh-1')
    mockApi({ 'POST /api/auth/refresh': () => ({ body: session(USERS.employee, '2') }) })
    const user = renderApp('/no-such-page')
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
    await user.click(screen.getByRole('link', { name: 'Back to dashboard' }))
    expect(screen.getByRole('heading', { name: 'Welcome, Alice Johnson' })).toBeInTheDocument()
  })
})
