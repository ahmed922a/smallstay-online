"use strict";
// Pure state helpers ported from SmallStay v1.7 (no Express, no SQLite here).
// Operate on the v1.7 DB shape:
// {v:3, setupDone, config, hotel, currency, users, rooms, stays, tickets,
//  events, snapshots:{date:{...}}, nextStayId, nextTicketId, price, startedAt}

const {
  ROLES, TICKET_STATUSES, HK_VALS, INSP_VALS, OCC_VALS, ACC_VALS,
} = require("./constants");

function pad2(n) { return String(n).padStart(2, "0"); }
function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}
function dateOf(iso) { return iso ? String(iso).slice(0, 10) : ""; }
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function configTotal(cfg) { return cfg ? cfg.floorCount * cfg.roomsPerFloor : 0; }
function isValidDateStr(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + "T12:00:00").getTime());
}

function newRoom(num, floor) {
  return {
    number: num, floor, type: null, occ: "vacant", hk: "clean", insp: "awaiting",
    access: "in", assignedTo: null, checklist: [false, false, false, false, false],
    cleanStartedAt: null, cleanStartedBy: null,
    lastCleanedBy: null, lastCleanedAt: null, lastCleanMinutes: null,
  };
}
function buildRoomsBlank(cfg) {
  const c = cfg || { firstFloor: 1, floorCount: 3, roomsPerFloor: 10 };
  const out = [];
  for (let f = c.firstFloor; f < c.firstFloor + c.floorCount; f++) {
    for (let k = 1; k <= c.roomsPerFloor; k++) out.push(newRoom(f * 100 + k, f));
  }
  return out;
}
function buildFreshState(cfg) {
  if (!cfg) {
    return {
      v: 3, setupDone: false, config: null, hotel: { name: "", address: "", currency: "IQD" },
      currency: "IQD", users: [], rooms: [], stays: [], tickets: [], events: [],
      snapshots: {}, nextStayId: 1, nextTicketId: 1, price: 0, startedAt: null,
    };
  }
  return {
    v: 3, setupDone: false, config: cfg,
    hotel: { name: cfg.hotelName || "", address: cfg.address || "", currency: cfg.currency },
    currency: cfg.currency, users: [], rooms: buildRoomsBlank(cfg), stays: [], tickets: [],
    events: [], snapshots: {}, nextStayId: 1, nextTicketId: 1, price: cfg.price,
    startedAt: null,
  };
}

function roomByNum(state, n) {
  const num = Number(n);
  return state.rooms.find((r) => r.number === num) || null;
}
function userById(state, id) {
  return state.users.find((u) => u.id === id) || null;
}
function activeStayForRoom(state, num) {
  return state.stays.find((s) => s.room === num && s.status === "in") || null;
}
function isReady(r) {
  return r.occ === "vacant" && r.hk === "clean" && r.insp === "passed" && r.access === "in";
}
function cannotReason(r) {
  if (r.access === "out") return "Out of service";
  if (r.occ === "occupied") return "Occupied";
  if (r.hk === "dirty") return "Dirty / needs cleaning";
  if (r.hk === "cleaning") return "Cleaning in progress";
  if (r.insp !== "passed") return "Awaiting inspection";
  return "";
}
function counts(state) {
  const c = { total: state.rooms.length, ready: 0, dirty: 0, oos: 0, occupied: 0, cleaning: 0, insp: 0, vacant: 0 };
  for (const r of state.rooms) {
    if (isReady(r)) c.ready++;
    if (r.hk === "dirty") c.dirty++;
    if (r.hk === "cleaning") c.cleaning++;
    if (r.insp === "awaiting" || r.insp === "failed") c.insp++;
    if (r.access === "out") c.oos++;
    if (r.occ === "occupied") c.occupied++; else c.vacant++;
  }
  return c;
}
function logEvent(state, kind, room, byId, text) {
  state.events.push({ at: new Date().toISOString(), kind, room: room || null, byId: byId || null, text: text || "" });
  if (state.events.length > 2000) state.events = state.events.slice(state.events.length - 2000);
}
function snapshotToday(state) {
  const c = counts(state);
  const d = todayStr();
  state.snapshots[d] = { date: d, ready: c.ready, occupied: c.occupied, dirty: c.dirty, awaiting: c.insp, oos: c.oos, at: new Date().toISOString() };
}

// Exact port of v1.7 reportData(date).
function reportData(state, date) {
  const ins = state.stays.filter((s) => s.checkInDate === date);
  const outs = state.stays.filter((s) => s.checkOutAt && dateOf(s.checkOutAt) === date);
  const during = state.stays.filter((s) => {
    if (s.checkInDate > date) return false;
    if (s.checkOutAt) {
      const co = dateOf(s.checkOutAt);
      return co > date || co === s.checkInDate;
    }
    if (s.status === "in") return true;
    return s.plannedOut > date;
  });
  let revenue = 0;
  for (const s of during) revenue += Math.round(s.basePrice * s.pct / 100);
  return { ins, outs, during, revenue };
}

// --- Privacy filtering (server-side) ---
function publicUser(u) {
  return { id: u.id, name: u.name, username: u.username, role: u.role, mode: u.mode };
}
function filterStay(s, priv) {
  if (priv) return clone(s);
  return {
    id: s.id, room: s.room, checkInDate: s.checkInDate, plannedOut: s.plannedOut,
    checkOutAt: s.checkOutAt, nights: s.nights, status: s.status,
    guests: (s.guests || []).map((g) => ({ name: g.name })),
  };
}
function serializeState(state, user, priv) {
  return {
    config: state.config, hotel: state.hotel, currency: state.currency,
    price: state.price, startedAt: state.startedAt || null,
    users: state.users.map(publicUser),
    rooms: clone(state.rooms),
    stays: state.stays.map((s) => filterStay(s, priv)),
    tickets: clone(state.tickets),
    counts: counts(state),
    mode: user && user._demo ? "demo" : "real",
  };
}

// --- CSV (exact port of v1.7 downloadCSV) ---
function csvCell(v) {
  let s = String(v == null ? "" : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function buildCsv(state, date, priv) {
  const data = reportData(state, date);
  const lines = [];
  const hotelName = (state.hotel && state.hotel.name) || "SmallStay";
  lines.push([hotelName + " — Daily Report", date].map(csvCell).join(","));
  lines.push(["Section", "Room", "Guests", "Check-in", "Planned departure", "Check-out", "Base price/night", "Guest pays %", "Agreed/night", "Nights", "Stay total", "Checked in by"].map(csvCell).join(","));
  function row(section, s) {
    const byName = s.byIn ? (userById(state, s.byIn) || {}).name || "—" : "";
    return [section, s.room,
      priv ? s.guests.map((g) => g.name + (g.idNum ? " (" + g.idNum + ")" : "")).join("; ") : s.guests.map((g) => g.name).join("; "),
      s.checkInDate, s.plannedOut, s.checkOutAt ? dateOf(s.checkOutAt) : "",
      priv ? s.basePrice : "", priv ? s.pct : "", priv ? Math.round(s.basePrice * s.pct / 100) : "",
      s.nights, priv ? s.total : "", byName].map(csvCell).join(",");
  }
  data.ins.forEach((s) => lines.push(row("Check-in", s)));
  data.outs.forEach((s) => lines.push(row("Check-out", s)));
  data.during.forEach((s) => lines.push(row("In house that night", s)));
  lines.push(["Revenue for this date (one night per occupied room)", "", "", "", "", "", "", "", priv ? data.revenue : ""].map(csvCell).join(","));
  return lines.join("\r\n");
}

// --- Backup validation: exact port of v1.7 validateBackup() ---
function validateBackup(payload) {
  const errs = [];
  if (!payload || typeof payload !== "object") return ["Not a JSON object."];
  if (payload.app !== "smallstay-v1") errs.push("Not a SmallStay backup file.");
  const d = payload.db;
  if (!d || typeof d !== "object") return errs.concat(["Missing data section."]);
  if (d.v !== 3) errs.push("Unsupported data version: " + d.v);
  if (!d.config || typeof d.config !== "object") errs.push("Backup has no hotel setup (floors / rooms).");
  else {
    if (!(d.config.firstFloor >= 0 && d.config.firstFloor <= 20)) errs.push("Bad first floor in backup.");
    if (!(d.config.floorCount >= 1 && d.config.floorCount <= 12)) errs.push("Bad guest-floor count in backup.");
    if (!(d.config.roomsPerFloor >= 1 && d.config.roomsPerFloor <= 12)) errs.push("Bad rooms-per-floor in backup.");
  }
  if (d.currency && d.currency !== "IQD" && d.currency !== "USD") errs.push("Bad currency in backup.");
  if (d.hotel && !d.hotel.name) errs.push("Backup has no hotel name.");
  if (!Array.isArray(d.rooms) || (d.config && d.rooms.length !== configTotal(d.config))) {
    errs.push("Rooms must match the hotel setup in the backup.");
  } else {
    const seen = {};
    d.rooms.forEach((r) => {
      if (seen[r.number]) errs.push("Duplicate room number " + r.number);
      seen[r.number] = true;
      const maxPer = d.config ? d.config.roomsPerFloor : 12;
      if (Math.floor(r.number / 100) !== r.floor || r.number % 100 < 1 || r.number % 100 > maxPer) errs.push("Room " + r.number + " does not match its floor.");
      if (d.config && (r.floor < d.config.firstFloor || r.floor >= d.config.firstFloor + d.config.floorCount)) errs.push("Room " + r.number + " is outside the hotel floors.");
      if (OCC_VALS.indexOf(r.occ) < 0) errs.push("Room " + r.number + ": bad occupancy value.");
      if (HK_VALS.indexOf(r.hk) < 0) errs.push("Room " + r.number + ": bad housekeeping value.");
      if (INSP_VALS.indexOf(r.insp) < 0) errs.push("Room " + r.number + ": bad inspection value.");
      if (ACC_VALS.indexOf(r.access) < 0) errs.push("Room " + r.number + ": bad service value.");
      if (r.type !== null && r.type !== "Single" && r.type !== "Twin") errs.push("Room " + r.number + ": bad room type.");
    });
  }
  if (!Array.isArray(d.users) || !d.users.length) errs.push("No staff accounts in backup.");
  else {
    const unames = {};
    d.users.forEach((u) => {
      if (ROLES.indexOf(u.role) < 0) errs.push("Bad staff role: " + u.role);
      if (!u.username) errs.push("A staff account has no username.");
      else if (unames[String(u.username).toLowerCase()]) errs.push("Duplicate username: " + u.username);
      else unames[String(u.username).toLowerCase()] = true;
      if (u.pin) errs.push("Backup contains a plaintext PIN for " + u.username + " — refused.");
    });
    if (!d.users.some((u) => u.role === "owner")) errs.push("Backup has no Owner account.");
  }
  if (!Array.isArray(d.stays) || !Array.isArray(d.tickets)) errs.push("Missing stays or tickets.");
  else {
    const roomSet = {};
    (d.rooms || []).forEach((r) => { roomSet[r.number] = true; });
    const activeRooms = {};
    d.stays.forEach((s) => {
      if (!roomSet[s.room]) errs.push("Stay refers to unknown room " + s.room);
      if (s.status === "in") {
        if (activeRooms[s.room]) errs.push("Two active stays for room " + s.room);
        activeRooms[s.room] = true;
        let rm = null;
        (d.rooms || []).forEach((r) => { if (r.number === s.room) rm = r; });
        if (rm && rm.occ !== "occupied") errs.push("Active stay in room " + s.room + " but the room is not marked occupied.");
      }
      if (typeof s.pct !== "number" || s.pct < 0 || s.pct > 100) errs.push("Stay in room " + s.room + ": guest-pays % out of range.");
      if (!Array.isArray(s.guests) || !s.guests.length || !s.guests[0].name) errs.push("Stay in room " + s.room + ": missing main guest.");
    });
    d.tickets.forEach((x) => {
      if (!roomSet[x.room]) errs.push("Ticket refers to unknown room " + x.room);
      if (TICKET_STATUSES.indexOf(x.status) < 0) errs.push("Ticket #" + x.id + ": bad status.");
    });
  }
  if (typeof d.price !== "number" || d.price < 0 || d.price > 100000000) errs.push("Bad price value.");
  if (typeof d.nextStayId !== "number" || typeof d.nextTicketId !== "number") errs.push("Missing ID counters.");
  return errs;
}

// Normalize a restored DB object into the server's canonical shape.
function normalizeRestored(d) {
  const s = clone(d);
  if (!s.currency) s.currency = "IQD";
  if (!s.hotel) s.hotel = { name: "Hotel", address: "", currency: s.currency };
  if (!Array.isArray(s.events)) s.events = [];
  if (!s.snapshots || typeof s.snapshots !== "object") s.snapshots = {};
  if (s.startedAt === undefined) s.startedAt = null;
  if (typeof s.setupDone !== "boolean") s.setupDone = Array.isArray(s.users) && s.users.length > 0;
  // Users: keep pinHash (bcrypt) when present; keep legacy v1.7 cred for
  // SHA-256 verification so a v1.7 backup's accounts still sign in.
  s.users = (s.users || []).map((u) => ({
    id: u.id, name: u.name, username: String(u.username).toLowerCase(),
    pinHash: u.pinHash || null, cred: u.cred || null,
    role: u.role, mode: u.mode || ((u.role === "owner" || u.role === "manager") ? "full" : "simple"),
  }));
  s.rooms = (s.rooms || []).map((r) => ({
    number: r.number, floor: r.floor, type: r.type == null ? null : r.type,
    occ: r.occ, hk: r.hk, insp: r.insp, access: r.access,
    assignedTo: r.assignedTo || null,
    checklist: Array.isArray(r.checklist) && r.checklist.length === 5 ? r.checklist : [false, false, false, false, false],
    cleanStartedAt: r.cleanStartedAt || null, cleanStartedBy: r.cleanStartedBy || null,
    lastCleanedBy: r.lastCleanedBy || null, lastCleanedAt: r.lastCleanedAt || null,
    lastCleanMinutes: r.lastCleanMinutes == null ? null : r.lastCleanMinutes,
  }));
  return s;
}

module.exports = {
  pad2, todayStr, dateOf, addDays, clone, configTotal, isValidDateStr,
  newRoom, buildRoomsBlank, buildFreshState,
  roomByNum, userById, activeStayForRoom, isReady, cannotReason, counts,
  logEvent, snapshotToday, reportData,
  publicUser, filterStay, serializeState, csvCell, buildCsv,
  validateBackup, normalizeRestored,
};
