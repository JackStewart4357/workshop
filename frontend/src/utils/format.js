// How dates and places are written, wherever an incident is shown.
import { floorLabel } from '../services/facilitiesService.js'

const DATE_TIME = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' })

/** '2026-11-19T10:38:03+00:00' -> '19 Nov 2026, 10:38', in the reader's own time zone. */
export function formatDateTime(iso) {
  return DATE_TIME.format(new Date(iso))
}

/** '2026-11-19T10:38:03+00:00' -> '19 Nov 2026': the day only, for lists. */
export function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** Where an incident is: 'Headquarters, Floor 2, seat 2F-A14'. The floor and the seat are optional. */
export function locationOf({ building, floor_level, seat }) {
  // != null, not truthiness: floor 0 is the ground floor
  return [building, floor_level != null && floorLabel(floor_level), seat && `seat ${seat}`].filter(Boolean).join(', ')
}
