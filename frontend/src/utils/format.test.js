import { describe, expect, it } from 'vitest'
import { formatDate, formatDateTime, locationOf } from './format.js'

describe('formatDateTime', () => {
  it('writes a date the API sent as day, month, year and time', () => {
    expect(formatDateTime('2026-11-15T12:30:00+00:00')).toMatch(/^1[56] Nov 2026, \d{2}:30$/)
  })
})

describe('formatDate', () => {
  it('writes an API timestamp as day, short month and year', () => {
    expect(formatDate('2026-11-19T12:00:00+00:00')).toBe('19 Nov 2026')
    expect(formatDate('2026-01-03T12:00:00Z')).toBe('3 Jan 2026')
  })
})

describe('locationOf', () => {
  it.each([
    [{ building: 'Headquarters', floor_level: 2, seat: '2F-A14' }, 'Headquarters, Floor 2, seat 2F-A14'],
    [{ building: 'Headquarters', floor_level: 0, seat: null }, 'Headquarters, Ground floor'],
    [{ building: 'Headquarters', floor_level: -1, seat: null }, 'Headquarters, Basement 1'],
    [{ building: 'Riverside Annex', floor_level: null, seat: null }, 'Riverside Annex'],
  ])('%o is "%s"', (incident, text) => {
    expect(locationOf(incident)).toBe(text)
  })
})
