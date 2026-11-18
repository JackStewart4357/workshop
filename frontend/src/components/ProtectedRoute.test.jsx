import { screen } from '@testing-library/react'
import { Route, Routes, useLocation } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import ProtectedRoute from './ProtectedRoute.jsx'
import { USERS, renderWithProviders } from '../test/helpers.jsx'

function LoginStub() {
  const location = useLocation()
  return <p>login page, came from {location.state?.from ?? 'nowhere'}</p>
}

function renderRoutes({ auth, route = '/secret', roles }) {
  return renderWithProviders(
    <Routes>
      <Route path="/login" element={<LoginStub />} />
      <Route element={<ProtectedRoute roles={roles} />}>
        <Route path="/secret" element={<p>secret content</p>} />
        <Route path="*" element={<p>some other page</p>} />
      </Route>
    </Routes>,
    { auth, route },
  )
}

describe('ProtectedRoute', () => {
  it('shows a spinner while the session is being checked', () => {
    renderRoutes({ auth: { user: null, status: 'loading' } })
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.queryByText('secret content')).not.toBeInTheDocument()
    expect(screen.queryByText(/login page/)).not.toBeInTheDocument()
  })

  it('sends a signed-out visitor to the login page and remembers the destination', () => {
    renderRoutes({ auth: { user: null }, route: '/secret?tab=2' })
    expect(screen.getByText('login page, came from /secret?tab=2')).toBeInTheDocument()
    expect(screen.queryByText('secret content')).not.toBeInTheDocument()
  })

  it('keeps the #fragment of the destination', () => {
    renderRoutes({ auth: { user: null }, route: '/secret?tab=2#notes' })
    expect(screen.getByText('login page, came from /secret?tab=2#notes')).toBeInTheDocument()
  })

  it.each(['//secret?tab=2', '///secret?tab=2', '/\\secret?tab=2'])('never remembers %s as a link to another site', (route) => {
    renderRoutes({ auth: { user: null }, route })
    expect(screen.getByText('login page, came from /secret?tab=2')).toBeInTheDocument()
  })

  it('remembers the destination when the session expired', () => {
    renderRoutes({ auth: { user: null, sessionEnd: 'expired' }, route: '/secret?tab=2' })
    expect(screen.getByText('login page, came from /secret?tab=2')).toBeInTheDocument()
  })

  it('forgets the destination after a deliberate sign-out', () => {
    renderRoutes({ auth: { user: null, sessionEnd: 'signed-out' }, route: '/secret?tab=2' })
    expect(screen.getByText('login page, came from nowhere')).toBeInTheDocument()
  })

  it('shows the page to any signed-in user when no roles are given', () => {
    renderRoutes({ auth: { user: USERS.employee } })
    expect(screen.getByText('secret content')).toBeInTheDocument()
  })

  it('shows the page to a user with an allowed role', () => {
    renderRoutes({ auth: { user: USERS.admin }, roles: ['ADMIN'] })
    expect(screen.getByText('secret content')).toBeInTheDocument()
  })

  it.each([USERS.employee, USERS.engineer])('denies $role a page limited to admins', (user) => {
    renderRoutes({ auth: { user }, roles: ['ADMIN'] })
    expect(screen.getByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(screen.queryByText('secret content')).not.toBeInTheDocument()
  })
})
