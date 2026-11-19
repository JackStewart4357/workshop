import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockApi } from '../test/helpers.jsx'

let engineers
beforeEach(async () => {
  vi.resetModules()
  engineers = await import('./engineersService.js')
})

describe('engineersService', () => {
  it('lists the engineers and the admins who can manage them', async () => {
    const profiles = [{ id: 'e-1', full_name: 'Priya Sharma', open_tickets: 2, max_open_tickets: 5 }]
    const managers = [{ id: 'u-3', full_name: 'Facility Admin' }]
    mockApi({
      'GET /api/engineers/profiles': () => ({ body: { profiles } }),
      'GET /api/engineers/managers': () => ({ body: { managers } }),
    })
    await expect(engineers.listEngineers()).resolves.toEqual(profiles)
    await expect(engineers.listManagers()).resolves.toEqual(managers)
  })

  it('sends each change to its own endpoint', async () => {
    const calls = mockApi({
      'POST /api/engineers/profiles': () => ({ status: 201, body: {} }),
      'PATCH /api/engineers/profiles/e-1': () => ({ body: {} }),
      'DELETE /api/engineers/profiles/e-1': () => ({ status: 204 }),
    })
    await engineers.addEngineer({ email: 'sam@acme.inc', specialism: 'Plumbing' })
    await engineers.updateEngineer('e-1', { specialism: 'Electrical', is_active: false })
    await engineers.removeEngineer('e-1')
    expect(calls.map((call) => call.body)).toEqual([
      { email: 'sam@acme.inc', specialism: 'Plumbing' },
      { specialism: 'Electrical', is_active: false },
      undefined,
    ])
  })
})
