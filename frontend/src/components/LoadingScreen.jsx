import Box from '@mui/material/Box'
import CircularProgress from '@mui/material/CircularProgress'

export default function LoadingScreen({ label = 'Loading' }) {
  return (
    <Box role="status" aria-live="polite" sx={{ minHeight: '100%', display: 'grid', placeItems: 'center', p: 4 }}>
      <CircularProgress aria-label={label} />
    </Box>
  )
}
