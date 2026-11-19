import { Link as RouterLink } from 'react-router-dom'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import LinearProgress from '@mui/material/LinearProgress'
import Link from '@mui/material/Link'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import AddIcon from '@mui/icons-material/Add'
import LoadingScreen from '../components/LoadingScreen.jsx'
import StatTile from '../components/StatTile.jsx'
import { PriorityChip, StatusChip } from '../components/StatusChip.jsx'
import { useAuth } from '../context/AuthContext.js'
import { PRIORITIES, PRIORITY_LABELS, STATUSES, getSummary, listIncidents } from '../services/incidentsService.js'
import { formatDate } from '../utils/format.js'
import { useServerList } from '../utils/useServerList.js'

const ROLE_SUMMARY = {
  EMPLOYEE: 'Report facility and workplace technology issues and follow their progress.',
  ENGINEER: 'See the incidents assigned to you and keep their status up to date.',
  ADMIN: 'Manage buildings, engineers and assignments, and oversee every incident.',
}

// What each role's dashboard is drawn from. The API already limits both the numbers and
// the lists to what the person may see. An engineer's numbers are counted here from the
// incidents assigned to them, because the API's summary also counts ones they reported.
const LOADERS = {
  EMPLOYEE: async () => {
    const [summary, incidents] = await Promise.all([getSummary(), listIncidents()])
    return { summary, incidents }
  },
  ENGINEER: async () => ({ incidents: await listIncidents({ assignee: 'me' }) }),
  ADMIN: async () => ({ summary: await getSummary() }),
}

const MOST_URGENT_FIRST = [...PRIORITIES].reverse()
const RESPONSE_TIMES = [
  ['to_acknowledge', 'Acknowledged in'],
  ['to_assign', 'Assigned in'],
  ['to_resolve', 'Resolved in'],
]
// Two tiles per row on a phone, as many as fit from there up
const TILES = {
  display: 'grid',
  gap: 2,
  gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(auto-fill, minmax(150px, 1fr))' },
}

const stillOpen = (incident) => incident.status !== 'RESOLVED' && incident.status !== 'CLOSED'

/** How many of the rows have each value of one field: { OPEN: 2, IN_PROGRESS: 0, ... }. */
const tally = (rows, field, values) =>
  Object.fromEntries(values.map((value) => [value, rows.filter((row) => row[field] === value).length]))

function Section({ title, children }) {
  return (
    <Paper component="section" aria-label={title} variant="outlined" sx={{ p: 2 }}>
      <Typography variant="h2" gutterBottom>
        {title}
      </Typography>
      {children}
    </Paper>
  )
}

/** One tile per status, each a link to the incident list filtered to it. */
function StatusTiles({ counts, statuses = STATUSES, captions = {}, filter = '' }) {
  return statuses.map((status) => (
    <StatTile
      key={status}
      mark={<StatusChip status={status} />}
      value={counts[status]}
      caption={captions[status]}
      to={`/incidents?${filter}status=${status}`}
    />
  ))
}

/**
 * Incidents by priority, most urgent first. One colour and one scale, so the bars compare
 * with each other; every bar has its number written at its tip. `to` makes each name a link.
 */
function PriorityBars({ counts, to }) {
  const total = PRIORITIES.reduce((sum, priority) => sum + counts[priority], 0)
  const longest = Math.max(1, ...PRIORITIES.map((priority) => counts[priority]))
  return (
    <Stack spacing={1}>
      {MOST_URGENT_FIRST.map((priority) => {
        const count = counts[priority]
        const share = total ? Math.round((count / total) * 100) : 0
        return (
          <Tooltip key={priority} describeChild placement="top-start" title={`${count} of ${total} (${share}%)`}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Box sx={{ width: 72, flexShrink: 0 }}>
                {to ? (
                  <Link component={RouterLink} to={to(priority)}>
                    {PRIORITY_LABELS[priority]}
                  </Link>
                ) : (
                  PRIORITY_LABELS[priority]
                )}
              </Box>
              <Box
                aria-hidden
                data-testid={`bar-${priority}`}
                sx={{
                  flex: `0 1 ${(count / longest) * 100}%`,
                  height: 12,
                  bgcolor: 'primary.main',
                  borderRadius: '0 4px 4px 0', // square where it starts, rounded where the value ends
                }}
              />
              <Typography sx={{ fontWeight: 600 }}>{count}</Typography>
            </Box>
          </Tooltip>
        )
      })}
    </Stack>
  )
}

/** A short list of incidents, each a link to its page. */
function IncidentRows({ incidents, withPriority = false }) {
  return (
    <Box component="ul" sx={{ listStyle: 'none', p: 0, m: 0 }}>
      {incidents.map((incident) => (
        <Box
          key={incident.id}
          component="li"
          sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, py: 1, borderTop: 1, borderColor: 'divider' }}
        >
          <Link
            component={RouterLink}
            to={`/incidents/${incident.id}`}
            sx={{ flexGrow: 1, minWidth: 0, overflowWrap: 'anywhere' }}
          >
            {incident.title}
          </Link>
          {withPriority && <PriorityChip priority={incident.priority} />}
          <StatusChip status={incident.status} />
          <Typography variant="body2" color="text.secondary">
            {formatDate(incident.created_at)}
          </Typography>
        </Box>
      ))}
    </Box>
  )
}

function EmployeeDashboard({ summary, incidents }) {
  return (
    <>
      <Box sx={TILES}>
        <StatusTiles counts={summary.by_status} />
      </Box>
      <Section title="Your latest incidents">
        {incidents.length === 0 ? (
          <Typography color="text.secondary">
            You have not reported anything yet. Use "Report incident" when something needs fixing.
          </Typography>
        ) : (
          <IncidentRows incidents={incidents.slice(0, 5)} />
        )}
      </Section>
    </>
  )
}

function EngineerDashboard({ incidents }) {
  const open = incidents.filter(stillOpen)
  const queue = [...open].sort(
    (a, b) =>
      MOST_URGENT_FIRST.indexOf(a.priority) - MOST_URGENT_FIRST.indexOf(b.priority) ||
      a.created_at.localeCompare(b.created_at), // then the one that has waited longest
  )
  return (
    <>
      <Box sx={TILES}>
        <StatusTiles
          counts={tally(incidents, 'status', STATUSES)}
          statuses={['IN_PROGRESS', 'BLOCKED', 'OPEN', 'RESOLVED']}
          captions={{ OPEN: 'assigned, not started', RESOLVED: 'waiting for confirmation' }}
          filter="assignee=me&"
        />
      </Box>
      <Section title="Your open work by priority">
        <PriorityBars counts={tally(open, 'priority', PRIORITIES)} />
      </Section>
      <Section title="Your queue">
        {queue.length === 0 ? (
          <Typography color="text.secondary">Nothing is waiting for you.</Typography>
        ) : (
          <IncidentRows incidents={queue.slice(0, 8)} withPriority />
        )}
      </Section>
    </>
  )
}

function AdminDashboard({ summary }) {
  return (
    <>
      <Box sx={TILES}>
        <StatTile label="All incidents" value={summary.total} to="/incidents" />
        <StatusTiles counts={summary.by_status} />
        <StatTile
          label="Unassigned"
          value={summary.unassigned_open}
          caption="open, no engineer yet"
          to="/incidents?assignee=none"
        />
        <StatTile label="Escalated" value={summary.escalated_open} caption="still open" />
      </Box>
      <Section title="Incidents by priority">
        <PriorityBars counts={summary.by_priority} to={(priority) => `/incidents?priority=${priority}`} />
      </Section>
      <Section title="Work across engineers">
        {summary.by_assignee.length === 0 && <Typography color="text.secondary">There are no engineers yet.</Typography>}
        <Stack spacing={1.5}>
          {summary.by_assignee.map((engineer) => {
            const full = engineer.open >= engineer.max_open_tickets
            return (
              <Box key={engineer.assignee_id}>
                <Stack direction="row" sx={{ alignItems: 'center', flexWrap: 'wrap', columnGap: 1 }}>
                  <Link
                    component={RouterLink}
                    to={`/incidents?assignee=${engineer.assignee_id}`}
                    sx={{ minWidth: 0, overflowWrap: 'anywhere' }}
                  >
                    {engineer.assignee}
                  </Link>
                  {!engineer.is_available && <Chip size="small" label="Unavailable" />}
                  <Typography color="text.secondary" sx={{ ml: 'auto' }}>
                    {engineer.open} of {engineer.max_open_tickets} open{full && ' (at capacity)'}
                  </Typography>
                </Stack>
                <LinearProgress
                  variant="determinate"
                  aria-label={`Workload of ${engineer.assignee}`}
                  // An engineer can hold more than their maximum: the bar stops at full
                  value={Math.min(100, (engineer.open / engineer.max_open_tickets) * 100)}
                  color={full ? 'warning' : 'primary'}
                  sx={{ mt: 0.5, height: 8, borderRadius: 4 }}
                />
              </Box>
            )
          })}
        </Stack>
      </Section>
      <Section title="Response times">
        <Box sx={TILES}>
          {RESPONSE_TIMES.map(([key, label]) => {
            const hours = summary.average_hours[key] // null until an incident has got that far
            return (
              <StatTile
                key={key}
                label={label}
                value={hours === null ? '–' : `${hours} h`}
                caption={hours === null ? 'no data yet' : 'on average'}
              />
            )
          })}
        </Box>
      </Section>
    </>
  )
}

const DASHBOARDS = { EMPLOYEE: EmployeeDashboard, ENGINEER: EngineerDashboard, ADMIN: AdminDashboard }

/** The first page after signing in: the numbers and lists that matter to this person's role. */
export default function DashboardPage() {
  const { user } = useAuth()
  const { items, loadError, retry } = useServerList(LOADERS[user.role])
  const Dashboard = DASHBOARDS[user.role]

  return (
    <Stack spacing={2}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
        <Box>
          <Typography variant="h1">Welcome, {user.full_name}</Typography>
          <Typography color="text.secondary">{ROLE_SUMMARY[user.role]}</Typography>
        </Box>
        {user.role === 'EMPLOYEE' && (
          <Button component={RouterLink} to="/incidents/new" variant="contained" startIcon={<AddIcon />}>
            Report incident
          </Button>
        )}
      </Stack>
      {loadError ? (
        // The welcome stays; only the figures are missing
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={retry}>
              Try again
            </Button>
          }
        >
          {loadError}
        </Alert>
      ) : items ? (
        <Dashboard {...items} />
      ) : (
        <LoadingScreen label="Loading your dashboard" />
      )}
    </Stack>
  )
}
