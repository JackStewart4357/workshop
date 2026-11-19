import { useCallback, useState } from 'react'
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import Chip from '@mui/material/Chip'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogTitle from '@mui/material/DialogTitle'
import FormControlLabel from '@mui/material/FormControlLabel'
import FormHelperText from '@mui/material/FormHelperText'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Rating from '@mui/material/Rating'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import ConfirmDialog from '../components/ConfirmDialog.jsx'
import LoadFailed from '../components/LoadFailed.jsx'
import LoadingScreen from '../components/LoadingScreen.jsx'
import { PriorityChip, StatusChip } from '../components/StatusChip.jsx'
import WorkflowSteps from '../components/WorkflowSteps.jsx'
import { useAuth } from '../context/AuthContext.js'
import { ROLE_LABELS, ROLES } from '../navigation.js'
import { listEngineers } from '../services/engineersService.js'
import { getFeedbackState, giveFeedback } from '../services/feedbackService.js'
import * as incidents from '../services/incidentsService.js'
import { formatDateTime, locationOf } from '../utils/format.js'
import { useDialogForm } from '../utils/useDialogForm.js'
import { useServerList } from '../utils/useServerList.js'
import {
  COMMENT_MAX_LENGTH,
  NOTE_MAX_LENGTH,
  REASON_MAX_LENGTH,
  validateOptional,
  validateRequired,
} from '../utils/validation.js'

// Every move in the workflow: what its button says, whether it asks "are you sure?", and,
// where the API wants a reason, how to ask for one. The API decides which of them a person
// is offered (`next_statuses`); this only words them.
const MOVES = {
  'OPEN>IN_PROGRESS': { label: 'Start work' },
  'OPEN>CLOSED': { label: 'Close without work', final: true },
  'IN_PROGRESS>BLOCKED': { label: 'Mark as blocked', ask: 'What is blocking it?', missing: 'Say what is blocking it' },
  'IN_PROGRESS>RESOLVED': { label: 'Mark as resolved' },
  'BLOCKED>IN_PROGRESS': { label: 'Resume work' },
  'RESOLVED>IN_PROGRESS': { label: 'Reopen', ask: 'Why does it need more work?', missing: 'Say why it needs more work' },
  'RESOLVED>CLOSED': { label: 'Close', final: true },
}
const FINISHED = ['RESOLVED', 'CLOSED']

// Everything the page shows. An incident the person may not see answers 404 exactly like
// one that does not exist; that becomes `incident: null`, not a failure.
async function loadIncident(id, userId, role) {
  const incident = await incidents.getIncident(id).catch((failure) => {
    if (failure.status === 404) return null
    throw failure
  })
  if (!incident) return { incident }
  const [engineers, feedback] = await Promise.all([
    role === ROLES.ADMIN ? listEngineers() : [], // for the assign control
    // Only the reporter is asked for feedback, once the work is done. The box is an extra:
    // if its service cannot answer, the page simply shows none.
    incident.reporter_id === userId && FINISHED.includes(incident.status) ? getFeedbackState(id).catch(() => null) : null,
  ])
  return { incident, engineers, feedback }
}

/** Asks for the reason a move needs, or for confirmation before a final one. */
function MoveDialog({ move, onMove, onClose }) {
  const { formError, saving, formRef, handleSubmit, field } = useDialogForm({
    initial: { reason: '' },
    rules: move.ask
      ? { reason: (value) => (value.trim() ? validateOptional('Reason', REASON_MAX_LENGTH)(value) : move.missing) }
      : {},
    toRequest: (form) => form.reason.trim() || undefined,
    onSave: (reason) => onMove(move.to, reason),
    onClose,
    firstField: 'reason',
  })

  return (
    <Dialog open onClose={saving ? undefined : onClose} fullWidth maxWidth="xs" aria-labelledby="move-dialog-title">
      <Box component="form" ref={formRef} noValidate onSubmit={handleSubmit}>
        <DialogTitle id="move-dialog-title">{move.label}?</DialogTitle>
        <DialogContent>
          {formError && <Alert severity="error">{formError}</Alert>}
          {move.ask ? (
            <TextField label={move.ask} autoFocus required multiline minRows={2} {...field('reason')} />
          ) : (
            <DialogContentText>
              A closed incident is final: it cannot be reopened or changed, and takes no more notes.
            </DialogContentText>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="contained" loading={saving}>
            {move.label}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  )
}

/** For admins: how urgent the incident is and who works on it. Both are saved together. */
function ManagePanel({ incident, engineers, busy, onSave, onDelete }) {
  const { formError, saving, formRef, handleSubmit, field } = useDialogForm({
    initial: { priority: incident.priority, assignee_id: incident.assignee_id ?? '' },
    rules: {},
    toRequest: (form) => form,
    onSave: (form) => onSave(form.priority, form.assignee_id || null),
    onClose: () => {}, // a saved change reloads the incident, which gives this form a fresh start
    firstField: 'priority',
  })

  return (
    <Paper component="section" aria-label="Manage" variant="outlined" sx={{ p: 2 }}>
      <Typography variant="h2">Manage</Typography>
      <Box component="form" ref={formRef} noValidate onSubmit={handleSubmit}>
        {formError && <Alert severity="error">{formError}</Alert>}
        <Box sx={{ display: 'grid', columnGap: 2, gridTemplateColumns: { xs: '1fr', sm: '1fr 2fr' } }}>
          <TextField select label="Priority" {...field('priority')}>
            {Object.entries(incidents.PRIORITY_LABELS).map(([priority, label]) => (
              <MenuItem key={priority} value={priority}>
                {label}
              </MenuItem>
            ))}
          </TextField>
          <TextField select label="Assignee" {...field('assignee_id', 'Availability and workload are shown, not enforced')}>
            <MenuItem value="">Unassigned</MenuItem>
            {engineers
              // A deactivated engineer cannot be chosen, but stays listed while they hold this incident
              .filter((engineer) => engineer.is_active || engineer.id === incident.assignee_id)
              .map((engineer) => (
                <MenuItem key={engineer.id} value={engineer.id}>
                  {engineer.full_name} — {engineer.open_tickets} of {engineer.max_open_tickets} open,{' '}
                  {engineer.is_active ? (engineer.is_available ? 'available' : 'unavailable') : 'deactivated'}
                </MenuItem>
              ))}
          </TextField>
        </Box>
        <Stack direction="row" sx={{ gap: 1, mt: 1, justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <Button color="error" onClick={onDelete} disabled={saving || busy}>
            Delete incident
          </Button>
          <Button type="submit" variant="contained" loading={saving} disabled={busy}>
            Save
          </Button>
        </Stack>
      </Box>
    </Paper>
  )
}

/** The notes on an incident and, until it is closed, the form to add one. */
function Notes({ incident, busy, onAdd }) {
  const { values, formError, saving, formRef, handleChange, handleSubmit, field } = useDialogForm({
    initial: { body: '', is_internal: false },
    rules: { body: validateRequired('Note', NOTE_MAX_LENGTH) },
    toRequest: (form) => form,
    onSave: (form) => onAdd(form.body.trim(), form.is_internal),
    onClose: () => {}, // the added note reloads the incident, which empties this form
    firstField: 'body',
  })

  return (
    <Paper component="section" aria-label="Notes" variant="outlined" sx={{ p: 2 }}>
      <Typography variant="h2">Notes</Typography>
      {incident.notes.length === 0 && <Typography color="text.secondary">No notes yet.</Typography>}
      <Stack component="ul" spacing={1.5} sx={{ listStyle: 'none', p: 0, my: 1.5 }}>
        {incident.notes.map((note) => (
          <Box
            key={note.id}
            component="li"
            // An internal note is set apart by a coloured edge as well as its label
            sx={{ pl: 1.5, borderLeft: 3, borderColor: note.is_internal ? 'warning.main' : 'divider', overflowWrap: 'anywhere' }}
          >
            <Stack direction="row" sx={{ flexWrap: 'wrap', alignItems: 'center', columnGap: 1 }}>
              <Typography sx={{ fontWeight: 600 }}>{note.author}</Typography>
              <Typography color="text.secondary">
                {ROLE_LABELS[note.author_role]}, {formatDateTime(note.created_at)}
              </Typography>
              {note.is_internal && <Chip size="small" color="warning" label="Internal" />}
            </Stack>
            <Typography sx={{ whiteSpace: 'pre-wrap' }}>{note.body}</Typography>
          </Box>
        ))}
      </Stack>

      {incident.status !== 'CLOSED' && (
        <Box component="form" ref={formRef} noValidate onSubmit={handleSubmit}>
          {formError && <Alert severity="error">{formError}</Alert>}
          <TextField label="Add a note" multiline minRows={2} {...field('body')} />
          <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
            {incident.is_staff ? (
              <FormControlLabel
                label="Internal note (staff only)"
                control={
                  <Checkbox name="is_internal" checked={values.is_internal} onChange={handleChange} disabled={saving} />
                }
              />
            ) : (
              <span />
            )}
            <Button type="submit" variant="outlined" loading={saving} disabled={busy}>
              Add note
            </Button>
          </Stack>
        </Box>
      )}
    </Paper>
  )
}

/** Where the reporter rates the engineer's work. What they send is never shown again here. */
function FeedbackForm({ onGive }) {
  const { values, formError, saving, formRef, handleChange, handleSubmit, field } = useDialogForm({
    initial: { rating: '', comment: '' },
    rules: {
      rating: (value) => (value ? '' : 'Choose a rating from 1 to 5 stars'),
      comment: validateOptional('Comment', COMMENT_MAX_LENGTH),
    },
    toRequest: (form) => form,
    onSave: (form) => onGive(Number(form.rating), form.comment.trim()),
    onClose: () => {}, // sending it reloads the page, which replaces this form with a thank-you
    firstField: 'comment',
  })
  const rating = field('rating') // the stars are not a text field: only their error message is used

  return (
    <Box component="form" ref={formRef} noValidate onSubmit={handleSubmit}>
      {formError && <Alert severity="error">{formError}</Alert>}
      <Typography id="rating-label" sx={{ mt: 1 }}>
        How well was it handled? *
      </Typography>
      <Rating
        name="rating"
        aria-labelledby="rating-label"
        value={Number(values.rating) || null}
        onChange={handleChange}
        disabled={saving}
      />
      {rating.error && (
        <FormHelperText error role="alert">
          {rating.helperText}
        </FormHelperText>
      )}
      <TextField label="Comment" multiline minRows={2} {...field('comment', 'Optional')} />
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
        <Typography color="text.secondary">Only the engineer's manager will see this.</Typography>
        <Button type="submit" variant="contained" loading={saving}>
          Send feedback
        </Button>
      </Stack>
    </Box>
  )
}

/** One incident: what and where it is, its progress through the workflow, and its notes. */
export default function IncidentDetailPage() {
  const { id } = useParams()
  const { user } = useAuth()
  const navigate = useNavigate()
  const fetchIncident = useCallback(() => loadIncident(id, user.id, user.role), [id, user.id, user.role])
  const { items, loadError, retry, error, setError, busy, change, removing, setRemoving, confirmRemove } =
    useServerList(fetchIncident)
  const [moving, setMoving] = useState(null) // the move waiting in a dialog

  if (loadError) return <LoadFailed title="Incident" message={loadError} onRetry={retry} />
  if (!items) return <LoadingScreen label="Loading the incident" />

  const { incident, engineers, feedback } = items
  if (!incident) {
    return (
      <Box sx={{ p: 4, textAlign: 'center' }}>
        <Typography variant="h1" gutterBottom>
          Incident not found
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          It does not exist, or it is not one you can see.
        </Typography>
        <Button component={RouterLink} to="/incidents" variant="contained">
          Back to incidents
        </Button>
      </Box>
    )
  }

  const isAdmin = user.role === ROLES.ADMIN
  const moves = incident.next_statuses.map((to) => {
    const move = MOVES[`${incident.status}>${to}`]
    // The reporter closing a resolved incident is confirming the fix
    const label = to === 'CLOSED' && !incident.is_staff ? 'Confirm it is fixed' : move.label
    return { ...move, to, label }
  })

  // Resolves with the failure only when the dialog can show it: a problem with the reason.
  async function move(to, reason) {
    const failure = await change(() => incidents.changeStatus(incident.id, to, reason))
    if (!failure || failure.status === 400) return failure
    setError(failure.message) // e.g. someone else moved it first: show where it stands now
    retry()
    return null
  }

  const details = [
    ['Category', incident.category],
    ['Location', locationOf(incident)],
    ['Reported by', incident.reporter],
    ['Assigned to', incident.assignee ?? 'Unassigned'],
    ['Reported', formatDateTime(incident.created_at)],
    ['Last updated', formatDateTime(incident.updated_at)],
  ]

  return (
    <Stack spacing={2}>
      <Box>
        <Button component={RouterLink} to="/incidents" startIcon={<ArrowBackIcon />}>
          All incidents
        </Button>
      </Box>
      {error && (
        // Sticky, just under the top bar, so it is seen wherever the page was scrolled to
        <Alert severity="error" onClose={() => setError('')} sx={{ position: 'sticky', top: 72, zIndex: 2 }}>
          {error}
        </Alert>
      )}

      <Paper variant="outlined" sx={{ p: 2, overflowWrap: 'anywhere' }}>
        <Typography variant="h1">{incident.title}</Typography>
        <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.5, my: 1 }}>
          <StatusChip status={incident.status} />
          <PriorityChip priority={incident.priority} />
          {incident.is_escalated && <Chip size="small" color="error" variant="outlined" label="Escalated" />}
        </Stack>
        <Typography sx={{ whiteSpace: 'pre-wrap', my: 2 }}>{incident.description}</Typography>
        <Box component="dl" sx={{ display: 'grid', gap: 1.5, m: 0, gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(3, 1fr)' } }}>
          {details.map(([name, value]) => (
            <Box key={name}>
              <Typography component="dt" variant="body2" color="text.secondary">
                {name}
              </Typography>
              <Typography component="dd" sx={{ m: 0 }}>
                {value}
              </Typography>
            </Box>
          ))}
        </Box>
      </Paper>

      <Paper component="section" aria-label="Progress" variant="outlined" sx={{ p: 2 }}>
        <Typography variant="h2" gutterBottom>
          Progress
        </Typography>
        <WorkflowSteps status={incident.status} blockedReason={incident.blocked_reason} />

        <Stack direction="row" sx={{ flexWrap: 'wrap', alignItems: 'center', gap: 1, mt: 2 }}>
          {moves.map((option, index) => (
            <Button
              key={option.to}
              variant={index === 0 ? 'contained' : 'outlined'}
              disabled={busy}
              // A move that needs a reason or is final goes through a dialog; the others happen at once
              onClick={() => (option.ask || option.final ? setMoving(option) : move(option.to))}
            >
              {option.label}
            </Button>
          ))}
          {isAdmin && incident.status === 'OPEN' && !incident.assignee_id && (
            <Typography color="text.secondary">Assign an engineer to start work.</Typography>
          )}
        </Stack>

        <Typography variant="h3" sx={{ fontSize: '1rem', fontWeight: 600, mt: 3 }}>
          History
        </Typography>
        <Stack component="ol" spacing={1} sx={{ listStyle: 'none', p: 0, m: 0, mt: 1 }}>
          {incident.history.map((step, index) => (
            <Box key={index} component="li" sx={{ pl: 1.5, borderLeft: 3, borderColor: 'divider', overflowWrap: 'anywhere' }}>
              <Typography>
                {step.from_status
                  ? `${incidents.STATUS_LABELS[step.from_status]} → ${incidents.STATUS_LABELS[step.to_status]}`
                  : 'Reported'}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {step.changed_by}, {formatDateTime(step.changed_at)}
              </Typography>
              {step.reason && <Typography variant="body2">Reason: {step.reason}</Typography>}
            </Box>
          ))}
        </Stack>
      </Paper>

      {isAdmin && incident.status !== 'CLOSED' && (
        <ManagePanel
          key={incident.updated_at} // a fresh form whenever the incident has changed
          incident={incident}
          engineers={engineers}
          busy={busy}
          onSave={(priority, assigneeId) => change(() => incidents.updateIncident(incident.id, priority, assigneeId))}
          onDelete={() =>
            setRemoving({
              what: 'this incident',
              note: 'Its notes and history are removed with it.',
              // Leave first: the reload that follows every change would find nothing here
              run: () => incidents.removeIncident(incident.id).then(() => navigate('/incidents')),
            })
          }
        />
      )}

      {feedback?.given && (
        <Alert severity="success">Thank you. Your feedback was sent to the engineer's manager.</Alert>
      )}
      {feedback?.can_give && (
        <Paper component="section" aria-label="Feedback" variant="outlined" sx={{ p: 2 }}>
          <Typography variant="h2">Feedback</Typography>
          <FeedbackForm onGive={(rating, comment) => change(() => giveFeedback(incident.id, rating, comment))} />
        </Paper>
      )}

      <Notes
        key={incident.notes.length} // a fresh form once the added note is in the list
        incident={incident}
        busy={busy}
        onAdd={(body, isInternal) => change(() => incidents.addNote(incident.id, body, isInternal))}
      />

      {moving && <MoveDialog move={moving} onMove={move} onClose={() => setMoving(null)} />}
      {removing && (
        <ConfirmDialog {...removing} busy={busy} onConfirm={confirmRemove} onCancel={() => setRemoving(null)} />
      )}
    </Stack>
  )
}
