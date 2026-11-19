import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import WorkflowSteps from './WorkflowSteps.jsx'
import { renderWithProviders } from '../test/helpers.jsx'

// What each step says, in order: its name and, underneath, where it stands
function steps() {
  const group = screen.getByRole('group', { name: 'Where this incident is in the workflow' })
  return [...group.querySelectorAll('.MuiStep-root')].map((step) => [
    step.querySelector('.MuiStepLabel-label').textContent,
    step.querySelector('.MuiStepLabel-labelContainer .MuiTypography-caption')?.textContent ?? '',
    step.getAttribute('aria-current'),
  ])
}

describe('WorkflowSteps', () => {
  it.each([
    ['OPEN', [['Open', 'Current step', 'step'], ['In progress', '', null], ['Resolved', '', null], ['Closed', '', null]]],
    ['IN_PROGRESS', [['Open', 'Done', null], ['In progress', 'Current step', 'step'], ['Resolved', '', null], ['Closed', '', null]]],
    ['RESOLVED', [['Open', 'Done', null], ['In progress', 'Done', null], ['Resolved', 'Current step', 'step'], ['Closed', '', null]]],
    ['CLOSED', [['Open', 'Done', null], ['In progress', 'Done', null], ['Resolved', 'Done', null], ['Closed', 'Done', null]]],
  ])('a %s incident shows the path with its place on it', (status, expected) => {
    renderWithProviders(<WorkflowSteps status={status} blockedReason={null} />)
    expect(steps()).toEqual(expected)
  })

  it('a blocked incident is shown stuck on the "in progress" step, with the reason', () => {
    renderWithProviders(<WorkflowSteps status="BLOCKED" blockedReason="Waiting for a part" />)
    expect(steps()).toEqual([
      ['Open', 'Done', null],
      ['Blocked', 'Waiting for a part', 'step'],
      ['Resolved', '', null],
      ['Closed', '', null],
    ])
    const group = screen.getByRole('group')
    expect(within(group).getByText('Blocked')).toHaveClass('Mui-error')
    expect(within(group).queryByText('In progress')).not.toBeInTheDocument()
  })

  it('runs across the page on a wide screen and down it on a phone', () => {
    const wide = renderWithProviders(<WorkflowSteps status="OPEN" />, { width: 1200 })
    expect(screen.getByRole('group')).toHaveClass('MuiStepper-horizontal')
    wide.unmount()

    renderWithProviders(<WorkflowSteps status="OPEN" />, { width: 400 })
    expect(screen.getByRole('group')).toHaveClass('MuiStepper-vertical')
  })
})
