import { describe, expect, it } from 'vitest'
import { NAV_ITEMS, ROLE_LABELS, ROLES, navItemsFor } from './navigation.js'

describe('navigation', () => {
  it.each(Object.values(ROLES))('shows the dashboard, then the incidents, to %s', (role) => {
    expect(navItemsFor(role).map((item) => item.path).slice(0, 2)).toEqual(['/', '/incidents'])
  })

  it.each(['/facilities', '/engineers'])('shows %s to admins only', (path) => {
    expect(navItemsFor(ROLES.ADMIN).map((item) => item.path)).toContain(path)
    expect(navItemsFor(ROLES.EMPLOYEE).map((item) => item.path)).not.toContain(path)
    expect(navItemsFor(ROLES.ENGINEER).map((item) => item.path)).not.toContain(path)
  })

  it('only returns items that list the role', () => {
    for (const role of Object.values(ROLES)) {
      expect(navItemsFor(role).every((item) => item.roles.includes(role))).toBe(true)
    }
    expect(navItemsFor('STRANGER')).toEqual([])
  })

  it('has a label for every role and no item without roles', () => {
    expect(Object.keys(ROLE_LABELS).sort()).toEqual(Object.values(ROLES).sort())
    expect(NAV_ITEMS.every((item) => item.roles.length > 0)).toBe(true)
  })
})
