// Engineer profiles, on top of the API client. Only a facility admin may read or change them.
import { api } from './apiClient.js'

const BASE = '/api/engineers'

/**
 * Every engineer, by name: [{ id, full_name, email, specialism, is_available, is_active,
 * max_open_tickets, open_tickets, manager_id, manager_name }].
 */
export async function listEngineers() {
  return (await api(`${BASE}/profiles`)).profiles
}

/** The facility admins who can be an engineer's manager: [{ id, full_name }]. */
export async function listManagers() {
  return (await api(`${BASE}/managers`)).managers
}

/** Creates the engineer's sign-in and profile together; the admin who adds them becomes their manager. */
export const addEngineer = (fields) => api(`${BASE}/profiles`, { method: 'POST', body: fields })
export const updateEngineer = (id, fields) => api(`${BASE}/profiles/${id}`, { method: 'PATCH', body: fields })
export const removeEngineer = (id) => api(`${BASE}/profiles/${id}`, { method: 'DELETE' })
