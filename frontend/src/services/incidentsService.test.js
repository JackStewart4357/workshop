import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockApi } from '../test/helpers.jsx'

const API = '/api/incidents'

let incidents
beforeEach(async () => {
  vi.resetModules()
  incidents = await import('./incidentsService.js')
})

describe('incidentsService', () => {
  it('has a label and a colour for every status and every priority', () => {
    for (const table of [incidents.STATUS_LABELS, incidents.STATUS_COLORS]) {
      expect(Object.keys(table)).toEqual(incidents.STATUSES)
    }
    for (const table of [incidents.PRIORITY_LABELS, incidents.PRIORITY_COLORS]) {
      expect(Object.keys(table)).toEqual(incidents.PRIORITIES)
    }
  })

  it('reads the categories, one incident and the dashboard numbers', async () => {
    const categories = [{ id: 'c-1', name: 'Plumbing', type: 'FACILITY' }]
    const incident = { id: 'i-1', title: 'Leaking tap', notes: [], history: [], next_statuses: [] }
    const summary = { total: 3, by_status: { OPEN: 3 } }
    mockApi({
      [`GET ${API}/categories`]: () => ({ body: { categories } }),
      [`GET ${API}/tickets/i-1`]: () => ({ body: { incident } }),
      [`GET ${API}/summary`]: () => ({ body: summary }),
    })
    await expect(incidents.listCategories()).resolves.toEqual(categories)
    await expect(incidents.getIncident('i-1')).resolves.toEqual(incident)
    await expect(incidents.getSummary()).resolves.toEqual(summary)
  })

  it('lists the incidents, sending only the filters that are set', async () => {
    const found = [{ id: 'i-1', title: 'Leaking tap' }]
    const calls = mockApi({ [`GET ${API}/tickets`]: () => ({ body: { incidents: found } }) })

    await expect(incidents.listIncidents()).resolves.toEqual(found)
    await incidents.listIncidents({ status: 'OPEN', priority: '', q: 'tap & sink', assignee: 'me', building_id: undefined })
    expect(calls.map((call) => call.query)).toEqual([undefined, { status: 'OPEN', q: 'tap & sink', assignee: 'me' }])
  })

  it('reports an incident and hands back what was saved', async () => {
    const fields = { title: 'Leaking tap', description: 'Drips', category_id: 'c-1', building_id: 'b-1' }
    const calls = mockApi({
      [`POST ${API}/tickets`]: ({ body }) => ({ status: 201, body: { incident: { id: 'i-9', ...body } } }),
    })
    await expect(incidents.reportIncident(fields)).resolves.toEqual({ id: 'i-9', ...fields })
    expect(calls[0].body).toEqual(fields)
  })

  it('sends each change to its own endpoint', async () => {
    const calls = mockApi({
      [`PATCH ${API}/tickets/i-1`]: () => ({ body: {} }),
      [`POST ${API}/tickets/i-1/status`]: () => ({ body: {} }),
      [`POST ${API}/tickets/i-1/notes`]: () => ({ status: 201, body: {} }),
      [`DELETE ${API}/tickets/i-1`]: () => ({ status: 204 }),
    })
    await incidents.updateIncident('i-1', 'HIGH', 'e-1')
    await incidents.updateIncident('i-1', 'LOW', null)
    await incidents.changeStatus('i-1', 'BLOCKED', 'Waiting for a part')
    await incidents.changeStatus('i-1', 'IN_PROGRESS')
    await incidents.addNote('i-1', 'Ordered the part', true)
    await incidents.addNote('i-1', 'Thanks')
    await incidents.removeIncident('i-1')
    expect(calls.map((call) => [call.method, call.body])).toEqual([
      ['PATCH', { priority: 'HIGH', assignee_id: 'e-1' }],
      ['PATCH', { priority: 'LOW', assignee_id: null }],
      ['POST', { status: 'BLOCKED', reason: 'Waiting for a part' }],
      ['POST', { status: 'IN_PROGRESS' }],
      ['POST', { body: 'Ordered the part', is_internal: true }],
      ['POST', { body: 'Thanks', is_internal: false }],
      ['DELETE', undefined],
    ])
  })
})
