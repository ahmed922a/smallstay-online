# SmallStay Online v1 — API Contract (source of truth for backend + frontend)

Project: `/home/hatch/workspace/smallstay-online/`
Port of: `/home/hatch/workspace/small-hotel-pms/SmallStay-v1.7.html` (read the whole file — 2551 lines).
Stack: Node.js (>=20) + Express, `node:sqlite` (built-in, no native build), `bcryptjs` (pure JS).
No external services. No Stripe, no email. Single hotel per deployment (one SQLite DB file = one hotel).

## Data model (SQLite tables; mirrors v1.7 DB v3)

- `meta(key TEXT PRIMARY KEY, value TEXT)` — JSON values: `setupDone` (0/1), `config`
  `{firstFloor, floorCount, roomsPerFloor, price, currency, hotelName, address}`,
  `hotel {name, address, currency}`, `currency`, `price`, `startedAt` (local YYYY-MM-DD,
  set at wizard time), `nextStayId`, `nextTicketId`.
- `users(id, name, username UNIQUE lowercased, pinHash, role, mode)` — mode `simple|full`.
  PINs hashed with bcryptjs, cost 10. NO default credentials anywhere.
- `rooms(number PK, floor, type NULL|'Single'|'Twin', occ 'vacant'|'occupied',
  hk 'dirty'|'cleaning'|'clean', insp 'awaiting'|'passed'|'failed', access 'in'|'out',
  assignedTo NULL|userId, checklist TEXT JSON [bool x5],
  cleanStartedAt NULL|ISO, cleanStartedBy NULL|userId,
  lastCleanedBy NULL|userId, lastCleanedAt NULL|ISO, lastCleanMinutes NULL|number 1 decimal)`
- `stays(id PK, room, guests TEXT JSON [{name,idNum,contact,car,idPhoto?}],
  checkInAt ISO, checkInDate YYYY-MM-DD, plannedOut YYYY-MM-DD, checkOutAt NULL|ISO,
  nights, basePrice, pct, total, byIn userId, byOut NULL|userId, status 'in'|'out')`
- `tickets(id PK, room, type, prio, status 'open'|'working'|'parts'|'check'|'closed',
  note, reporterId, assigneeId NULL, createdAt ISO, blocking 0|1, history TEXT JSON [{at,byId,action}])`
- `events(id PK autoincrement, at ISO, kind, room NULL, byId NULL, text)` — cap 2000 rows (delete oldest).
- `snapshots(date PK YYYY-MM-DD, ready, occupied, dirty, awaiting, oos, at ISO)` — one row per
  day, written on every real-mode mutation (same as v1.7 `snapshotToday()` on persist).
- `sessions(token PK, userId NULL|userId, mode 'real'|'demo', demoKey NULL|text, createdAt ISO, expiresAt ISO)`
  — httpOnly cookie `ss_session`, 7-day expiry, SameSite=Lax, Secure only when `NODE_ENV=production`
  (behind Render HTTPS; `app.set('trust proxy', 1)`).

Demo state: per demo session, kept IN MEMORY on the server (Map keyed by `demoKey`), seeded by
the exact `buildDemoDB()` logic from v1.7 (config firstFloor 1, 3 floors, 10 rooms, 50000 IQD;
10 occupied stays + 1 checked-out stay; 6 tickets; 7 demo users with NO PINs:
owner/manager/reception/2 housekeepers/maintenance/supervisor; ready rooms are indices
[0,8,15,18,24,27,29] of the room list). Demo sessions NEVER touch the SQLite DB.
Demo users are chosen by role only (no PIN). Backup/restore/reset are disabled in demo
(403 with message "This is disabled in demo").

## Permissions (exact copy of v1.7 PERMS)

- owner: dashboard, rooms.view, room.type, housekeeping.view, hk.assign, hk.work, inspect,
  maintenance.view, ticket.report, ticket.work, ticket.close, ticket.assign, service.release,
  checkin, checkout, stays.view, reports, reports.csv, team.view, staff.manage, staff.mode,
  settings, price.change, backup, restore, reset, download
- manager: same as owner EXCEPT reset (no reset)
- supervisor: rooms.view, housekeeping.view, hk.assign, inspect, maintenance.view, ticket.report,
  ticket.close, service.release, stays.view, reports, download
- reception: rooms.view, checkin, checkout, stays.view, ticket.report, download
- housekeeper: rooms.view, hk.work, ticket.report, download
- maintenance: rooms.view, ticket.report, ticket.work, download

`canSeePrivate()` = role is owner, manager or reception. Server-side privacy filtering
(see "Privacy filtering" below) — never rely on the UI to hide data.

`fullMode(user)` = role owner/manager OR user.mode === 'full'. Working staff default 'simple'.

## Business rules (exact copy of v1.7 — do not "improve" them)

- Ready = occ vacant AND hk clean AND insp passed AND access in. No manual "make ready".
- Wizard validation: hotel name required; currency IQD or USD only; price integer 1..100000000;
  firstFloor 0..20; floorCount 1..12; roomsPerFloor 1..12. Rooms generated floor*100+1..roomsPerFloor.
  Wizard only allowed when no config exists yet (else 409). Sets `startedAt` = local date.
- Owner setup: only when config exists and setupDone is false. name, username (lowercased),
  PIN >= 4 chars, PINs must match. Creates owner (mode full), setupDone=1, logs in.
- Login: username lowercased match; wrong user or wrong PIN -> 401 "Wrong username or PIN."
  (same message for both, no user enumeration). Rate limit: max 10 failed attempts per
  15 minutes per IP AND per username (429 after). Successful login resets the counter.
- Check-in: perm `checkin`. Room must exist and be Ready (rechecked server-side at save);
  no second active stay for the room (409). nights integer >= 1; pct number 0..100;
  plannedOut = depart (YYYY-MM-DD) or today+nights. Guests: main guest name + idNum required;
  extra guests each need name + idNum. total = round(price*pct/100)*nights; basePrice = current
  DB price. Room occ -> occupied. `idPhoto` (data URL, JPEG) only on guests[0]; server rejects
  photos > 2 MB (413) and non-image data URLs (400).
- Check-out: perm `checkout`. Stay must be status 'in'. Sets status out, checkOutAt now,
  byOut = caller. Room -> vacant, dirty, awaiting, checklist reset, cleaning record cleared
  (lastCleanedBy/At/Minutes and cleanStartedAt/By all NULL).
- Housekeeping start: perm `hk.work`. Room hk -> cleaning, cleanStartedAt = now ISO,
  cleanStartedBy = caller; if room unassigned, assignedTo = caller.
- Checklist toggle: perm `hk.work`. Toggles checklist[index] (0..4).
- Housekeeping finish: perm `hk.work`. ALL 5 checklist items must be true else 400
  "Finish the whole checklist first." Sets hk clean, insp awaiting, lastCleanedBy = caller,
  lastCleanedAt = now, lastCleanMinutes = minutes from cleanStartedAt to now, 1 decimal
  (null when start was not recorded), clears cleanStartedAt/By.
- Housekeeping assign: perm `hk.assign`. assignedTo = staffId (must be a housekeeper user) or null.
- Inspect: perm `inspect`. pass=true -> insp passed. pass=false -> insp failed, hk dirty,
  checklist reset to all false.
- Report ticket: perm `ticket.report`. room, type (one of TICKET_TYPES), prio (one of
  TICKET_PRIOS) required. note optional (max 500 chars). reporterId = caller.
  assigneeId = caller if caller is maintenance, else null. status open, blocking 0.
- Ticket status: actions working|parts|fixed|oos|close|back.
  - working/parts/fixed: perm `ticket.work`. Maintenance worker may only act on tickets
    assigned to them or unassigned (if assigneeId set and != caller -> 403).
    fixed -> status 'check', history "Fixed — sent for check".
  - oos: perm `ticket.work`. Ticket status stays open, blocking=1, room access -> out.
  - close: perm `ticket.close`. status closed.
  - back: perm `ticket.close`. status working.
  - close via check list also clears blocking (closeBlockingAndRelease): after closing a
    ticket, set its blocking=0. (v1.7 does this in closeBlockingAndRelease; plain close
    from ticketCard checkMode uses it. Implement: when action=close and ticket was
    blocking, set blocking=0.)
- Release room: perm `service.release`. Blocked (400) if any ticket for the room has
  blocking=1 and status != closed. Else room access -> in.
- Room type: perm `room.type`. type must be null | 'Single' | 'Twin'.
- Create staff: perm `staff.manage`. name, username (lowercased, unique case-insensitive),
  PIN >= 4, role one of ROLES. Only owner may create role owner (403 otherwise).
  mode = 'full' for owner/manager, else 'simple'.
- Remove staff: perm `staff.manage`. Cannot remove self (403). Owner accounts removable
  only by owner (403 otherwise).
- Set staff mode: perm `staff.mode`. Cannot change owner/manager mode (403). mode simple|full.
- Price change: perm `price.change`. price integer >= 0 (max 100000000). Affects new
  check-ins only (existing stays keep basePrice/total).
- Backup: perm `backup`, real mode only. Returns the v1.7 backup payload:
  `{app:"smallstay-v1", backupVersion:3, exportedAt:ISO, db:{...full DB shape v:3...}}`
  with users' pinHash included (like v1.7 hashed PINs in backup) and NO plaintext PINs.
- Restore: perm `restore`, real mode only. Body `{payload}`. Validate with the SAME rules as
  v1.7 `validateBackup()` (app id, v=3, config ranges, currency, room count == floors*perFloor,
  room numbers match floor and 1..roomsPerFloor, room enum values, room types, >=1 user,
  unique usernames, valid roles, >=1 owner, NO plaintext `pin` field on any user, stays/tickets
  reference known rooms, at most one active stay per room, active stay room marked occupied,
  pct 0..100, main guest present, ticket statuses valid, price range, nextStayId/nextTicketId
  numbers). Invalid -> 400 with list of errors (max 6 shown + count). Valid -> replace the
  whole DB, delete ALL sessions (everyone signs in again with the backup's accounts).
- Reset (start fresh): perm `reset` (owner only), real mode only. Body `{confirm:"DELETE"}`
  (case-insensitive, else 400). Erases ALL real data, rebuilds fresh empty DB (no config),
  deletes all sessions.
- Report: perm `reports`. GET /api/report?date=YYYY-MM-DD (default today). Server computes
  exactly v1.7 `reportData(date)`: ins (checkInDate==date), outs (checkOutAt date==date),
  during (occupied that night: checkInDate<=date; if checked out, checkout date > date OR
  checkout date == checkInDate; if status in, counts incl. overdue; if out with no checkOutAt,
  plannedOut > date), revenue = sum over `during` of round(basePrice*pct/100).
  Response includes counts for the date: today -> live counts; past date with snapshot ->
  snapshot counts; past date without snapshot -> `noHistory:true` (never invent numbers).
  Revenue and money fields only when canSeePrivate, else omitted.
- CSV: perm `reports.csv`. GET /api/report.csv?date= — same rows as v1.7 downloadCSV,
  formula protection (prefix ' when cell starts with = + - @ tab CR), private columns blank
  when !canSeePrivate. Filename smallstay-report-YYYY-MM-DD.csv.
- Events: logged server-side on every mutation (kind, room, byId, text) as in v1.7; capped 2000.
  Not exposed in /api/state (v1.7 never renders them); included in backup db.events.

## HTTP API (all JSON except CSV download; all /api/* except status/login/setup return 401 when not signed in)

- GET  /api/health -> {ok:true}
- GET  /api/status -> {setupDone, hasConfig, hotelName} (public; no user data)
- GET  /api/users/public -> [{name, username, role}] (public; for the "Who is signing in?" picker;
  empty list before setup)
- POST /api/setup/wizard {hotelName, address?, currency, price, firstFloor, floorCount, roomsPerFloor}
  -> 200 {ok:true} | 400 {error} | 409 {error:"Hotel is already set up."}
- POST /api/setup/owner {name, username, pin, pin2} -> sets session cookie, 200 {user:{id,name,username,role,mode}} | 400 | 409
- POST /api/auth/login {username, pin} -> sets cookie, 200 {user} | 401 {error:"Wrong username or PIN."} | 429
- POST /api/auth/logout -> clears cookie, 200 {ok:true}
- GET  /api/auth/me -> 200 {user, hotel, config, price, currency, startedAt, mode} | 401
- POST /api/demo/start {role} -> demo session cookie, 200 {user:{demo user}, mode:"demo"} | 400 bad role
- POST /api/demo/exit -> clears demo session (back to logged-out real entry), 200 {ok:true}
- GET  /api/state -> 200 {config, hotel, currency, price, startedAt, users:[{id,name,username,role,mode}],
  rooms:[...], stays:[...privacy-filtered], tickets:[...], snapshots: {today's snapshot + any snapshot
  the client asked for? NO — snapshots only via /api/report}, counts:{ready,occupied,dirty,insp,oos,total,vacant}}
  Demo mode returns the demo store's state. 401 when not signed in.
- POST /api/rooms/:number/type {type} -> 200 {ok:true, room}
- POST /api/housekeeping/start {room} | POST /api/housekeeping/checklist {room,index}
  | POST /api/housekeeping/finish {room} | POST /api/housekeeping/assign {room, staffId|null}
- POST /api/inspections {room, pass}
- POST /api/tickets {room, type, prio, note?}
- POST /api/tickets/:id/status {action}
- POST /api/tickets/:id/assign {staffId|null}
- POST /api/rooms/:number/release
- POST /api/checkin {room, nights, pct, depart?, guests}
- POST /api/checkout {stayId}
- GET  /api/report?date=YYYY-MM-DD
- GET  /api/report.csv?date=YYYY-MM-DD
- POST /api/staff {name, username, pin, role}
- DELETE /api/staff/:id
- POST /api/staff/:id/mode {mode}
- POST /api/settings/price {price}
- GET  /api/backup
- POST /api/restore {payload}
- POST /api/reset {confirm}
- All mutations return 200 {ok:true, message?} (frontend re-fetches /api/state after each
  mutation). Errors: 400 {error:"..."} validation, 403 {error:"You do not have permission to do this."},
  404 {error:"Not found."}, 409 {error:"..."} conflicts.

## Privacy filtering (server-side, in /api/state, /api/report, CSV)

- canSeePrivate (owner/manager/reception): full stay objects incl. guests idNum/contact/car/idPhoto,
  money fields (basePrice, pct, total), byIn/byOut user ids (names resolved from users list).
- Others (supervisor/housekeeper/maintenance): stays contain ONLY {id, room, checkInDate,
  plannedOut, checkOutAt, nights, status, guests:[{name}]} — NO idNum/contact/car/idPhoto,
  NO basePrice/pct/total, NO byIn/byOut. Report money/revenue omitted. CSV private columns blank.
- Users list in state: {id, name, username, role, mode} only — NEVER pinHash.
- No user data in logs. No PINs in logs.

## Constants (copy from v1.7)

ROLES = owner, manager, supervisor, reception, housekeeper, maintenance
CHECKLIST_ITEMS = ["Bathroom cleaned","Beds made / linen changed","Towels replaced","Floor vacuumed / mopped","Trash emptied & supplies refilled"]
TICKET_TYPES = ["Water / plumbing","Air conditioning","Door / lock","TV / electric","Bathroom","Furniture","Other"]
TICKET_PRIOS = ["Low","Normal","High","Urgent"]
Room type: null | "Single" | "Twin". Currency: IQD | USD.

## Files

- server/index.js (or server.js) — Express app, static serving of ../public, all routes
- server/db.js — SQLite open/migrations/seed helpers
- server/demo.js — buildDemoDB() port (exact demo data from v1.7)
- server/auth.js — bcrypt, sessions, rate limit, permission helpers
- public/index.html, public/app.js, public/styles.css (or single-file app? keep 3 files; index.html
  references them relatively)
- package.json — deps: express, bcryptjs. Scripts: "start": "node server/index.js",
  "test": "node --test tests/"
- .env.example — variable names only, NO values: PORT, DATABASE_PATH, SESSION_SECRET, NODE_ENV
- render.yaml + Dockerfile (Render free web service; Dockerfile uses node:24-slim, npm ci, PORT env)
- README.md — plain steps: run locally, data storage, deploy on Render
- replica/backend.md — security checklist from replica-backend skill, ticked honestly
- tests/ — node --test API tests (see task brief for required coverage)
