import { useMediaQuery } from 'react-responsive'
import Step from '@mui/material/Step'
import StepLabel from '@mui/material/StepLabel'
import Stepper from '@mui/material/Stepper'
import Typography from '@mui/material/Typography'
import { STATUS_LABELS } from '../services/incidentsService.js'

// The path every incident follows. Blocked is not a step of its own: it is a pause while
// the work is in progress, so it is drawn on that step.
const STEPS = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']
const PHONE_QUERY = { maxWidth: 599 }

/**
 * Where an incident is in the workflow, as a row of steps (a column on a phone). Every
 * step says in words whether it is done or current, so colour is never the only signal.
 */
export default function WorkflowSteps({ status, blockedReason }) {
  const isPhone = useMediaQuery(PHONE_QUERY)
  const blocked = status === 'BLOCKED'
  const current = STEPS.indexOf(blocked ? 'IN_PROGRESS' : status)

  return (
    <Stepper
      role="group"
      aria-label="Where this incident is in the workflow"
      activeStep={current}
      orientation={isPhone ? 'vertical' : 'horizontal'}
      alternativeLabel={!isPhone}
    >
      {STEPS.map((step, index) => {
        const done = index < current || status === 'CLOSED' // closed is the end of the path
        const here = index === current && !done
        const stuck = here && blocked
        const note = done ? 'Done' : here ? (stuck ? blockedReason : 'Current step') : ''
        return (
          <Step key={step} completed={done} aria-current={here ? 'step' : undefined}>
            <StepLabel
              error={stuck}
              optional={
                note && (
                  <Typography variant="caption" color={stuck ? 'error' : 'text.secondary'} sx={{ overflowWrap: 'anywhere' }}>
                    {note}
                  </Typography>
                )
              }
            >
              {STATUS_LABELS[stuck ? 'BLOCKED' : step]}
            </StepLabel>
          </Step>
        )
      })}
    </Stepper>
  )
}
