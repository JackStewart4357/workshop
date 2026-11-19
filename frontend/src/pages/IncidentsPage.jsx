import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link as RouterLink, useSearchParams } from 'react-router-dom'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import FormControlLabel from '@mui/material/FormControlLabel'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemButton from '@mui/material/ListItemButton'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import AddIcon from '@mui/icons-material/Add'
import LoadFailed from '../components/LoadFailed.jsx'
import LoadingScreen from '../components/LoadingScreen.jsx'
import { PriorityChip, StatusChip } from '../components/StatusChip.jsx'
import StuckReasons from '../components/StuckReasons.jsx'
import { useAuth } from '../context/AuthContext.js'
import { ROLES } from '../navigation.js'
import { listEngineers } from '../services/engineersService.js'
import { listBuildings } from '../services/facilitiesService.js'
import * as incidents from '../services/incidentsService.js'
import { formatDateTime, locationOf } from '../utils/format.js'
import { useServerList } from '../utils/useServerList.js'

// The filters, by the names the API gives them. They live in the page address, so a
// reload, the Back button and a shared link all show the same list.
const FILTERS = ['q', 'status', 'priority', 'category_id', 'building_id', 'assignee', 'escalated']
const SEARCH_PAUSE = 400 // milliseconds without typing before a search is sent
const LIST_LIMIT = 200 // the most the API returns

const named = (labels) => Object.entries(labels).map(([value, label]) => ({ value, label }))

// What the filter bar offers. Only an admin can read the engineers, and only an admin
// filters by any assignee.
async function loadChoices() {
  const [categories, buildings] = await Promise.all([incidents.listCategories(), listBuildings()])
  return { categories, buildings, engineers: [] }
}

async function loadAdminChoices() {
  const [choices, engineers] = await Promise.all([loadChoices(), listEngineers()])
  return { ...choices, engineers }
}

/** One filter as a drop-down; its first choice ("Any") means the filter is off. */
function FilterSelect({ label, value, any = 'Any', options, onChange }) {
  return (
    <TextField
      select
      label={label}
      size="small"
      margin="none"
      // A value the list does not have (a hand-edited address) is shown as "Any"
      value={options.some((option) => option.value === value) ? value : ''}
      onChange={(event) => onChange(event.target.value)}
      slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true } }}
    >
      <MenuItem value="">{any}</MenuItem>
      {options.map((option) => (
        <MenuItem key={option.value} value={option.value}>
          {option.label}
        </MenuItem>
      ))}
    </TextField>
  )
}

/** The search box: sent on Enter, or by itself once the typing pauses. */
function SearchBox({ value, onSearch }) {
  const [text, setText] = useState(value)
  const [sent, setSent] = useState(value) // the last search this box asked for
  const [seen, setSeen] = useState(value)
  // The address changed without this box (Back, "Clear filters"): show what it says now
  if (value !== seen) {
    setSeen(value)
    if (value !== sent) {
      setSent(value)
      setText(value)
    }
  }

  const search = useCallback(
    (wanted) => {
      if (wanted === sent) return
      setSent(wanted)
      onSearch(wanted)
    },
    [sent, onSearch],
  )
  useEffect(() => {
    const timer = setTimeout(() => search(text.trim()), SEARCH_PAUSE)
    return () => clearTimeout(timer)
  }, [text, search])

  return (
    <Box
      component="form"
      role="search"
      onSubmit={(event) => {
        event.preventDefault()
        search(text.trim())
      }}
    >
      <TextField
        label="Search"
        type="search"
        size="small"
        margin="none"
        placeholder="Words in the title or description"
        value={text}
        onChange={(event) => setText(event.target.value)}
        slotProps={{ inputLabel: { shrink: true }, htmlInput: { maxLength: 100 } }}
      />
    </Box>
  )
}

/** Every incident the signed-in person may see, with search and filters. */
export default function IncidentsPage() {
  const { user } = useAuth()
  const [params, setParams] = useSearchParams()
  const address = params.toString()
  const filters = useMemo(() => {
    const asked = new URLSearchParams(address)
    return Object.fromEntries(FILTERS.map((name) => [name, asked.get(name) ?? '']))
  }, [address])
  const fetchIncidents = useCallback(() => incidents.listIncidents(filters), [filters])
  const list = useServerList(fetchIncidents)
  const choices = useServerList(user.role === ROLES.ADMIN ? loadAdminChoices : loadChoices)

  const setFilter = useCallback(
    (name, value) =>
      setParams(
        (current) => {
          const next = new URLSearchParams(current)
          if (value) next.set(name, value)
          else next.delete(name)
          return next
        },
        { replace: true },
      ),
    [setParams],
  )
  const search = useCallback((text) => setFilter('q', text), [setFilter])

  if (list.loadError || choices.loadError) {
    return (
      <LoadFailed
        title="Incidents"
        message={list.loadError || choices.loadError}
        onRetry={() => {
          list.retry()
          choices.retry()
        }}
      />
    )
  }
  if (!list.items || !choices.items) return <LoadingScreen label="Loading incidents" />

  const { categories, buildings, engineers } = choices.items
  const filtered = FILTERS.some((name) => filters[name])

  return (
    <Stack spacing={2}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="h1">Incidents</Typography>
        <Button component={RouterLink} to="/incidents/new" variant="contained" startIcon={<AddIcon />}>
          Report incident
        </Button>
      </Stack>

      <Paper
        component="section"
        aria-label="Filters"
        variant="outlined"
        sx={{
          p: 2,
          display: 'grid',
          gap: 2,
          alignItems: 'center',
          gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', lg: 'repeat(3, 1fr)' },
        }}
      >
        <SearchBox value={filters.q} onSearch={search} />
        <FilterSelect
          label="Status"
          value={filters.status}
          options={named(incidents.STATUS_LABELS)}
          onChange={(value) => setFilter('status', value)}
        />
        <FilterSelect
          label="Priority"
          value={filters.priority}
          options={named(incidents.PRIORITY_LABELS)}
          onChange={(value) => setFilter('priority', value)}
        />
        <FilterSelect
          label="Category"
          value={filters.category_id}
          options={categories.map((category) => ({ value: category.id, label: category.name }))}
          onChange={(value) => setFilter('category_id', value)}
        />
        <FilterSelect
          label="Building"
          value={filters.building_id}
          options={buildings.map((building) => ({ value: building.id, label: building.name }))}
          onChange={(value) => setFilter('building_id', value)}
        />
        {user.role === ROLES.ADMIN && (
          <FilterSelect
            label="Assignee"
            any="Anyone"
            value={filters.assignee}
            options={[
              { value: 'none', label: 'Unassigned' },
              ...engineers.map((engineer) => ({ value: engineer.id, label: engineer.full_name })),
            ]}
            onChange={(value) => setFilter('assignee', value)}
          />
        )}
        {user.role === ROLES.ENGINEER && (
          <FormControlLabel
            label="Assigned to me"
            control={
              <Switch
                checked={filters.assignee === 'me'}
                onChange={(event) => setFilter('assignee', event.target.checked ? 'me' : '')}
              />
            }
          />
        )}
        <FormControlLabel
          label="Escalated only"
          control={
            <Switch
              checked={filters.escalated === 'true'}
              onChange={(event) => setFilter('escalated', event.target.checked ? 'true' : '')}
            />
          }
        />
        {filtered && (
          <Button onClick={() => setParams({}, { replace: true })} sx={{ justifySelf: 'start' }}>
            Clear filters
          </Button>
        )}
      </Paper>

      {list.items.length === 0 && (
        <Typography color="text.secondary">
          {filtered ? 'No incidents match these filters.' : 'No incidents yet.'}
        </Typography>
      )}
      {list.items.length === LIST_LIMIT && (
        <Typography color="text.secondary">
          Showing the newest {LIST_LIMIT}. Narrow the filters to see others.
        </Typography>
      )}

      {list.items.length > 0 && (
        <Paper variant="outlined">
          <List disablePadding aria-label="Incidents">
            {list.items.map((incident, index) => (
              <ListItem key={incident.id} disablePadding divider={index < list.items.length - 1}>
                <ListItemButton
                  component={RouterLink}
                  to={`/incidents/${incident.id}`}
                  // Stacked on a phone; three columns side by side from tablet width up
                  sx={{
                    display: 'grid',
                    gap: { xs: 0.5, md: 2 },
                    alignItems: 'start',
                    gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 5fr) minmax(0, 4fr) minmax(0, 4fr)' },
                    overflowWrap: 'anywhere',
                  }}
                >
                  <Box>
                    <Typography sx={{ fontWeight: 600 }}>{incident.title}</Typography>
                    <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
                      <StatusChip status={incident.status} />
                      <PriorityChip priority={incident.priority} />
                      {incident.is_escalated && <Chip size="small" color="error" variant="outlined" label="Escalated" />}
                    </Stack>
                    <StuckReasons incident={incident} />
                  </Box>
                  <Box>
                    <Typography>{incident.category}</Typography>
                    <Typography color="text.secondary">{locationOf(incident)}</Typography>
                  </Box>
                  <Box>
                    <Typography>{incident.assignee ? `Assigned to ${incident.assignee}` : 'Unassigned'}</Typography>
                    <Typography color="text.secondary">
                      Reported by {incident.reporter}, {formatDateTime(incident.created_at)}
                    </Typography>
                    {/* Only once something has happened to it since it was reported */}
                    {incident.updated_at !== incident.created_at && (
                      <Typography color="text.secondary">Updated {formatDateTime(incident.updated_at)}</Typography>
                    )}
                  </Box>
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        </Paper>
      )}
    </Stack>
  )
}
