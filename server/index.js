"use strict";
// SmallStay Online v1 — Express API. See API_SPEC.md (source of truth).
// Real mode: one SQLite DB file = one hotel (state held in memory, written
// back to SQLite on every mutation). Demo mode: per-session in-memory state
// seeded by buildDemoDB(); demo never touches SQLite hotel data.

const express = require("express");
const path = require("path");
const {
  ROLES, TICKET_TYPES, TICKET_PRIOS, can, canSeePrivate,
} = require("./constants");
const L = require("./logic");
const {
  openDb, loadState, saveState, createSession, getSession, deleteSession, deleteAllSessions,
} = require("./db");
const { buildDemoDB } = require("./demo");
const {
  hashPin, verifyPin, uid, parseCookies, sessionCookieHeader, createRateLimiter,
} = require("./auth");

const NO_PERM = "You do not have permission to do this.";
const DEMO_DISABLED = "This is disabled in demo";
const WRONG_LOGIN = "Wrong username or PIN.";

function isInt(v) { return typeof v === "number" && Number.isInteger(v); }
function isNonEmptyStr(v) { return typeof v === "string" && v.trim().length > 0; }
function clientIp(req) {
  return (req.ip || req.socket.remoteAddress || "unknown").toString();
}
// Decoded byte size of a base64 data URL (without decoding the whole thing).
function dataUrlBytes(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl || "");
  if (!m) return -1;
  const b64 = m[2].replace(/\s/g, "");
  const pad = (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
  return Math.floor((b64.length * 3) / 4) - pad;
}

function createApp(opts) {
  const dbPath = (opts && opts.dbPath) || process.env.DATABASE_PATH || path.join(__dirname, "..", "data", "smallstay.db");
  const db = openDb(dbPath);
  let state = loadState(db);
  const demoStates = new Map(); // demoKey -> demo state object
  const limiter = createRateLimiter();

  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "3mb" }));
  // JSON errors (bad JSON / body too big) as JSON, never HTML.
  app.use((err, _req, res, next) => {
    if (err && err.type === "entity.too.large") return res.status(413).json({ error: "Request is too large." });
    if (err instanceof SyntaxError) return res.status(400).json({ error: "Invalid JSON." });
    return next(err);
  });

  function persist() {
    L.snapshotToday(state);
    saveState(db, state);
  }
  function err(res, status, message) { return res.status(status).json({ error: message }); }
  function ok(res, extra) { return res.json(Object.assign({ ok: true }, extra || {})); }

  // Resolve the session cookie into {user, mode, demoKey, state, token}.
  function resolveAuth(req) {
    const cookies = parseCookies(req);
    const token = cookies.ss_session;
    if (!token) return null;
    const sess = getSession(db, token);
    if (!sess) return null;
    if (sess.mode === "demo") {
      const dstate = demoStates.get(sess.demoKey);
      if (!dstate) return null;
      const user = L.userById(dstate, sess.userId);
      if (!user) return null;
      return { user, mode: "demo", demoKey: sess.demoKey, state: dstate, token };
    }
    const user = L.userById(state, sess.userId);
    if (!user) return null;
    return { user, mode: "real", demoKey: null, state, token };
  }
  function requireAuth(req, res, next) {
    const ctx = resolveAuth(req);
    if (!ctx) return err(res, 401, "Not signed in.");
    req.ctx = ctx;
    return next();
  }
  function requirePerm(action) {
    return (req, res, next) => {
      if (!can(req.ctx.user, action)) return err(res, 403, NO_PERM);
      return next();
    };
  }
  function requireReal(req, res, next) {
    if (req.ctx.mode === "demo") return err(res, 403, DEMO_DISABLED);
    return next();
  }
  function issueSession(res, userId, mode, demoKey) {
    const s = createSession(db, { userId, mode, demoKey });
    res.setHeader("Set-Cookie", sessionCookieHeader(s.token));
    return s;
  }

  // ---------------- Public ----------------
  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  app.get("/api/status", (_req, res) => {
    res.json({
      setupDone: !!state.setupDone,
      hasConfig: !!state.config,
      hotelName: (state.hotel && state.hotel.name) || "",
    });
  });

  app.get("/api/users/public", (_req, res) => {
    if (!state.setupDone) return res.json([]);
    return res.json(state.users.map((u) => ({ name: u.name, username: u.username, role: u.role })));
  });

  // ---------------- Setup ----------------
  app.post("/api/setup/wizard", (req, res) => {
    if (state.config) return err(res, 409, "Hotel is already set up.");
    const b = req.body || {};
    const hotelName = typeof b.hotelName === "string" ? b.hotelName.trim() : "";
    const address = typeof b.address === "string" ? b.address.trim() : "";
    const currency = b.currency;
    const price = b.price, firstFloor = b.firstFloor, floorCount = b.floorCount, roomsPerFloor = b.roomsPerFloor;
    if (!hotelName) return err(res, 400, "Hotel name is required.");
    if (currency !== "IQD" && currency !== "USD") return err(res, 400, "Choose IQD or USD.");
    if (!isInt(price) || price < 1 || price > 100000000) return err(res, 400, "Enter a room price above 0.");
    if (!isInt(firstFloor) || firstFloor < 0 || firstFloor > 20) return err(res, 400, "First floor must be 0 to 20.");
    if (!isInt(floorCount) || floorCount < 1 || floorCount > 12) return err(res, 400, "Guest floors must be 1 to 12.");
    if (!isInt(roomsPerFloor) || roomsPerFloor < 1 || roomsPerFloor > 12) return err(res, 400, "Rooms per floor must be 1 to 12.");
    const cfg = { firstFloor, floorCount, roomsPerFloor, price, currency, hotelName, address };
    state = L.buildFreshState(cfg);
    if (!state.startedAt) state.startedAt = L.todayStr(); // local date, not UTC
    persist();
    return ok(res);
  });

  app.post("/api/setup/owner", (req, res) => {
    if (!state.config) return err(res, 409, "Set up the hotel first.");
    if (state.setupDone) return err(res, 409, "Owner account already exists.");
    const b = req.body || {};
    const name = typeof b.name === "string" ? b.name.trim() : "";
    const username = typeof b.username === "string" ? b.username.trim().toLowerCase() : "";
    const pin = b.pin, pin2 = b.pin2;
    if (!name || !username || !pin) return err(res, 400, "Fill in all fields.");
    if (typeof pin !== "string" || pin.length < 4) return err(res, 400, "PIN must be at least 4 characters.");
    if (pin !== pin2) return err(res, 400, "PINs do not match.");
    const owner = { id: uid("u"), name, username, pinHash: hashPin(pin), cred: null, role: "owner", mode: "full" };
    state.users = [owner];
    state.setupDone = true;
    L.logEvent(state, "setup.owner", null, owner.id, "Owner account created");
    persist();
    issueSession(res, owner.id, "real", null);
    return res.json({ user: L.publicUser(owner) });
  });

  // ---------------- Auth ----------------
  app.post("/api/auth/login", (req, res) => {
    const b = req.body || {};
    const username = typeof b.username === "string" ? b.username.trim().toLowerCase() : "";
    const pin = b.pin;
    const ip = clientIp(req);
    if (limiter.isRateLimited(ip, username)) {
      return err(res, 429, "Too many failed sign-in attempts. Try again in 15 minutes.");
    }
    const found = state.users.find((u) => u.username.toLowerCase() === username) || null;
    if (!found || !verifyPin(found, pin)) {
      limiter.recordFailedLogin(ip, username);
      return err(res, 401, WRONG_LOGIN);
    }
    limiter.resetLoginFailures(ip, username);
    issueSession(res, found.id, "real", null);
    return res.json({ user: L.publicUser(found) });
  });

  app.post("/api/auth/logout", (req, res) => {
    const cookies = parseCookies(req);
    if (cookies.ss_session) {
      const sess = getSession(db, cookies.ss_session);
      if (sess && sess.mode === "demo" && sess.demoKey) demoStates.delete(sess.demoKey);
      deleteSession(db, cookies.ss_session);
    }
    res.setHeader("Set-Cookie", sessionCookieHeader(null, { clear: true }));
    return ok(res);
  });

  app.get("/api/auth/me", requireAuth, (req, res) => {
    const st = req.ctx.state;
    return res.json({
      user: L.publicUser(req.ctx.user),
      hotel: st.hotel, config: st.config, price: st.price,
      currency: st.currency, startedAt: st.startedAt || null, mode: req.ctx.mode,
    });
  });

  // ---------------- Demo ----------------
  app.post("/api/demo/start", (req, res) => {
    const role = (req.body || {}).role;
    if (!ROLES.includes(role)) return err(res, 400, "Unknown role.");
    const demoKey = uid("demo");
    const dstate = buildDemoDB();
    demoStates.set(demoKey, dstate);
    const user = dstate.users.find((u) => u.role === role) || dstate.users[0];
    issueSession(res, user.id, "demo", demoKey);
    return res.json({ user: L.publicUser(user), mode: "demo" });
  });

  app.post("/api/demo/exit", (req, res) => {
    const cookies = parseCookies(req);
    if (cookies.ss_session) {
      const sess = getSession(db, cookies.ss_session);
      if (sess && sess.demoKey) demoStates.delete(sess.demoKey);
      deleteSession(db, cookies.ss_session);
    }
    res.setHeader("Set-Cookie", sessionCookieHeader(null, { clear: true }));
    return ok(res);
  });

  // ---------------- State ----------------
  app.get("/api/state", requireAuth, (req, res) => {
    const out = L.serializeState(req.ctx.state, req.ctx.user, canSeePrivate(req.ctx.user));
    out.mode = req.ctx.mode;
    return res.json(out);
  });

  // ---------------- Rooms ----------------
  function roomParam(req, res) {
    const n = parseInt(req.params.number, 10);
    if (!Number.isInteger(n)) { err(res, 404, "Not found."); return null; }
    const r = L.roomByNum(req.ctx.state, n);
    if (!r) { err(res, 404, "Not found."); return null; }
    return r;
  }
  app.post("/api/rooms/:number/type", requireAuth, requirePerm("room.type"), (req, res) => {
    const r = roomParam(req, res);
    if (!r) return;
    const type = (req.body || {}).type;
    if (type !== null && type !== "Single" && type !== "Twin") return err(res, 400, "Room type must be Single, Twin, or empty.");
    r.type = type;
    L.logEvent(req.ctx.state, "room.type", r.number, req.ctx.user.id, "Room type set to " + (type || "To confirm"));
    if (req.ctx.mode === "real") persist();
    return ok(res, { room: L.clone(r) });
  });

  app.post("/api/rooms/:number/release", requireAuth, requirePerm("service.release"), (req, res) => {
    const r = roomParam(req, res);
    if (!r) return;
    const unresolved = req.ctx.state.tickets.filter((x) => x.room === r.number && x.status !== "closed" && x.blocking);
    if (unresolved.length) {
      return err(res, 400, "Room cannot be released — unresolved blocking ticket(s): " + unresolved.map((x) => "#" + x.id + " " + x.type).join(", "));
    }
    r.access = "in";
    L.logEvent(req.ctx.state, "room.release", r.number, req.ctx.user.id, "Released into service by " + req.ctx.user.name);
    if (req.ctx.mode === "real") persist();
    return ok(res);
  });

  // ---------------- Housekeeping ----------------
  app.post("/api/housekeeping/start", requireAuth, requirePerm("hk.work"), (req, res) => {
    const st = req.ctx.state;
    const r = L.roomByNum(st, (req.body || {}).room);
    if (!r) return err(res, 404, "Not found.");
    r.hk = "cleaning";
    r.cleanStartedAt = new Date().toISOString();
    r.cleanStartedBy = req.ctx.user.id;
    if (!r.assignedTo) r.assignedTo = req.ctx.user.id;
    L.logEvent(st, "hk.start", r.number, req.ctx.user.id, "Cleaning started by " + req.ctx.user.name);
    if (req.ctx.mode === "real") persist();
    return ok(res);
  });

  app.post("/api/housekeeping/checklist", requireAuth, requirePerm("hk.work"), (req, res) => {
    const st = req.ctx.state;
    const b = req.body || {};
    const r = L.roomByNum(st, b.room);
    if (!r) return err(res, 404, "Not found.");
    if (!isInt(b.index) || b.index < 0 || b.index > 4) return err(res, 400, "Checklist item must be 0 to 4.");
    r.checklist[b.index] = !r.checklist[b.index];
    if (req.ctx.mode === "real") persist();
    return ok(res);
  });

  app.post("/api/housekeeping/finish", requireAuth, requirePerm("hk.work"), (req, res) => {
    const st = req.ctx.state;
    const r = L.roomByNum(st, (req.body || {}).room);
    if (!r) return err(res, 404, "Not found.");
    if (r.checklist.some((x) => !x)) return err(res, 400, "Finish the whole checklist first.");
    r.hk = "clean";
    r.insp = "awaiting";
    let mins = null;
    if (r.cleanStartedAt) mins = Math.round(((new Date() - new Date(r.cleanStartedAt)) / 60000) * 10) / 10;
    r.lastCleanedBy = req.ctx.user.id;
    r.lastCleanedAt = new Date().toISOString();
    r.lastCleanMinutes = mins;
    r.cleanStartedAt = null;
    r.cleanStartedBy = null;
    L.logEvent(st, "hk.finish", r.number, req.ctx.user.id, "Cleaning finished by " + req.ctx.user.name + (mins == null ? "" : " in " + mins + " min") + " — sent for inspection");
    if (req.ctx.mode === "real") persist();
    return ok(res);
  });

  app.post("/api/housekeeping/assign", requireAuth, requirePerm("hk.assign"), (req, res) => {
    const st = req.ctx.state;
    const b = req.body || {};
    const r = L.roomByNum(st, b.room);
    if (!r) return err(res, 404, "Not found.");
    const staffId = b.staffId == null ? null : b.staffId;
    if (staffId !== null) {
      const u = L.userById(st, staffId);
      if (!u || u.role !== "housekeeper") return err(res, 400, "Assign cleaning only to a housekeeper.");
    }
    r.assignedTo = staffId;
    const name = staffId ? (L.userById(st, staffId) || {}).name || "—" : "Unassigned";
    L.logEvent(st, "hk.assign", r.number, req.ctx.user.id, "Cleaning assigned to " + name);
    if (req.ctx.mode === "real") persist();
    return ok(res);
  });

  // ---------------- Inspections ----------------
  app.post("/api/inspections", requireAuth, requirePerm("inspect"), (req, res) => {
    const st = req.ctx.state;
    const b = req.body || {};
    const r = L.roomByNum(st, b.room);
    if (!r) return err(res, 404, "Not found.");
    if (typeof b.pass !== "boolean") return err(res, 400, "pass must be true or false.");
    if (b.pass) {
      r.insp = "passed";
      L.logEvent(st, "inspect.pass", r.number, req.ctx.user.id, "Inspection passed by " + req.ctx.user.name);
    } else {
      r.insp = "failed"; r.hk = "dirty"; r.checklist = [false, false, false, false, false];
      L.logEvent(st, "inspect.fail", r.number, req.ctx.user.id, "Inspection failed by " + req.ctx.user.name + " — back to cleaning");
    }
    if (req.ctx.mode === "real") persist();
    return ok(res);
  });

  // ---------------- Tickets ----------------
  app.post("/api/tickets", requireAuth, requirePerm("ticket.report"), (req, res) => {
    const st = req.ctx.state;
    const b = req.body || {};
    const r = L.roomByNum(st, b.room);
    if (!r) return err(res, 404, "Not found.");
    if (!TICKET_TYPES.includes(b.type)) return err(res, 400, "Unknown problem type.");
    if (!TICKET_PRIOS.includes(b.prio)) return err(res, 400, "Unknown priority.");
    const note = typeof b.note === "string" ? b.note : "";
    if (note.length > 500) return err(res, 400, "Note is too long (max 500 characters).");
    const now = new Date().toISOString();
    const x = {
      id: st.nextTicketId++, room: r.number, type: b.type, prio: b.prio,
      status: "open", note: note.trim(), reporterId: req.ctx.user.id,
      assigneeId: req.ctx.user.role === "maintenance" ? req.ctx.user.id : null,
      createdAt: now, blocking: false,
      history: [{ at: now, byId: req.ctx.user.id, action: "Reported" }],
    };
    st.tickets.push(x);
    L.logEvent(st, "ticket.report", r.number, req.ctx.user.id, b.type + " reported");
    if (req.ctx.mode === "real") persist();
    return ok(res, { id: x.id });
  });

  app.post("/api/tickets/:id/status", requireAuth, (req, res) => {
    const st = req.ctx.state;
    const id = parseInt(req.params.id, 10);
    const x = st.tickets.find((t) => t.id === id);
    if (!x) return err(res, 404, "Not found.");
    const action = (req.body || {}).action;
    const now = new Date().toISOString();
    const hist = (a) => x.history.push({ at: now, byId: req.ctx.user.id, action: a });
    if (action === "working" || action === "parts" || action === "fixed") {
      if (!can(req.ctx.user, "ticket.work")) return err(res, 403, NO_PERM);
      if (req.ctx.user.role === "maintenance" && x.assigneeId && x.assigneeId !== req.ctx.user.id) return err(res, 403, NO_PERM);
      if (action === "working") { x.status = "working"; hist("Working on it"); }
      else if (action === "parts") { x.status = "parts"; hist("Needs parts"); }
      else {
        x.status = "check"; hist("Fixed — sent for check");
        L.logEvent(st, "ticket.fixed", x.room, req.ctx.user.id, "Fixed — sent for check");
        if (req.ctx.mode === "real") persist();
        return ok(res);
      }
    } else if (action === "oos") {
      if (!can(req.ctx.user, "ticket.work")) return err(res, 403, NO_PERM);
      const r = L.roomByNum(st, x.room);
      x.status = "open"; x.blocking = true;
      if (r) r.access = "out";
      hist("Room put out of service from this ticket");
      L.logEvent(st, "room.oos", x.room, req.ctx.user.id, "Room put out of service");
    } else if (action === "close") {
      if (!can(req.ctx.user, "ticket.close")) return err(res, 403, NO_PERM);
      const wasBlocking = !!x.blocking;
      x.status = "closed";
      if (wasBlocking) x.blocking = false; // closeBlockingAndRelease
      hist("Checked — OK, ticket closed");
      L.logEvent(st, "ticket.close", x.room, req.ctx.user.id, "Ticket closed after check");
      if (req.ctx.mode === "real") persist();
      return ok(res);
    } else if (action === "back") {
      if (!can(req.ctx.user, "ticket.close")) return err(res, 403, NO_PERM);
      x.status = "working";
      hist("Sent back — not fixed yet");
      L.logEvent(st, "ticket.back", x.room, req.ctx.user.id, "Ticket sent back");
      if (req.ctx.mode === "real") persist();
      return ok(res);
    } else {
      return err(res, 400, "Unknown ticket action.");
    }
    if (req.ctx.mode === "real") persist();
    return ok(res);
  });

  app.post("/api/tickets/:id/assign", requireAuth, requirePerm("ticket.assign"), (req, res) => {
    const st = req.ctx.state;
    const id = parseInt(req.params.id, 10);
    const x = st.tickets.find((t) => t.id === id);
    if (!x) return err(res, 404, "Not found.");
    const staffId = (req.body || {}).staffId == null ? null : req.body.staffId;
    if (staffId !== null) {
      const u = L.userById(st, staffId);
      if (!u || u.role !== "maintenance") return err(res, 400, "Assign repairs only to a maintenance worker.");
    }
    x.assigneeId = staffId;
    const name = staffId ? (L.userById(st, staffId) || {}).name || "—" : "Unassigned";
    x.history.push({ at: new Date().toISOString(), byId: req.ctx.user.id, action: "Assigned to " + name });
    L.logEvent(st, "ticket.assign", x.room, req.ctx.user.id, "Assigned to " + name);
    if (req.ctx.mode === "real") persist();
    return ok(res);
  });

  // ---------------- Check-in / check-out ----------------
  app.post("/api/checkin", requireAuth, requirePerm("checkin"), (req, res) => {
    const st = req.ctx.state;
    const b = req.body || {};
    const r = L.roomByNum(st, b.room);
    if (!r) return err(res, 400, "Room is not ready.");
    if (L.activeStayForRoom(st, r.number)) return err(res, 409, "This room already has a guest checked in.");
    if (!L.isReady(r)) return err(res, 400, "Room is not ready. (" + L.cannotReason(r) + ")");
    if (!isInt(b.nights) || b.nights < 1) return err(res, 400, "Nights must be 1 or more.");
    if (typeof b.pct !== "number" || isNaN(b.pct) || b.pct < 0 || b.pct > 100) return err(res, 400, "Guest pays % must be 0 to 100.");
    let depart = null;
    if (b.depart !== undefined && b.depart !== null && b.depart !== "") {
      if (!L.isValidDateStr(b.depart)) return err(res, 400, "Planned departure date is not valid.");
      depart = b.depart;
    }
    const guests = b.guests;
    if (!Array.isArray(guests) || !guests.length) return err(res, 400, "Guest name and ID are required.");
    for (let i = 0; i < guests.length; i++) {
      const g = guests[i] || {};
      if (!isNonEmptyStr(g.name)) return err(res, 400, i === 0 ? "Main guest name is required." : "Every guest needs a name.");
      if (!isNonEmptyStr(g.idNum)) return err(res, 400, i === 0 ? "Main guest ID is required." : "Every guest needs an ID.");
    }
    // ID photo: main guest only, image data URL, max 2 MB decoded.
    const cleanGuests = guests.map((g, i) => {
      const out = {
        name: String(g.name).trim(), idNum: String(g.idNum).trim(),
        contact: typeof g.contact === "string" ? g.contact.trim() : "",
        car: typeof g.car === "string" ? g.car.trim() : "",
      };
      if (i === 0 && typeof g.idPhoto === "string" && g.idPhoto) out.idPhoto = g.idPhoto;
      return out;
    });
    const photo = cleanGuests[0].idPhoto;
    if (photo !== undefined) {
      if (!/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(photo)) return err(res, 400, "ID photo must be an image.");
      const bytes = dataUrlBytes(photo);
      if (bytes < 0) return err(res, 400, "ID photo must be an image.");
      if (bytes > 2 * 1024 * 1024) return err(res, 413, "ID photo is too large (max 2 MB).");
    }
    const now = new Date();
    const stay = {
      id: st.nextStayId++, room: r.number, guests: cleanGuests,
      checkInAt: now.toISOString(), checkInDate: L.todayStr(),
      plannedOut: depart || L.addDays(L.todayStr(), b.nights), checkOutAt: null,
      nights: b.nights, basePrice: st.price, pct: b.pct,
      total: Math.round(st.price * b.pct / 100) * b.nights,
      byIn: req.ctx.user.id, byOut: null, status: "in",
    };
    st.stays.push(stay);
    r.occ = "occupied";
    L.logEvent(st, "checkin", r.number, req.ctx.user.id, "Checked in " + cleanGuests[0].name + " (" + cleanGuests.length + " guests)");
    if (req.ctx.mode === "real") persist();
    return ok(res, { stayId: stay.id });
  });

  app.post("/api/checkout", requireAuth, requirePerm("checkout"), (req, res) => {
    const st = req.ctx.state;
    const s = st.stays.find((x) => x.id === (req.body || {}).stayId);
    if (!s) return err(res, 404, "Not found.");
    if (s.status !== "in") return err(res, 400, "This stay is already checked out.");
    s.status = "out";
    s.checkOutAt = new Date().toISOString();
    s.byOut = req.ctx.user.id;
    const r = L.roomByNum(st, s.room);
    if (r) {
      r.occ = "vacant"; r.hk = "dirty"; r.insp = "awaiting"; r.checklist = [false, false, false, false, false];
      r.lastCleanedBy = null; r.lastCleanedAt = null; r.lastCleanMinutes = null;
      r.cleanStartedAt = null; r.cleanStartedBy = null;
    }
    L.logEvent(st, "checkout", s.room, req.ctx.user.id, "Checked out " + (s.guests[0] ? s.guests[0].name : ""));
    if (req.ctx.mode === "real") persist();
    return ok(res);
  });

  // ---------------- Report / CSV ----------------
  function reportDateParam(req, res) {
    const date = (req.query && req.query.date) || L.todayStr();
    if (!L.isValidDateStr(date)) { err(res, 400, "Date must be YYYY-MM-DD."); return null; }
    return date;
  }
  app.get("/api/report", requireAuth, requirePerm("reports"), (req, res) => {
    const date = reportDateParam(req, res);
    if (!date) return;
    const st = req.ctx.state;
    const priv = canSeePrivate(req.ctx.user);
    const data = L.reportData(st, date);
    const isToday = date === L.todayStr();
    let countsOut = null, noHistory = false;
    if (isToday) {
      const c = L.counts(st);
      countsOut = { ready: c.ready, occupied: c.occupied, dirty: c.dirty, awaiting: c.insp, oos: c.oos };
    } else if (st.snapshots && st.snapshots[date]) {
      const sn = st.snapshots[date];
      countsOut = { ready: sn.ready, occupied: sn.occupied, dirty: sn.dirty, awaiting: sn.awaiting, oos: sn.oos };
    } else {
      noHistory = true;
    }
    const out = {
      date, noHistory, counts: countsOut,
      ins: data.ins.map((s) => L.filterStay(s, priv)),
      outs: data.outs.map((s) => L.filterStay(s, priv)),
      during: data.during.map((s) => L.filterStay(s, priv)),
    };
    if (priv) out.revenue = data.revenue;
    return res.json(out);
  });

  app.get("/api/report.csv", requireAuth, requirePerm("reports.csv"), (req, res) => {
    const date = reportDateParam(req, res);
    if (!date) return;
    const csv = L.buildCsv(req.ctx.state, date, canSeePrivate(req.ctx.user));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="smallstay-report-' + date + '.csv"');
    return res.send(csv);
  });

  // ---------------- Staff ----------------
  app.post("/api/staff", requireAuth, requirePerm("staff.manage"), (req, res) => {
    const st = req.ctx.state;
    const b = req.body || {};
    const name = typeof b.name === "string" ? b.name.trim() : "";
    const username = typeof b.username === "string" ? b.username.trim().toLowerCase() : "";
    const pin = b.pin, role = b.role;
    if (!name || !username || !pin) return err(res, 400, "Fill in all fields.");
    if (typeof pin !== "string" || pin.length < 4) return err(res, 400, "PIN must be at least 4 characters.");
    if (!ROLES.includes(role)) return err(res, 400, "Unknown role.");
    if (role === "owner" && req.ctx.user.role !== "owner") return err(res, 403, NO_PERM);
    if (st.users.some((u) => u.username.toLowerCase() === username)) return err(res, 409, "Username is already taken.");
    const u = {
      id: uid("u"), name, username, pinHash: hashPin(pin), cred: null, role,
      mode: (role === "owner" || role === "manager") ? "full" : "simple",
    };
    st.users.push(u);
    L.logEvent(st, "staff.create", null, req.ctx.user.id, "Staff account created: " + username + " (" + role + ")");
    if (req.ctx.mode === "real") persist();
    return ok(res, { user: L.publicUser(u) });
  });

  app.delete("/api/staff/:id", requireAuth, requirePerm("staff.manage"), (req, res) => {
    const st = req.ctx.state;
    if (req.params.id === req.ctx.user.id) return err(res, 403, NO_PERM);
    const u = L.userById(st, req.params.id);
    if (!u) return err(res, 404, "Not found.");
    if (u.role === "owner" && req.ctx.user.role !== "owner") return err(res, 403, NO_PERM);
    st.users = st.users.filter((x) => x.id !== req.params.id);
    L.logEvent(st, "staff.remove", null, req.ctx.user.id, "Staff account removed: " + u.username);
    if (req.ctx.mode === "real") persist();
    return ok(res);
  });

  app.post("/api/staff/:id/mode", requireAuth, requirePerm("staff.mode"), (req, res) => {
    const st = req.ctx.state;
    const mode = (req.body || {}).mode;
    if (mode !== "simple" && mode !== "full") return err(res, 400, "Mode must be simple or full.");
    const u = L.userById(st, req.params.id);
    if (!u) return err(res, 404, "Not found.");
    if (u.role === "owner" || u.role === "manager") return err(res, 403, NO_PERM);
    u.mode = mode;
    L.logEvent(st, "staff.mode", null, req.ctx.user.id, u.username + " mode → " + mode);
    if (req.ctx.mode === "real") persist();
    return ok(res);
  });

  // ---------------- Settings / price ----------------
  app.post("/api/settings/price", requireAuth, requirePerm("price.change"), (req, res) => {
    const st = req.ctx.state;
    const price = (req.body || {}).price;
    if (!isInt(price) || price < 0 || price > 100000000) return err(res, 400, "Price must be 0 to 100000000.");
    st.price = price;
    L.logEvent(st, "price.change", null, req.ctx.user.id, "Default price set to " + price);
    if (req.ctx.mode === "real") persist();
    return ok(res);
  });

  // ---------------- Backup / restore / reset ----------------
  app.get("/api/backup", requireAuth, requirePerm("backup"), requireReal, (req, res) => {
    const payload = {
      app: "smallstay-v1", backupVersion: 3,
      exportedAt: new Date().toISOString(), db: L.clone(state),
    };
    return res.json(payload);
  });

  app.post("/api/restore", requireAuth, requirePerm("restore"), requireReal, (req, res) => {
    const payload = (req.body || {}).payload;
    if (!payload || typeof payload !== "object") return err(res, 400, "No backup payload.");
    const errs = L.validateBackup(payload);
    if (errs.length) {
      const shown = errs.slice(0, 6);
      const extra = errs.length > 6 ? " (+" + (errs.length - 6) + " more errors)" : "";
      return res.status(400).json({
        error: "Invalid backup: " + shown.join(" ") + extra,
        errors: shown, totalErrors: errs.length,
      });
    }
    state = L.normalizeRestored(payload.db);
    persist();
    deleteAllSessions(db);
    demoStates.clear();
    res.setHeader("Set-Cookie", sessionCookieHeader(null, { clear: true }));
    return ok(res);
  });

  app.post("/api/reset", requireAuth, requirePerm("reset"), requireReal, (req, res) => {
    const confirm = (req.body || {}).confirm;
    if (typeof confirm !== "string" || confirm.toLowerCase() !== "delete") {
      return err(res, 400, 'Type DELETE to confirm.');
    }
    state = L.buildFreshState(null);
    saveState(db, state);
    deleteAllSessions(db);
    demoStates.clear();
    res.setHeader("Set-Cookie", sessionCookieHeader(null, { clear: true }));
    return ok(res);
  });

  // ---------------- Static frontend (built by another agent) ----------------
  app.use(express.static(path.join(__dirname, "..", "public")));

  // Fallthrough: unknown /api route.
  app.use("/api", (_req, res) => err(res, 404, "Not found."));

  function close() {
    try { db.close(); } catch (_) { /* already closed */ }
  }
  return { app, db, close, getState: () => state, demoStates };
}

if (require.main === module) {
  const port = parseInt(process.env.PORT || "3000", 10);
  const { app, close } = createApp({});
  const server = app.listen(port, () => {
    console.log("SmallStay Online v1 listening on port " + port);
  });
  const shutdown = () => { server.close(() => { close(); process.exit(0); }); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

module.exports = { createApp };
