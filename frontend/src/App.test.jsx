// End-to-end through the real router, auth provider and API client; only fetch is faked.
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '@mui/material/styles'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { USERS, apiError, mockApi as fakeApi, session } from './test/helpers.jsx'

// The dashboard at "/" asks for its numbers on every visit: an empty answer unless a test says otherwise.
const EMPTY_DASHBOARD = {
  'GET /api/incidents/summary': () => ({
    body: {
      total: 0,
      by_status: { OPEN: 0, IN_PROGRESS: 0, BLOCKED: 0, RESOLVED: 0, CLOSED: 0 },
      by_priority: { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 },
      unassigned_open: 0,
      escalated_open: 0,
      needs_attention: [],
      kept_informed: { open: 0, quiet: 0, awaiting_confirmation: 0, closed: 0, confirmed_by_reporter: 0, quietest: [] },
      by_assignee: [],
      by_category: [],
      by_location: { buildings: [], floors: [], seats: [] },
      average_hours: { to_acknowledge: null, to_assign: null, to_resolve: null },
    },
  }),
  'GET /api/incidents/tickets': () => ({ body: { incidents: [] } }),
}
const mockApi = (routes) => fakeApi({ ...EMPTY_DASHBOARD, ...routes })
import theme from './theme.js'

const REFRESH_KEY = 'acme.refreshToken'

let App, AuthProvider, apiClient
beforeEach(async () => {
  vi.resetModules()
  ;({ default: App } = await import('./App.jsx'))
  ;({ default: AuthProvider } = await import('./context/AuthProvider.jsx'))
  apiClient = await import('./services/apiClient.js')
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

async function signIn(user, email = 'priya@acme.inc') {
  await user.type(await screen.findByLabelText(/email/i), email)
  await user.type(screen.getByLabelText(/^password/i), 'Password123')
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
}

const expired = () => apiError(401, 'token_expired', 'Your session has expired')

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

  it.each(['/login', '/register'])('%s waits for the saved session to be checked before showing its form', async (route) => {
    window.localStorage.setItem(REFRESH_KEY, 'refresh-old')
    let answer
    mockApi({ 'POST /api/auth/refresh': () => new Promise((resolve) => (answer = resolve)) })
    renderApp(route)

    expect(screen.getByRole('progressbar', { name: 'Checking your session' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    await act(async () => answer(apiError(401, 'invalid_token', 'Your session is no longer valid')))
    expect(await screen.findByLabelText(/email/i)).toBeInTheDocument()
  })

  it('/login goes straight to the dashboard when the saved session is still good', async () => {
    window.localStorage.setItem(REFRESH_KEY, 'refresh-1')
    let answer
    mockApi({ 'POST /api/auth/refresh': () => new Promise((resolve) => (answer = resolve)) })
    renderApp('/login')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    await act(async () => answer({ body: session(USERS.engineer, '2') }))
    expect(await screen.findByRole('heading', { name: 'Welcome, Priya Sharma' })).toBeInTheDocument()
  })

  it('signing out forgets the page, so the next sign-in starts on the dashboard', async () => {
    window.localStorage.setItem(REFRESH_KEY, 'refresh-1')
    mockApi({
      'POST /api/auth/refresh': () => ({ body: session(USERS.admin, '2') }),
      'POST /api/auth/logout': () => ({ status: 204 }),
      'POST /api/auth/login': () => ({ body: session(USERS.employee, '3') }),
    })
    const user = renderApp('/no-such-page')
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    await signIn(user, 'alice@acme.inc')

    expect(await screen.findByRole('heading', { name: 'Welcome, Alice Johnson' })).toBeInTheDocument()
  })

  it('an expired session returns to sign in with an explanation, then back to the same page', async () => {
    window.localStorage.setItem(REFRESH_KEY, 'refresh-1')
    let sessionAlive = true
    mockApi({
      'POST /api/auth/refresh': () => (sessionAlive ? { body: session(USERS.engineer, '2') } : expired()),
      'GET /api/incidents': expired,
      'POST /api/auth/login': () => ({ body: session(USERS.engineer, '3') }),
      'POST /api/auth/logout': () => ({ status: 204 }),
    })
    const user = renderApp('/no-such-page')
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument()

    sessionAlive = false
    await act(async () => {
      await apiClient.api('/api/incidents').catch(() => {})
    })
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Your session has expired. Please sign in again.')

    await signIn(user)
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('signing out of a session that had already expired shows no explanation', async () => {
    mockApi({
      'POST /api/auth/login': () => ({ body: session(USERS.engineer) }),
      'POST /api/auth/logout': expired,
      'POST /api/auth/refresh': expired,
    })
    const user = renderApp('/no-such-page')
    await signIn(user)
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await signIn(user)
    expect(await screen.findByRole('heading', { name: 'Welcome, Priya Sharma' })).toBeInTheDocument()
  })

  it('a request answered 401 after signing out is not reported as an expired session', async () => {
    window.localStorage.setItem(REFRESH_KEY, 'refresh-1')
    let answer
    mockApi({
      'POST /api/auth/refresh': () => ({ body: session(USERS.engineer, '2') }),
      'GET /api/incidents': () => new Promise((resolve) => (answer = resolve)),
      'POST /api/auth/logout': () => ({ status: 204 }),
    })
    const user = renderApp('/')
    await screen.findByRole('heading', { name: 'Welcome, Priya Sharma' })

    const pending = apiClient.api('/api/incidents').catch(() => {}) // still in flight at sign-out
    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    await screen.findByRole('heading', { name: 'Sign in' })
    await act(async () => {
      answer(expired())
      await pending
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each(['signs in', 'registers'])('an expiry is still explained when someone %s after a sign-out', async (how) => {
    mockApi({
      'POST /api/auth/login': () => ({ body: session(USERS.engineer) }),
      'POST /api/auth/register': () => ({ status: 201, body: session(USERS.engineer) }),
      'POST /api/auth/logout': () => ({ status: 204 }),
      'GET /api/incidents': expired,
      'POST /api/auth/refresh': expired,
    })
    const user = renderApp('/')
    await signIn(user)
    await user.click(await screen.findByRole('button', { name: 'Sign out' }))

    if (how === 'signs in') {
      await signIn(user)
    } else {
      await user.click(await screen.findByRole('link', { name: 'Create an account' }))
      await user.type(screen.getByLabelText(/full name/i), 'Priya Sharma')
      await user.type(screen.getByLabelText(/work email/i), 'priya@acme.inc')
      await user.type(screen.getByLabelText(/^password/i), 'Password123')
      await user.type(screen.getByLabelText(/confirm password/i), 'Password123')
      await user.click(screen.getByRole('button', { name: 'Create account' }))
    }
    await screen.findByRole('heading', { name: 'Welcome, Priya Sharma' })

    await act(async () => {
      await apiClient.api('/api/incidents').catch(() => {})
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('Your session has expired. Please sign in again.')
  })

  it('an admin opens Facilities from the menu', async () => {
    window.localStorage.setItem(REFRESH_KEY, 'refresh-1')
    mockApi({
      'POST /api/auth/refresh': () => ({ body: session(USERS.admin, '2') }),
      'GET /api/facilities/buildings': ({ token }) =>
        token === 'access-2' ? { body: { buildings: [] } } : apiError(401, 'unauthorized', 'Authentication is required'),
    })
    const user = renderApp('/')
    await user.click(await screen.findByRole('link', { name: 'Facilities' }))
    expect(await screen.findByRole('heading', { name: 'Facilities' })).toBeInTheDocument()
    expect(screen.getByText('There are no buildings yet.')).toBeInTheDocument()
  })

  it.each([USERS.employee, USERS.engineer])('$role cannot open Facilities, even by typing its address', async (who) => {
    window.localStorage.setItem(REFRESH_KEY, 'refresh-1')
    const calls = mockApi({ 'POST /api/auth/refresh': () => ({ body: session(who, '2') }) })
    renderApp('/facilities')
    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Facilities' })).not.toBeInTheDocument()
    expect(calls.map((call) => call.path)).toEqual(['/api/auth/refresh'])
  })

  it('an admin opens Engineers from the menu', async () => {
    window.localStorage.setItem(REFRESH_KEY, 'refresh-1')
    const asAdmin = (body) => ({ token }) =>
      token === 'access-2' ? { body } : apiError(401, 'unauthorized', 'Authentication is required')
    mockApi({
      'POST /api/auth/refresh': () => ({ body: session(USERS.admin, '2') }),
      'GET /api/engineers/profiles': asAdmin({ profiles: [] }),
      'GET /api/engineers/managers': asAdmin({ managers: [] }),
    })
    const user = renderApp('/')
    await user.click(await screen.findByRole('link', { name: 'Engineers' }))
    expect(await screen.findByRole('heading', { name: 'Engineers' })).toBeInTheDocument()
    expect(screen.getByText('There are no engineers yet.')).toBeInTheDocument()
  })

  it.each([USERS.employee, USERS.engineer])('$role cannot open Engineers, even by typing its address', async (who) => {
    window.localStorage.setItem(REFRESH_KEY, 'refresh-1')
    const calls = mockApi({ 'POST /api/auth/refresh': () => ({ body: session(who, '2') }) })
    renderApp('/engineers')
    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Engineers' })).not.toBeInTheDocument()
    expect(calls.map((call) => call.path)).toEqual(['/api/auth/refresh'])
  })

  it.each([USERS.employee, USERS.engineer, USERS.admin])(
    '$role opens Incidents from the menu, then the report form, then an incident by its address',
    async (who) => {
      window.localStorage.setItem(REFRESH_KEY, 'refresh-1')
      const signedIn = (body) => ({ token }) =>
        token === 'access-2' ? { body } : apiError(401, 'unauthorized', 'Authentication is required')
      const incident = {
        id: 'i-1',
        title: 'Leaking tap',
        description: 'Drips',
        status: 'OPEN',
        priority: 'MEDIUM',
        category: 'Plumbing',
        building: 'Headquarters',
        floor_level: null,
        seat: null,
        reporter: 'Alice Johnson',
        reporter_id: 'u-1',
        assignee: null,
        assignee_id: null,
        is_escalated: false,
        blocked_reason: null,
        created_at: '2026-11-18T09:15:00+00:00',
        updated_at: '2026-11-18T09:15:00+00:00',
        notes: [],
        history: [],
        next_statuses: [],
        is_staff: false,
      }
      mockApi({
        'POST /api/auth/refresh': () => ({ body: session(who, '2') }),
        'GET /api/incidents/tickets': signedIn({ incidents: [incident] }),
        'GET /api/incidents/tickets/i-1': signedIn({ incident }),
        'GET /api/incidents/categories': signedIn({ categories: [] }),
        'GET /api/facilities/buildings': signedIn({ buildings: [] }),
        'GET /api/engineers/profiles': signedIn({ profiles: [] }),
      })
      const user = renderApp('/')

      await user.click(await screen.findByRole('link', { name: 'Incidents' }))
      expect(await screen.findByRole('heading', { name: 'Incidents' })).toBeInTheDocument()

      await user.click(screen.getByRole('link', { name: 'Report incident' }))
      expect(await screen.findByRole('heading', { name: 'Report an incident' })).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Incidents' })).toHaveClass('active') // the menu still shows where we are

      await user.click(screen.getByRole('link', { name: 'Cancel' }))
      await user.click(await screen.findByRole('link', { name: /Leaking tap/ }))
      expect(await screen.findByRole('heading', { name: 'Leaking tap' })).toBeInTheDocument()
      expect(screen.getAllByRole('main')).toHaveLength(1)
    },
  )
})
