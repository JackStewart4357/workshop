import { Link as RouterLink, useNavigate } from 'react-router-dom'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ListSubheader from '@mui/material/ListSubheader'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import LoadFailed from '../components/LoadFailed.jsx'
import LoadingScreen from '../components/LoadingScreen.jsx'
import { floorLabel, listBuildings } from '../services/facilitiesService.js'
import * as incidents from '../services/incidentsService.js'
import { useDialogForm } from '../utils/useDialogForm.js'
import { useServerList } from '../utils/useServerList.js'
import { DESCRIPTION_MAX_LENGTH, TITLE_MAX_LENGTH, validateRequired } from '../utils/validation.js'

const RULES = {
  title: validateRequired('Title', TITLE_MAX_LENGTH),
  description: validateRequired('Description', DESCRIPTION_MAX_LENGTH),
  category_id: (value) => (value ? '' : 'Choose a category from the list'),
  building_id: (value) => (value ? '' : 'Choose a building from the list'),
}
const CATEGORY_TYPES = { FACILITY: 'Facility', TECHNOLOGY: 'Technology' }
// What sits inside what: choosing another building empties the floor and the seat
const INSIDE = { building_id: ['floor_id', 'seat_id'], floor_id: ['seat_id'] }

// The lists the form chooses from
async function loadChoices() {
  const [categories, buildings] = await Promise.all([incidents.listCategories(), listBuildings()])
  return { categories, buildings }
}

function ReportForm({ categories, buildings }) {
  const navigate = useNavigate()
  const { values, formError, saving, formRef, handleChange, handleSubmit, field } = useDialogForm({
    initial: { title: '', description: '', category_id: '', priority: 'MEDIUM', building_id: '', floor_id: '', seat_id: '' },
    rules: RULES,
    toRequest: (form) => ({
      ...form,
      title: form.title.trim(),
      description: form.description.trim(),
      floor_id: form.floor_id || null, // the floor and the seat are optional
      seat_id: form.seat_id || null,
    }),
    // Resolves with the error, or goes to the new incident when it worked
    onSave: (fields) =>
      incidents.reportIncident(fields).then(
        (incident) => navigate(`/incidents/${incident.id}`),
        (failure) => failure,
      ),
    onClose: () => {}, // nothing to close: the page has already moved on
    firstField: 'title',
  })
  const floors = buildings.find((building) => building.id === values.building_id)?.floors ?? []
  const seats = floors.find((floor) => floor.id === values.floor_id)?.seats ?? []

  function handlePlace(event) {
    handleChange(event)
    INSIDE[event.target.name].forEach((name) => handleChange({ target: { name, value: '' } }))
  }

  return (
    <Paper variant="outlined" sx={{ p: 2, maxWidth: 720 }}>
      <Box component="form" ref={formRef} noValidate onSubmit={handleSubmit}>
        {formError && <Alert severity="error">{formError}</Alert>}
        <TextField label="Title" autoFocus required {...field('title', 'A short summary, for example "Projector will not turn on"')} />
        <TextField
          label="Description"
          required
          multiline
          minRows={4}
          {...field('description', 'What is wrong, and anything that helps an engineer find and fix it')}
        />
        <TextField select label="Category" required {...field('category_id')}>
          {Object.entries(CATEGORY_TYPES).flatMap(([type, label]) => [
            <ListSubheader key={type}>{label}</ListSubheader>,
            ...categories
              .filter((category) => category.type === type)
              .map((category) => (
                <MenuItem key={category.id} value={category.id}>
                  {category.name}
                </MenuItem>
              )),
          ])}
        </TextField>
        <TextField select label="Priority" {...field('priority', 'How urgent it is for you; an admin may change it')}>
          {Object.entries(incidents.PRIORITY_LABELS).map(([priority, label]) => (
            <MenuItem key={priority} value={priority}>
              {label}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          label="Building"
          required
          {...field('building_id', buildings.length ? '' : 'There are no buildings yet. A facility admin adds them under Facilities.')}
          onChange={handlePlace}
        >
          {buildings.map((building) => (
            <MenuItem key={building.id} value={building.id}>
              {building.name}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          label="Floor"
          {...field('floor_id', !values.building_id ? 'Choose a building first' : floors.length ? 'Optional' : 'This building has no floors listed')}
          onChange={handlePlace}
          disabled={saving || floors.length === 0}
        >
          <MenuItem value="">Not sure</MenuItem>
          {floors.map((floor) => (
            <MenuItem key={floor.id} value={floor.id}>
              {floorLabel(floor.level)}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          label="Seat"
          {...field('seat_id', !values.floor_id ? 'Choose a floor first' : seats.length ? 'Optional' : 'This floor has no seats listed')}
          disabled={saving || seats.length === 0}
        >
          <MenuItem value="">Not at a seat</MenuItem>
          {seats.map((seat) => (
            <MenuItem key={seat.id} value={seat.id}>
              {seat.code}
            </MenuItem>
          ))}
        </TextField>
        <Stack direction="row" sx={{ gap: 1, mt: 2, justifyContent: 'flex-end' }}>
          <Button component={RouterLink} to="/incidents" disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="contained" loading={saving}>
            Report incident
          </Button>
        </Stack>
      </Box>
    </Paper>
  )
}

/** The form anyone signed in uses to report an incident. */
export default function ReportIncidentPage() {
  const { items, loadError, retry } = useServerList(loadChoices)

  if (loadError) return <LoadFailed title="Report an incident" message={loadError} onRetry={retry} />
  if (!items) return <LoadingScreen label="Loading the form" />

  return (
    <Stack spacing={2}>
      <Typography variant="h1">Report an incident</Typography>
      <ReportForm {...items} />
    </Stack>
  )
}
