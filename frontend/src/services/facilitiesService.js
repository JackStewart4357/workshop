// Buildings, floors and seats, on top of the API client. Anyone signed in can read them;
// the API only lets a facility admin change them.
import { api } from './apiClient.js'

const BASE = '/api/facilities'

/** Every building with its floors and their seats: [{ id, name, address, floors: [{ id, level, seats }] }]. */
export async function listBuildings() {
  return (await api(`${BASE}/buildings`)).buildings
}

export const addBuilding = (fields) => api(`${BASE}/buildings`, { method: 'POST', body: fields })
export const updateBuilding = (id, fields) => api(`${BASE}/buildings/${id}`, { method: 'PATCH', body: fields })
export const removeBuilding = (id) => api(`${BASE}/buildings/${id}`, { method: 'DELETE' })
export const addFloor = (buildingId, level) =>
  api(`${BASE}/buildings/${buildingId}/floors`, { method: 'POST', body: { level } })
export const updateFloor = (id, level) => api(`${BASE}/floors/${id}`, { method: 'PATCH', body: { level } })
export const removeFloor = (id) => api(`${BASE}/floors/${id}`, { method: 'DELETE' })
export const addSeat = (floorId, code) => api(`${BASE}/floors/${floorId}/seats`, { method: 'POST', body: { code } })
export const updateSeat = (id, code) => api(`${BASE}/seats/${id}`, { method: 'PATCH', body: { code } })
export const removeSeat = (id) => api(`${BASE}/seats/${id}`, { method: 'DELETE' })

/** Floors are stored as a number: 0 is the ground floor and negative numbers are basements. */
export function floorLabel(level) {
  if (level === 0) return 'Ground floor'
  return level > 0 ? `Floor ${level}` : `Basement ${-level}`
}
