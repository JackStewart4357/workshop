// Incidents, on top of the API client: reporting, the list with its filters, one incident
// with its notes and history, the status workflow, and the dashboard numbers. The API
// decides what each person may see and do; these functions only ask.
import { api } from './apiClient.js'

const BASE = '/api/incidents'

// In workflow order. Blocked is a pause inside "In progress", not a step of its own.
export const STATUSES = ['OPEN', 'IN_PROGRESS', 'BLOCKED', 'RESOLVED', 'CLOSED']
export const STATUS_LABELS = {
  OPEN: 'Open',
  IN_PROGRESS: 'In progress',
  BLOCKED: 'Blocked',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
}
export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']
export const PRIORITY_LABELS = { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High', CRITICAL: 'Critical' }
// Theme colour names (MUI), one per status and per priority.
export const STATUS_COLORS = { OPEN: 'info', IN_PROGRESS: 'primary', BLOCKED: 'error', RESOLVED: 'success', CLOSED: 'default' }
export const PRIORITY_COLORS = { LOW: 'default', MEDIUM: 'info', HIGH: 'warning', CRITICAL: 'error' }

/** The categories an incident can have: [{ id, name, type }]. */
export async function listCategories() {
  return (await api(`${BASE}/categories`)).categories
}

/**
 * The incidents the signed-in person may see, newest first (at most 200).
 * filters: { status, priority, category_id, building_id, assignee ('none', 'me' or a profile id), q };
 * empty ones are left out.
 */
export async function listIncidents(filters = {}) {
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value)).toString()
  return (await api(`${BASE}/tickets${query ? `?${query}` : ''}`)).incidents
}

/** One incident with its notes, status history, `next_statuses` (the moves this person may make) and `is_staff`. */
export async function getIncident(id) {
  return (await api(`${BASE}/tickets/${id}`)).incident
}

/** fields: { title, description, category_id, building_id, floor_id, seat_id, priority }. Resolves with the new incident. */
export async function reportIncident(fields) {
  return (await api(`${BASE}/tickets`, { method: 'POST', body: fields })).incident
}

/** Admin only. Both are sent each time; assigneeId is an engineer's profile id, or null for nobody. */
export const updateIncident = (id, priority, assigneeId) =>
  api(`${BASE}/tickets/${id}`, { method: 'PATCH', body: { priority, assignee_id: assigneeId } })

/** Move an incident along the workflow. A reason is needed to block it and to reopen it. */
export const changeStatus = (id, status, reason) =>
  api(`${BASE}/tickets/${id}/status`, { method: 'POST', body: { status, reason } })

export const addNote = (id, body, isInternal = false) =>
  api(`${BASE}/tickets/${id}/notes`, { method: 'POST', body: { body, is_internal: isInternal } })

export const removeIncident = (id) => api(`${BASE}/tickets/${id}`, { method: 'DELETE' })

/**
 * The dashboard numbers over the incidents this person may see: { total, by_status,
 * by_priority, unassigned_open, escalated_open, by_assignee (admins only), average_hours }.
 */
export const getSummary = () => api(`${BASE}/summary`)
