import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockApi } from '../test/helpers.jsx'

const API = '/api/feedback'

let feedback
beforeEach(async () => {
  vi.resetModules()
  feedback = await import('./feedbackService.js')
})

describe('feedbackService', () => {
  it('asks whether feedback can be given, and gives it', async () => {
    const calls = mockApi({
      [`GET ${API}/incidents/i-1`]: () => ({ body: { given: false, can_give: true } }),
      [`POST ${API}/incidents/i-1`]: () => ({ status: 201, body: { given: true, can_give: false } }),
    })
    await expect(feedback.getFeedbackState('i-1')).resolves.toEqual({ given: false, can_give: true })
    await expect(feedback.giveFeedback('i-1', 4, 'Quick')).resolves.toEqual({ given: true, can_give: false })
    expect(calls[1].body).toEqual({ rating: 4, comment: 'Quick' })
  })

  it('reads the rating summaries and one engineer\'s feedback for their manager', async () => {
    const engineers = [{ engineer_id: 'e-1', count: 3, average: 4.3 }]
    const rows = [{ id: 'f-1', incident_id: 'i-1', incident: 'Leak', rating: 5, comment: null, author: 'Alice Johnson' }]
    mockApi({
      [`GET ${API}/engineers`]: () => ({ body: { engineers } }),
      [`GET ${API}/engineers/e-1`]: () => ({ body: { feedback: rows } }),
    })
    await expect(feedback.listRatingSummaries()).resolves.toEqual(engineers)
    await expect(feedback.listEngineerFeedback('e-1')).resolves.toEqual(rows)
  })
})
