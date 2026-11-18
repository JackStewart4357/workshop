import ApartmentIcon from '@mui/icons-material/Apartment'
import DashboardIcon from '@mui/icons-material/Dashboard'

export const ROLES = { EMPLOYEE: 'EMPLOYEE', ENGINEER: 'ENGINEER', ADMIN: 'ADMIN' }

export const ROLE_LABELS = {
  EMPLOYEE: 'Employee',
  ENGINEER: 'Engineer',
  ADMIN: 'Facility admin',
}

// Every page in the side menu, and which roles may see it. A page is added here when it
// is built; the same `roles` list is passed to <ProtectedRoute> so menu and access agree.
export const NAV_ITEMS = [
  { label: 'Dashboard', path: '/', icon: DashboardIcon, roles: [ROLES.EMPLOYEE, ROLES.ENGINEER, ROLES.ADMIN] },
  { label: 'Facilities', path: '/facilities', icon: ApartmentIcon, roles: [ROLES.ADMIN] },
]

export function navItemsFor(role) {
  return NAV_ITEMS.filter((item) => item.roles.includes(role))
}
