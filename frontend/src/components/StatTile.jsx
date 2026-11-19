import { Link as RouterLink } from 'react-router-dom'
import Box from '@mui/material/Box'
import CardActionArea from '@mui/material/CardActionArea'
import Paper from '@mui/material/Paper'
import Typography from '@mui/material/Typography'

/**
 * One headline number on a dashboard: what it counts, the number, and an optional line
 * underneath. `mark` stands in for the plain label when something already names itself,
 * such as a status chip. With `to`, the whole tile is a link to the list the number counts.
 */
export default function StatTile({ label, mark, value, caption, to }) {
  const figure = (
    <Box sx={{ p: 2 }}>
      {mark ?? (
        <Typography variant="body2" color="text.secondary">
          {label}
        </Typography>
      )}
      <Typography sx={{ fontSize: '1.75rem', fontWeight: 600, lineHeight: 1.3 }}>{value}</Typography>
      {caption && (
        <Typography variant="body2" color="text.secondary">
          {caption}
        </Typography>
      )}
    </Box>
  )
  return (
    <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
      {to ? (
        <CardActionArea component={RouterLink} to={to} sx={{ height: '100%' }}>
          {figure}
        </CardActionArea>
      ) : (
        figure
      )}
    </Paper>
  )
}
