import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogTitle from '@mui/material/DialogTitle'

/** "Remove X?" Nothing is removed until the admin confirms; both buttons hold while it is sent. */
export default function ConfirmDialog({ what, note, busy, onConfirm, onCancel }) {
  return (
    <Dialog open onClose={busy ? undefined : onCancel} aria-labelledby="remove-dialog-title">
      <DialogTitle id="remove-dialog-title">Remove {what}?</DialogTitle>
      <DialogContent>
        <DialogContentText>{note} This cannot be undone.</DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button color="error" variant="contained" loading={busy} onClick={onConfirm}>
          Remove
        </Button>
      </DialogActions>
    </Dialog>
  )
}
