import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import StuckReasons from './StuckReasons.jsx'

const lines = (incident) => {
  const { container } = render(<StuckReasons incident={incident} />)
  return [...container.querySelectorAll('p')].map((line) => line.textContent)
}

describe('StuckReasons', () => {
  it('says why an incident is blocked and why it was escalated, one line each', () => {
    const incident = { status: 'BLOCKED', blocked_reason: 'Waiting for a part', is_escalated: true, escalation_reason: 'Third time' }
    expect(lines(incident)).toEqual(['Blocked: Waiting for a part', 'Escalated: Third time'])
  })

  it('shows nothing for an incident that is neither, even if an old reason is still stored', () => {
    expect(lines({ status: 'IN_PROGRESS', blocked_reason: 'Old', is_escalated: false, escalation_reason: null })).toEqual([])
    expect(lines({ status: 'BLOCKED', blocked_reason: null, is_escalated: true, escalation_reason: null })).toEqual([])
  })
})
