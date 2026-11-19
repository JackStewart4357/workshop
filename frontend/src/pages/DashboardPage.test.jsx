// Each role's dashboard against a small fake incidents API: only fetch is faked.
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import DashboardPage from './DashboardPage.jsx'
import { USERS, apiError, mockApi, renderWithProviders } from '../test/helpers.jsx'

const API = '/api/incidents'

// What the fake API answers; a test changes these before rendering.
let summary, incidents
beforeEach(() => {
  summary = {
    total: 12,
    by_status: { OPEN: 3, IN_PROGRESS: 4, BLOCKED: 1, RESOLVED: 2, CLOSED: 0 },
    by_priority: { LOW: 2, MEDIUM: 6, HIGH: 3, CRITICAL: 1 },
    unassigned_open: 2,
    escalated_open: 0,
    by_assignee: [
      { assignee_id: 'e-3', assignee: 'Lena Fischer', is_available: false, max_open_tickets: 3, open: 4 },
      { assignee_id: 'e-2', assignee: 'Marco Rossi', is_available: true, max_open_tickets: 4, open: 4 },
      { assignee_id: 'e-1', assignee: 'Priya Sharma', is_available: true, max_open_tickets: 5, open: 2 },
    ],
    by_category: [
      { category_id: 'c-1', category: 'Electrical', type: 'FACILITY', count: 6 },
      { category_id: 'c-2', category: 'Network', type: 'TECHNOLOGY', count: 4 },
      { category_id: 'c-3', category: 'Plumbing', type: 'FACILITY', count: 2 },
    ],
    by_location: {
      buildings: [
        { building_id: 'b-1', building: 'Headquarters', count: 9 },
        { building_id: 'b-2', building: 'Riverside Annex', count: 3 },
      ],
      floors: [
        { building: 'Headquarters', floor_level: 2, count: 5 },
        { building: 'Headquarters', floor_level: 0, count: 3 },
      ],
      seats: [{ building: 'Headquarters', floor_level: 2, seat: '2F-A14', count: 4 }],
    },
    average_hours: { to_acknowledge: 1.5, to_assign: 3, to_resolve: null },
  }
  incidents = []
})

const incident = (id, title, status, priority, day) => ({
  id,
  title,
  status,
  priority,
  created_at: `2026-11-${day}T12:00:00+00:00`,
})

async function renderDashboard(who, routes = {}) {
  const calls = mockApi({
    [`GET ${API}/summary`]: () => ({ body: summary }),
    [`GET ${API}/tickets`]: () => ({ body: { incidents } }),
    ...routes,
  })
  renderWithProviders(<DashboardPage />, { auth: { user: who } })
  expect(screen.getByRole('progressbar', { name: 'Loading your dashboard' })).toBeInTheDocument()
  await screen.findAllByRole('link')
  return calls
}

const section = (name) => within(screen.getByRole('region', { name }))
const href = (name) => screen.getByRole('link', { name }).getAttribute('href')
const titles = (name) =>
  section(name)
    .getAllByRole('listitem')
    .map((row) => within(row).getByRole('link').textContent)

describe('DashboardPage', () => {
  it.each([
    [USERS.employee, /report facility and workplace technology issues/i],
    [USERS.engineer, /incidents assigned to you/i],
    [USERS.admin, /oversee every incident/i],
  ])('welcomes $full_name and says what the page is for', async (who, purpose) => {
    await renderDashboard(who)
    expect(screen.getByRole('heading', { level: 1, name: `Welcome, ${who.full_name}` })).toBeInTheDocument()
    expect(screen.getByText(purpose)).toBeInTheDocument()
  })

  describe('for a facility admin', () => {
    it('counts every incident by status, each count a link to that list', async () => {
      const calls = await renderDashboard(USERS.admin)
      expect(href('All incidents 12')).toBe('/incidents')
      expect(href('Open 3')).toBe('/incidents?status=OPEN')
      expect(href('In progress 4')).toBe('/incidents?status=IN_PROGRESS')
      expect(href('Blocked 1')).toBe('/incidents?status=BLOCKED')
      expect(href('Resolved 2')).toBe('/incidents?status=RESOLVED')
      expect(href('Closed 0')).toBe('/incidents?status=CLOSED')
      expect(href('Unassigned 2 open, no engineer yet')).toBe('/incidents?assignee=none')
      // Escalated has no list of its own to open
      expect(screen.getByText('Escalated').parentElement).toHaveTextContent('Escalated0still open')
      expect(screen.queryByRole('link', { name: /escalated/i })).not.toBeInTheDocument()

      expect(calls.map((call) => call.path)).toEqual([`${API}/summary`]) // an admin's page needs no list
      expect(screen.queryByRole('link', { name: 'Report incident' })).not.toBeInTheDocument()
    })

    it('shows incidents by priority, most urgent first, as bars on one scale with their numbers', async () => {
      await renderDashboard(USERS.admin)
      const priorities = section('Incidents by priority')
      expect(priorities.getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
        ['Critical', '/incidents?priority=CRITICAL'],
        ['High', '/incidents?priority=HIGH'],
        ['Medium', '/incidents?priority=MEDIUM'],
        ['Low', '/incidents?priority=LOW'],
      ])
      const row = (priority) => priorities.getByRole('link', { name: priority }).parentElement.parentElement
      expect(row('Critical')).toHaveTextContent(/^Critical1$/)
      expect(row('Medium')).toHaveTextContent(/^Medium6$/)
      // The longest bar fills the row and the others are drawn against it
      expect(getComputedStyle(priorities.getByTestId('bar-MEDIUM')).flexBasis).toBe('100%')
      expect(getComputedStyle(priorities.getByTestId('bar-HIGH')).flexBasis).toBe('50%')
      expect(parseFloat(getComputedStyle(priorities.getByTestId('bar-CRITICAL')).flexBasis)).toBeCloseTo(16.67, 1)
    })

    it('tells the share of each priority on hover', async () => {
      await renderDashboard(USERS.admin)
      await userEvent.setup().hover(section('Incidents by priority').getByText('6'))
      expect(await screen.findByRole('tooltip')).toHaveTextContent('6 of 12 (50%)')
    })

    it('shows how work is spread across the engineers and who is unavailable', async () => {
      await renderDashboard(USERS.admin)
      const work = section('Work across engineers')
      expect(work.getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
        ['Lena Fischer', '/incidents?assignee=e-3'],
        ['Marco Rossi', '/incidents?assignee=e-2'],
        ['Priya Sharma', '/incidents?assignee=e-1'],
      ])
      const row = (name) => within(work.getByRole('link', { name }).parentElement)
      const bar = (name) => work.getByRole('progressbar', { name: `Workload of ${name}` })

      // Over her maximum: the bar stops at full, and the words say so as well as the colour
      expect(row('Lena Fischer').getByText('4 of 3 open (at capacity)')).toBeInTheDocument()
      expect(row('Lena Fischer').getByText('Unavailable')).toBeInTheDocument()
      expect(bar('Lena Fischer')).toHaveAttribute('aria-valuenow', '100')
      expect(bar('Lena Fischer')).toHaveClass('MuiLinearProgress-colorWarning')

      expect(row('Marco Rossi').getByText('4 of 4 open (at capacity)')).toBeInTheDocument()
      expect(bar('Marco Rossi')).toHaveClass('MuiLinearProgress-colorWarning')

      expect(row('Priya Sharma').getByText('2 of 5 open')).toBeInTheDocument()
      expect(row('Priya Sharma').queryByText('Unavailable')).not.toBeInTheDocument()
      expect(bar('Priya Sharma')).toHaveAttribute('aria-valuenow', '40')
      expect(bar('Priya Sharma')).toHaveClass('MuiLinearProgress-colorPrimary')
      expect(work.queryByText('There are no engineers yet.')).not.toBeInTheDocument()
    })

    it('ranks the categories, most common first, each marked facility or technology and linked to its list', async () => {
      await renderDashboard(USERS.admin)
      const rows = section('Most common categories').getAllByRole('listitem')
      expect(rows.map((row) => row.textContent)).toEqual(['Electrical · Facility6', 'Network · Technology4', 'Plumbing · Facility2'])
      expect(href('Network')).toBe('/incidents?category_id=c-2')
    })

    it('shows the buildings, floors and seats where incidents recur most', async () => {
      await renderDashboard(USERS.admin)
      const places = (name) =>
        within(section('Where incidents recur').getByRole('group', { name }))
          .getAllByRole('listitem')
          .map((row) => row.textContent)
      expect(places('Buildings')).toEqual(['Headquarters9', 'Riverside Annex3'])
      expect(places('Floors')).toEqual(['Headquarters, Floor 25', 'Headquarters, Ground floor3'])
      expect(places('Seats')).toEqual(['Headquarters, Floor 2, seat 2F-A144'])
      expect(href('Riverside Annex')).toBe('/incidents?building_id=b-2') // only buildings can be filtered on
      expect(within(section('Where incidents recur').getByRole('group', { name: 'Seats' })).queryByRole('link')).toBeNull()
    })

    it('shows how quickly incidents are acknowledged, assigned and resolved, or that there is no data yet', async () => {
      await renderDashboard(USERS.admin)
      const times = section('Response times')
      expect(times.getByText('Acknowledged in').parentElement).toHaveTextContent('Acknowledged in1.5 hon average')
      expect(times.getByText('Assigned in').parentElement).toHaveTextContent('Assigned in3 hon average')
      expect(times.getByText('Resolved in').parentElement).toHaveTextContent('Resolved in–no data yet')
    })

    it('copes with an empty system: zeros, no bars and no engineers', async () => {
      summary = {
        total: 0,
        by_status: { OPEN: 0, IN_PROGRESS: 0, BLOCKED: 0, RESOLVED: 0, CLOSED: 0 },
        by_priority: { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 },
        unassigned_open: 0,
        escalated_open: 0,
        by_assignee: [],
        by_category: [],
        by_location: { buildings: [], floors: [], seats: [] },
        average_hours: { to_acknowledge: null, to_assign: null, to_resolve: null },
      }
      await renderDashboard(USERS.admin)
      expect(section('Most common categories').getByText('No incidents have been reported yet.')).toBeInTheDocument()
      expect(section('Where incidents recur').getByText('No incident names one of the seats yet.')).toBeInTheDocument()
      expect(href('All incidents 0')).toBe('/incidents')
      expect(getComputedStyle(screen.getByTestId('bar-CRITICAL')).flexBasis).toBe('0%')
      expect(section('Work across engineers').getByText('There are no engineers yet.')).toBeInTheDocument()
      expect(section('Response times').getAllByText('no data yet')).toHaveLength(3)

      await userEvent.setup().hover(screen.getByTestId('bar-CRITICAL').parentElement)
      expect(await screen.findByRole('tooltip')).toHaveTextContent('0 of 0 (0%)')
    })
  })

  describe('for an employee', () => {
    it('counts their incidents by status and offers to report a new one', async () => {
      const calls = await renderDashboard(USERS.employee)
      expect(href('Open 3')).toBe('/incidents?status=OPEN')
      expect(href('In progress 4')).toBe('/incidents?status=IN_PROGRESS')
      expect(href('Blocked 1')).toBe('/incidents?status=BLOCKED')
      expect(href('Resolved 2')).toBe('/incidents?status=RESOLVED')
      expect(href('Closed 0')).toBe('/incidents?status=CLOSED')
      expect(href('Report incident')).toBe('/incidents/new')

      // Nothing that is the admin's business
      expect(screen.queryByText(/all incidents|unassigned|escalated/i)).not.toBeInTheDocument()
      expect(screen.queryByRole('region', { name: /priority|engineers|response/i })).not.toBeInTheDocument()
      expect(calls.map((call) => [call.path, call.query])).toEqual([
        [`${API}/summary`, undefined],
        [`${API}/tickets`, undefined],
      ])
    })

    it('lists their five latest incidents, each a link to its page', async () => {
      incidents = [
        incident('i-6', 'Projector flickers', 'OPEN', 'LOW', 19),
        incident('i-5', 'Door will not lock', 'IN_PROGRESS', 'HIGH', 18),
        incident('i-4', 'No heating', 'BLOCKED', 'HIGH', 17),
        incident('i-3', 'Leaking tap', 'RESOLVED', 'MEDIUM', 16),
        incident('i-2', 'Broken chair', 'CLOSED', 'LOW', 15),
        incident('i-1', 'Old one', 'CLOSED', 'LOW', 14),
      ]
      await renderDashboard(USERS.employee)
      expect(titles('Your latest incidents')).toEqual([
        'Projector flickers',
        'Door will not lock',
        'No heating',
        'Leaking tap',
        'Broken chair',
      ])
      expect(href('Door will not lock')).toBe('/incidents/i-5')
      const row = within(screen.getByRole('link', { name: 'Door will not lock' }).parentElement)
      expect(row.getByText('In progress')).toBeInTheDocument()
      expect(row.getByText('18 Nov 2026')).toBeInTheDocument()
      expect(row.queryByText(/priority/i)).not.toBeInTheDocument()
      expect(screen.queryByText(/you have not reported anything yet/i)).not.toBeInTheDocument()
    })

    it('invites someone who has reported nothing to report their first incident', async () => {
      await renderDashboard(USERS.employee)
      expect(section('Your latest incidents').getByText(/you have not reported anything yet/i)).toBeInTheDocument()
      expect(section('Your latest incidents').queryByRole('listitem')).not.toBeInTheDocument()
    })
  })

  describe('for an engineer', () => {
    beforeEach(() => {
      incidents = [
        incident('i-9', 'Printer jam', 'OPEN', 'LOW', 19),
        incident('i-8', 'Server room hot', 'IN_PROGRESS', 'CRITICAL', 18),
        incident('i-7', 'Wi-Fi drops', 'BLOCKED', 'HIGH', 17),
        incident('i-6', 'Lift stuck', 'IN_PROGRESS', 'HIGH', 12),
        incident('i-5', 'Light out', 'OPEN', 'LOW', 11),
        incident('i-4', 'Tap fixed', 'RESOLVED', 'CRITICAL', 10),
        incident('i-3', 'Old door', 'CLOSED', 'HIGH', 9),
      ]
    })

    it('counts the work assigned to them, taken from their own list', async () => {
      const calls = await renderDashboard(USERS.engineer)
      expect(href('In progress 2')).toBe('/incidents?assignee=me&status=IN_PROGRESS')
      expect(href('Blocked 1')).toBe('/incidents?assignee=me&status=BLOCKED')
      expect(href('Open 2 assigned, not started')).toBe('/incidents?assignee=me&status=OPEN')
      expect(href('Resolved 1 waiting for confirmation')).toBe('/incidents?assignee=me&status=RESOLVED')
      expect(screen.queryByRole('link', { name: /closed/i })).not.toBeInTheDocument()
      expect(screen.queryByRole('link', { name: 'Report incident' })).not.toBeInTheDocument()

      // Only the incidents assigned to them are asked for; the summary would also count ones they reported
      expect(calls.map((call) => [call.path, call.query])).toEqual([[`${API}/tickets`, { assignee: 'me' }]])
    })

    it('shows their open work by priority, leaving out what is resolved or closed', async () => {
      await renderDashboard(USERS.engineer)
      const priorities = section('Your open work by priority')
      const row = (priority) => priorities.getByText(priority).parentElement
      expect(row('Critical')).toHaveTextContent(/^Critical1$/) // the resolved critical one is not counted
      expect(row('High')).toHaveTextContent(/^High2$/) // nor the closed high one
      expect(row('Medium')).toHaveTextContent(/^Medium0$/)
      expect(row('Low')).toHaveTextContent(/^Low2$/)
      expect(priorities.queryByRole('link')).not.toBeInTheDocument()
    })

    it('queues their open incidents most urgent first, then longest waiting', async () => {
      await renderDashboard(USERS.engineer)
      expect(titles('Your queue')).toEqual(['Server room hot', 'Lift stuck', 'Wi-Fi drops', 'Light out', 'Printer jam'])
      expect(href('Lift stuck')).toBe('/incidents/i-6')
      const row = within(screen.getByRole('link', { name: 'Lift stuck' }).parentElement)
      expect(row.getByText('High priority')).toBeInTheDocument()
      expect(row.getByText('In progress')).toBeInTheDocument()
      expect(row.getByText('12 Nov 2026')).toBeInTheDocument()
    })

    it('shows at most eight incidents in the queue', async () => {
      incidents = Array.from({ length: 10 }, (_, n) => incident(`i-${n}`, `Incident ${n}`, 'OPEN', 'MEDIUM', 10 + n))
      await renderDashboard(USERS.engineer)
      expect(titles('Your queue')).toEqual(Array.from({ length: 8 }, (_, n) => `Incident ${n}`))
      expect(href('Open 10 assigned, not started')).toBe('/incidents?assignee=me&status=OPEN') // the count is not cut
    })

    it('says so when nothing is waiting for them', async () => {
      incidents = [incident('i-4', 'Tap fixed', 'RESOLVED', 'CRITICAL', 10)]
      await renderDashboard(USERS.engineer)
      expect(section('Your queue').getByText('Nothing is waiting for you.')).toBeInTheDocument()
      expect(section('Your queue').queryByRole('listitem')).not.toBeInTheDocument()
      expect(href('Resolved 1 waiting for confirmation')).toBe('/incidents?assignee=me&status=RESOLVED')
    })
  })

  it('keeps the welcome and offers to try again when the figures cannot be loaded', async () => {
    let fail = true
    mockApi({
      [`GET ${API}/summary`]: () => (fail ? apiError(500, 'internal_error', 'An unexpected error occurred') : { body: summary }),
    })
    renderWithProviders(<DashboardPage />, { auth: { user: USERS.admin } })
    expect(await screen.findByRole('alert')).toHaveTextContent('An unexpected error occurred')
    expect(screen.getByRole('heading', { name: 'Welcome, Facility Admin' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /all incidents/i })).not.toBeInTheDocument()

    fail = false
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('link', { name: 'All incidents 12' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
