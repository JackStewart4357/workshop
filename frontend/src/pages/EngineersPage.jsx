import { useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogTitle from '@mui/material/DialogTitle'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import LinearProgress from '@mui/material/LinearProgress'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import AddIcon from '@mui/icons-material/Add'
import DeleteIcon from '@mui/icons-material/DeleteOutlined'
import EditIcon from '@mui/icons-material/Edit'
import ConfirmDialog from '../components/ConfirmDialog.jsx'
import LoadFailed from '../components/LoadFailed.jsx'
import LoadingScreen from '../components/LoadingScreen.jsx'
import PasswordField from '../components/PasswordField.jsx'
import { useAuth } from '../context/AuthContext.js'
import * as engineers from '../services/engineersService.js'
import { useDialogForm } from '../utils/useDialogForm.js'
import { useServerList } from '../utils/useServerList.js'
import {
  EMAIL_DOMAIN,
  NAME_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  SPECIALISM_MAX_LENGTH,
  TICKETS_MAX,
  TICKETS_MIN,
  validateCompanyEmail,
  validateMaxTickets,
  validateNewPassword,
  validateRequired,
} from '../utils/validation.js'

const PROFILE_RULES = {
  full_name: validateRequired('Full name', NAME_MAX_LENGTH),
  specialism: validateRequired('Specialism', SPECIALISM_MAX_LENGTH),
  max_open_tickets: validateMaxTickets,
}
const ADD_RULES = { ...PROFILE_RULES, email: validateCompanyEmail, password: validateNewPassword }
const EDIT_RULES = {
  ...PROFILE_RULES,
  manager_id: (value) => (value ? '' : 'Choose a facility admin as the manager'),
}

// Everything the screen shows: the engineers, and the admins one of them can report to.
async function loadEngineers() {
  const [profiles, managers] = await Promise.all([engineers.listEngineers(), engineers.listManagers()])
  return { profiles, managers }
}

/**
 * The form for a new engineer (which also creates their sign-in), or for changing an
 * existing one. The email is the sign-in name, so it cannot be changed afterwards.
 */
function EngineerDialog({ engineer, managers, onSave, onClose }) {
  const { user } = useAuth()
  const isNew = !engineer.id
  const canManage = (id) => managers.some((manager) => manager.id === id)
  // Feedback on an engineer is for their manager only, so only that manager can hand them
  // to someone else (the API enforces it). Without a working manager, any admin can set one.
  const managerLocked = !isNew && canManage(engineer.manager_id) && engineer.manager_id !== user.id
  const { values, formError, saving, formRef, handleChange, handleSubmit, field } = useDialogForm({
    initial: isNew
      ? { full_name: '', email: '', password: '', specialism: '', max_open_tickets: '5' }
      : {
          full_name: engineer.full_name,
          specialism: engineer.specialism,
          max_open_tickets: String(engineer.max_open_tickets),
          // An engineer without a manager yet is offered the admin who is editing them
          manager_id: [engineer.manager_id, user.id].find(canManage) ?? '',
          is_available: engineer.is_available,
          is_active: engineer.is_active,
        },
    rules: isNew ? ADD_RULES : EDIT_RULES,
    toRequest: (form) => ({
      ...form, // the form holds exactly the fields its request takes
      full_name: form.full_name.trim(),
      specialism: form.specialism.trim(),
      max_open_tickets: Number(form.max_open_tickets),
      ...(isNew && { email: form.email.trim() }),
    }),
    onSave,
    onClose,
    firstField: 'full_name',
  })

  return (
    <Dialog open onClose={saving ? undefined : onClose} fullWidth maxWidth="xs" aria-labelledby="engineer-dialog-title">
      <Box component="form" ref={formRef} noValidate onSubmit={handleSubmit}>
        <DialogTitle id="engineer-dialog-title">{isNew ? 'Add engineer' : 'Edit engineer'}</DialogTitle>
        <DialogContent>
          {!isNew && <DialogContentText>Signs in as {engineer.email}</DialogContentText>}
          {formError && <Alert severity="error">{formError}</Alert>}
          <TextField label="Full name" autoFocus required {...field('full_name')} />
          {isNew && (
            <>
              <TextField
                label="Email"
                type="email"
                autoComplete="off"
                required
                {...field('email', `Must end in @${EMAIL_DOMAIN}`)}
              />
              <PasswordField
                label="First password"
                autoComplete="new-password"
                required
                {...field('password', `At least ${PASSWORD_MIN_LENGTH} characters, with a letter and a number`)}
              />
            </>
          )}
          <TextField label="Specialism" required {...field('specialism', 'For example: Electrical, HVAC, Network')} />
          <TextField
            label="Max open tickets"
            type="number"
            required
            slotProps={{ htmlInput: { min: TICKETS_MIN, max: TICKETS_MAX } }}
            {...field('max_open_tickets', 'How many open tickets they can hold at once')}
          />
          {!isNew && (
            <>
              <TextField
                select
                label="Manager"
                required
                {...field(
                  'manager_id',
                  managerLocked
                    ? `Only ${engineer.manager_name} can hand this engineer to another manager`
                    : 'The only person who sees feedback about this engineer',
                )}
                disabled={saving || managerLocked}
              >
                {managers.map((manager) => (
                  <MenuItem key={manager.id} value={manager.id}>
                    {manager.full_name}
                  </MenuItem>
                ))}
              </TextField>
              <FormControlLabel
                label="Available for new tickets"
                control={
                  <Switch name="is_available" checked={values.is_available} onChange={handleChange} disabled={saving} />
                }
              />
              <FormControlLabel
                label="Account active"
                control={<Switch name="is_active" checked={values.is_active} onChange={handleChange} disabled={saving} />}
              />
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="contained" loading={saving}>
            Save
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  )
}

/** The admin screen for engineer profiles: who they are, whether they are available, and their workload. */
export default function EngineersPage() {
  const { items, loadError, retry, error, setError, busy, change, removing, setRemoving, confirmRemove } =
    useServerList(loadEngineers)
  const [editing, setEditing] = useState(null) // the engineer in the dialog; {} for a new one

  if (loadError) return <LoadFailed title="Engineers" message={loadError} onRetry={retry} />
  if (!items) return <LoadingScreen label="Loading engineers" />

  return (
    <Stack spacing={2}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="h1">Engineers</Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setEditing({})} disabled={busy}>
          Add engineer
        </Button>
      </Stack>
      {error && (
        // Sticky, just under the top bar: the card that could not be removed may be far down the page
        <Alert severity="error" onClose={() => setError('')} sx={{ position: 'sticky', top: 72, zIndex: 2 }}>
          {error}
        </Alert>
      )}
      {items.profiles.length === 0 && <Typography color="text.secondary">There are no engineers yet.</Typography>}

      {/* One column on a phone, two from tablet width up */}
      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' } }}>
        {items.profiles.map((engineer) => (
          <Paper key={engineer.id} component="section" aria-label={engineer.full_name} variant="outlined" sx={{ p: 2 }}>
            <Stack direction="row" sx={{ alignItems: 'flex-start', gap: 0.5 }}>
              <Box sx={{ flexGrow: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                <Typography variant="h2">{engineer.full_name}</Typography>
                <Typography color="text.secondary">{engineer.email}</Typography>
              </Box>
              <IconButton aria-label={`Edit ${engineer.full_name}`} onClick={() => setEditing(engineer)} disabled={busy}>
                <EditIcon />
              </IconButton>
              <IconButton
                aria-label={`Remove ${engineer.full_name}`}
                onClick={() =>
                  setRemoving({
                    what: engineer.full_name,
                    note: 'Their sign-in is removed with the profile.',
                    run: () => engineers.removeEngineer(engineer.id),
                  })
                }
                disabled={busy}
              >
                <DeleteIcon />
              </IconButton>
            </Stack>

            <Typography sx={{ mt: 1, overflowWrap: 'anywhere' }}>{engineer.specialism}</Typography>
            <Typography color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              {engineer.manager_name ? `Manager: ${engineer.manager_name}` : 'No manager yet'}
            </Typography>
            <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1, my: 1.5 }}>
              <Chip
                size="small"
                color={engineer.is_available ? 'success' : 'default'}
                label={engineer.is_available ? 'Available' : 'Unavailable'}
              />
              {!engineer.is_active && <Chip size="small" color="warning" label="Deactivated" />}
            </Stack>

            <Typography>
              {engineer.open_tickets} of {engineer.max_open_tickets} open tickets
            </Typography>
            <LinearProgress
              variant="determinate"
              aria-label={`Workload of ${engineer.full_name}`}
              // An engineer can hold more than their maximum (it was lowered, or an admin insisted)
              value={Math.min(100, (engineer.open_tickets / engineer.max_open_tickets) * 100)}
              color={engineer.open_tickets >= engineer.max_open_tickets ? 'warning' : 'primary'}
              sx={{ mt: 0.5, height: 8, borderRadius: 4 }}
            />
          </Paper>
        ))}
      </Box>

      {editing && (
        <EngineerDialog
          engineer={editing}
          managers={items.managers}
          onSave={(fields) =>
            change(() => (editing.id ? engineers.updateEngineer(editing.id, fields) : engineers.addEngineer(fields)))
          }
          onClose={() => setEditing(null)}
        />
      )}
      {removing && (
        <ConfirmDialog {...removing} busy={busy} onConfirm={confirmRemove} onCancel={() => setRemoving(null)} />
      )}
    </Stack>
  )
}
