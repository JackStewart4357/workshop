import Typography from '@mui/material/Typography'

/**
 * Why an incident is held up or was raised: "Blocked: ..." and "Escalated: ...", one line
 * each, for the rows that list incidents. Shows nothing for an incident that is neither.
 */
export default function StuckReasons({ incident }) {
  const lines = [
    incident.status === 'BLOCKED' && incident.blocked_reason && `Blocked: ${incident.blocked_reason}`,
    incident.is_escalated && incident.escalation_reason && `Escalated: ${incident.escalation_reason}`,
  ].filter(Boolean)
  return lines.map((line) => (
    <Typography key={line} variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
      {line}
    </Typography>
  ))
}
