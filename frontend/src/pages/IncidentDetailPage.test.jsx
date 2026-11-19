// The page against a small fake API that remembers what it is told: only fetch is faked.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it } from 'vitest'
import IncidentDetailPage from './IncidentDetailPage.jsx'
import { USERS, apiError, mockApi, renderWithProviders } from '../test/helpers.jsx'
import { formatDateTime } from '../utils/format.js'

const TICKET = '/api/incidents/tickets/i-1'
const FEEDBACK = '/api/feedback/incidents/i-1'
const LATER = '2026-11-19T08:00:00+00:00'

const engineers = [
  { id: 'e-1', full_name: 'Priya Sharma', is_active: true, is_available: true, open_tickets: 2, max_open_tickets: 5 },
  { id: 'e-2', full_name: 'Marco Rossi', is_active: true, is_available: false, open_tickets: 4, max_open_tickets: 4 },
  { id: 'e-3', full_name: 'Lena Fischer', is_active: false, is_available: true, open_tickets: 0, max_open_tickets: 3 },
]

// What the fake API holds. Handlers change it, and the page's next GET shows the result.
let incident, feedback
beforeEach(() => {
  feedback = { given: false, can_give: true }
  incident = {
    id: 'i-1',
    title: 'Leaking tap',
    description: 'Drips all night.\nThe floor is wet.',
    status: 'IN_PROGRESS',
    priority: 'HIGH',
    category: 'Plumbing',
    category_id: 'c-1',
    building: 'Headquarters',
    building_id: 'b-1',
    floor_level: 2,
    floor_id: 'f-2',
    seat: '2F-A14',
    seat_id: 's-1',
    reporter: 'Alice Johnson',
    reporter_id: USERS.employee.id,
    assignee: 'Priya Sharma',
    assignee_id: 'e-1',
    is_escalated: false,
    escalation_reason: null,
    escalated_at: null,
    escalated_by: null,
    can_escalate: false,
    blocked_reason: null,
    created_at: '2026-11-18T09:15:00+00:00',
    updated_at: '2026-11-18T11:30:00+00:00',
    acknowledged_at: '2026-11-18T10:00:00+00:00',
    assigned_at: '2026-11-18T10:00:00+00:00',
    resolved_at: null,
    closed_at: null,
    notes: [
      { id: 'n-1', body: 'It is the cold tap.', is_internal: false, author: 'Alice Johnson', author_role: 'EMPLOYEE', created_at: '2026-11-18T09:20:00+00:00' },
      { id: 'n-2', body: 'Washer ordered.', is_internal: true, author: 'Priya Sharma', author_role: 'ENGINEER', created_at: '2026-11-18T11:30:00+00:00' },
    ],
    history: [
      { from_status: null, to_status: 'OPEN', changed_by: 'Alice Johnson', reason: null, changed_at: '2026-11-18T09:15:00+00:00' },
      { from_status: 'OPEN', to_status: 'IN_PROGRESS', changed_by: 'Priya Sharma', reason: null, changed_at: '2026-11-18T10:30:00+00:00' },
    ],
    next_statuses: ['BLOCKED', 'RESOLVED'],
    is_staff: true,
  }
})

// The fake API, answering as the real one does
const api = {
  [`GET ${TICKET}`]: () => (incident ? { body: { incident } } : apiError(404, 'not_found', 'Incident not found')),
  'GET /api/engineers/profiles': () => ({ body: { profiles: engineers } }),
  [`GET ${FEEDBACK}`]: () => ({ body: feedback }),
  [`POST ${TICKET}/status`]: ({ body }) => {
    const step = { from_status: incident.status, to_status: body.status, changed_by: 'Priya Sharma', reason: body.reason ?? null, changed_at: LATER }
    incident = {
      ...incident,
      status: body.status,
      blocked_reason: body.status === 'BLOCKED' ? body.reason : null,
      history: [...incident.history, step],
      next_statuses: [],
      updated_at: LATER,
    }
    return { body: { incident } }
  },
  [`POST ${TICKET}/escalate`]: ({ body }) => {
    incident = {
      ...incident,
      is_escalated: true,
      escalation_reason: body.reason,
      escalated_at: LATER,
      escalated_by: 'Priya Sharma',
      can_escalate: false,
      updated_at: LATER,
    }
    return { body: { incident } }
  },
  [`PATCH ${TICKET}`]: ({ body }) => {
    const assignee = engineers.find((engineer) => engineer.id === body.assignee_id)?.full_name ?? null
    incident = { ...incident, ...body, assignee, updated_at: LATER }
    return { body: { incident } }
  },
  [`POST ${TICKET}/notes`]: ({ body }) => {
    const note = { id: 'n-9', ...body, author: 'Priya Sharma', author_role: 'ENGINEER', created_at: LATER }
    incident = { ...incident, notes: [...incident.notes, note], updated_at: LATER }
    return { status: 201, body: { note } }
  },
  [`DELETE ${TICKET}`]: () => {
    incident = null
    return { status: 204 }
  },
  [`POST ${FEEDBACK}`]: () => {
    feedback = { given: true, can_give: false }
    return { status: 201, body: feedback }
  },
}

function mount(who) {
  renderWithProviders(
    <Routes>
      <Route path="/incidents/:id" element={<IncidentDetailPage />} />
      <Route path="/incidents" element={<p>The list of incidents</p>} />
    </Routes>,
    { route: '/incidents/i-1', auth: { user: who } },
  )
}

async function renderPage({ user: who = USERS.engineer, routes = {} } = {}) {
  const calls = mockApi({ ...api, ...routes })
  mount(who)
  const user = userEvent.setup()
  await waitFor(() => expect(screen.queryByRole('progressbar', { name: 'Loading the incident' })).not.toBeInTheDocument())
  return { calls, user }
}

const writes = (calls) => calls.filter((call) => call.method !== 'GET')
const section = (name) => within(screen.getByRole('region', { name }))
const select = (name) => screen.getByRole('combobox', { name: new RegExp(`^${name}`) })
const failed = () => apiError(500, 'internal_error', 'An unexpected error occurred')

// Pasted, not typed key by key: it is the same to the form and keeps the tests quick
async function write(user, field, text) {
  await user.click(field)
  await user.paste(text)
}

describe('IncidentDetailPage', () => {
  it('shows a spinner, then the incident: what, where, who, when and its description', async () => {
    mockApi(api)
    mount(USERS.engineer)
    expect(screen.getByRole('progressbar', { name: 'Loading the incident' })).toBeInTheDocument()

    expect(await screen.findByRole('heading', { name: 'Leaking tap', level: 1 })).toBeInTheDocument()
    expect(screen.getByText('High priority')).toBeInTheDocument()
    expect(screen.queryByText('Escalated')).not.toBeInTheDocument()
    expect(screen.getByText(/Drips all night\.\s+The floor is wet\./)).toBeInTheDocument()
    const facts = [...document.querySelectorAll('dl > div')].map((fact) => [
      fact.querySelector('dt').textContent,
      fact.querySelector('dd').textContent,
    ])
    expect(facts).toEqual([
      ['Category', 'Plumbing'],
      ['Location', 'Headquarters, Floor 2, seat 2F-A14'],
      ['Reported by', 'Alice Johnson'],
      ['Assigned to', 'Priya Sharma'],
      ['Reported', formatDateTime(incident.created_at)],
      ['Last updated', formatDateTime(incident.updated_at)],
    ])
    expect(screen.getByRole('link', { name: 'All incidents' })).toHaveAttribute('href', '/incidents')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('marks an escalated incident and one nobody is assigned to', async () => {
    incident = { ...incident, is_escalated: true, assignee: null, assignee_id: null }
    await renderPage()
    expect(screen.getByText('Escalated')).toBeInTheDocument()
    expect(screen.getByText('Unassigned')).toBeInTheDocument()
  })

  it('says who escalated an incident, when and why, and offers no second escalation', async () => {
    const escalated = { is_escalated: true, escalation_reason: 'Third leak this month', escalated_at: LATER, can_escalate: false }
    incident = { ...incident, ...escalated, escalated_by: 'Alice Johnson' }
    await renderPage()
    expect(screen.getByRole('note')).toHaveTextContent(
      `Escalated by Alice Johnson on ${formatDateTime(LATER)}: Third leak this month`,
    )
    expect(screen.queryByRole('button', { name: 'Escalate' })).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument() // a standing note, not an error
  })

  it('still says when and why if the person who escalated it is no longer known', async () => {
    incident = { ...incident, is_escalated: true, escalation_reason: 'No reply', escalated_at: LATER, escalated_by: null }
    await renderPage()
    expect(screen.getByRole('note')).toHaveTextContent(`Escalated on ${formatDateTime(LATER)}: No reply`)
  })

  it('escalates an incident only with a reason, then shows it as escalated', async () => {
    incident = { ...incident, can_escalate: true }
    const { calls, user } = await renderPage({ user: USERS.employee })
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Escalate' }))
    const dialog = within(screen.getByRole('dialog', { name: 'Escalate?' }))

    await user.click(dialog.getByRole('button', { name: 'Escalate' }))
    expect(dialog.getByText('Say why it needs escalating')).toBeInTheDocument()
    await write(user, dialog.getByLabelText(/why does this need escalating/i), 'x'.repeat(501))
    await user.click(dialog.getByRole('button', { name: 'Escalate' }))
    expect(dialog.getByText('Reason must be at most 500 characters')).toBeInTheDocument()
    expect(writes(calls)).toEqual([])

    await user.clear(dialog.getByLabelText(/why does this need escalating/i))
    await write(user, dialog.getByLabelText(/why does this need escalating/i), '  Nobody has replied in a week ')
    await user.click(dialog.getByRole('button', { name: 'Escalate' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(writes(calls)).toEqual([
      { method: 'POST', path: `${TICKET}/escalate`, token: undefined, body: { reason: 'Nobody has replied in a week' } },
    ])
    expect(screen.getByRole('note')).toHaveTextContent(
      `Escalated by Priya Sharma on ${formatDateTime(LATER)}: Nobody has replied in a week`,
    )
    expect(screen.getByText('Escalated')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Escalate' })).not.toBeInTheDocument()
  })

  it('shows what the API says about the escalation reason under the field', async () => {
    incident = { ...incident, can_escalate: true }
    const { user } = await renderPage({
      routes: {
        [`POST ${TICKET}/escalate`]: () =>
          apiError(400, 'validation_error', 'Some fields are invalid', { reason: 'Say why it needs escalating' }),
      },
    })
    await user.click(screen.getByRole('button', { name: 'Escalate' }))
    const dialog = within(screen.getByRole('dialog'))
    await write(user, dialog.getByLabelText(/why does this need escalating/i), 'Urgent')
    await user.click(dialog.getByRole('button', { name: 'Escalate' }))

    expect(await dialog.findByText('Say why it needs escalating')).toBeInTheDocument()
    expect(dialog.getByLabelText(/why does this need escalating/i)).toHaveValue('Urgent')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('when the incident was escalated or finished in the meantime, says so and shows where it stands now', async () => {
    incident = { ...incident, can_escalate: true }
    const { calls, user } = await renderPage({
      routes: {
        [`POST ${TICKET}/escalate`]: () => {
          // what someone else did a moment ago
          incident = { ...incident, is_escalated: true, escalation_reason: 'Theirs', escalated_at: LATER, can_escalate: false }
          return apiError(409, 'conflict', 'This incident is already escalated')
        },
      },
    })
    await user.click(screen.getByRole('button', { name: 'Escalate' }))
    const dialog = within(screen.getByRole('dialog'))
    await write(user, dialog.getByLabelText(/why does this need escalating/i), 'Mine')
    await user.click(dialog.getByRole('button', { name: 'Escalate' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('This incident is already escalated')
    expect(await screen.findByRole('note')).toHaveTextContent(/: Theirs$/)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Escalate' })).not.toBeInTheDocument()
    expect(calls.filter((call) => call.method === 'GET' && call.path === TICKET)).toHaveLength(2)
  })

  it('draws the workflow with the incident\'s place on it, and lists every move made so far', async () => {
    await renderPage()
    const progress = section('Progress')
    const steps = progress.getByRole('group', { name: 'Where this incident is in the workflow' })
    expect(steps.querySelector('[aria-current="step"]')).toHaveTextContent('In progressCurrent step')

    const moves = within(progress.getByRole('list')).getAllByRole('listitem')
    expect(moves.map((move) => move.textContent)).toEqual([
      `ReportedAlice Johnson, ${formatDateTime('2026-11-18T09:15:00+00:00')}`,
      `Open → In progressPriya Sharma, ${formatDateTime('2026-11-18T10:30:00+00:00')}`,
    ])
  })

  it('tells someone it is not there when the incident does not exist or is not theirs to see', async () => {
    incident = null
    const { calls, user } = await renderPage({ user: USERS.employee })
    expect(screen.getByRole('heading', { name: 'Incident not found' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(calls.map((call) => call.path)).toEqual([TICKET]) // nothing else is asked for

    await user.click(screen.getByRole('link', { name: 'Back to incidents' }))
    expect(screen.getByText('The list of incidents')).toBeInTheDocument()
  })

  it('offers to try again when the incident cannot be loaded', async () => {
    let working = false
    const { user } = await renderPage({ routes: { [`GET ${TICKET}`]: () => (working ? api[`GET ${TICKET}`]() : failed()) } })
    expect(screen.getByRole('alert')).toHaveTextContent('An unexpected error occurred')
    expect(screen.queryByRole('heading', { name: 'Incident not found' })).not.toBeInTheDocument()

    working = true
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'Leaking tap' })).toBeInTheDocument()
  })

  // --- the workflow ----------------------------------------------------------------

  it.each([
    ['OPEN', ['IN_PROGRESS', 'CLOSED'], true, ['Start work', 'Close without work']],
    ['IN_PROGRESS', ['BLOCKED', 'RESOLVED'], true, ['Mark as blocked', 'Mark as resolved']],
    ['BLOCKED', ['IN_PROGRESS'], true, ['Resume work']],
    ['RESOLVED', ['CLOSED', 'IN_PROGRESS'], true, ['Close', 'Reopen']],
    ['RESOLVED', ['CLOSED', 'IN_PROGRESS'], false, ['Confirm it is fixed', 'Reopen']], // as its reporter
    ['CLOSED', [], true, []],
    ['OPEN', [], false, []], // the reporter of an incident nobody has resolved yet
  ])('a %s incident that can move to %j offers exactly those moves (staff: %s)', async (status, next, staff, labels) => {
    incident = { ...incident, status, next_statuses: next, is_staff: staff, blocked_reason: status === 'BLOCKED' ? 'No part' : null }
    await renderPage()
    const progress = section('Progress')
    expect(progress.queryAllByRole('button').map((button) => button.textContent)).toEqual(labels)
  })

  it('makes a move that needs no explanation at once, and shows where the incident is now', async () => {
    const { calls, user } = await renderPage()
    await user.click(screen.getByRole('button', { name: 'Mark as resolved' }))

    await waitFor(() => expect(screen.getAllByText('Resolved')).toHaveLength(2)) // the chip and the step
    expect(writes(calls)).toEqual([{ method: 'POST', path: `${TICKET}/status`, token: undefined, body: { status: 'RESOLVED' } }])
    expect(section('Progress').getByText('In progress → Resolved')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('asks what is blocking an incident before marking it blocked, and shows the reason on the workflow', async () => {
    const { calls, user } = await renderPage()
    await user.click(screen.getByRole('button', { name: 'Mark as blocked' }))
    const dialog = within(screen.getByRole('dialog', { name: 'Mark as blocked?' }))

    await user.click(dialog.getByRole('button', { name: 'Mark as blocked' }))
    expect(dialog.getByText('Say what is blocking it')).toBeInTheDocument()
    await write(user, dialog.getByLabelText(/what is blocking it/i), 'x'.repeat(501))
    await user.click(dialog.getByRole('button', { name: 'Mark as blocked' }))
    expect(dialog.getByText('Reason must be at most 500 characters')).toBeInTheDocument()
    expect(writes(calls)).toEqual([])

    await user.clear(dialog.getByLabelText(/what is blocking it/i))
    await write(user, dialog.getByLabelText(/what is blocking it/i), '  Waiting for a washer ')
    await user.click(dialog.getByRole('button', { name: 'Mark as blocked' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(writes(calls)[0].body).toEqual({ status: 'BLOCKED', reason: 'Waiting for a washer' })
    const steps = section('Progress').getByRole('group')
    expect(steps.querySelector('[aria-current="step"]')).toHaveTextContent('BlockedWaiting for a washer')
    expect(section('Progress').getByText('Reason: Waiting for a washer')).toBeInTheDocument()
  })

  it('asks why before reopening, and shows what the API says about the reason under the field', async () => {
    incident = { ...incident, status: 'RESOLVED', next_statuses: ['CLOSED', 'IN_PROGRESS'] }
    const answers = [() => apiError(400, 'validation_error', 'Some fields are invalid', { reason: 'Say why it needs more work' })]
    const { calls, user } = await renderPage({
      routes: { [`POST ${TICKET}/status`]: (request) => (answers.shift() ?? api[`POST ${TICKET}/status`])(request) },
    })
    await user.click(screen.getByRole('button', { name: 'Reopen' }))
    const dialog = within(screen.getByRole('dialog', { name: 'Reopen?' }))
    await user.click(dialog.getByRole('button', { name: 'Reopen' }))
    expect(dialog.getByText('Say why it needs more work')).toBeInTheDocument()
    expect(writes(calls)).toEqual([])

    await write(user, dialog.getByLabelText(/why does it need more work/i), 'Still dripping')
    await user.click(dialog.getByRole('button', { name: 'Reopen' }))
    expect(await dialog.findByText('Say why it needs more work')).toBeInTheDocument() // this time from the API
    expect(dialog.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText('Some fields are invalid')).not.toBeInTheDocument()

    await user.click(dialog.getByRole('button', { name: 'Reopen' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(writes(calls).map((call) => call.body)).toEqual([
      { status: 'IN_PROGRESS', reason: 'Still dripping' },
      { status: 'IN_PROGRESS', reason: 'Still dripping' },
    ])
  })

  it.each([
    ['Close', true],
    ['Confirm it is fixed', false],
  ])('"%s" is final, so it asks first; cancelling sends nothing', async (label, staff) => {
    incident = { ...incident, status: 'RESOLVED', next_statuses: ['CLOSED', 'IN_PROGRESS'], is_staff: staff }
    const { calls, user } = await renderPage()
    await user.click(screen.getByRole('button', { name: label }))
    let dialog = within(screen.getByRole('dialog', { name: `${label}?` }))
    expect(dialog.getByText(/A closed incident is final/)).toBeInTheDocument()
    expect(dialog.queryByRole('textbox')).not.toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(writes(calls)).toEqual([])

    await user.click(screen.getByRole('button', { name: label }))
    dialog = within(screen.getByRole('dialog'))
    await user.click(dialog.getByRole('button', { name: label }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(writes(calls)[0].body).toEqual({ status: 'CLOSED' })
    expect(section('Progress').getByText('Resolved → Closed')).toBeInTheDocument()
  })

  it('when someone else moved the incident first, says so and shows where it stands now', async () => {
    const conflict = 'This incident was just changed by someone else. Reload and try again.'
    const { calls, user } = await renderPage({
      routes: {
        [`POST ${TICKET}/status`]: () => {
          incident = { ...incident, status: 'RESOLVED', next_statuses: ['CLOSED', 'IN_PROGRESS'] } // what the other person did
          return apiError(409, 'conflict', conflict)
        },
      },
    })
    await user.click(screen.getByRole('button', { name: 'Mark as blocked' }))
    const dialog = within(screen.getByRole('dialog'))
    await write(user, dialog.getByLabelText(/what is blocking it/i), 'No part')
    await user.click(dialog.getByRole('button', { name: 'Mark as blocked' }))

    expect(await screen.findByRole('button', { name: 'Reopen' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(conflict)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(calls.filter((call) => call.method === 'GET' && call.path === TICKET)).toHaveLength(2)

    await user.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows why a move without a dialog was refused, and reloads', async () => {
    incident = { ...incident, status: 'OPEN', next_statuses: ['IN_PROGRESS', 'CLOSED'] }
    const { calls, user } = await renderPage({
      routes: { [`POST ${TICKET}/status`]: () => apiError(409, 'conflict', 'Assign an engineer before work starts') },
    })
    await user.click(screen.getByRole('button', { name: 'Start work' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Assign an engineer before work starts')
    await waitFor(() => expect(calls.filter((call) => call.path === TICKET)).toHaveLength(2))
    expect(screen.getByRole('button', { name: 'Start work' })).toBeEnabled()
  })

  it.each([
    ['an admin, when it is open and nobody is assigned', USERS.admin, 'OPEN', null, true],
    ['an admin, once someone is assigned', USERS.admin, 'OPEN', 'e-1', false],
    ['an admin, when it is no longer open', USERS.admin, 'RESOLVED', null, false],
    ['its reporter', USERS.employee, 'OPEN', null, false],
  ])('"assign an engineer to start work": %s', async (_who, user, status, assigneeId, shown) => {
    incident = { ...incident, status, assignee_id: assigneeId, assignee: assigneeId && 'Priya Sharma', next_statuses: [] }
    await renderPage({ user })
    expect(Boolean(screen.queryByText('Assign an engineer to start work.'))).toBe(shown)
  })

  it('holds the other controls while a move is being sent', async () => {
    let finish
    const { calls, user } = await renderPage({
      user: USERS.admin,
      routes: { [`POST ${TICKET}/status`]: () => new Promise((resolve) => (finish = resolve)) },
    })
    await user.click(screen.getByRole('button', { name: 'Mark as resolved' }))

    expect(screen.getByRole('button', { name: 'Mark as blocked' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Mark as resolved' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete incident' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add note' })).toBeDisabled()
    expect(writes(calls)).toHaveLength(1)

    finish(api[`POST ${TICKET}/status`]({ body: { status: 'RESOLVED' } }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled())
  })

  // --- managing (admins) -----------------------------------------------------------

  it('lets an admin set the priority and the assignee, starting from what is saved', async () => {
    const { calls, user } = await renderPage({ user: USERS.admin })
    const manage = section('Manage')
    expect(select('Priority')).toHaveTextContent('High')
    expect(select('Assignee')).toHaveTextContent('Priya Sharma — 2 of 5 open, available')

    await user.click(select('Assignee'))
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Unassigned',
      'Priya Sharma — 2 of 5 open, available',
      'Marco Rossi — 4 of 4 open, unavailable', // shown, not enforced; the deactivated engineer is not offered
    ])
    await user.click(screen.getByRole('option', { name: /Marco Rossi/ }))
    await user.click(select('Priority'))
    await user.click(screen.getByRole('option', { name: 'Critical' }))
    await user.click(manage.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Critical priority')).toBeInTheDocument()
    expect(writes(calls)).toEqual([
      { method: 'PATCH', path: TICKET, token: undefined, body: { priority: 'CRITICAL', assignee_id: 'e-2' } },
    ])
    // The form starts again from what is now saved, ready for the next change
    expect(select('Assignee')).toHaveTextContent('Marco Rossi')
    expect(section('Manage').getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('sends "nobody" when an admin unassigns the incident', async () => {
    const { calls, user } = await renderPage({ user: USERS.admin })
    await user.click(select('Assignee'))
    await user.click(screen.getByRole('option', { name: 'Unassigned' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(writes(calls)).toHaveLength(1))
    expect(writes(calls)[0].body).toEqual({ priority: 'HIGH', assignee_id: null })
    await waitFor(() => expect(document.querySelector('dl')).toHaveTextContent('Assigned toUnassigned'))
  })

  it('keeps a deactivated engineer in the list while the incident is still theirs', async () => {
    incident = { ...incident, assignee: 'Lena Fischer', assignee_id: 'e-3' }
    await renderPage({ user: USERS.admin })
    expect(select('Assignee')).toHaveTextContent('Lena Fischer — 0 of 3 open, deactivated')
  })

  it('shows a complaint about the assignee under that field, and any other failure above the form', async () => {
    const answers = [
      apiError(400, 'validation_error', 'Some fields are invalid', { assignee_id: 'Choose an active engineer' }),
      apiError(409, 'conflict', 'A closed incident cannot be changed'),
    ]
    const { user } = await renderPage({ user: USERS.admin, routes: { [`PATCH ${TICKET}`]: () => answers.shift() } })
    const manage = section('Manage')
    await user.click(manage.getByRole('button', { name: 'Save' }))
    expect(await manage.findByText('Choose an active engineer')).toBeInTheDocument()
    expect(manage.queryByRole('alert')).not.toBeInTheDocument()

    await user.click(manage.getByRole('button', { name: 'Save' }))
    expect(await manage.findByRole('alert')).toHaveTextContent('A closed incident cannot be changed')
  })

  it.each([
    ['an engineer', USERS.engineer, 'IN_PROGRESS'],
    ['its reporter', USERS.employee, 'IN_PROGRESS'],
    ['an admin once it is closed', USERS.admin, 'CLOSED'],
  ])('offers no managing to %s', async (_who, user, status) => {
    incident = { ...incident, status, next_statuses: [] }
    const { calls } = await renderPage({ user })
    expect(screen.queryByRole('region', { name: 'Manage' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete incident' })).not.toBeInTheDocument()
    // Only an admin's page asks for the engineers
    expect(calls.some((call) => call.path === '/api/engineers/profiles')).toBe(user === USERS.admin)
  })

  it('deletes the incident only after the admin confirms, then returns to the list', async () => {
    const { calls, user } = await renderPage({ user: USERS.admin })
    await user.click(screen.getByRole('button', { name: 'Delete incident' }))
    let dialog = within(screen.getByRole('dialog', { name: 'Remove this incident?' }))
    expect(dialog.getByText('Its notes and history are removed with it. This cannot be undone.')).toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(writes(calls)).toEqual([])

    await user.click(screen.getByRole('button', { name: 'Delete incident' }))
    dialog = within(screen.getByRole('dialog'))
    await user.click(dialog.getByRole('button', { name: 'Remove' }))

    expect(await screen.findByText('The list of incidents')).toBeInTheDocument()
    expect(writes(calls)).toEqual([{ method: 'DELETE', path: TICKET, token: undefined, body: undefined }])
  })

  it('says why an incident could not be deleted, and keeps showing it', async () => {
    const { user } = await renderPage({ user: USERS.admin, routes: { [`DELETE ${TICKET}`]: failed } })
    await user.click(screen.getByRole('button', { name: 'Delete incident' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('An unexpected error occurred')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('heading', { name: 'Leaking tap' })).toBeInTheDocument()
    expect(screen.queryByText('The list of incidents')).not.toBeInTheDocument()
  })

  // --- notes -----------------------------------------------------------------------

  it('lists the notes with who wrote them and when, and sets internal ones apart', async () => {
    await renderPage()
    const notes = within(section('Notes').getByRole('list')).getAllByRole('listitem')
    expect(notes.map((note) => note.textContent)).toEqual([
      `Alice JohnsonEmployee, ${formatDateTime('2026-11-18T09:20:00+00:00')}It is the cold tap.`,
      `Priya SharmaEngineer, ${formatDateTime('2026-11-18T11:30:00+00:00')}InternalWasher ordered.`,
    ])
    expect(section('Notes').queryByText('No notes yet.')).not.toBeInTheDocument()
  })

  it('lets staff add a note, internal or not, and empties the form afterwards', async () => {
    const { calls, user } = await renderPage()
    const notes = section('Notes')
    await user.click(notes.getByRole('button', { name: 'Add note' }))
    expect(notes.getByText('Note is required')).toBeInTheDocument()
    await write(user, notes.getByLabelText('Add a note'), 'n'.repeat(2001))
    await user.click(notes.getByRole('button', { name: 'Add note' }))
    expect(notes.getByText('Note must be at most 2000 characters')).toBeInTheDocument()
    expect(writes(calls)).toEqual([])

    await user.clear(notes.getByLabelText('Add a note'))
    await write(user, notes.getByLabelText('Add a note'), '  Fitted the washer. ')
    await user.click(notes.getByRole('checkbox', { name: 'Internal note (staff only)' }))
    await user.click(notes.getByRole('button', { name: 'Add note' }))

    expect(await section('Notes').findByText('Fitted the washer.')).toBeInTheDocument()
    expect(writes(calls)).toEqual([
      { method: 'POST', path: `${TICKET}/notes`, token: undefined, body: { body: 'Fitted the washer.', is_internal: true } },
    ])
    expect(section('Notes').getByLabelText('Add a note')).toHaveValue('')
    expect(section('Notes').getByRole('checkbox', { name: 'Internal note (staff only)' })).not.toBeChecked()
    expect(section('Notes').getByRole('button', { name: 'Add note' })).toBeEnabled()
  })

  it('offers someone who is not staff an ordinary note only', async () => {
    incident = { ...incident, is_staff: false, next_statuses: [], notes: [] }
    const { calls, user } = await renderPage({ user: USERS.employee })
    const notes = section('Notes')
    expect(notes.getByText('No notes yet.')).toBeInTheDocument()
    expect(notes.queryByRole('checkbox')).not.toBeInTheDocument()

    await write(user, notes.getByLabelText('Add a note'), 'Any news?')
    await user.click(notes.getByRole('button', { name: 'Add note' }))
    await waitFor(() => expect(writes(calls)).toHaveLength(1))
    expect(writes(calls)[0].body).toEqual({ body: 'Any news?', is_internal: false })
  })

  it('shows why a note could not be added, and keeps what was written', async () => {
    const { user } = await renderPage({
      routes: { [`POST ${TICKET}/notes`]: () => apiError(409, 'conflict', 'A closed incident cannot take new notes') },
    })
    const notes = section('Notes')
    await write(user, notes.getByLabelText('Add a note'), 'Too late?')
    await user.click(notes.getByRole('button', { name: 'Add note' }))
    expect(await notes.findByRole('alert')).toHaveTextContent('A closed incident cannot take new notes')
    expect(notes.getByLabelText('Add a note')).toHaveValue('Too late?')
  })

  it('takes no more notes once the incident is closed', async () => {
    incident = { ...incident, status: 'CLOSED', next_statuses: [] }
    await renderPage()
    expect(section('Notes').getByText('Washer ordered.')).toBeInTheDocument()
    expect(section('Notes').queryByLabelText('Add a note')).not.toBeInTheDocument()
    expect(section('Notes').queryByRole('button', { name: 'Add note' })).not.toBeInTheDocument()
  })

  // --- feedback --------------------------------------------------------------------

  const asReporter = (changes = {}) => {
    incident = { ...incident, status: 'RESOLVED', next_statuses: ['CLOSED', 'IN_PROGRESS'], is_staff: false, ...changes }
    return renderPage({ user: USERS.employee })
  }

  it('asks the reporter of a resolved incident to rate the work, and thanks them without showing it back', async () => {
    const { calls, user } = await asReporter()
    const box = section('Feedback')
    expect(box.getByText("Only the engineer's manager will see this.")).toBeInTheDocument()
    expect(box.getByRole('radiogroup', { name: 'How well was it handled? *' })).toBeInTheDocument()

    await user.click(box.getByRole('button', { name: 'Send feedback' }))
    expect(box.getByRole('alert')).toHaveTextContent('Choose a rating from 1 to 5 stars')
    await write(user, box.getByLabelText('Comment'), 'c'.repeat(1001))
    await user.click(box.getByRole('radio', { name: '4 Stars' }))
    await user.click(box.getByRole('button', { name: 'Send feedback' }))
    expect(box.getByText('Comment must be at most 1000 characters')).toBeInTheDocument()
    expect(writes(calls)).toEqual([])

    await user.clear(box.getByLabelText('Comment'))
    await write(user, box.getByLabelText('Comment'), '  Fixed within the hour ')
    await user.click(box.getByRole('button', { name: 'Send feedback' }))

    expect(await screen.findByText("Thank you. Your feedback was sent to the engineer's manager.")).toBeInTheDocument()
    expect(writes(calls)).toEqual([
      { method: 'POST', path: FEEDBACK, token: undefined, body: { rating: 4, comment: 'Fixed within the hour' } },
    ])
    expect(screen.queryByRole('region', { name: 'Feedback' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Fixed within the hour/)).not.toBeInTheDocument()
  })

  it('sends a rating with no comment', async () => {
    const { calls, user } = await asReporter({ status: 'CLOSED', next_statuses: [] })
    await user.click(section('Feedback').getByRole('radio', { name: '5 Stars' }))
    await user.click(section('Feedback').getByRole('button', { name: 'Send feedback' }))
    await screen.findByText(/Thank you/)
    expect(writes(calls)[0].body).toEqual({ rating: 5, comment: '' })
  })

  it('shows why feedback could not be sent, and keeps the form', async () => {
    const { user } = await asReporter()
    mockApi({ ...api, [`POST ${FEEDBACK}`]: () => apiError(409, 'conflict', 'You have already given feedback on this incident') })
    await user.click(section('Feedback').getByRole('radio', { name: '2 Stars' }))
    await user.click(section('Feedback').getByRole('button', { name: 'Send feedback' }))
    expect(await section('Feedback').findByRole('alert')).toHaveTextContent('You have already given feedback on this incident')
    expect(section('Feedback').getByRole('radio', { name: '2 Stars' })).toBeChecked()
  })

  it('only thanks a reporter who has already given feedback', async () => {
    feedback = { given: true, can_give: false }
    await asReporter()
    expect(screen.getByText("Thank you. Your feedback was sent to the engineer's manager.")).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Feedback' })).not.toBeInTheDocument()
  })

  it.each([
    ['there is nobody to rate', { body: { given: false, can_give: false } }],
    ['the feedback service cannot answer', apiError(500, 'internal_error', 'An unexpected error occurred')],
    ['the feedback service says "not found"', apiError(404, 'not_found', 'Incident not found')],
  ])('shows no feedback box, and the rest of the page as usual, when %s', async (_why, answer) => {
    incident = { ...incident, status: 'RESOLVED', next_statuses: ['CLOSED', 'IN_PROGRESS'], is_staff: false }
    await renderPage({ user: USERS.employee, routes: { [`GET ${FEEDBACK}`]: () => answer } })
    expect(screen.getByRole('heading', { name: 'Leaking tap' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Feedback' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Thank you/)).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each([
    ['the incident is not resolved yet', USERS.employee, 'IN_PROGRESS'],
    ['the person is not its reporter', USERS.engineer, 'RESOLVED'],
    ['the person is an admin', USERS.admin, 'CLOSED'],
  ])('does not even ask about feedback when %s', async (_why, user, status) => {
    incident = { ...incident, status, next_statuses: [] }
    const { calls } = await renderPage({ user })
    expect(calls.some((call) => call.path === FEEDBACK)).toBe(false)
    expect(screen.queryByRole('region', { name: 'Feedback' })).not.toBeInTheDocument()
  })

  it.each([
    ['closed without ever being resolved', null, 2],
    ['resolved and then closed', LATER, 0],
  ])('an incident %s shows the steps in between as skipped or not', async (_how, resolvedAt, skipped) => {
    incident = { ...incident, status: 'CLOSED', resolved_at: resolvedAt, next_statuses: [] }
    await renderPage()
    expect(section('Progress').queryAllByText('Skipped')).toHaveLength(skipped)
  })
})
