import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useAuth } from '../context/AuthContext.js'

// What each role will do here. The figures and lists arrive with the incidents service.
const ROLE_SUMMARY = {
  EMPLOYEE: 'Report facility and workplace technology issues and follow their progress.',
  ENGINEER: 'See the incidents assigned to you and keep their status up to date.',
  ADMIN: 'Manage buildings, engineers and assignments, and oversee every incident.',
}

export default function DashboardPage() {
  const { user } = useAuth()
  return (
    <Stack spacing={2}>
      <Typography variant="h1">Welcome, {user.full_name}</Typography>
      <Paper variant="outlined" sx={{ p: 3 }}>
        <Typography variant="h2" gutterBottom>
          Your dashboard
        </Typography>
        <Typography color="text.secondary">{ROLE_SUMMARY[user.role]}</Typography>
      </Paper>
    </Stack>
  )
}
