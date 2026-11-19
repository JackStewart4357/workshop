import Button from '@mui/material/Button'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'

/**
 * The foot of a list drawn a page at a time: how much of it is on screen, and a button for
 * the next page. Takes what useShowMore() returns; draws nothing once everything is shown.
 */
export default function ShowMore({ shown, total, pageSize, showMore }) {
  if (shown >= total) return null
  return (
    <Stack direction="row" sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
      <Button variant="outlined" onClick={showMore}>
        Show {Math.min(pageSize, total - shown)} more
      </Button>
      <Typography color="text.secondary">
        Showing {shown} of {total}
      </Typography>
    </Stack>
  )
}
