import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'

/** Shown in place of a page whose data could not be loaded. */
export default function LoadFailed({ title, message, onRetry }) {
  return (
    <Stack spacing={2} sx={{ alignItems: 'flex-start' }}>
      <Typography variant="h1">{title}</Typography>
      <Alert severity="error">{message}</Alert>
      <Button variant="contained" onClick={onRetry}>
        Try again
      </Button>
    </Stack>
  )
}
