# SmallStay Online v1

SmallStay is a simple hotel operations app for a small hotel: rooms, housekeeping,
inspections, maintenance tickets, reception check-in / check-out with guest ID photos,
daily reports, staff accounts and backup. This is the **online version** — the app
runs on a server, data is saved in a database on the server, and staff open it from
any computer or phone with a link and sign in with their username and PIN.

- Price: $29/month flat, no per-room fee, no per-seat fee. (No payment system is
  built in v1 — that is a later step.)
- One hotel per deployment: one database file = one hotel.
- No Booking.com sync. No cloud sync to other apps. Works in English, Arabic and
  Sorani Kurdish (RTL).

## How to run it on your own computer

You need Node.js 20 or newer.

```bash
npm install
npm start
```

Then open http://localhost:3000 in a browser.

- First use: run the Setup Wizard (hotel name, currency IQD or USD, room price,
  first guest floor, number of guest floors, rooms per floor), then create your
  owner username and PIN. There is no default password.
- Your data is saved in the file set by `DATABASE_PATH` (default
  `./data/smallstay.db`, created automatically).
- To run the tests: `npm test` (16 API tests, Node's built-in test runner).

## Settings (environment variables)

Copy `.env.example` to `.env` and fill in your own values. Never share the `.env`
file and never put real secrets in code.

| Variable | What it is |
| --- | --- |
| `PORT` | Port the server listens on (default 3000; Render sets this itself) |
| `DATABASE_PATH` | Where the SQLite database file lives (default `./data/smallstay.db`) |
| `SESSION_SECRET` | A long random string for sessions (set one in production) |
| `NODE_ENV` | `production` on the live server (turns on secure cookies) |

## How the data is stored

- One SQLite database file. Tables: users, rooms, stays, tickets, events,
  snapshots, sessions, plus a `meta` table for hotel setup and counters.
- PINs are stored only as bcrypt hashes, never in plain text.
- Guest contact, ID, car and photo data is only ever sent by the server to
  owner, manager and reception accounts. Housekeeping, maintenance and
  supervisor accounts only ever receive guest names.
- The demo ("Try demo — sample data") runs on separate fictional data kept in
  the server's memory only. It never reads or changes real hotel data, and
  backup / restore / reset are disabled in demo.
- **Backup:** sign in as Owner or Manager → Settings → Download backup. Keep
  the file safe. Restore validates the file first and only replaces the data
  if the file is fully valid. After a restore, everyone signs in again with
  the accounts from the backup.

## How to put it on the internet (Render)

1. Push this folder to a GitHub repository (your own account).
2. In Render (render.com), create a **Web Service** from that repository.
   Or use the `render.yaml` in this folder (Blueprint): Render → New →
   Blueprint, pick the repository.
3. Render installs the dependencies and runs `npm start`. The app is then live
   at the link Render gives you (something like
   `https://smallstay-online.onrender.com`). Staff open that link and sign in.
4. Set the environment variables in Render: `NODE_ENV=production` and a long
   random `SESSION_SECRET`. `PORT` and `DATABASE_PATH` are already set in
   `render.yaml`.

**Important, please read:** on Render's free plan the server's disk is wiped
when the service restarts or redeploys, so the database file would be lost.
That means: **take a Backup from Settings regularly** (it downloads one file
with everything), and restore it if the data ever disappears. For data that
survives restarts, attach a persistent disk to the service in Render
(1 GB is enough — this is the paid part of Render) with mount path `/app/data`.

## Known limits of v1 (honest)

- If you are locked out (nobody remembers the owner PIN), there is no
  "forgot PIN" yet: the owner must sign in first, then erase from Settings
  (owner only, type DELETE). In the old offline file version the erase worked
  from the sign-in screen; online it cannot, because anyone on the internet
  could otherwise erase the hotel. A proper owner-recovery step is a later
  version.
- One hotel per deployment. A second hotel needs a second deployment.
- No payment collection, no email, no Booking.com sync.
- Demo data is kept in the server's memory and disappears when the server
  restarts (real data is in the database file and does not).
- The app needs internet to use: if the hotel's internet is down, staff
  cannot open it. (The old offline file still works without internet — keep
  it as a fallback if that matters.)
