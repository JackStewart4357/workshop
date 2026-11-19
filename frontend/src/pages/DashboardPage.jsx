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
import StuckReasons from '../components/StuckReasons.jsx'
import { useAuth } from '../context/AuthContext.js'
import { PRIORITIES, PRIORITY_LABELS, STATUSES, getSummary, listIncidents } from '../services/incidentsService.js'
import { formatDate, locationOf } from '../utils/format.js'
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
const CATEGORY_TYPES = { FACILITY: 'Facility', TECHNOLOGY: 'Technology' }
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
                  flexGrow: count / longest, // below 1, a bar takes that share of the room left in its row
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

/**
 * A ranking, largest first as the API sends it: a name, a bar and the number. The bars share
 * one scale, so they compare with each other. `to` makes the name a link to that list.
 */
function RankedBars({ rows, empty }) {
  if (rows.length === 0) return <Typography color="text.secondary">{empty}</Typography>
  const longest = rows[0].count
  return (
    <Stack component="ol" spacing={1} sx={{ listStyle: 'none', p: 0, m: 0 }}>
      {rows.map(({ label, note, count, to }) => (
        <Box
          component="li"
          key={label}
          sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '260px 1fr' }, alignItems: 'center', columnGap: 1 }}
        >
          <Box sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
            {to ? (
              <Link component={RouterLink} to={to}>
                {label}
              </Link>
            ) : (
              label
            )}
            {note && (
              <Typography component="span" color="text.secondary">
                {' '}
                · {note}
              </Typography>
            )}
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Box
              aria-hidden
              sx={{ flexGrow: count / longest, height: 12, bgcolor: 'primary.main', borderRadius: '0 4px 4px 0' }}
            />
            <Typography sx={{ fontWeight: 600 }}>{count}</Typography>
          </Box>
        </Box>
      ))}
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

/**
 * How well the people who report incidents are kept up to date: how many open incidents
 * had an update their reporter could see lately, which have gone quiet, and how the
 * finished ones ended. "An update" is a status change or a public note from someone else.
 */
function KeptInformed({ informed }) {
  const { open, quiet, quietest, closed } = informed
  return (
    <Section title="Keeping reporters informed">
      {open === 0 ? (
        <Typography color="text.secondary">There are no open incidents.</Typography>
      ) : (
        <>
          <Typography>
            <strong>
              {open - quiet} of {open}
            </strong>{' '}
            open incidents had an update their reporter could see in the last 3 days
          </Typography>
          <LinearProgress
            variant="determinate"
            aria-label="Open incidents with a recent update"
            value={Math.round(((open - quiet) / open) * 100)}
            sx={{ mt: 0.5, height: 8, borderRadius: 4 }}
          />
          {quiet === 0 ? (
            <Typography color="text.secondary" sx={{ mt: 1.5 }}>
              Every open incident has had a recent update.
            </Typography>
          ) : (
            <>
              <Typography sx={{ mt: 1.5 }}>
                {quiet} {quiet === 1 ? 'has' : 'have'} been quiet for 3 days or more:
              </Typography>
              <Box component="ul" sx={{ listStyle: 'none', p: 0, m: 0 }}>
                {quietest.map((incident) => (
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
                    <StatusChip status={incident.status} />
                    <Typography variant="body2" color="text.secondary">
                      {incident.assignee ?? 'Unassigned'},{' '}
                      {incident.last_heard ? `last update ${formatDate(incident.last_heard)}` : 'no update yet'}
                    </Typography>
                  </Box>
                ))}
              </Box>
              {quiet > quietest.length && (
                <Typography color="text.secondary">and {quiet - quietest.length} more</Typography>
              )}
            </>
          )}
        </>
      )}
      {/* Outcomes: what is waiting for its reporter, and how often the reporter was the one to close it */}
      <Typography sx={{ mt: 1.5 }}>
        <Link component={RouterLink} to="/incidents?status=RESOLVED">
          {informed.awaiting_confirmation} resolved, waiting for the reporter to confirm
        </Link>
      </Typography>
      <Typography>
        {closed === 0
          ? 'No incidents have been closed yet.'
          : `${informed.confirmed_by_reporter} of ${closed} closed incidents were confirmed by their reporter`}
      </Typography>
    </Section>
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
          to="/incidents?assignee=none&status=OPEN"
        />
        <StatTile
          label="Escalated"
          value={summary.escalated_open}
          caption="still open"
          to="/incidents?escalated=true"
        />
      </Box>
      <Section title="Needs attention">
        {/* Open incidents that are blocked or escalated, the longest without an update first, each with its reason */}
        {summary.needs_attention.length === 0 && (
          <Typography color="text.secondary">Nothing is blocked or escalated.</Typography>
        )}
        <Box component="ul" sx={{ listStyle: 'none', p: 0, m: 0 }}>
          {summary.needs_attention.map((incident) => (
            <Box key={incident.id} component="li" sx={{ py: 1, borderTop: 1, borderColor: 'divider' }}>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
                <Link
                  component={RouterLink}
                  to={`/incidents/${incident.id}`}
                  sx={{ flexGrow: 1, minWidth: 0, overflowWrap: 'anywhere' }}
                >
                  {incident.title}
                </Link>
                <StatusChip status={incident.status} />
                {incident.is_escalated && <Chip size="small" color="error" variant="outlined" label="Escalated" />}
                <Typography variant="body2" color="text.secondary">
                  {incident.assignee ?? 'Unassigned'}
                </Typography>
              </Box>
              <StuckReasons incident={incident} />
            </Box>
          ))}
        </Box>
      </Section>
      <KeptInformed informed={summary.kept_informed} />
      <Section title="Incidents by priority">
        <PriorityBars counts={summary.by_priority} to={(priority) => `/incidents?priority=${priority}`} />
      </Section>
      <Section title="Most common categories">
        <RankedBars
          empty="No incidents have been reported yet."
          rows={summary.by_category.map((row) => ({
            label: row.category,
            note: CATEGORY_TYPES[row.type],
            count: row.count,
            to: `/incidents?category_id=${row.category_id}`,
          }))}
        />
      </Section>
      <Section title="Where incidents recur">
        {/* The five with the most incidents ever reported there, whatever their status */}
        <Box sx={{ display: 'grid', gap: 2 }}>
          {[
            ['Buildings', summary.by_location.buildings, (row) => `/incidents?building_id=${row.building_id}`],
            ['Floors', summary.by_location.floors],
            ['Seats', summary.by_location.seats],
          ].map(([title, places, to]) => (
            <Box key={title} role="group" aria-label={title}>
              <Typography variant="subtitle2" component="h3" gutterBottom>
                {title}
              </Typography>
              <RankedBars
                empty={`No incident names one of the ${title.toLowerCase()} yet.`}
                rows={places.map((row) => ({ label: locationOf(row), count: row.count, to: to?.(row) }))}
              />
            </Box>
          ))}
        </Box>
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
