// The page against a small fake engineers API: only fetch is faked.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import EngineersPage from './EngineersPage.jsx'
import { USERS, apiError, mockApi, renderWithProviders } from '../test/helpers.jsx'

const API = '/api/engineers'
const IN_USE = 'This engineer has incident history and cannot be removed. Deactivate them instead.'

// What the fake API holds; a handler changes it and the page's next GET shows the result.
let profiles, managers
beforeEach(() => {
  managers = [
    { id: USERS.admin.id, full_name: 'Facility Admin' },
    { id: 'u-9', full_name: 'Morgan Lee' },
  ]
  profiles = [
    {
      id: 'e-1',
      full_name: 'Lena Fischer',
      email: 'lena.engineer@acme.inc',
      specialism: 'HVAC & general facility',
      is_available: false,
      is_active: false,
      max_open_tickets: 3,
      open_tickets: 4,
      manager_id: null,
      manager_name: null,
    },
    {
      id: 'e-2',
      full_name: 'Priya Sharma',
      email: 'priya.engineer@acme.inc',
      specialism: 'Network & IT hardware',
      is_available: true,
      is_active: true,
      max_open_tickets: 5,
      open_tickets: 2,
      manager_id: 'u-9',
      manager_name: 'Morgan Lee',
    },
  ]
})

const reads = {
  [`GET ${API}/profiles`]: () => ({ body: { profiles } }),
  [`GET ${API}/managers`]: () => ({ body: { managers } }),
}

// Saves a change to Priya the way the API does, so the next GET shows it.
const savePriya = ({ body }) => {
  profiles = [profiles[0], { ...profiles[1], ...body }]
  return { body: { profile: profiles[1] } }
}

async function renderPage(routes = {}) {
  const calls = mockApi({ ...reads, ...routes })
  renderWithProviders(<EngineersPage />, { auth: { user: USERS.admin } })
  const user = userEvent.setup()
  await screen.findByRole('heading', { name: 'Engineers' })
  return { calls, user }
}

async function fillNewEngineer(user, { email = 'sam.engineer@acme.inc' } = {}) {
  await user.click(screen.getByRole('button', { name: 'Add engineer' }))
  const dialog = screen.getByRole('dialog', { name: 'Add engineer' })
  await user.type(within(dialog).getByLabelText(/full name/i), '  Sam Okoro ')
  await user.type(within(dialog).getByLabelText(/email/i), email)
  await user.type(within(dialog).getByLabelText(/^first password/i), 'Passw0rd!')
  await user.type(within(dialog).getByLabelText(/specialism/i), ' Plumbing ')
  return dialog
}

const card = (name) => screen.getByRole('region', { name })
const writes = (calls) => calls.filter((call) => call.method !== 'GET')

describe('EngineersPage', () => {
  it('shows a spinner, then every engineer with their availability, manager and workload', async () => {
    mockApi(reads)
    renderWithProviders(<EngineersPage />, { auth: { user: USERS.admin } })
    expect(screen.getByRole('progressbar', { name: 'Loading engineers' })).toBeInTheDocument()

    expect(await screen.findByRole('heading', { name: 'Priya Sharma' })).toBeInTheDocument()
    const priya = within(card('Priya Sharma'))
    expect(priya.getByText('priya.engineer@acme.inc')).toBeInTheDocument()
    expect(priya.getByText('Network & IT hardware')).toBeInTheDocument()
    expect(priya.getByText('Available')).toBeInTheDocument()
    expect(priya.queryByText('Deactivated')).not.toBeInTheDocument()
    expect(priya.getByText('Manager: Morgan Lee')).toBeInTheDocument()
    expect(priya.getByText('2 of 5 open tickets')).toBeInTheDocument()
    expect(priya.getByRole('progressbar', { name: 'Workload of Priya Sharma' })).toHaveAttribute('aria-valuenow', '40')

    // Lena holds more than her maximum: the bar stops at full
    const lena = within(card('Lena Fischer'))
    expect(lena.getByText('Unavailable')).toBeInTheDocument()
    expect(lena.getByText('Deactivated')).toBeInTheDocument()
    expect(lena.getByText('No manager yet')).toBeInTheDocument()
    expect(lena.getByText('4 of 3 open tickets')).toBeInTheDocument()
    expect(lena.getByRole('progressbar', { name: 'Workload of Lena Fischer' })).toHaveAttribute('aria-valuenow', '100')
    expect(screen.queryByText('There are no engineers yet.')).not.toBeInTheDocument()
  })

  it('says so when there are no engineers yet', async () => {
    profiles = []
    await renderPage()
    expect(screen.getByText('There are no engineers yet.')).toBeInTheDocument()
  })

  it('offers to try again when the engineers cannot be loaded', async () => {
    let online = false
    mockApi({
      ...reads,
      [`GET ${API}/profiles`]: () =>
        online ? { body: { profiles } } : apiError(500, 'internal_error', 'An unexpected error occurred'),
    })
    renderWithProviders(<EngineersPage />, { auth: { user: USERS.admin } })
    const user = userEvent.setup()
    expect(await screen.findByRole('alert')).toHaveTextContent('An unexpected error occurred')

    online = true
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'Priya Sharma' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('adds an engineer with their sign-in and shows them', async () => {
    const { calls, user } = await renderPage({
      [`POST ${API}/profiles`]: ({ body }) => {
        const { password: _password, ...fields } = body
        const profile = { id: 'e-3', ...fields, is_available: true, is_active: true, open_tickets: 0 }
        profiles = [...profiles, { ...profile, manager_id: USERS.admin.id, manager_name: 'Facility Admin' }]
        return { status: 201, body: { profile: profiles.at(-1) } }
      },
    })
    const dialog = await fillNewEngineer(user)
    expect(within(dialog).getByLabelText(/max open tickets/i)).toHaveValue(5)
    expect(within(dialog).queryByLabelText(/manager/i)).not.toBeInTheDocument() // it will be this admin
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('heading', { name: 'Sam Okoro' })).toBeInTheDocument()
    expect(within(card('Sam Okoro')).getByText('Manager: Facility Admin')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(writes(calls)).toEqual([
      {
        method: 'POST',
        path: `${API}/profiles`,
        token: undefined,
        body: {
          full_name: 'Sam Okoro',
          email: 'sam.engineer@acme.inc',
          password: 'Passw0rd!',
          specialism: 'Plumbing',
          max_open_tickets: 5,
        },
      },
    ])
  })

  it('checks the new engineer form before sending anything', async () => {
    const { calls, user } = await renderPage()
    await user.click(screen.getByRole('button', { name: 'Add engineer' }))
    const dialog = within(screen.getByRole('dialog'))
    await user.clear(dialog.getByLabelText(/max open tickets/i))
    await user.type(dialog.getByLabelText(/max open tickets/i), '51')
    await user.click(dialog.getByRole('button', { name: 'Save' }))

    expect(dialog.getByText('Full name is required')).toBeInTheDocument()
    expect(dialog.getByText('Email is required')).toBeInTheDocument()
    expect(dialog.getByText('Password is required')).toBeInTheDocument()
    expect(dialog.getByText('Specialism is required')).toBeInTheDocument()
    expect(dialog.getByText('Max open tickets must be a whole number from 1 to 50')).toBeInTheDocument()
    expect(dialog.getByLabelText(/full name/i)).toHaveFocus()
    expect(writes(calls)).toEqual([])

    // Typing in a field clears its message and brings its hint back
    await user.type(dialog.getByLabelText(/email/i), 'sam@gmail.com')
    expect(dialog.queryByText('Email is required')).not.toBeInTheDocument()
    expect(dialog.getByText('Must end in @acme.inc')).toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: 'Save' }))
    expect(dialog.getByText('Only @acme.inc email addresses can register')).toBeInTheDocument()

    await user.click(dialog.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows "email already exists" from the API under the email field and keeps the form open', async () => {
    const message = 'An account with this email already exists'
    const { user } = await renderPage({
      [`POST ${API}/profiles`]: () => apiError(409, 'conflict', message, { email: message }),
    })
    const dialog = await fillNewEngineer(user, { email: 'priya.engineer@acme.inc' })
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(await within(dialog).findByText(message)).toBeInTheDocument()
    expect(within(dialog).getByLabelText(/email/i)).toBeInvalid()
    expect(within(dialog).getByLabelText(/email/i)).toHaveFocus()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled()
    expect(within(dialog).getByLabelText(/^first password/i)).toHaveValue('Passw0rd!') // nothing to retype
  })

  it('shows any other failure inside the form', async () => {
    const { user } = await renderPage({
      [`POST ${API}/profiles`]: () => apiError(403, 'access_denied', 'You do not have permission'),
    })
    const dialog = await fillNewEngineer(user)
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('You do not have permission')
    expect(within(dialog).getByLabelText(/full name/i)).toHaveFocus()
  })

  it('edits an engineer, starting from what is saved, and sends every field', async () => {
    const { calls, user } = await renderPage({ [`PATCH ${API}/profiles/e-2`]: savePriya })
    await user.click(screen.getByRole('button', { name: 'Edit Priya Sharma' }))
    const dialog = within(screen.getByRole('dialog', { name: 'Edit engineer' }))
    expect(dialog.getByText('Signs in as priya.engineer@acme.inc')).toBeInTheDocument()
    expect(dialog.queryByLabelText(/email/i)).not.toBeInTheDocument() // the sign-in name cannot change
    expect(dialog.queryByLabelText(/password/i)).not.toBeInTheDocument()
    expect(dialog.getByLabelText(/full name/i)).toHaveValue('Priya Sharma')
    expect(dialog.getByLabelText(/specialism/i)).toHaveValue('Network & IT hardware')
    expect(dialog.getByLabelText(/max open tickets/i)).toHaveValue(5)
    expect(dialog.getByRole('combobox', { name: /manager/i })).toHaveTextContent('Morgan Lee')
    expect(dialog.getByRole('switch', { name: 'Available for new tickets' })).toBeChecked()
    expect(dialog.getByRole('switch', { name: 'Account active' })).toBeChecked()

    await user.clear(dialog.getByLabelText(/specialism/i))
    await user.type(dialog.getByLabelText(/specialism/i), 'Network & Wi-Fi')
    await user.clear(dialog.getByLabelText(/max open tickets/i))
    await user.type(dialog.getByLabelText(/max open tickets/i), '8')
    await user.click(dialog.getByRole('combobox', { name: /manager/i }))
    await user.click(screen.getByRole('option', { name: 'Facility Admin' }))
    await user.click(dialog.getByRole('switch', { name: 'Available for new tickets' }))
    await user.click(dialog.getByRole('button', { name: 'Save' }))

    expect(await within(card('Priya Sharma')).findByText('Network & Wi-Fi')).toBeInTheDocument()
    expect(within(card('Priya Sharma')).getByText('Unavailable')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(writes(calls)).toEqual([
      {
        method: 'PATCH',
        path: `${API}/profiles/e-2`,
        token: undefined,
        body: {
          full_name: 'Priya Sharma',
          specialism: 'Network & Wi-Fi',
          max_open_tickets: 8,
          manager_id: USERS.admin.id,
          is_available: false,
          is_active: true,
        },
      },
    ])
  })

  it('deactivates an engineer with the "Account active" switch', async () => {
    const { calls, user } = await renderPage({ [`PATCH ${API}/profiles/e-2`]: savePriya })
    await user.click(screen.getByRole('button', { name: 'Edit Priya Sharma' }))
    await user.click(screen.getByRole('switch', { name: 'Account active' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await within(card('Priya Sharma')).findByText('Deactivated')).toBeInTheDocument()
    expect(writes(calls)[0].body).toMatchObject({ is_active: false, is_available: true, manager_id: 'u-9' })
  })

  it('offers the admin who is editing as manager when the engineer has none, or theirs has left', async () => {
    profiles[1].manager_id = 'u-gone' // no longer a facility admin
    const { user } = await renderPage()
    for (const name of ['Lena Fischer', 'Priya Sharma']) {
      await user.click(screen.getByRole('button', { name: `Edit ${name}` }))
      expect(screen.getByRole('combobox', { name: /manager/i })).toHaveTextContent('Facility Admin')
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    }
  })

  it('asks for a manager when there is none to offer', async () => {
    managers = []
    const { calls, user } = await renderPage()
    await user.click(screen.getByRole('button', { name: 'Edit Lena Fischer' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByText('Choose a facility admin as the manager')).toBeInTheDocument()
    expect(writes(calls)).toEqual([])
  })

  it('shows a complaint about the manager under that field, and one about a hidden field in the form', async () => {
    const complaints = [{ manager_id: 'Choose a facility admin as the manager' }, { email: 'Email is required' }]
    const { user } = await renderPage({
      [`PATCH ${API}/profiles/e-2`]: () => apiError(400, 'validation_error', 'Some fields are invalid', complaints.shift()),
    })
    await user.click(screen.getByRole('button', { name: 'Edit Priya Sharma' }))
    const dialog = within(screen.getByRole('dialog'))
    await user.click(dialog.getByRole('button', { name: 'Save' }))
    expect(await dialog.findByText('Choose a facility admin as the manager')).toBeInTheDocument()
    expect(dialog.queryByRole('alert')).not.toBeInTheDocument()

    await user.click(dialog.getByRole('button', { name: 'Save' }))
    expect(await dialog.findByRole('alert')).toHaveTextContent('Some fields are invalid')
  })

  it('removes an engineer only after the admin confirms', async () => {
    const { calls, user } = await renderPage({
      [`DELETE ${API}/profiles/e-1`]: () => {
        profiles = profiles.slice(1)
        return { status: 204 }
      },
    })
    await user.click(screen.getByRole('button', { name: 'Remove Lena Fischer' }))
    const dialog = screen.getByRole('dialog', { name: 'Remove Lena Fischer?' })
    expect(dialog).toHaveTextContent('Their sign-in is removed with the profile. This cannot be undone.')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(writes(calls)).toEqual([])

    await user.click(screen.getByRole('button', { name: 'Remove Lena Fischer' }))
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Lena Fischer' })).not.toBeInTheDocument())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Priya Sharma' })).toBeInTheDocument()
  })

  it('explains why an engineer with incident history cannot be removed, and keeps them', async () => {
    const { user } = await renderPage({ [`DELETE ${API}/profiles/e-2`]: () => apiError(409, 'conflict', IN_USE) })
    await user.click(screen.getByRole('button', { name: 'Remove Priya Sharma' }))
    await user.click(screen.getByRole('button', { name: 'Remove' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(IN_USE)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Priya Sharma' })).toBeInTheDocument()

    await user.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('holds the form and the page while a change is being saved', async () => {
    let finish
    const { calls, user } = await renderPage({
      [`PATCH ${API}/profiles/e-2`]: () => new Promise((resolve) => (finish = resolve)),
    })
    await user.click(screen.getByRole('button', { name: 'Edit Priya Sharma' }))
    const dialog = within(screen.getByRole('dialog'))
    await user.type(dialog.getByLabelText(/full name/i), '{Enter}')

    expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(dialog.getByLabelText(/full name/i)).toBeDisabled()
    expect(dialog.getByRole('switch', { name: 'Account active' })).toBeDisabled()
    expect(dialog.getByRole('combobox', { name: /manager/i })).toHaveAttribute('aria-disabled', 'true')
    expect(writes(calls)).toHaveLength(1)

    finish({ body: { profile: profiles[1] } })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Add engineer' })).toBeEnabled()
  })

  it('holds the other controls while a removal is being sent', async () => {
    let finish
    const { user } = await renderPage({
      [`DELETE ${API}/profiles/e-1`]: () => new Promise((resolve) => (finish = resolve)),
    })
    await user.click(screen.getByRole('button', { name: 'Remove Lena Fischer' }))
    await user.click(screen.getByRole('button', { name: 'Remove' }))

    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    // The page behind the dialog is hidden from the accessibility tree while it is open
    for (const name of ['Add engineer', 'Edit Priya Sharma', 'Remove Priya Sharma']) {
      expect(screen.getByRole('button', { name, hidden: true })).toBeDisabled()
    }

    finish({ status: 204 })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})
