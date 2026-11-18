import Box from '@mui/material/Box'
import Container from '@mui/material/Container'
import Paper from '@mui/material/Paper'
import Typography from '@mui/material/Typography'

/** The centred card shared by the login and register pages. */
export default function AuthPageShell({ title, subtitle, children }) {
  return (
    <Container component="main" maxWidth="xs" sx={{ minHeight: '100%', display: 'flex', alignItems: 'center', py: 4 }}>
      <Paper variant="outlined" sx={{ p: { xs: 3, sm: 4 }, width: '100%' }}>
        <Typography variant="overline" color="primary">
          ACME Facility Incidents
        </Typography>
        <Typography variant="h1" gutterBottom>
          {title}
        </Typography>
        {subtitle && (
          <Typography color="text.secondary" sx={{ mb: 1 }}>
            {subtitle}
          </Typography>
        )}
        <Box>{children}</Box>
      </Paper>
    </Container>
  )
}
