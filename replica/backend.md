# SmallStay Online v1 — backend checklist

From the replica-backend skill's security checklist, checked honestly on
2026-11-10 against the code in `server/` and the tests in `tests/api.test.js`
(16 tests, all passing).

- [x] secrets only in env vars, `.env*` in `.gitignore`, nothing in client bundles
  — `.env.example` has names only, no values. `SESSION_SECRET` is read from env.
  (Note: session tokens are random 32-byte secrets stored server-side, so the
  secret is not used for signing; it is still required as an env var in
  production and documented in README.)
- [x] input validated on the server (every route) — wizard ranges, PIN length,
  pct 0–100, nights >= 1, room types, ticket types/prios, date format,
  photo size/type limits (2 MB, image data URLs only), backup payload shape.
- [x] authorisation checked on every read and write, tested with a second user
  — PERMS map from v1.7 enforced in every route handler (`requirePerm`);
  tests cover housekeeper 403 on check-in, reception 403 on staff manage,
  supervisor receiving no private guest data, maintenance blocked from
  another worker's ticket.
- [x] rate limits on auth — login: max 10 failed attempts per 15 minutes per
  IP and per username, 429 after, counter reset on success (tested).
- [x] webhooks verify signatures — N/A: no Stripe, no webhooks in v1.
- [x] uploads: size and type limits — ID photos: JSON body limit 3 MB, photo
  data URL max 2 MB, must be an image data URL; client downscales to max
  900 px JPEG before upload. Photos are served only inside private stay
  details (owner/manager/reception).
- [x] no user data in URLs or logs — no guest data, PINs or tokens are logged;
  errors return plain messages.
- [ ] dependencies audited (`npm audit`) — NOT DONE: `npm audit` could not run
  here (the internal registry denies the audit endpoint). Run `npm audit`
  before deploying and fix anything it reports. Dependencies are only
  `express` and `bcryptjs`.
- [ ] privacy policy lists every processor — NOT DONE: no privacy policy page
  exists yet. Needed before selling to other hotels (processors: the host
  Render, and nothing else in v1).

## Auth

- Username + PIN sign-in (same as the offline app). PINs hashed with bcrypt,
  cost 10. No default credentials; the owner creates their own account.
- Sessions: httpOnly cookies, server-side session rows in SQLite, 7-day
  expiry, SameSite=Lax, Secure flag in production (`NODE_ENV=production`,
  `trust proxy` on). Sign-out deletes the session. Restore wipes all sessions.
- Roles: owner, manager, supervisor, reception, housekeeper, maintenance —
  same permission map as v1.7. Guest private data (contact, ID, car, photo)
  and money fields are filtered server-side for supervisor/housekeeper/
  maintenance (tested).

## Database

- SQLite via built-in `node:sqlite`, single file (`DATABASE_PATH`, default
  `./data/smallstay.db`). Tables: meta, users, rooms, stays, tickets, events,
  snapshots, sessions. Whole-state save in one transaction per mutation.
- Backups: JSON export in the v1.7 backup format (`app:"smallstay-v1"`,
  version 3), validated with the exact v1.7 rules before restore. Restored
  v1.7 backups also accept legacy salted-SHA-256 `cred` accounts so old
  backups still sign in; new accounts always use bcrypt.
- Snapshots: one row per day with room counts, written on every real-mode
  mutation (used for past-date reports; dates without a snapshot say so
  instead of inventing numbers).
- **Render free-plan warning:** the disk is ephemeral — see README. Take
  regular backups, or attach a persistent disk.

## Known gaps (not hidden)

- Locked-out recovery: no signed-out erase/reset endpoint (by design — anyone
  on the internet could wipe the hotel). The owner must sign in, then erase
  from Settings. A proper recovery flow is a later version.
- Rate limiter and demo states live in server memory (lost on restart).
  Demo data is in-memory by design; the rate-limit window is 15 minutes.
- `npm audit` and a privacy policy page are still open (see above).
