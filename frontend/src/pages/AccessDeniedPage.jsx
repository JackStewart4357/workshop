import { Link as RouterLink } from 'react-router-dom'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'

export default function AccessDeniedPage() {
  return (
    <Box component="main" sx={{ p: 4, textAlign: 'center' }}>
      <Typography variant="h1" gutterBottom>
        Access denied
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 3 }}>
        Your role does not have permission to view this page.
      </Typography>
      <Button component={RouterLink} to="/" variant="contained">
        Back to dashboard
      </Button>
    </Box>
  )
}
