// Feedback on an engineer's work, on top of the API client. The person who reported an
// incident gives it; only that engineer's manager can ever read it. The API enforces that:
// no call here returns feedback to anyone else, not even back to its author.
import { api } from './apiClient.js'

const BASE = '/api/feedback'

/** For the incident's reporter: { given, can_give }. Anyone else gets "not found". */
export const getFeedbackState = (incidentId) => api(`${BASE}/incidents/${incidentId}`)

/** rating is 1 to 5; the comment is optional. Resolves with the new { given, can_give }. */
export const giveFeedback = (incidentId, rating, comment) =>
  api(`${BASE}/incidents/${incidentId}`, { method: 'POST', body: { rating, comment } })

/** For an admin: one row per engineer they manage: [{ engineer_id, count, average }]. */
export async function listRatingSummaries() {
  return (await api(`${BASE}/engineers`)).engineers
}

/** For the engineer's manager only: [{ id, incident_id, incident, rating, comment, author, created_at }], newest first. */
export async function listEngineerFeedback(profileId) {
  return (await api(`${BASE}/engineers/${profileId}`)).feedback
}
