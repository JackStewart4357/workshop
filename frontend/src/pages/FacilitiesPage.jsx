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
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ConfirmDialog from '../components/ConfirmDialog.jsx'
import LoadFailed from '../components/LoadFailed.jsx'
import LoadingScreen from '../components/LoadingScreen.jsx'
import ShowMore from '../components/ShowMore.jsx'
import * as facilities from '../services/facilitiesService.js'
import { focusOnOpen, useDialogForm } from '../utils/useDialogForm.js'
import { useServerList } from '../utils/useServerList.js'
import { useShowMore } from '../utils/useShowMore.js'
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
// Any building can be folded to one line, taking its floors and seats with it. Up to this
// many buildings start open. With more, the page opens short: a search box, every building
// folded, and a page of them at a time.
const FEW_BUILDINGS = 5
const PAGE_SIZE = 20
const counted = (count, thing) => `${count} ${thing}${count === 1 ? '' : 's'}`

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
          <TextField label="Name" inputRef={focusOnOpen} required {...field('name')} />
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

/**
 * A one-field dialog for correcting what is already there: a floor's number or a seat's code.
 * `name` is the API's name for the field, so its complaint about it lands under the field.
 */
function ChangeDialog({ title, label, name, type = 'text', value, validate, onSave, onClose }) {
  const { formError, saving, formRef, handleSubmit, field } = useDialogForm({
    initial: { [name]: String(value) },
    rules: { [name]: validate },
    toRequest: (values) => values[name].trim(),
    onSave,
    onClose,
    firstField: name,
  })

  return (
    <Dialog open onClose={saving ? undefined : onClose} fullWidth maxWidth="xs" aria-labelledby="change-dialog-title">
      <Box component="form" ref={formRef} noValidate onSubmit={handleSubmit}>
        <DialogTitle id="change-dialog-title">{title}</DialogTitle>
        <DialogContent>
          {formError && <Alert severity="error">{formError}</Alert>}
          <TextField label={label} type={type} inputRef={focusOnOpen} required {...field(name)} />
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
  const [changing, setChanging] = useState(null) // the floor or seat in the one-field dialog, with how to save it
  const [search, setSearch] = useState('')
  const [toggled, setToggled] = useState({}) // buildings opened or folded by hand: { id: open }

  const all = buildings ?? []
  const many = all.length > FEW_BUILDINGS
  const wanted = many ? search.trim().toLowerCase() : ''
  const found = wanted
    ? all.filter((building) => [building.name, building.address].some((text) => text.toLowerCase().includes(wanted)))
    : all
  const paging = useShowMore(found, PAGE_SIZE)
  const isOpen = (building) => toggled[building.id] ?? !many

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
      {many && (
        <TextField
          label="Find a building"
          type="search"
          size="small"
          margin="none"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          helperText="By name or address"
        />
      )}
      {many && found.length === 0 && <Typography color="text.secondary">No buildings match.</Typography>}

      {paging.visible.map((building) => (
        <Paper key={building.id} component="section" aria-label={building.name} variant="outlined" sx={{ p: 2 }}>
          <Stack direction="row" sx={{ alignItems: 'flex-start', gap: 0.5 }}>
            {/* Folding a building folds its floors and seats with it */}
            <IconButton
              aria-label={`${isOpen(building) ? 'Hide' : 'Show'} ${building.name}`}
              aria-expanded={isOpen(building)}
              onClick={() => setToggled((current) => ({ ...current, [building.id]: !isOpen(building) }))}
            >
              {isOpen(building) ? <ExpandLessIcon /> : <ExpandMoreIcon />}
            </IconButton>
            <Box sx={{ flexGrow: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
              <Typography variant="h2">{building.name}</Typography>
              <Typography color="text.secondary">{building.address}</Typography>
              {!isOpen(building) && (
                <Typography color="text.secondary">
                  {counted(building.floors.length, 'floor')},{' '}
                  {counted(
                    building.floors.reduce((seats, floor) => seats + floor.seats.length, 0),
                    'seat',
                  )}
                </Typography>
              )}
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

          {isOpen(building) && (
            <>
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
                        aria-label={`Change ${label}`}
                        onClick={() =>
                          setChanging({
                            title: `Change ${label} of ${building.name}`,
                            label: 'Floor number',
                            name: 'level',
                            type: 'number',
                            value: floor.level,
                            validate: validateFloorLevel,
                            save: (level) => facilities.updateFloor(floor.id, Number(level)),
                          })
                        }
                        disabled={busy}
                      >
                        <EditIcon fontSize="small" />
                      </IconButton>
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
                    <Box
                      sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, mb: 1.5, minHeight: 32 }}
                    >
                      {floor.seats.length === 0 && <Typography color="text.secondary">No seats yet</Typography>}
                      {floor.seats.map((seat) => (
                        <Chip
                          key={seat.id}
                          label={seat.code}
                          disabled={busy}
                          // The chip itself opens the code for correcting; its cross still removes the seat
                          aria-label={`Change seat ${seat.code}`}
                          onClick={() =>
                            setChanging({
                              title: `Change seat ${seat.code}`,
                              label: 'Seat code',
                              name: 'code',
                              value: seat.code,
                              validate: validateSeatCode,
                              save: (code) => facilities.updateSeat(seat.id, code),
                            })
                          }
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
            </>
          )}
        </Paper>
      ))}
      <ShowMore {...paging} />

      {editing && (
        <BuildingDialog
          building={editing}
          onSave={(fields) =>
            change(() => (editing.id ? facilities.updateBuilding(editing.id, fields) : facilities.addBuilding(fields)))
          }
          onClose={() => setEditing(null)}
        />
      )}
      {changing && (
        <ChangeDialog
          {...changing}
          onSave={(value) => change(() => changing.save(value))}
          onClose={() => setChanging(null)}
        />
      )}
      {removing && (
        <ConfirmDialog {...removing} busy={busy} onConfirm={confirmRemove} onCancel={() => setRemoving(null)} />
      )}
    </Stack>
  )
}
