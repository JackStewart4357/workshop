import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import AppLayout from './AppLayout.jsx'
import { USERS, renderWithProviders } from '../test/helpers.jsx'

// Give the menu a second, admin-only entry so role filtering is visible.
vi.mock('../navigation.js', async (importOriginal) => {
  const original = await importOriginal()
  const items = [...original.NAV_ITEMS, { label: 'Facilities', path: '/facilities', icon: () => null, roles: ['ADMIN'] }]
  return { ...original, NAV_ITEMS: items, navItemsFor: (role) => items.filter((item) => item.roles.includes(role)) }
})

function renderLayout({ user = USERS.employee, width = 1280, logout = vi.fn().mockResolvedValue() } = {}) {
  renderWithProviders(
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<p>page content</p>} />
        <Route path="/facilities" element={<p>facilities content</p>} />
      </Route>
      <Route path="/login" element={<p>login page</p>} />
    </Routes>,
    { auth: { user, logout }, width },
  )
  return { logout }
}

describe('AppLayout', () => {
  it('shows the page, the user name and their role', () => {
    renderLayout({ user: USERS.engineer })
    expect(screen.getByText('page content')).toBeInTheDocument()
    expect(screen.getByText('Priya Sharma')).toBeInTheDocument()
    expect(screen.getByText('Engineer')).toBeInTheDocument()
  })

  it('lists only the pages the role may open', () => {
    renderLayout({ user: USERS.employee })
    const nav = screen.getByRole('navigation', { name: 'Main' })
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).toBeInTheDocument()
    expect(within(nav).queryByRole('link', { name: 'Facilities' })).not.toBeInTheDocument()
  })

  it('shows admin-only pages to an admin and navigates to them', async () => {
    const user = userEvent.setup()
    renderLayout({ user: USERS.admin })
    await user.click(screen.getByRole('link', { name: 'Facilities' }))
    expect(screen.getByText('facilities content')).toBeInTheDocument()
  })

  it('marks the current page in the menu', () => {
    renderLayout()
    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page')
  })

  it('signs out and returns to the login page', async () => {
    const user = userEvent.setup()
    const { logout } = renderLayout()
    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(logout).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('login page')).toBeInTheDocument()
  })

  it('on a phone, hides the menu behind a button', async () => {
    const user = userEvent.setup()
    renderLayout({ user: USERS.admin, width: 390 })
    expect(screen.queryByRole('link', { name: 'Facilities' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Open menu' }))
    await user.click(await screen.findByRole('link', { name: 'Facilities' }))

    expect(screen.getByText('facilities content')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Facilities' })).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  })
})
