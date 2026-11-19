import Chip from '@mui/material/Chip'
import { PRIORITY_COLORS, PRIORITY_LABELS, STATUS_COLORS, STATUS_LABELS } from '../services/incidentsService.js'

// A status or a priority looks the same wherever it is shown: the list, the incident page
// and the dashboard. The label always carries the meaning; colour is never the only signal.

export function StatusChip({ status }) {
  return <Chip size="small" color={STATUS_COLORS[status]} label={STATUS_LABELS[status]} />
}

export function PriorityChip({ priority }) {
  return (
    <Chip size="small" variant="outlined" color={PRIORITY_COLORS[priority]} label={`${PRIORITY_LABELS[priority]} priority`} />
  )
}
