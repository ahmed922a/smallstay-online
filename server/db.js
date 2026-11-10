"use strict";
// SQLite storage (node:sqlite, built-in). One DB file = one hotel.
// The whole hotel state is kept in memory as the v1.7 DB shape and written
// back to SQLite (one transaction) on every real-mode mutation.

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { buildFreshState, clone } = require("./logic");

function openDb(dbPath) {
  const dir = path.dirname(dbPath);
  if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS users(
      id TEXT PRIMARY KEY, name TEXT, username TEXT UNIQUE, pinHash TEXT,
      cred TEXT, role TEXT, mode TEXT);
    CREATE TABLE IF NOT EXISTS rooms(
      number INTEGER PRIMARY KEY, floor INTEGER, type TEXT, occ TEXT, hk TEXT,
      insp TEXT, access TEXT, assignedTo TEXT, checklist TEXT,
      cleanStartedAt TEXT, cleanStartedBy TEXT,
      lastCleanedBy TEXT, lastCleanedAt TEXT, lastCleanMinutes REAL);
    CREATE TABLE IF NOT EXISTS stays(
      id INTEGER PRIMARY KEY, room INTEGER, guests TEXT, checkInAt TEXT,
      checkInDate TEXT, plannedOut TEXT, checkOutAt TEXT, nights INTEGER,
      basePrice REAL, pct REAL, total REAL, byIn TEXT, byOut TEXT, status TEXT);
    CREATE TABLE IF NOT EXISTS tickets(
      id INTEGER PRIMARY KEY, room INTEGER, type TEXT, prio TEXT, status TEXT,
      note TEXT, reporterId TEXT, assigneeId TEXT, createdAt TEXT,
      blocking INTEGER, history TEXT);
    CREATE TABLE IF NOT EXISTS events(
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, kind TEXT, room INTEGER,
      byId TEXT, text TEXT);
    CREATE TABLE IF NOT EXISTS snapshots(
      date TEXT PRIMARY KEY, ready INTEGER, occupied INTEGER, dirty INTEGER,
      awaiting INTEGER, oos INTEGER, at TEXT);
    CREATE TABLE IF NOT EXISTS sessions(
      token TEXT PRIMARY KEY, userId TEXT, mode TEXT, demoKey TEXT,
      createdAt TEXT, expiresAt TEXT);
  `);
  return db;
}

function loadState(db) {
  const metaRow = (k) => {
    const r = db.prepare("SELECT value FROM meta WHERE key=?").get(k);
    return r ? JSON.parse(r.value) : undefined;
  };
  const hasAnyMeta = db.prepare("SELECT COUNT(*) c FROM meta").get().c > 0;
  if (!hasAnyMeta) return buildFreshState(null);

  const setupDone = metaRow("setupDone") === 1;
  const config = metaRow("config") ?? null;
  const hotel = metaRow("hotel") || { name: "", address: "", currency: "IQD" };
  const currency = metaRow("currency") || "IQD";
  const price = metaRow("price") ?? 0;
  const startedAt = metaRow("startedAt") ?? null;
  const nextStayId = metaRow("nextStayId") ?? 1;
  const nextTicketId = metaRow("nextTicketId") ?? 1;

  const users = db.prepare("SELECT * FROM users").all().map((u) => ({
    id: u.id, name: u.name, username: u.username,
    pinHash: u.pinHash || null,
    cred: u.cred ? JSON.parse(u.cred) : null,
    role: u.role, mode: u.mode,
  }));
  const rooms = db.prepare("SELECT * FROM rooms ORDER BY number").all().map((r) => ({
    number: r.number, floor: r.floor, type: r.type, occ: r.occ, hk: r.hk,
    insp: r.insp, access: r.access, assignedTo: r.assignedTo,
    checklist: JSON.parse(r.checklist || "[false,false,false,false,false]"),
    cleanStartedAt: r.cleanStartedAt, cleanStartedBy: r.cleanStartedBy,
    lastCleanedBy: r.lastCleanedBy, lastCleanedAt: r.lastCleanedAt,
    lastCleanMinutes: r.lastCleanMinutes,
  }));
  const stays = db.prepare("SELECT * FROM stays ORDER BY id").all().map((s) => ({
    id: s.id, room: s.room, guests: JSON.parse(s.guests || "[]"),
    checkInAt: s.checkInAt, checkInDate: s.checkInDate, plannedOut: s.plannedOut,
    checkOutAt: s.checkOutAt, nights: s.nights, basePrice: s.basePrice,
    pct: s.pct, total: s.total, byIn: s.byIn, byOut: s.byOut, status: s.status,
  }));
  const tickets = db.prepare("SELECT * FROM tickets ORDER BY id").all().map((t) => ({
    id: t.id, room: t.room, type: t.type, prio: t.prio, status: t.status,
    note: t.note || "", reporterId: t.reporterId, assigneeId: t.assigneeId,
    createdAt: t.createdAt, blocking: t.blocking === 1,
    history: JSON.parse(t.history || "[]"),
  }));
  const events = db.prepare("SELECT at, kind, room, byId, text FROM events ORDER BY id").all()
    .map((e) => ({ at: e.at, kind: e.kind, room: e.room, byId: e.byId, text: e.text }));
  const snapshots = {};
  for (const s of db.prepare("SELECT * FROM snapshots").all()) {
    snapshots[s.date] = { date: s.date, ready: s.ready, occupied: s.occupied, dirty: s.dirty, awaiting: s.awaiting, oos: s.oos, at: s.at };
  }
  return {
    v: 3, setupDone, config, hotel, currency, users, rooms, stays, tickets,
    events, snapshots, nextStayId, nextTicketId, price, startedAt,
  };
}

// Write the whole in-memory state back to SQLite in one transaction.
function saveState(db, state) {
  const s = clone(state);
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM meta; DELETE FROM users; DELETE FROM rooms; DELETE FROM stays; DELETE FROM tickets; DELETE FROM events; DELETE FROM snapshots;");
    const putMeta = db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)");
    putMeta.run("setupDone", JSON.stringify(s.setupDone ? 1 : 0));
    putMeta.run("config", JSON.stringify(s.config));
    putMeta.run("hotel", JSON.stringify(s.hotel));
    putMeta.run("currency", JSON.stringify(s.currency));
    putMeta.run("price", JSON.stringify(s.price));
    putMeta.run("startedAt", JSON.stringify(s.startedAt));
    putMeta.run("nextStayId", JSON.stringify(s.nextStayId));
    putMeta.run("nextTicketId", JSON.stringify(s.nextTicketId));
    const insUser = db.prepare("INSERT INTO users(id, name, username, pinHash, cred, role, mode) VALUES (?,?,?,?,?,?,?)");
    for (const u of s.users) insUser.run(u.id, u.name, u.username, u.pinHash || null, u.cred ? JSON.stringify(u.cred) : null, u.role, u.mode);
    const insRoom = db.prepare("INSERT INTO rooms(number, floor, type, occ, hk, insp, access, assignedTo, checklist, cleanStartedAt, cleanStartedBy, lastCleanedBy, lastCleanedAt, lastCleanMinutes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    for (const r of s.rooms) insRoom.run(r.number, r.floor, r.type, r.occ, r.hk, r.insp, r.access, r.assignedTo, JSON.stringify(r.checklist), r.cleanStartedAt, r.cleanStartedBy, r.lastCleanedBy, r.lastCleanedAt, r.lastCleanMinutes);
    const insStay = db.prepare("INSERT INTO stays(id, room, guests, checkInAt, checkInDate, plannedOut, checkOutAt, nights, basePrice, pct, total, byIn, byOut, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    for (const st of s.stays) insStay.run(st.id, st.room, JSON.stringify(st.guests), st.checkInAt, st.checkInDate, st.plannedOut, st.checkOutAt, st.nights, st.basePrice, st.pct, st.total, st.byIn, st.byOut, st.status);
    const insTicket = db.prepare("INSERT INTO tickets(id, room, type, prio, status, note, reporterId, assigneeId, createdAt, blocking, history) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    for (const t of s.tickets) insTicket.run(t.id, t.room, t.type, t.prio, t.status, t.note || "", t.reporterId, t.assigneeId, t.createdAt, t.blocking ? 1 : 0, JSON.stringify(t.history || []));
    const insEvent = db.prepare("INSERT INTO events(at, kind, room, byId, text) VALUES (?,?,?,?,?)");
    for (const e of s.events) insEvent.run(e.at, e.kind, e.room, e.byId, e.text);
    const insSnap = db.prepare("INSERT INTO snapshots(date, ready, occupied, dirty, awaiting, oos, at) VALUES (?,?,?,?,?,?,?)");
    for (const k of Object.keys(s.snapshots)) {
      const sn = s.snapshots[k];
      insSnap.run(sn.date, sn.ready, sn.occupied, sn.dirty, sn.awaiting, sn.oos, sn.at);
    }
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch (_) { /* already rolled back */ }
    throw e;
  }
}

// --- Sessions (server-side, token is a random secret; no data in the cookie) ---
function createSession(db, { userId, mode, demoKey, days = 7 }) {
  const crypto = require("crypto");
  const token = crypto.randomBytes(32).toString("hex");
  const now = new Date();
  const expires = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  db.prepare("INSERT INTO sessions(token, userId, mode, demoKey, createdAt, expiresAt) VALUES (?,?,?,?,?,?)")
    .run(token, userId || null, mode, demoKey || null, now.toISOString(), expires.toISOString());
  return { token, expiresAt: expires.toISOString() };
}
function getSession(db, token) {
  if (!token) return null;
  const row = db.prepare("SELECT * FROM sessions WHERE token=?").get(token);
  if (!row) return null;
  if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token=?").run(token);
    return null;
  }
  return row;
}
function deleteSession(db, token) {
  if (token) db.prepare("DELETE FROM sessions WHERE token=?").run(token);
}
function deleteAllSessions(db) {
  db.exec("DELETE FROM sessions");
}

module.exports = { openDb, loadState, saveState, createSession, getSession, deleteSession, deleteAllSessions };
