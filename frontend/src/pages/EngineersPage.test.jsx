// The page against a small fake engineers API: only fetch is faked.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import EngineersPage from './EngineersPage.jsx'
import { USERS, apiError, mockApi, renderWithProviders } from '../test/helpers.jsx'

const API = '/api/engineers'
const FEEDBACK = '/api/feedback/engineers'
const IN_USE = 'This engineer has incident history and cannot be removed. Deactivate them instead.'

// What the fake API holds; a handler changes it and the page's next GET shows the result.
let profiles, managers, ratings
beforeEach(() => {
  ratings = [{ engineer_id: 'e-2', count: 3, average: 4.3 }] // the API sends only the engineers this admin manages
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
      manager_id: USERS.admin.id, // the admin every test signs in as
      manager_name: 'Facility Admin',
    },
  ]
})

const reads = {
  [`GET ${API}/profiles`]: () => ({ body: { profiles } }),
  [`GET ${API}/managers`]: () => ({ body: { managers } }),
  [`GET ${FEEDBACK}`]: () => ({ body: { engineers: ratings } }),
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
    expect(priya.getByText('Manager: Facility Admin')).toBeInTheDocument()
    expect(priya.getByText('2 of 5 open tickets')).toBeInTheDocument()
    expect(priya.getByRole('progressbar', { name: 'Workload of Priya Sharma' })).toHaveAttribute('aria-valuenow', '40')

    // Lena holds more than her maximum: the bar stops at full
    const lena = within(card('Lena Fischer'))
    expect(lena.queryByText('Unavailable')).not.toBeInTheDocument() // deactivated says it all
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
    expect(dialog.getByRole('combobox', { name: /manager/i })).toHaveTextContent('Facility Admin')
    expect(dialog.getByRole('switch', { name: 'Available for new tickets' })).toBeChecked()
    expect(dialog.getByRole('switch', { name: 'Account active' })).toBeChecked()

    await user.clear(dialog.getByLabelText(/specialism/i))
    await user.type(dialog.getByLabelText(/specialism/i), 'Network & Wi-Fi')
    await user.clear(dialog.getByLabelText(/max open tickets/i))
    await user.type(dialog.getByLabelText(/max open tickets/i), '8')
    await user.click(dialog.getByRole('combobox', { name: /manager/i }))
    await user.click(screen.getByRole('option', { name: 'Morgan Lee' }))
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
          manager_id: 'u-9',
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
    expect(writes(calls)[0].body).toMatchObject({ is_active: false, is_available: true, manager_id: USERS.admin.id })
  })

  it('lets only the current manager hand an engineer over: other admins see the choice locked', async () => {
    profiles[1] = { ...profiles[1], manager_id: 'u-9', manager_name: 'Morgan Lee' }
    const { calls, user } = await renderPage({ [`PATCH ${API}/profiles/e-2`]: savePriya })
    await user.click(screen.getByRole('button', { name: 'Edit Priya Sharma' }))
    const dialog = within(screen.getByRole('dialog'))
    const manager = dialog.getByRole('combobox', { name: /manager/i })
    expect(manager).toHaveTextContent('Morgan Lee')
    expect(manager).toHaveAttribute('aria-disabled', 'true')
    expect(dialog.getByText('Only Morgan Lee can hand this engineer to another manager')).toBeInTheDocument()

    // Everything else can still be changed, and the manager is sent back as it was
    await user.click(dialog.getByRole('switch', { name: 'Available for new tickets' }))
    await user.click(dialog.getByRole('button', { name: 'Save' }))
    expect(await within(card('Priya Sharma')).findByText('Unavailable')).toBeInTheDocument()
    expect(writes(calls)[0].body).toMatchObject({ is_available: false, manager_id: 'u-9' })
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
    expect(dialog).toHaveTextContent('Their sign-in (lena.engineer@acme.inc) is removed with the profile. This cannot be undone.')
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

  describe('feedback, for the engineer\'s manager only', () => {
    const said = [
      {
        id: 'fb-2',
        incident_id: 'i-7',
        incident: 'Wi-Fi drops',
        rating: 5,
        comment: 'Fixed within the hour',
        author: 'Alice Johnson',
        created_at: '2026-11-18T12:00:00+00:00',
      },
      {
        id: 'fb-1',
        incident_id: 'i-3',
        incident: 'Broken projector',
        rating: 2,
        comment: null,
        author: 'Ben Carter',
        created_at: '2026-11-10T12:00:00+00:00',
      },
    ]

    it('sums up the ratings of an engineer this admin manages and shows nothing for anyone else', async () => {
      await renderPage()
      const priya = within(card('Priya Sharma'))
      expect(priya.getByText('Rated 4.3 out of 5 from 3 reports')).toBeInTheDocument()
      expect(priya.getByRole('button', { name: 'View feedback on Priya Sharma' })).toBeInTheDocument()

      // Lena is not in the API's answer: this admin does not manage her
      const lena = within(card('Lena Fischer'))
      expect(lena.queryByText(/rated|feedback/i)).not.toBeInTheDocument()
      expect(lena.queryByRole('button', { name: /feedback/i })).not.toBeInTheDocument()
    })

    it.each([
      [0, null, 'No feedback yet', false],
      [1, 5, 'Rated 5 out of 5 from 1 report', true],
    ])('words the summary for %i reports', async (count, average, words, canOpen) => {
      ratings = [{ engineer_id: 'e-2', count, average }]
      await renderPage()
      expect(within(card('Priya Sharma')).getByText(words)).toBeInTheDocument()
      expect(screen.queryAllByRole('button', { name: /view feedback/i })).toHaveLength(canOpen ? 1 : 0)
    })

    it('opens everything said about the engineer: rating, comment, who, which incident and when', async () => {
      let answer
      const { calls, user } = await renderPage({
        [`GET ${FEEDBACK}/e-2`]: () => new Promise((resolve) => (answer = resolve)),
      })
      await user.click(screen.getByRole('button', { name: 'View feedback on Priya Sharma' }))
      const dialog = within(screen.getByRole('dialog', { name: 'Feedback on Priya Sharma' }))
      expect(dialog.getByRole('progressbar', { name: 'Loading feedback' })).toBeInTheDocument()
      expect(dialog.getByText('Only you, as their manager, can see this.')).toBeInTheDocument()

      answer({ body: { feedback: said } })
      expect(await dialog.findByText('Fixed within the hour')).toBeInTheDocument()
      expect(dialog.getAllByRole('img').map((stars) => stars.getAttribute('aria-label'))).toEqual(['5 out of 5', '2 out of 5'])
      expect(dialog.getByText('No comment')).toBeInTheDocument() // the second one left no words
      expect(dialog.getByText(/Alice Johnson on/)).toHaveTextContent('Alice Johnson on Wi-Fi drops, 18 Nov 2026')
      expect(dialog.getByText(/Ben Carter on/)).toHaveTextContent('Ben Carter on Broken projector, 10 Nov 2026')
      expect(dialog.getByRole('link', { name: 'Wi-Fi drops' })).toHaveAttribute('href', '/incidents/i-7')
      expect(dialog.queryByText('No feedback yet')).not.toBeInTheDocument()
      expect(dialog.queryByRole('progressbar')).not.toBeInTheDocument()
      expect(calls.at(-1)).toMatchObject({ method: 'GET', path: `${FEEDBACK}/e-2` })

      await user.click(dialog.getByRole('button', { name: 'Close' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(writes(calls)).toEqual([]) // reading feedback changes nothing
    })

    it('shows the API\'s refusal inside the dialog when someone else has become the manager', async () => {
      const refusal = "Only this engineer's manager can read their feedback"
      const { user } = await renderPage({ [`GET ${FEEDBACK}/e-2`]: () => apiError(403, 'access_denied', refusal) })
      await user.click(screen.getByRole('button', { name: 'View feedback on Priya Sharma' }))
      const dialog = within(screen.getByRole('dialog'))
      expect(await dialog.findByRole('alert')).toHaveTextContent(refusal)
      expect(dialog.queryByRole('img')).not.toBeInTheDocument()
      expect(dialog.queryByRole('progressbar')).not.toBeInTheDocument()
      expect(dialog.queryByText('No feedback yet')).not.toBeInTheDocument()
    })

    it('says so when the feedback has gone by the time the dialog opens', async () => {
      const { user } = await renderPage({ [`GET ${FEEDBACK}/e-2`]: () => ({ body: { feedback: [] } }) })
      await user.click(screen.getByRole('button', { name: 'View feedback on Priya Sharma' }))
      expect(await within(screen.getByRole('dialog')).findByText('No feedback yet')).toBeInTheDocument()
    })

    it('still shows the engineers when the ratings cannot be loaded, just without them', async () => {
      await renderPage({ [`GET ${FEEDBACK}`]: () => apiError(500, 'internal_error', 'An unexpected error occurred') })
      expect(within(card('Priya Sharma')).getByText('2 of 5 open tickets')).toBeInTheDocument()
      expect(screen.queryByText(/rated|feedback/i)).not.toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })

  describe('with many engineers', () => {
    // Lena and Priya from above, plus enough others to need searching and paging
    const withExtra = (count) => [
      ...profiles,
      ...Array.from({ length: count }, (_, index) => ({
        ...profiles[1],
        id: `x-${index}`,
        full_name: `Engineer ${String(index + 1).padStart(2, '0')}`,
        email: `engineer${index + 1}@acme.inc`,
        specialism: index % 2 ? 'Plumbing' : 'Electrical',
      })),
    ]
    const shownEngineers = () => screen.getAllByRole('region').map((region) => region.getAttribute('aria-label'))

    it('leaves a handful of engineers exactly as they were: nothing to search or page', async () => {
      await renderPage()
      expect(shownEngineers()).toEqual(['Lena Fischer', 'Priya Sharma'])
      expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
      expect(screen.queryByText(/^Showing \d+ of/)).not.toBeInTheDocument()
    })

    it('shows the cards 20 at a time', async () => {
      profiles = withExtra(23) // 25 in all
      const { user } = await renderPage()
      expect(shownEngineers()).toHaveLength(20)
      expect(screen.getByText('Showing 20 of 25')).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Show 5 more' }))
      expect(shownEngineers()).toHaveLength(25)
      expect(screen.queryByRole('button', { name: /more$/ })).not.toBeInTheDocument()
    })

    it('finds engineers by name, email or specialism, whatever the case', async () => {
      profiles = withExtra(23)
      const { user } = await renderPage()
      const box = screen.getByRole('searchbox', { name: 'Find an engineer' })

      await user.type(box, ' PRIYA ') // her name
      expect(shownEngineers()).toEqual(['Priya Sharma'])
      await user.clear(box)
      await user.type(box, 'lena.engineer@') // an email
      expect(shownEngineers()).toEqual(['Lena Fischer'])
      await user.clear(box)
      await user.type(box, 'plumb') // a specialism: every second extra engineer
      expect(shownEngineers()).toHaveLength(11)
      expect(screen.queryByText(/^Showing/)).not.toBeInTheDocument()

      await user.clear(box)
      await user.type(box, 'nobody like this')
      expect(screen.queryByRole('region')).not.toBeInTheDocument()
      expect(screen.getByText('No engineers match.')).toBeInTheDocument()

      await user.clear(box)
      expect(shownEngineers()).toHaveLength(20)
    })

    it('still edits and removes an engineer found by searching', async () => {
      profiles = withExtra(23)
      const { calls, user } = await renderPage({
        [`DELETE ${API}/profiles/x-22`]: () => {
          profiles = profiles.filter((profile) => profile.id !== 'x-22')
          return { status: 204 }
        },
      })
      await user.type(screen.getByRole('searchbox', { name: 'Find an engineer' }), 'engineer 23') // on the second page
      await user.click(within(card('Engineer 23')).getByRole('button', { name: 'Remove Engineer 23' }))
      await user.click(screen.getByRole('button', { name: 'Remove' }))

      await waitFor(() => expect(screen.getByText('No engineers match.')).toBeInTheDocument())
      expect(writes(calls)).toMatchObject([{ method: 'DELETE', path: `${API}/profiles/x-22` }])
    })
  })
})
