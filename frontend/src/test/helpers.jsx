// Shared test helpers: a fake backend and render wrappers.
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Context as ResponsiveContext } from 'react-responsive'
import { ThemeProvider } from '@mui/material/styles'
import { vi } from 'vitest'
import { AuthContext } from '../context/AuthContext.js'
import theme from '../theme.js'

export const USERS = {
  employee: { id: 'u-1', email: 'alice@acme.inc', full_name: 'Alice Johnson', role: 'EMPLOYEE', created_at: '2026-01-01T00:00:00Z' },
  engineer: { id: 'u-2', email: 'priya@acme.inc', full_name: 'Priya Sharma', role: 'ENGINEER', created_at: '2026-01-01T00:00:00Z' },
  admin: { id: 'u-3', email: 'admin@acme.inc', full_name: 'Facility Admin', role: 'ADMIN', created_at: '2026-01-01T00:00:00Z' },
}

export function session(user = USERS.employee, suffix = '1') {
  return {
    user,
    access_token: `access-${suffix}`,
    refresh_token: `refresh-${suffix}`,
    token_type: 'Bearer',
    expires_in: 900,
  }
}

export function apiError(status, code, message, details) {
  return { status, body: { error: { code, message, ...(details ? { details } : {}) } } }
}

/**
 * Replace fetch with a fake backend.
 *   routes: { 'POST /api/auth/login': (request) => ({ status, body }) }
 * Each handler receives { method, path, query, body, token }. Returns the list of calls made.
 */
export function mockApi(routes) {
  const calls = []
  const fetchMock = vi.fn(async (url, options = {}) => {
    const method = options.method || 'GET'
    const { pathname: path, searchParams } = new URL(url, 'http://localhost')
    const request = {
      method,
      path,
      ...(searchParams.size > 0 && { query: Object.fromEntries(searchParams) }), // only when there is one
      body: options.body ? JSON.parse(options.body) : undefined,
      token: options.headers?.Authorization?.replace('Bearer ', ''),
    }
    calls.push(request)
    const handler = routes[`${method} ${path}`]
    if (!handler) throw new Error(`Unexpected request in test: ${method} ${path}`)
    const { status = 200, body } = await handler(request)
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

/** Render with the theme, a router and (optionally) a fixed screen width in pixels. */
export function renderWithProviders(ui, { route = '/', width, auth } = {}) {
  let tree = ui
  if (auth) {
    const value = { status: 'ready', login: vi.fn(), register: vi.fn(), logout: vi.fn(), ...auth }
    tree = <AuthContext.Provider value={value}>{tree}</AuthContext.Provider>
  }
  tree = <MemoryRouter initialEntries={[route]}>{tree}</MemoryRouter>
  if (width) tree = <ResponsiveContext.Provider value={{ width }}>{tree}</ResponsiveContext.Provider>
  return render(<ThemeProvider theme={theme}>{tree}</ThemeProvider>)
}
