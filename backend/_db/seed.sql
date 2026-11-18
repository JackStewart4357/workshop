-- Demo data for local development and demos. Run after schema.sql:
--   psql -h localhost -U postgres -d postgres -f backend/_db/seed.sql
--
-- Safe to run repeatedly: every row has a fixed id and existing rows are left alone.
-- NOT for production: every account below shares the password  Password123
-- (stored as a bcrypt hash, cost 10).

BEGIN;

-- ---------------------------------------------------------------------------
-- Users: 1 admin, 3 engineers, 4 employees
-- ---------------------------------------------------------------------------
INSERT INTO users (id, email, full_name, password_hash, role) VALUES
    ('10000000-0000-4000-8000-000000000001', 'admin@acme.inc', 'Facility Admin', '$2b$10$.kLFyFbFHr4G2YPCu65i.e4nTs.40Oqv5RgHnl7hgpyRIChvGXKWi', 'ADMIN'),
    ('10000000-0000-4000-8000-000000000002', 'priya.engineer@acme.inc', 'Priya Sharma', '$2b$10$.kLFyFbFHr4G2YPCu65i.e4nTs.40Oqv5RgHnl7hgpyRIChvGXKWi', 'ENGINEER'),
    ('10000000-0000-4000-8000-000000000003', 'marco.engineer@acme.inc', 'Marco Rossi', '$2b$10$.kLFyFbFHr4G2YPCu65i.e4nTs.40Oqv5RgHnl7hgpyRIChvGXKWi', 'ENGINEER'),
    ('10000000-0000-4000-8000-000000000004', 'lena.engineer@acme.inc', 'Lena Fischer', '$2b$10$.kLFyFbFHr4G2YPCu65i.e4nTs.40Oqv5RgHnl7hgpyRIChvGXKWi', 'ENGINEER'),
    ('10000000-0000-4000-8000-000000000005', 'alice@acme.inc', 'Alice Johnson', '$2b$10$.kLFyFbFHr4G2YPCu65i.e4nTs.40Oqv5RgHnl7hgpyRIChvGXKWi', 'EMPLOYEE'),
    ('10000000-0000-4000-8000-000000000006', 'bob@acme.inc', 'Bob Williams', '$2b$10$.kLFyFbFHr4G2YPCu65i.e4nTs.40Oqv5RgHnl7hgpyRIChvGXKWi', 'EMPLOYEE'),
    ('10000000-0000-4000-8000-000000000007', 'chen@acme.inc', 'Chen Wei', '$2b$10$.kLFyFbFHr4G2YPCu65i.e4nTs.40Oqv5RgHnl7hgpyRIChvGXKWi', 'EMPLOYEE'),
    ('10000000-0000-4000-8000-000000000008', 'dana@acme.inc', 'Dana Okafor', '$2b$10$.kLFyFbFHr4G2YPCu65i.e4nTs.40Oqv5RgHnl7hgpyRIChvGXKWi', 'EMPLOYEE')
ON CONFLICT DO NOTHING;

-- Lena is unavailable (on leave) but still holds tickets, to exercise reassignment.
INSERT INTO engineer_profiles (id, user_id, specialism, is_available, max_open_tickets) VALUES
    ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'Network & IT hardware',  TRUE,  5),
    ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003', 'Electrical & software',  TRUE,  4),
    ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000004', 'HVAC & general facility', FALSE, 3)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Facilities: 2 buildings, 5 floors, 10 seats
-- ---------------------------------------------------------------------------
INSERT INTO buildings (id, name, address) VALUES
    ('30000000-0000-4000-8000-000000000001', 'Headquarters', '1 Acme Plaza, London'),
    ('30000000-0000-4000-8000-000000000002', 'Riverside Annex', '25 Wharf Road, London')
ON CONFLICT DO NOTHING;

INSERT INTO floors (id, building_id, level) VALUES
    ('40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 0),
    ('40000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000001', 1),
    ('40000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000001', 2),
    ('40000000-0000-4000-8000-000000000004', '30000000-0000-4000-8000-000000000002', 0),
    ('40000000-0000-4000-8000-000000000005', '30000000-0000-4000-8000-000000000002', 1)
ON CONFLICT DO NOTHING;

INSERT INTO seats (id, floor_id, code) VALUES
    ('50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'GF-A01'),
    ('50000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000001', 'GF-A02'),
    ('50000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000002', '1F-A01'),
    ('50000000-0000-4000-8000-000000000004', '40000000-0000-4000-8000-000000000002', '1F-B07'),
    ('50000000-0000-4000-8000-000000000005', '40000000-0000-4000-8000-000000000003', '2F-A14'),
    ('50000000-0000-4000-8000-000000000006', '40000000-0000-4000-8000-000000000003', '2F-A15'),
    ('50000000-0000-4000-8000-000000000007', '40000000-0000-4000-8000-000000000004', 'GF-R01'),
    ('50000000-0000-4000-8000-000000000008', '40000000-0000-4000-8000-000000000004', 'GF-R02'),
    ('50000000-0000-4000-8000-000000000009', '40000000-0000-4000-8000-000000000005', '1F-R01'),
    ('50000000-0000-4000-8000-000000000010', '40000000-0000-4000-8000-000000000005', '1F-R02')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Incidents: 12, covering every status, priority, escalation, blocking and a duplicate.
-- Seat 2F-A14 has repeated HVAC problems (incidents 1 and 8) for the "recurring issues" report.
-- Times are relative to when the seed first runs.
-- ---------------------------------------------------------------------------
INSERT INTO incidents (
    id, title, description, status, priority, category_id,
    building_id, floor_id, seat_id, reporter_id, assignee_id,
    is_escalated, escalation_reason, escalated_by, escalated_at, blocked_reason, duplicate_of,
    created_at, updated_at, acknowledged_at, assigned_at, resolved_at, closed_at
)
SELECT
    v.id, v.title, v.description, v.status, v.priority, c.id,
    v.building_id, v.floor_id, v.seat_id, v.reporter_id, v.assignee_id,
    v.escalation_reason IS NOT NULL, v.escalation_reason,
    CASE WHEN v.escalation_reason IS NOT NULL THEN v.reporter_id END,
    now() - v.escalated_ago, v.blocked_reason, v.duplicate_of,
    now() - v.created_ago, now() - v.updated_ago, now() - v.acknowledged_ago,
    now() - v.assigned_ago, now() - v.resolved_ago, now() - v.closed_ago
FROM (VALUES
    -- 1: brand new, nobody has looked at it yet
    ('70000000-0000-4000-8000-000000000001'::uuid, 'Air conditioning blowing warm air',
     'The vent above my desk has been blowing warm air since this morning.',
     'OPEN', 'MEDIUM', 'HVAC',
     '30000000-0000-4000-8000-000000000001'::uuid, '40000000-0000-4000-8000-000000000003'::uuid, '50000000-0000-4000-8000-000000000005'::uuid,
     '10000000-0000-4000-8000-000000000005'::uuid, NULL::uuid,
     NULL::text, NULL::interval, NULL::text, NULL::uuid,
     interval '2 hours', interval '2 hours', NULL::interval, NULL::interval, NULL::interval, NULL::interval),
    -- 2: open, unassigned and escalated by the reporter
    ('70000000-0000-4000-8000-000000000002', 'Wi-Fi keeps dropping in meeting room',
     'Connection drops every few minutes on the first floor, calls are unusable.',
     'OPEN', 'HIGH', 'Network',
     '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', NULL,
     '10000000-0000-4000-8000-000000000006', NULL,
     'Client workshop tomorrow in this room', interval '3 hours', NULL, NULL,
     interval '1 day', interval '3 hours', NULL, NULL, NULL, NULL),
    -- 3: being worked on
    ('70000000-0000-4000-8000-000000000003', 'Docking station not detecting monitors',
     'Neither external monitor is detected when I dock my laptop.',
     'IN_PROGRESS', 'HIGH', 'Hardware',
     '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000004',
     '10000000-0000-4000-8000-000000000007', '20000000-0000-4000-8000-000000000001',
     NULL, NULL, NULL, NULL,
     interval '2 days', interval '5 hours', interval '2 days' - interval '30 minutes', interval '2 days' - interval '30 minutes', NULL, NULL),
    -- 4: being worked on
    ('70000000-0000-4000-8000-000000000004', 'Flickering ceiling lights',
     'The lights over the ground floor desks flicker constantly.',
     'IN_PROGRESS', 'MEDIUM', 'Electrical',
     '30000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000004', '50000000-0000-4000-8000-000000000007',
     '10000000-0000-4000-8000-000000000008', '20000000-0000-4000-8000-000000000002',
     NULL, NULL, NULL, NULL,
     interval '3 days', interval '1 day', interval '3 days' - interval '4 hours', interval '3 days' - interval '4 hours', NULL, NULL),
    -- 5: critical, blocked and escalated
    ('70000000-0000-4000-8000-000000000005', 'No network on the whole first floor of the Annex',
     'Every wired and wireless connection on the floor is down.',
     'BLOCKED', 'CRITICAL', 'Network',
     '30000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000005', NULL,
     '10000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000001',
     'Twenty people cannot work', interval '20 hours', 'Waiting for a replacement switch from the supplier', NULL,
     interval '1 day', interval '6 hours', interval '1 day' - interval '10 minutes', interval '1 day' - interval '15 minutes', NULL, NULL),
    -- 6: blocked, low priority, assigned to the unavailable engineer
    ('70000000-0000-4000-8000-000000000006', 'Broken desk chair',
     'The gas lift on my chair has failed and it sinks to the floor.',
     'BLOCKED', 'LOW', 'Furniture',
     '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000002',
     '10000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000003',
     NULL, NULL, 'Replacement part on order, due next week', NULL,
     interval '6 days', interval '4 days', interval '5 days', interval '5 days', NULL, NULL),
    -- 7: fixed, waiting for the reporter to confirm
    ('70000000-0000-4000-8000-000000000007', 'Cannot install the design software',
     'The installer fails with a licence error.',
     'RESOLVED', 'MEDIUM', 'Software',
     '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000003', '50000000-0000-4000-8000-000000000006',
     '10000000-0000-4000-8000-000000000007', '20000000-0000-4000-8000-000000000002',
     NULL, NULL, NULL, NULL,
     interval '4 days', interval '1 day', interval '4 days' - interval '1 hour', interval '4 days' - interval '2 hours', interval '1 day', NULL),
    -- 8: earlier HVAC fault at the same seat as incident 1
    ('70000000-0000-4000-8000-000000000008', 'Office too cold near the window',
     'The air conditioning will not respond to the thermostat.',
     'RESOLVED', 'HIGH', 'HVAC',
     '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000003', '50000000-0000-4000-8000-000000000005',
     '10000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000003',
     NULL, NULL, NULL, NULL,
     interval '10 days', interval '8 days', interval '10 days' - interval '3 hours', interval '10 days' - interval '3 hours', interval '8 days', NULL),
    -- 9: closed
    ('70000000-0000-4000-8000-000000000009', 'Kitchen spill not cleaned',
     'Coffee spill by the ground floor kitchen has been there all morning.',
     'CLOSED', 'LOW', 'Cleaning',
     '30000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000004', NULL,
     '10000000-0000-4000-8000-000000000008', '20000000-0000-4000-8000-000000000003',
     NULL, NULL, NULL, NULL,
     interval '14 days', interval '13 days', interval '14 days' - interval '20 minutes', interval '14 days' - interval '30 minutes', interval '14 days' - interval '2 hours', interval '13 days'),
    -- 10: closed
    ('70000000-0000-4000-8000-000000000010', 'Projector has no sound',
     'Video works in the boardroom but there is no audio from the speakers.',
     'CLOSED', 'MEDIUM', 'Audio / Video',
     '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', NULL,
     '10000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000001',
     NULL, NULL, NULL, NULL,
     interval '12 days', interval '9 days', interval '12 days' - interval '1 hour', interval '12 days' - interval '2 hours', interval '10 days', interval '9 days'),
    -- 11: closed by the admin as a duplicate of incident 3
    ('70000000-0000-4000-8000-000000000011', 'Monitors not working with dock',
     'Same desk as my colleague: the dock does not drive the screens.',
     'CLOSED', 'MEDIUM', 'Hardware',
     '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000004',
     '10000000-0000-4000-8000-000000000008', NULL,
     NULL, NULL, NULL, '70000000-0000-4000-8000-000000000003',
     interval '2 days' - interval '1 hour', interval '2 days' - interval '3 hours', interval '2 days' - interval '3 hours', NULL, NULL, interval '2 days' - interval '3 hours'),
    -- 12: building-level problem with no floor or seat
    ('70000000-0000-4000-8000-000000000012', 'Leak at the Annex main entrance',
     'Water is dripping from the canopy over the front door when it rains.',
     'OPEN', 'MEDIUM', 'Plumbing',
     '30000000-0000-4000-8000-000000000002', NULL, NULL,
     '10000000-0000-4000-8000-000000000007', NULL,
     NULL, NULL, NULL, NULL,
     interval '5 hours', interval '5 hours', NULL, NULL, NULL, NULL)
) AS v (
    id, title, description, status, priority, category,
    building_id, floor_id, seat_id, reporter_id, assignee_id,
    escalation_reason, escalated_ago, blocked_reason, duplicate_of,
    created_ago, updated_ago, acknowledged_ago, assigned_ago, resolved_ago, closed_ago
)
JOIN categories c ON c.name = v.category
ORDER BY v.id                      -- incident 3 must exist before its duplicate, incident 11
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Status history: one row per transition, starting with creation (from_status NULL).
-- ---------------------------------------------------------------------------
INSERT INTO incident_status_history (id, incident_id, from_status, to_status, changed_by, reason, changed_at)
SELECT v.id, v.incident_id, v.from_status, v.to_status, v.changed_by, v.reason, now() - v.ago
FROM (VALUES
    ('90000000-0000-4000-8000-000000000001'::uuid, '70000000-0000-4000-8000-000000000001'::uuid, NULL::text, 'OPEN', '10000000-0000-4000-8000-000000000005'::uuid, NULL::text, interval '2 hours'),
    ('90000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000002', NULL, 'OPEN', '10000000-0000-4000-8000-000000000006', NULL, interval '1 day'),
    ('90000000-0000-4000-8000-000000000003', '70000000-0000-4000-8000-000000000003', NULL, 'OPEN', '10000000-0000-4000-8000-000000000007', NULL, interval '2 days'),
    ('90000000-0000-4000-8000-000000000004', '70000000-0000-4000-8000-000000000003', 'OPEN', 'IN_PROGRESS', '10000000-0000-4000-8000-000000000002', NULL, interval '2 days' - interval '2 hours'),
    ('90000000-0000-4000-8000-000000000005', '70000000-0000-4000-8000-000000000004', NULL, 'OPEN', '10000000-0000-4000-8000-000000000008', NULL, interval '3 days'),
    ('90000000-0000-4000-8000-000000000006', '70000000-0000-4000-8000-000000000004', 'OPEN', 'IN_PROGRESS', '10000000-0000-4000-8000-000000000003', NULL, interval '2 days'),
    ('90000000-0000-4000-8000-000000000007', '70000000-0000-4000-8000-000000000005', NULL, 'OPEN', '10000000-0000-4000-8000-000000000006', NULL, interval '1 day'),
    ('90000000-0000-4000-8000-000000000008', '70000000-0000-4000-8000-000000000005', 'OPEN', 'IN_PROGRESS', '10000000-0000-4000-8000-000000000002', NULL, interval '23 hours'),
    ('90000000-0000-4000-8000-000000000009', '70000000-0000-4000-8000-000000000005', 'IN_PROGRESS', 'BLOCKED', '10000000-0000-4000-8000-000000000002', 'Waiting for a replacement switch from the supplier', interval '6 hours'),
    ('90000000-0000-4000-8000-000000000010', '70000000-0000-4000-8000-000000000006', NULL, 'OPEN', '10000000-0000-4000-8000-000000000005', NULL, interval '6 days'),
    ('90000000-0000-4000-8000-000000000011', '70000000-0000-4000-8000-000000000006', 'OPEN', 'IN_PROGRESS', '10000000-0000-4000-8000-000000000004', NULL, interval '5 days'),
    ('90000000-0000-4000-8000-000000000012', '70000000-0000-4000-8000-000000000006', 'IN_PROGRESS', 'BLOCKED', '10000000-0000-4000-8000-000000000004', 'Replacement part on order, due next week', interval '4 days'),
    ('90000000-0000-4000-8000-000000000013', '70000000-0000-4000-8000-000000000007', NULL, 'OPEN', '10000000-0000-4000-8000-000000000007', NULL, interval '4 days'),
    ('90000000-0000-4000-8000-000000000014', '70000000-0000-4000-8000-000000000007', 'OPEN', 'IN_PROGRESS', '10000000-0000-4000-8000-000000000003', NULL, interval '3 days'),
    ('90000000-0000-4000-8000-000000000015', '70000000-0000-4000-8000-000000000007', 'IN_PROGRESS', 'RESOLVED', '10000000-0000-4000-8000-000000000003', 'Licence reassigned and software installed', interval '1 day'),
    ('90000000-0000-4000-8000-000000000016', '70000000-0000-4000-8000-000000000008', NULL, 'OPEN', '10000000-0000-4000-8000-000000000005', NULL, interval '10 days'),
    ('90000000-0000-4000-8000-000000000017', '70000000-0000-4000-8000-000000000008', 'OPEN', 'IN_PROGRESS', '10000000-0000-4000-8000-000000000004', NULL, interval '9 days'),
    ('90000000-0000-4000-8000-000000000018', '70000000-0000-4000-8000-000000000008', 'IN_PROGRESS', 'RESOLVED', '10000000-0000-4000-8000-000000000004', 'Thermostat recalibrated', interval '8 days'),
    ('90000000-0000-4000-8000-000000000019', '70000000-0000-4000-8000-000000000009', NULL, 'OPEN', '10000000-0000-4000-8000-000000000008', NULL, interval '14 days'),
    ('90000000-0000-4000-8000-000000000020', '70000000-0000-4000-8000-000000000009', 'OPEN', 'IN_PROGRESS', '10000000-0000-4000-8000-000000000004', NULL, interval '14 days' - interval '1 hour'),
    ('90000000-0000-4000-8000-000000000021', '70000000-0000-4000-8000-000000000009', 'IN_PROGRESS', 'RESOLVED', '10000000-0000-4000-8000-000000000004', 'Cleaned and floor dried', interval '14 days' - interval '2 hours'),
    ('90000000-0000-4000-8000-000000000022', '70000000-0000-4000-8000-000000000009', 'RESOLVED', 'CLOSED', '10000000-0000-4000-8000-000000000008', NULL, interval '13 days'),
    ('90000000-0000-4000-8000-000000000023', '70000000-0000-4000-8000-000000000010', NULL, 'OPEN', '10000000-0000-4000-8000-000000000006', NULL, interval '12 days'),
    ('90000000-0000-4000-8000-000000000024', '70000000-0000-4000-8000-000000000010', 'OPEN', 'IN_PROGRESS', '10000000-0000-4000-8000-000000000002', NULL, interval '11 days'),
    ('90000000-0000-4000-8000-000000000025', '70000000-0000-4000-8000-000000000010', 'IN_PROGRESS', 'RESOLVED', '10000000-0000-4000-8000-000000000002', 'Audio cable replaced', interval '10 days'),
    ('90000000-0000-4000-8000-000000000026', '70000000-0000-4000-8000-000000000010', 'RESOLVED', 'CLOSED', '10000000-0000-4000-8000-000000000006', NULL, interval '9 days'),
    ('90000000-0000-4000-8000-000000000027', '70000000-0000-4000-8000-000000000011', NULL, 'OPEN', '10000000-0000-4000-8000-000000000008', NULL, interval '2 days' - interval '1 hour'),
    ('90000000-0000-4000-8000-000000000028', '70000000-0000-4000-8000-000000000011', 'OPEN', 'CLOSED', '10000000-0000-4000-8000-000000000001', 'Duplicate of the existing docking station incident', interval '2 days' - interval '3 hours'),
    ('90000000-0000-4000-8000-000000000029', '70000000-0000-4000-8000-000000000012', NULL, 'OPEN', '10000000-0000-4000-8000-000000000007', NULL, interval '5 hours')
) AS v (id, incident_id, from_status, to_status, changed_by, reason, ago)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Notes: public conversation plus two staff-only (is_internal) notes
-- ---------------------------------------------------------------------------
INSERT INTO incident_notes (id, incident_id, author_id, body, is_internal, created_at, updated_at)
SELECT v.id, v.incident_id, v.author_id, v.body, v.is_internal, now() - v.ago, now() - v.ago
FROM (VALUES
    ('80000000-0000-4000-8000-000000000001'::uuid, '70000000-0000-4000-8000-000000000003'::uuid, '10000000-0000-4000-8000-000000000002'::uuid, 'I have swapped the dock for a spare. Can you check whether both monitors now work?', FALSE, interval '1 day'),
    ('80000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000007', 'One works, the second still shows no signal.', FALSE, interval '5 hours'),
    ('80000000-0000-4000-8000-000000000003', '70000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000002', 'The floor switch has failed. A replacement is ordered and should arrive tomorrow.', FALSE, interval '6 hours'),
    ('80000000-0000-4000-8000-000000000004', '70000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', 'Supplier ref SW-44817. Chase them if nothing arrives by noon.', TRUE, interval '5 hours'),
    ('80000000-0000-4000-8000-000000000005', '70000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000001', 'Lena is on leave; reassign when the part arrives.', TRUE, interval '3 days'),
    ('80000000-0000-4000-8000-000000000006', '70000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000003', 'Installed and licensed. Please confirm it opens and close the ticket.', FALSE, interval '1 day'),
    ('80000000-0000-4000-8000-000000000007', '70000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000006', 'It dropped again three times during this morning''s call.', FALSE, interval '4 hours'),
    ('80000000-0000-4000-8000-000000000008', '70000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000001', 'Closing as a duplicate: this desk is already being handled under the earlier report.', FALSE, interval '2 days' - interval '3 hours')
) AS v (id, incident_id, author_id, body, is_internal, ago)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- AI suggestions (stretch goal): one pending, one approved
-- ---------------------------------------------------------------------------
INSERT INTO ai_suggestions (id, incident_id, type, suggestion, applied, cited_incident_ids, decision, decided_by, decided_at, created_at) VALUES
    ('a0000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 'TRIAGE',
     '{"category": "HVAC", "priority": "HIGH", "reason": "Second HVAC fault at seat 2F-A14 in two weeks"}', NULL,
     ARRAY['70000000-0000-4000-8000-000000000008']::uuid[], 'PENDING', NULL, NULL, now() - interval '2 hours'),
    ('a0000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000011', 'DUPLICATE',
     '{"duplicate_of": "70000000-0000-4000-8000-000000000003", "confidence": 0.93}',
     '{"duplicate_of": "70000000-0000-4000-8000-000000000003"}',
     ARRAY['70000000-0000-4000-8000-000000000003']::uuid[], 'APPROVED',
     '10000000-0000-4000-8000-000000000001', now() - interval '2 days' + interval '3 hours', now() - interval '2 days' + interval '1 hour')
ON CONFLICT DO NOTHING;

COMMIT;
