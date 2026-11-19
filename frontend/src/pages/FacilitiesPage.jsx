import { useRef, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import AddIcon from '@mui/icons-material/Add'
import CancelIcon from '@mui/icons-material/Cancel'
import DeleteIcon from '@mui/icons-material/DeleteOutlined'
import EditIcon from '@mui/icons-material/Edit'
import ConfirmDialog from '../components/ConfirmDialog.jsx'
import LoadFailed from '../components/LoadFailed.jsx'
import LoadingScreen from '../components/LoadingScreen.jsx'
import * as facilities from '../services/facilitiesService.js'
import { useDialogForm } from '../utils/useDialogForm.js'
import { useServerList } from '../utils/useServerList.js'
import {
  ADDRESS_MAX_LENGTH,
  NAME_MAX_LENGTH,
  SEAT_CODE_MAX_LENGTH,
  validateFloorLevel,
  validateRequired,
} from '../utils/validation.js'

const BUILDING_RULES = {
  name: validateRequired('Name', NAME_MAX_LENGTH),
  address: validateRequired('Address', ADDRESS_MAX_LENGTH),
}
const validateSeatCode = validateRequired('Seat code', SEAT_CODE_MAX_LENGTH)

/** The form for a new building, or for changing an existing one's name and address. */
function BuildingDialog({ building, onSave, onClose }) {
  const { formError, saving, formRef, handleSubmit, field } = useDialogForm({
    initial: { name: building.name ?? '', address: building.address ?? '' },
    rules: BUILDING_RULES,
    toRequest: (values) => ({ name: values.name.trim(), address: values.address.trim() }),
    onSave,
    onClose,
    firstField: 'name',
  })

  return (
    <Dialog open onClose={saving ? undefined : onClose} fullWidth maxWidth="xs" aria-labelledby="building-dialog-title">
      <Box component="form" ref={formRef} noValidate onSubmit={handleSubmit}>
        <DialogTitle id="building-dialog-title">{building.id ? 'Edit building' : 'Add building'}</DialogTitle>
        <DialogContent>
          {formError && <Alert severity="error">{formError}</Alert>}
          <TextField label="Name" autoFocus required {...field('name')} />
          <TextField label="Address" required {...field('address')} />
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

/** A one-field "add" form, used for a floor (its number) and for a seat (its code). */
function InlineAdd({ label, button, type = 'text', validate, onAdd, busy }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const input = useRef(null)

  async function handleSubmit(event) {
    event.preventDefault()
    const problem = validate(value)
    setError(problem)
    if (problem) return

    const failure = await onAdd(value.trim())
    if (failure) setError(Object.values(failure.fieldErrors)[0] || failure.message)
    else setValue('')
    // The field is never disabled, so the keyboard stays here: ready for the next one
    input.current?.focus()
  }

  return (
    <Box component="form" noValidate onSubmit={handleSubmit} sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
      <TextField
        label={label}
        type={type}
        size="small"
        margin="none"
        fullWidth={false}
        inputRef={input}
        value={value}
        onChange={(event) => {
          setValue(event.target.value)
          setError('')
        }}
        error={Boolean(error)}
        helperText={error}
      />
      <Button type="submit" disabled={busy} sx={{ whiteSpace: 'nowrap' }}>
        {button}
      </Button>
    </Box>
  )
}

/** The one admin screen for buildings, their floors and the seats on each floor. */
export default function FacilitiesPage() {
  const {
    items: buildings, // null until the first load finishes
    loadError,
    retry,
    error,
    setError,
    busy,
    change,
    removing, // { what, note, run } waiting for confirmation
    setRemoving,
    confirmRemove,
  } = useServerList(facilities.listBuildings)
  const [editing, setEditing] = useState(null) // the building in the dialog; {} for a new one

  if (loadError) return <LoadFailed title="Facilities" message={loadError} onRetry={retry} />
  if (!buildings) return <LoadingScreen label="Loading facilities" />

  return (
    <Stack spacing={2}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="h1">Facilities</Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setEditing({})} disabled={busy}>
          Add building
        </Button>
      </Stack>
      {error && (
        // Sticky, just under the top bar: the row that could not be removed may be far down the page
        <Alert severity="error" onClose={() => setError('')} sx={{ position: 'sticky', top: 72, zIndex: 2 }}>
          {error}
        </Alert>
      )}
      {buildings.length === 0 && <Typography color="text.secondary">There are no buildings yet.</Typography>}

      {buildings.map((building) => (
        <Paper key={building.id} component="section" aria-label={building.name} variant="outlined" sx={{ p: 2 }}>
          <Stack direction="row" sx={{ alignItems: 'flex-start', gap: 0.5 }}>
            <Box sx={{ flexGrow: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
              <Typography variant="h2">{building.name}</Typography>
              <Typography color="text.secondary">{building.address}</Typography>
            </Box>
            <IconButton aria-label={`Edit ${building.name}`} onClick={() => setEditing(building)} disabled={busy}>
              <EditIcon />
            </IconButton>
            <IconButton
              aria-label={`Remove ${building.name}`}
              onClick={() =>
                setRemoving({
                  what: building.name,
                  note: 'Its floors and seats are removed with it.',
                  run: () => facilities.removeBuilding(building.id),
                })
              }
              disabled={busy}
            >
              <DeleteIcon />
            </IconButton>
          </Stack>

          {building.floors.map((floor) => {
            const label = facilities.floorLabel(floor.level)
            return (
              <Box
                key={floor.id}
                role="group"
                aria-label={label}
                sx={{ mt: 2, pt: 1, borderTop: 1, borderColor: 'divider' }}
              >
                <Stack direction="row" sx={{ alignItems: 'center' }}>
                  <Typography sx={{ flexGrow: 1, fontWeight: 600 }}>{label}</Typography>
                  <IconButton
                    size="small"
                    aria-label={`Remove ${label}`}
                    onClick={() =>
                      setRemoving({
                        what: `${label} of ${building.name}`,
                        note: 'Its seats are removed with it.',
                        run: () => facilities.removeFloor(floor.id),
                      })
                    }
                    disabled={busy}
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Stack>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, mb: 1.5, minHeight: 32 }}>
                  {floor.seats.length === 0 && <Typography color="text.secondary">No seats yet</Typography>}
                  {floor.seats.map((seat) => (
                    <Chip
                      key={seat.id}
                      label={seat.code}
                      disabled={busy}
                      deleteIcon={<CancelIcon titleAccess={`Remove seat ${seat.code}`} />}
                      onDelete={() =>
                        setRemoving({ what: `seat ${seat.code}`, run: () => facilities.removeSeat(seat.id) })
                      }
                    />
                  ))}
                </Box>
                <InlineAdd
                  label="Seat code"
                  button="Add seat"
                  validate={validateSeatCode}
                  onAdd={(code) => change(() => facilities.addSeat(floor.id, code))}
                  busy={busy}
                />
              </Box>
            )
          })}

          <Box sx={{ mt: 2, pt: 2, borderTop: 1, borderColor: 'divider' }}>
            <InlineAdd
              label="Floor number"
              button="Add floor"
              type="number"
              validate={validateFloorLevel}
              onAdd={(level) => change(() => facilities.addFloor(building.id, Number(level)))}
              busy={busy}
            />
          </Box>
        </Paper>
      ))}

      {editing && (
        <BuildingDialog
          building={editing}
          onSave={(fields) =>
            change(() => (editing.id ? facilities.updateBuilding(editing.id, fields) : facilities.addBuilding(fields)))
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
