import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockApi } from '../test/helpers.jsx'

let facilities
beforeEach(async () => {
  vi.resetModules()
  facilities = await import('./facilitiesService.js')
})

describe('facilitiesService', () => {
  it('lists the buildings', async () => {
    const buildings = [{ id: 'b-1', name: 'Headquarters', address: '1 Acme Plaza', floors: [] }]
    mockApi({ 'GET /api/facilities/buildings': () => ({ body: { buildings } }) })
    await expect(facilities.listBuildings()).resolves.toEqual(buildings)
  })

  it('sends each change to its own endpoint', async () => {
    const created = () => ({ status: 201, body: {} })
    const removed = () => ({ status: 204 })
    const calls = mockApi({
      'POST /api/facilities/buildings': created,
      'PATCH /api/facilities/buildings/b-1': () => ({ body: {} }),
      'DELETE /api/facilities/buildings/b-1': removed,
      'POST /api/facilities/buildings/b-1/floors': created,
      'DELETE /api/facilities/floors/f-1': removed,
      'POST /api/facilities/floors/f-1/seats': created,
      'DELETE /api/facilities/seats/s-1': removed,
      'PATCH /api/facilities/floors/f-1': () => ({ body: {} }),
      'PATCH /api/facilities/seats/s-1': () => ({ body: {} }),
    })
    await facilities.addBuilding({ name: 'HQ', address: '1 Acme Plaza' })
    await facilities.updateBuilding('b-1', { name: 'HQ', address: '2 Acme Plaza' })
    await facilities.removeBuilding('b-1')
    await facilities.addFloor('b-1', 2)
    await facilities.removeFloor('f-1')
    await facilities.addSeat('f-1', '2F-A14')
    await facilities.removeSeat('s-1')
    await facilities.updateFloor('f-1', -1)
    await facilities.updateSeat('s-1', '2F-A15')
    expect(calls.slice(-2).map((call) => [call.method, call.path])).toEqual([
      ['PATCH', '/api/facilities/floors/f-1'],
      ['PATCH', '/api/facilities/seats/s-1'],
    ])
    expect(calls.map((call) => call.body)).toEqual([
      { name: 'HQ', address: '1 Acme Plaza' },
      { name: 'HQ', address: '2 Acme Plaza' },
      undefined,
      { level: 2 },
      undefined,
      { code: '2F-A14' },
      undefined,
      { level: -1 },
      { code: '2F-A15' },
    ])
  })

  it.each([
    [0, 'Ground floor'],
    [1, 'Floor 1'],
    [12, 'Floor 12'],
    [-1, 'Basement 1'],
    [-3, 'Basement 3'],
  ])('names floor %i "%s"', (level, label) => {
    expect(facilities.floorLabel(level)).toBe(label)
  })
})
