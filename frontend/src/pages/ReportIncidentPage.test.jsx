// The form against a small fake API: only fetch is faked.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import ReportIncidentPage from './ReportIncidentPage.jsx'
import { USERS, apiError, mockApi, renderWithProviders } from '../test/helpers.jsx'

const TICKETS = '/api/incidents/tickets'

const categories = [
  { id: 'c-1', name: 'Plumbing', type: 'FACILITY' },
  { id: 'c-2', name: 'Network', type: 'TECHNOLOGY' },
  { id: 'c-3', name: 'Electrical', type: 'FACILITY' },
]
const buildings = [
  {
    id: 'b-1',
    name: 'Headquarters',
    address: '1 Acme Plaza',
    floors: [
      { id: 'f-0', level: 0, seats: [] },
      { id: 'f-2', level: 2, seats: [{ id: 's-1', code: '2F-A14' }, { id: 's-2', code: '2F-A15' }] },
    ],
  },
  { id: 'b-2', name: 'Riverside Annex', address: '25 Wharf Road', floors: [{ id: 'f-9', level: 1, seats: [] }] },
  { id: 'b-3', name: 'Warehouse', address: '3 Dock Lane', floors: [] },
]
const reads = {
  'GET /api/incidents/categories': () => ({ body: { categories } }),
  'GET /api/facilities/buildings': () => ({ body: { buildings } }),
}
const created = ({ body }) => ({ status: 201, body: { incident: { id: 'i-9', ...body } } })

async function renderPage(routes = {}) {
  const calls = mockApi({ ...reads, ...routes })
  renderWithProviders(
    <Routes>
      <Route path="/incidents/new" element={<ReportIncidentPage />} />
      <Route path="/incidents/:id" element={<p>The page of the new incident</p>} />
      <Route path="/incidents" element={<p>The list of incidents</p>} />
    </Routes>,
    { route: '/incidents/new', auth: { user: USERS.employee } },
  )
  const user = userEvent.setup()
  await screen.findByRole('heading', { name: 'Report an incident' })
  return { calls, user }
}

const select = (name) => screen.getByRole('combobox', { name: new RegExp(`^${name}`) })
const writes = (calls) => calls.filter((call) => call.method !== 'GET')

async function choose(user, name, option) {
  await user.click(select(name))
  await user.click(screen.getByRole('option', { name: option }))
}

// Pasted, not typed key by key: it is the same to the form and keeps the tests quick
async function write(user, label, text) {
  await user.click(screen.getByLabelText(label))
  await user.paste(text)
}

async function fillRequired(user) {
  await write(user, /title/i, '  Leaking tap ')
  await write(user, /description/i, ' Drips all night ')
  await choose(user, 'Category', 'Plumbing')
  await choose(user, 'Building', 'Headquarters')
}

describe('ReportIncidentPage', () => {
  it('shows a spinner, then the form; reporting sends every field and opens the new incident', async () => {
    const calls = mockApi({ ...reads, [`POST ${TICKETS}`]: created })
    renderWithProviders(
      <Routes>
        <Route path="/incidents/new" element={<ReportIncidentPage />} />
        <Route path="/incidents/:id" element={<p>The page of the new incident</p>} />
      </Routes>,
      { route: '/incidents/new', auth: { user: USERS.employee } },
    )
    expect(screen.getByRole('progressbar', { name: 'Loading the form' })).toBeInTheDocument()
    const user = userEvent.setup()
    await screen.findByRole('heading', { name: 'Report an incident' })
    expect(screen.getByLabelText(/title/i)).toHaveFocus()
    expect(select('Priority')).toHaveTextContent('Medium')

    await fillRequired(user)
    await choose(user, 'Priority', 'High')
    await choose(user, 'Floor', 'Floor 2')
    await choose(user, 'Seat', '2F-A15')
    await user.click(screen.getByRole('button', { name: 'Report incident' }))

    expect(await screen.findByText('The page of the new incident')).toBeInTheDocument()
    expect(writes(calls)).toEqual([
      {
        method: 'POST',
        path: TICKETS,
        token: undefined,
        body: {
          title: 'Leaking tap',
          description: 'Drips all night',
          category_id: 'c-1',
          priority: 'HIGH',
          building_id: 'b-1',
          floor_id: 'f-2',
          seat_id: 's-2',
        },
      },
    ])
  })

  it('lists the categories under their type', async () => {
    const { user } = await renderPage()
    await user.click(select('Category'))
    expect([...screen.getByRole('listbox').children].map((item) => item.textContent)).toEqual([
      'Facility',
      'Plumbing',
      'Electrical',
      'Technology',
      'Network',
    ])
  })

  it('leaves the floor and the seat out when they are not chosen', async () => {
    const { calls, user } = await renderPage({ [`POST ${TICKETS}`]: created })
    await fillRequired(user)
    await user.click(screen.getByRole('button', { name: 'Report incident' }))

    await screen.findByText('The page of the new incident')
    expect(writes(calls)[0].body).toMatchObject({ priority: 'MEDIUM', floor_id: null, seat_id: null })
  })

  it('offers only the floors of the chosen building and the seats of the chosen floor', async () => {
    const { user } = await renderPage()
    expect(select('Floor')).toHaveAttribute('aria-disabled', 'true')
    expect(select('Seat')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText('Choose a building first')).toBeInTheDocument()
    expect(screen.getByText('Choose a floor first')).toBeInTheDocument()

    await choose(user, 'Building', 'Headquarters')
    await user.click(select('Floor'))
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Not sure', 'Ground floor', 'Floor 2'])
    await user.click(screen.getByRole('option', { name: 'Ground floor' }))
    expect(select('Seat')).toHaveAttribute('aria-disabled', 'true') // the ground floor has no seats

    await choose(user, 'Floor', 'Floor 2')
    await user.click(select('Seat'))
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Not at a seat', '2F-A14', '2F-A15'])
    await user.click(screen.getByRole('option', { name: '2F-A14' }))

    await choose(user, 'Building', 'Warehouse') // a building with no floors
    expect(select('Floor')).toHaveAttribute('aria-disabled', 'true')
  })

  it('choosing another building empties the floor and seat; another floor empties the seat', async () => {
    const { calls, user } = await renderPage({ [`POST ${TICKETS}`]: created })
    await fillRequired(user)
    await choose(user, 'Floor', 'Floor 2')
    await choose(user, 'Seat', '2F-A14')
    await choose(user, 'Floor', 'Ground floor')
    await choose(user, 'Floor', 'Floor 2') // back on the seat's floor: it is not chosen any more
    expect(select('Seat')).not.toHaveTextContent('2F-A14')
    await choose(user, 'Seat', '2F-A14')

    await choose(user, 'Building', 'Riverside Annex')
    expect(select('Floor')).not.toHaveTextContent('Floor 2')
    await user.click(screen.getByRole('button', { name: 'Report incident' }))

    await screen.findByText('The page of the new incident')
    expect(writes(calls)[0].body).toMatchObject({ building_id: 'b-2', floor_id: null, seat_id: null })
  })

  it('checks the form before sending anything, and puts the keyboard on the first problem', async () => {
    const { calls, user } = await renderPage()
    await user.click(screen.getByRole('button', { name: 'Report incident' }))

    expect(screen.getByText('Title is required')).toBeInTheDocument()
    expect(screen.getByText('Description is required')).toBeInTheDocument()
    expect(screen.getByText('Choose a category from the list')).toBeInTheDocument()
    expect(screen.getByText('Choose a building from the list')).toBeInTheDocument()
    expect(screen.getByLabelText(/title/i)).toHaveFocus()
    expect(writes(calls)).toEqual([])

    await write(user, /title/i, 't'.repeat(151))
    await write(user, /description/i, 'd'.repeat(4001))
    await user.click(screen.getByRole('button', { name: 'Report incident' }))
    expect(screen.getByText('Title must be at most 150 characters')).toBeInTheDocument()
    expect(screen.getByText('Description must be at most 4000 characters')).toBeInTheDocument()
    expect(writes(calls)).toEqual([])
  })

  it('shows what the API says about a field under that field, and keeps what was typed', async () => {
    const complaint = { floor_id: 'Choose a floor in this building', priority: 'Priority must be one of: LOW, MEDIUM, HIGH, CRITICAL' }
    const { user } = await renderPage({
      [`POST ${TICKETS}`]: () => apiError(400, 'validation_error', 'Some fields are invalid', complaint),
    })
    await fillRequired(user)
    await user.click(screen.getByRole('button', { name: 'Report incident' }))

    expect(await screen.findByText('Choose a floor in this building')).toBeInTheDocument()
    expect(screen.getByText('Priority must be one of: LOW, MEDIUM, HIGH, CRITICAL')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByLabelText(/title/i)).toHaveValue('  Leaking tap ')
    expect(screen.getByRole('button', { name: 'Report incident' })).toBeEnabled()
  })

  it('shows any other failure above the form', async () => {
    const { user } = await renderPage({
      [`POST ${TICKETS}`]: () => apiError(500, 'internal_error', 'An unexpected error occurred'),
    })
    await fillRequired(user)
    await user.click(screen.getByRole('button', { name: 'Report incident' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('An unexpected error occurred')
    expect(screen.queryByText('The page of the new incident')).not.toBeInTheDocument()
  })

  it('holds the form while the incident is being sent', async () => {
    let finish
    const { calls, user } = await renderPage({ [`POST ${TICKETS}`]: () => new Promise((resolve) => (finish = resolve)) })
    await fillRequired(user)
    await user.type(screen.getByLabelText(/title/i), '{Enter}')

    expect(screen.getByRole('button', { name: 'Report incident' })).toBeDisabled()
    expect(screen.getByLabelText(/title/i)).toBeDisabled()
    expect(select('Building')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('link', { name: 'Cancel' })).toHaveAttribute('aria-disabled', 'true')
    expect(writes(calls)).toHaveLength(1)

    finish({ status: 201, body: { incident: { id: 'i-9' } } })
    expect(await screen.findByText('The page of the new incident')).toBeInTheDocument()
  })

  it('"Cancel" goes back to the list without sending anything', async () => {
    const { calls, user } = await renderPage()
    await user.type(screen.getByLabelText(/title/i), 'Never mind')
    await user.click(screen.getByRole('link', { name: 'Cancel' }))
    expect(screen.getByText('The list of incidents')).toBeInTheDocument()
    expect(writes(calls)).toEqual([])
  })

  it('offers to try again when the form\'s lists cannot be loaded', async () => {
    let working = false
    const { user } = await renderPage({
      'GET /api/facilities/buildings': () =>
        working ? { body: { buildings } } : apiError(500, 'internal_error', 'An unexpected error occurred'),
    })
    expect(screen.getByRole('alert')).toHaveTextContent('An unexpected error occurred')
    expect(screen.queryByLabelText(/title/i)).not.toBeInTheDocument()

    working = true
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByLabelText(/title/i)).toBeInTheDocument()
    await waitFor(() => expect(within(document.body).queryByRole('alert')).not.toBeInTheDocument())
  })
})
