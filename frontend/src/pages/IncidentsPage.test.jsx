// The page against a small fake API: only fetch is faked.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link } from 'react-router-dom'
import { beforeEach, describe, expect, it } from 'vitest'
import IncidentsPage from './IncidentsPage.jsx'
import { USERS, apiError, mockApi, renderWithProviders } from '../test/helpers.jsx'
import { formatDateTime } from '../utils/format.js'

const TICKETS = '/api/incidents/tickets'

const categories = [
  { id: 'c-1', name: 'Plumbing', type: 'FACILITY' },
  { id: 'c-2', name: 'Network', type: 'TECHNOLOGY' },
]
const buildings = [
  { id: 'b-1', name: 'Headquarters', address: '1 Acme Plaza', floors: [] },
  { id: 'b-2', name: 'Riverside Annex', address: '25 Wharf Road', floors: [] },
]
const engineers = [
  { id: 'e-1', full_name: 'Priya Sharma' },
  { id: 'e-2', full_name: 'Marco Rossi' },
]
const leak = {
  id: 'i-1',
  title: 'Leaking tap',
  status: 'IN_PROGRESS',
  priority: 'HIGH',
  category: 'Plumbing',
  building: 'Headquarters',
  floor_level: 2,
  seat: '2F-A14',
  reporter: 'Alice Johnson',
  assignee: 'Priya Sharma',
  assignee_id: 'e-1',
  is_escalated: true,
  escalation_reason: 'Third leak this month',
  blocked_reason: null,
  created_at: '2026-11-18T09:15:00+00:00',
  updated_at: '2026-11-18T10:00:00+00:00',
}
const wifi = {
  ...leak,
  id: 'i-2',
  title: 'Wi-Fi keeps dropping',
  status: 'OPEN',
  priority: 'LOW',
  category: 'Network',
  building: 'Riverside Annex',
  floor_level: null,
  seat: null,
  assignee: null,
  assignee_id: null,
  is_escalated: false,
  escalation_reason: null,
}

// What the fake API answers a list request with; a test replaces it to change the list.
let found
beforeEach(() => {
  found = [leak, wifi]
})

const reads = {
  [`GET ${TICKETS}`]: () => ({ body: { incidents: found } }),
  'GET /api/incidents/categories': () => ({ body: { categories } }),
  'GET /api/facilities/buildings': () => ({ body: { buildings } }),
}
const adminReads = { ...reads, 'GET /api/engineers/profiles': () => ({ body: { profiles: engineers } }) }

async function renderPage({ user: who = USERS.employee, route = '/incidents', routes = reads } = {}) {
  const calls = mockApi(who === USERS.admin && routes === reads ? adminReads : routes)
  renderWithProviders(<IncidentsPage />, { route, auth: { user: who } })
  const user = userEvent.setup()
  await screen.findByRole('heading', { name: 'Incidents' })
  return { calls, user }
}

// The filters each list request carried, in the order they were sent
const asked = (calls) => calls.filter((call) => call.path === TICKETS).map((call) => call.query ?? {})
const filter = (name) => screen.getByRole('combobox', { name: new RegExp(`^${name}`) })

async function choose(user, name, option) {
  await user.click(filter(name))
  await user.click(screen.getByRole('option', { name: option }))
}

describe('IncidentsPage', () => {
  it('shows a spinner, then every incident with what, where, who and when', async () => {
    mockApi(reads)
    renderWithProviders(<IncidentsPage />, { route: '/incidents', auth: { user: USERS.employee } })
    expect(screen.getByRole('progressbar', { name: 'Loading incidents' })).toBeInTheDocument()

    const first = within(await screen.findByRole('link', { name: /Leaking tap/ }))
    expect(first.getByText('In progress')).toBeInTheDocument()
    expect(first.getByText('High priority')).toBeInTheDocument()
    expect(first.getByText('Escalated')).toBeInTheDocument()
    expect(first.getByText('Escalated: Third leak this month')).toBeInTheDocument()
    expect(first.queryByText(/^Blocked:/)).not.toBeInTheDocument()
    expect(first.getByText('Plumbing')).toBeInTheDocument()
    expect(first.getByText('Headquarters, Floor 2, seat 2F-A14')).toBeInTheDocument()
    expect(first.getByText('Assigned to Priya Sharma')).toBeInTheDocument()
    expect(first.getByText(`Reported by Alice Johnson, ${formatDateTime(leak.created_at)}`)).toBeInTheDocument()
    expect(first.getByText(`Updated ${formatDateTime(leak.updated_at)}`)).toBeInTheDocument()

    const second = within(screen.getByRole('link', { name: /Wi-Fi keeps dropping/ }))
    expect(second.getByText('Open')).toBeInTheDocument()
    expect(second.getByText('Low priority')).toBeInTheDocument()
    expect(second.queryByText('Escalated')).not.toBeInTheDocument()
    expect(second.queryByText(/^(Blocked|Escalated):/)).not.toBeInTheDocument()
    expect(second.getByText('Riverside Annex')).toBeInTheDocument()
    expect(second.getByText('Unassigned')).toBeInTheDocument()

    // Newest first, as the API sent them; each row opens its incident
    const rows = within(screen.getByRole('list', { name: 'Incidents' })).getAllByRole('link')
    expect(rows.map((row) => row.getAttribute('href'))).toEqual(['/incidents/i-1', '/incidents/i-2'])
    expect(screen.getByRole('link', { name: 'Report incident' })).toHaveAttribute('href', '/incidents/new')
    expect(screen.queryByText(/No incidents/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Showing the newest/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument()
  })

  it('says when an incident was last updated only once something has happened to it', async () => {
    found = [leak, { ...wifi, updated_at: wifi.created_at }] // nobody has touched the Wi-Fi one yet
    await renderPage()
    const touched = within(await screen.findByRole('link', { name: /Leaking tap/ }))
    expect(touched.getByText(`Updated ${formatDateTime(leak.updated_at)}`)).toBeInTheDocument()
    const untouched = within(screen.getByRole('link', { name: /Wi-Fi keeps dropping/ }))
    expect(untouched.getByText(`Reported by Alice Johnson, ${formatDateTime(wifi.created_at)}`)).toBeInTheDocument()
    expect(untouched.queryByText(/^Updated/)).not.toBeInTheDocument()
  })

  it('says so when there are no incidents, and says it differently when filters hide them', async () => {
    found = []
    const first = await renderPage()
    expect(screen.getByText('No incidents yet.')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Incidents' })).not.toBeInTheDocument()

    await choose(first.user, 'Status', 'Closed')
    expect(await screen.findByText('No incidents match these filters.')).toBeInTheDocument()
    expect(screen.queryByText('No incidents yet.')).not.toBeInTheDocument()
  })

  it('says when the list is cut off at the 200 the API returns', async () => {
    found = Array.from({ length: 200 }, (_, index) => ({ ...wifi, id: `i-${index}` }))
    await renderPage()
    expect(screen.getByText('Showing the newest 200. Narrow the filters to see others.')).toBeInTheDocument()
  })

  it.each([`GET ${TICKETS}`, 'GET /api/incidents/categories'])(
    'offers to try again when %s cannot be answered',
    async (route) => {
      let working = false
      const answer = reads[route]
      const { user } = await renderPage({
        routes: { ...reads, [route]: () => (working ? answer() : apiError(500, 'internal_error', 'An unexpected error occurred')) },
      })
      expect(screen.getByRole('alert')).toHaveTextContent('An unexpected error occurred')
      expect(screen.queryByRole('link', { name: /Leaking tap/ })).not.toBeInTheDocument()

      working = true
      await user.click(screen.getByRole('button', { name: 'Try again' }))
      expect(await screen.findByRole('link', { name: /Leaking tap/ })).toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    },
  )

  it('starts from the filters in the page address: sent to the API and shown in the controls', async () => {
    const route = '/incidents?q=tap&status=IN_PROGRESS&priority=HIGH&category_id=c-1&building_id=b-2&assignee=none&page=7'
    const { calls } = await renderPage({ user: USERS.admin, route })

    expect(asked(calls)).toEqual([
      { q: 'tap', status: 'IN_PROGRESS', priority: 'HIGH', category_id: 'c-1', building_id: 'b-2', assignee: 'none' },
    ])
    expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveValue('tap')
    expect(filter('Status')).toHaveTextContent('In progress')
    expect(filter('Priority')).toHaveTextContent('High')
    expect(filter('Category')).toHaveTextContent('Plumbing')
    expect(filter('Building')).toHaveTextContent('Riverside Annex')
    expect(filter('Assignee')).toHaveTextContent('Unassigned')
  })

  it('shows a choice the address names but the list does not have as "Any"', async () => {
    await renderPage({ route: '/incidents?status=FIXED&category_id=c-gone' })
    expect(filter('Status')).toHaveTextContent('Any')
    expect(filter('Category')).toHaveTextContent('Any')
  })

  it('asks the API again whenever a filter is chosen, combining them, and "Any" switches one off', async () => {
    const { calls, user } = await renderPage()
    await choose(user, 'Status', 'Open')
    await choose(user, 'Priority', 'Critical')
    await choose(user, 'Category', 'Network')
    await choose(user, 'Building', 'Headquarters')
    await choose(user, 'Status', 'Any')

    await waitFor(() => expect(asked(calls)).toHaveLength(6))
    expect(asked(calls)).toEqual([
      {},
      { status: 'OPEN' },
      { status: 'OPEN', priority: 'CRITICAL' },
      { status: 'OPEN', priority: 'CRITICAL', category_id: 'c-2' },
      { status: 'OPEN', priority: 'CRITICAL', category_id: 'c-2', building_id: 'b-1' },
      { priority: 'CRITICAL', category_id: 'c-2', building_id: 'b-1' },
    ])
    expect(filter('Status')).toHaveTextContent('Any')
    expect(filter('Building')).toHaveTextContent('Headquarters')
  })

  it('shows what the API found for the filters', async () => {
    const { user } = await renderPage()
    found = [wifi]
    await choose(user, 'Status', 'Open')
    await waitFor(() => expect(screen.queryByRole('link', { name: /Leaking tap/ })).not.toBeInTheDocument())
    expect(screen.getByRole('link', { name: /Wi-Fi keeps dropping/ })).toBeInTheDocument()
  })

  it('searches once the typing pauses, and at once on Enter, without asking twice', async () => {
    const { calls, user } = await renderPage()
    const box = screen.getByRole('searchbox', { name: 'Search' })

    await user.type(box, '  leaking tap ')
    expect(asked(calls)).toEqual([{}]) // still typing: nothing sent yet
    await waitFor(() => expect(asked(calls)).toEqual([{}, { q: 'leaking tap' }]))

    await user.clear(box)
    await user.type(box, 'wifi{Enter}')
    expect(asked(calls).at(-1)).toEqual({ q: 'wifi' })
    await new Promise((resolve) => setTimeout(resolve, 600)) // the pause passes: no second request for the same words
    expect(asked(calls)).toEqual([{}, { q: 'leaking tap' }, { q: 'wifi' }])
    expect(box).toHaveValue('wifi')
  })

  it('"Clear filters" switches everything off, the search box included', async () => {
    const { calls, user } = await renderPage({ route: '/incidents?q=tap&status=OPEN' })
    await user.click(screen.getByRole('button', { name: 'Clear filters' }))

    await waitFor(() => expect(asked(calls)).toEqual([{ q: 'tap', status: 'OPEN' }, {}]))
    expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveValue('')
    expect(filter('Status')).toHaveTextContent('Any')
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument()
    await new Promise((resolve) => setTimeout(resolve, 600)) // the emptied box does not search again
    expect(asked(calls)).toHaveLength(2)
  })

  it('says under a blocked incident what is blocking it', async () => {
    found = [{ ...wifi, status: 'BLOCKED', blocked_reason: 'Waiting for the provider' }]
    await renderPage()
    const row = within(screen.getByRole('link', { name: /Wi-Fi keeps dropping/ }))
    expect(row.getByText('Blocked: Waiting for the provider')).toBeInTheDocument()
  })

  it.each([USERS.employee, USERS.engineer, USERS.admin])(
    'lets $role switch to the escalated incidents only, kept in the address like the other filters',
    async (who) => {
      const { calls, user } = await renderPage({ user: who })
      const escalated = screen.getByRole('switch', { name: 'Escalated only' })
      expect(escalated).not.toBeChecked()
      await user.click(escalated)
      await waitFor(() => expect(asked(calls)).toEqual([{}, { escalated: 'true' }]))
      expect(escalated).toBeChecked()

      await user.click(screen.getByRole('button', { name: 'Clear filters' }))
      await waitFor(() => expect(asked(calls)).toEqual([{}, { escalated: 'true' }, {}]))
      expect(screen.getByRole('switch', { name: 'Escalated only' })).not.toBeChecked()
    },
  )

  it('starts with "Escalated only" on when the address says so, as the dashboard link does', async () => {
    const { calls } = await renderPage({ route: '/incidents?escalated=true' })
    expect(asked(calls)).toEqual([{ escalated: 'true' }])
    expect(screen.getByRole('switch', { name: 'Escalated only' })).toBeChecked()
  })

  it('lets an admin filter by any engineer, by nobody, or by anyone', async () => {
    const { calls, user } = await renderPage({ user: USERS.admin })
    await user.click(filter('Assignee'))
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Anyone',
      'Unassigned',
      'Priya Sharma',
      'Marco Rossi',
    ])
    await user.click(screen.getByRole('option', { name: 'Marco Rossi' }))
    await choose(user, 'Assignee', 'Unassigned')
    await choose(user, 'Assignee', 'Anyone')

    await waitFor(() => expect(asked(calls)).toEqual([{}, { assignee: 'e-2' }, { assignee: 'none' }, {}]))
    expect(screen.queryByRole('switch', { name: 'Assigned to me' })).not.toBeInTheDocument()
  })

  it('lets an engineer switch to the incidents assigned to them', async () => {
    const { calls, user } = await renderPage({ user: USERS.engineer })
    const mine = screen.getByRole('switch', { name: 'Assigned to me' })
    expect(mine).not.toBeChecked()
    await user.click(mine)
    await waitFor(() => expect(asked(calls)).toEqual([{}, { assignee: 'me' }]))
    expect(mine).toBeChecked()

    await user.click(mine)
    await waitFor(() => expect(asked(calls)).toHaveLength(3))
    expect(asked(calls).at(-1)).toEqual({})
    expect(screen.queryByRole('combobox', { name: /^Assignee/ })).not.toBeInTheDocument()
  })

  it('offers an employee no assignee filter, and never asks for the engineers', async () => {
    const { calls } = await renderPage() // the fake API has no engineers route: asking would fail the test
    expect(screen.queryByRole('combobox', { name: /^Assignee/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Assigned to me' })).not.toBeInTheDocument()
    expect(calls.map((call) => call.path).sort()).toEqual(['/api/facilities/buildings', '/api/incidents/categories', TICKETS])
  })

  it('leaves a refused address behind when the menu link is followed', async () => {
    mockApi({
      ...reads,
      [`GET ${TICKETS}`]: ({ query }) =>
        query ? apiError(400, 'validation_error', 'Some fields are invalid') : { body: { incidents: found } },
    })
    renderWithProviders(
      <>
        <Link to="/incidents">Menu</Link>
        <IncidentsPage />
      </>,
      { route: '/incidents?status=open', auth: { user: USERS.employee } },
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('Some fields are invalid')

    await userEvent.setup().click(screen.getByRole('link', { name: 'Menu' }))
    expect(await screen.findByRole('link', { name: /Leaking tap/ })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
