"use strict";
// API tests for SmallStay Online v1 — Node's built-in runner only.
// Every test starts its own server on a random port with a fresh temp DB.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../server/index");

function localToday() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

async function start(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smallstay-test-"));
  const dbPath = path.join(dir, "test.db");
  const { app, close } = createApp({ dbPath });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = server.address().port;
  const base = "http://127.0.0.1:" + port;
  t.after(() => {
    server.close();
    close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // Minimal cookie jar: one session cookie.
  function jar() { return { cookie: "" }; }
  async function req(j, method, p, body) {
    const headers = { "Content-Type": "application/json" };
    if (j && j.cookie) headers.Cookie = j.cookie;
    const r = await fetch(base + p, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = r.headers.get("set-cookie");
    if (j && setCookie) {
      const m = /ss_session=[^;]*/.exec(setCookie);
      j.cookie = m ? m[0] : "";
      if (/Max-Age=0/.test(setCookie)) j.cookie = "";
    }
    let data = null;
    const text = await r.text();
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    return { status: r.status, data, headers: r.headers };
  }
  return { base, req, jar };
}

async function setupHotel(s) {
  const ownerJar = s.jar();
  const w = await s.req(ownerJar, "POST", "/api/setup/wizard", {
    hotelName: "Test Hotel", address: "Main Street", currency: "IQD",
    price: 50000, firstFloor: 1, floorCount: 3, roomsPerFloor: 10,
  });
  assert.equal(w.status, 200, "wizard: " + JSON.stringify(w.data));
  const o = await s.req(ownerJar, "POST", "/api/setup/owner", {
    name: "Test Owner", username: "owner", pin: "1234", pin2: "1234",
  });
  assert.equal(o.status, 200, "owner setup: " + JSON.stringify(o.data));
  assert.equal(o.data.user.role, "owner");
  return ownerJar;
}

async function makeStaff(s, ownerJar, { name, username, pin, role }) {
  const r = await s.req(ownerJar, "POST", "/api/staff", { name, username, pin, role });
  assert.equal(r.status, 200, "create staff " + username + ": " + JSON.stringify(r.data));
  return r.data.user;
}
async function loginAs(s, username, pin) {
  const j = s.jar();
  const r = await s.req(j, "POST", "/api/auth/login", { username, pin });
  assert.equal(r.status, 200, "login " + username + ": " + JSON.stringify(r.data));
  return j;
}
async function makeReady(s, jar, room) {
  const r = await s.req(jar, "POST", "/api/inspections", { room, pass: true });
  assert.equal(r.status, 200, "inspect pass room " + room + ": " + JSON.stringify(r.data));
}
async function getState(s, jar) {
  const r = await s.req(jar, "GET", "/api/state");
  assert.equal(r.status, 200, "state: " + JSON.stringify(r.data));
  return r.data;
}

const GUEST_PHOTO = "data:image/jpeg;base64," + Buffer.from("fake-jpeg-bytes").toString("base64");

test("health", async (t) => {
  const s = await start(t);
  const r = await s.req(null, "GET", "/api/health");
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { ok: true });
});

test("wizard validation errors, then success, then 409 on repeat", async (t) => {
  const s = await start(t);
  const j = s.jar();
  const bad = [
    [{ currency: "IQD", price: 50000, firstFloor: 1, floorCount: 3, roomsPerFloor: 10 }, "missing hotel name"],
    [{ hotelName: "H", currency: "EUR", price: 50000, firstFloor: 1, floorCount: 3, roomsPerFloor: 10 }, "bad currency"],
    [{ hotelName: "H", currency: "IQD", price: 0, firstFloor: 1, floorCount: 3, roomsPerFloor: 10 }, "price 0"],
    [{ hotelName: "H", currency: "IQD", price: 50000, firstFloor: 21, floorCount: 3, roomsPerFloor: 10 }, "first floor 21"],
    [{ hotelName: "H", currency: "IQD", price: 50000, firstFloor: 1, floorCount: 13, roomsPerFloor: 10 }, "floor count 13"],
    [{ hotelName: "H", currency: "IQD", price: 50000, firstFloor: 1, floorCount: 3, roomsPerFloor: 0 }, "rooms per floor 0"],
  ];
  for (const [body, why] of bad) {
    const r = await s.req(j, "POST", "/api/setup/wizard", body);
    assert.equal(r.status, 400, why + ": " + JSON.stringify(r.data));
  }
  const okR = await s.req(j, "POST", "/api/setup/wizard", {
    hotelName: "Test Hotel", currency: "IQD", price: 50000,
    firstFloor: 1, floorCount: 3, roomsPerFloor: 10,
  });
  assert.equal(okR.status, 200);
  const again = await s.req(j, "POST", "/api/setup/wizard", {
    hotelName: "Other", currency: "USD", price: 100,
    firstFloor: 1, floorCount: 1, roomsPerFloor: 1,
  });
  assert.equal(again.status, 409);
  assert.equal(again.data.error, "Hotel is already set up.");
  const status = await s.req(null, "GET", "/api/status");
  assert.deepEqual(status.data, { setupDone: false, hasConfig: true, hotelName: "Test Hotel" });
});

test("owner setup validation + sign-in, wrong PIN 401", async (t) => {
  const s = await start(t);
  const j = s.jar();
  // Owner setup before wizard -> 409.
  const early = await s.req(j, "POST", "/api/setup/owner", { name: "O", username: "owner", pin: "1234", pin2: "1234" });
  assert.equal(early.status, 409);
  await s.req(j, "POST", "/api/setup/wizard", {
    hotelName: "Test Hotel", currency: "IQD", price: 50000,
    firstFloor: 1, floorCount: 3, roomsPerFloor: 10,
  });
  const mismatch = await s.req(j, "POST", "/api/setup/owner", { name: "O", username: "owner", pin: "1234", pin2: "9999" });
  assert.equal(mismatch.status, 400);
  const short = await s.req(j, "POST", "/api/setup/owner", { name: "O", username: "owner", pin: "12", pin2: "12" });
  assert.equal(short.status, 400);
  const okR = await s.req(j, "POST", "/api/setup/owner", { name: "Test Owner", username: "owner", pin: "1234", pin2: "1234" });
  assert.equal(okR.status, 200);
  assert.equal(okR.data.user.username, "owner");
  // Second owner setup -> 409.
  const again = await s.req(j, "POST", "/api/setup/owner", { name: "O2", username: "owner2", pin: "1234", pin2: "1234" });
  assert.equal(again.status, 409);
  // Sign out, sign back in.
  await s.req(j, "POST", "/api/auth/logout");
  const meOut = await s.req(j, "GET", "/api/auth/me");
  assert.equal(meOut.status, 401);
  const wrong = await s.req(j, "POST", "/api/auth/login", { username: "owner", pin: "9999" });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.data.error, "Wrong username or PIN.");
  const unknown = await s.req(j, "POST", "/api/auth/login", { username: "nobody", pin: "1234" });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.data.error, "Wrong username or PIN."); // same message, no enumeration
  const good = await s.req(j, "POST", "/api/auth/login", { username: "OWNER", pin: "1234" });
  assert.equal(good.status, 200, "username match is case-insensitive");
  const me = await s.req(j, "GET", "/api/auth/me");
  assert.equal(me.status, 200);
  assert.equal(me.data.user.role, "owner");
  assert.equal(me.data.hotel.name, "Test Hotel");
  assert.equal(me.data.price, 50000);
  assert.equal(me.data.startedAt, localToday());
  // Public users picker lists the owner.
  const pub = await s.req(null, "GET", "/api/users/public");
  assert.equal(pub.status, 200);
  assert.deepEqual(pub.data, [{ name: "Test Owner", username: "owner", role: "owner" }]);
});

test("login rate limit: 10 failed attempts then 429", async (t) => {
  const s = await start(t);
  const ownerJar = await setupHotel(s);
  void ownerJar;
  const j = s.jar();
  for (let i = 0; i < 10; i++) {
    const r = await s.req(j, "POST", "/api/auth/login", { username: "owner", pin: "0000" });
    assert.equal(r.status, 401, "attempt " + (i + 1));
  }
  const blocked = await s.req(j, "POST", "/api/auth/login", { username: "owner", pin: "0000" });
  assert.equal(blocked.status, 429);
});

test("worker creation + housekeeper cannot check in + privacy filtering in /api/state", async (t) => {
  const s = await start(t);
  const ownerJar = await setupHotel(s);
  const hk = await makeStaff(s, ownerJar, { name: "Sara", username: "sara", pin: "5678", role: "housekeeper" });
  const rec = await makeStaff(s, ownerJar, { name: "Rana", username: "rana", pin: "5678", role: "reception" });
  const sup = await makeStaff(s, ownerJar, { name: "Sam", username: "sam", pin: "5678", role: "supervisor" });
  assert.equal(hk.mode, "simple");
  assert.equal(rec.mode, "simple");
  // Duplicate username (case-insensitive) -> 409.
  const dup = await s.req(ownerJar, "POST", "/api/staff", { name: "Sara 2", username: "SARA", pin: "5678", role: "housekeeper" });
  assert.equal(dup.status, 409);
  // Only owner may create another owner.
  const mgrJar = s.jar();
  await makeStaff(s, ownerJar, { name: "Mona", username: "mona", pin: "5678", role: "manager" });
  const mgrLogin = await s.req(mgrJar, "POST", "/api/auth/login", { username: "mona", pin: "5678" });
  assert.equal(mgrLogin.status, 200);
  const owner2 = await s.req(mgrJar, "POST", "/api/staff", { name: "Bad", username: "badowner", pin: "5678", role: "owner" });
  assert.equal(owner2.status, 403);

  // Reception checks a guest in (with contact, car, ID photo, money).
  const recJar = await loginAs(s, "rana", "5678");
  await makeReady(s, ownerJar, 101);
  const ci = await s.req(recJar, "POST", "/api/checkin", {
    room: 101, nights: 2, pct: 40,
    guests: [{ name: "Guest One", idNum: "ID-1", contact: "0770 111", car: "Car 1", idPhoto: GUEST_PHOTO }],
  });
  assert.equal(ci.status, 200, JSON.stringify(ci.data));

  // Housekeeper: cannot check in, and sees no private data in state.
  const hkJar = await loginAs(s, "sara", "5678");
  const hkCi = await s.req(hkJar, "POST", "/api/checkin", {
    room: 102, nights: 1, pct: 100, guests: [{ name: "X", idNum: "ID-X" }],
  });
  assert.equal(hkCi.status, 403);
  const hkState = await getState(s, hkJar);
  assert.equal(hkState.stays.length, 1);
  const hs = hkState.stays[0];
  assert.deepEqual(hs.guests, [{ name: "Guest One" }]);
  assert.equal(hs.idNum, undefined);
  assert.equal(hs.basePrice, undefined);
  assert.equal(hs.pct, undefined);
  assert.equal(hs.total, undefined);
  assert.equal(hs.byIn, undefined);
  assert.equal(hs.byOut, undefined);
  assert.equal(JSON.stringify(hkState).includes("0770 111"), false, "contact must not leak");
  assert.equal(JSON.stringify(hkState).includes("fake-jpeg"), false, "idPhoto must not leak");
  assert.equal(JSON.stringify(hkState).includes("pinHash"), false, "pinHash must never leak");
  // Owner sees everything.
  const owState = await getState(s, ownerJar);
  assert.equal(owState.stays[0].guests[0].contact, "0770 111");
  assert.equal(owState.stays[0].guests[0].idPhoto, GUEST_PHOTO);
  assert.equal(owState.stays[0].total, 40000);
  // Supervisor also sees no private data.
  const supJar = await loginAs(s, "sam", "5678");
  const supState = await getState(s, supJar);
  assert.deepEqual(supState.stays[0].guests, [{ name: "Guest One" }]);
  assert.equal(supState.stays[0].total, undefined);
});

test("reception cannot manage staff; supervisor cannot create staff", async (t) => {
  const s = await start(t);
  const ownerJar = await setupHotel(s);
  await makeStaff(s, ownerJar, { name: "Rana", username: "rana", pin: "5678", role: "reception" });
  await makeStaff(s, ownerJar, { name: "Sam", username: "sam", pin: "5678", role: "supervisor" });
  const recJar = await loginAs(s, "rana", "5678");
  const r1 = await s.req(recJar, "POST", "/api/staff", { name: "X", username: "x", pin: "5678", role: "housekeeper" });
  assert.equal(r1.status, 403);
  const r2 = await s.req(recJar, "DELETE", "/api/staff/some-id");
  assert.equal(r2.status, 403);
  const supJar = await loginAs(s, "sam", "5678");
  const r3 = await s.req(supJar, "POST", "/api/staff", { name: "X", username: "x", pin: "5678", role: "housekeeper" });
  assert.equal(r3.status, 403);
  // Owner cannot remove self; manager cannot remove owner.
  const self = await s.req(ownerJar, "DELETE", "/api/staff/" + (await getState(s, ownerJar)).users.find((u) => u.username === "owner").id);
  assert.equal(self.status, 403);
});

test("full check-in -> check-out flow with dates and money math", async (t) => {
  const s = await start(t);
  const ownerJar = await setupHotel(s);
  await makeStaff(s, ownerJar, { name: "Rana", username: "rana", pin: "5678", role: "reception" });
  const recJar = await loginAs(s, "rana", "5678");
  await makeReady(s, ownerJar, 101);
  const today = localToday();
  const ci = await s.req(recJar, "POST", "/api/checkin", {
    room: 101, nights: 2, pct: 40,
    guests: [
      { name: "Guest One", idNum: "ID-1", contact: "0770", car: "" },
      { name: "Guest Two", idNum: "ID-2" },
    ],
  });
  assert.equal(ci.status, 200);
  const stayId = ci.data.stayId;
  let st = await getState(s, recJar);
  const stay = st.stays.find((x) => x.id === stayId);
  assert.equal(stay.checkInDate, today);
  assert.equal(stay.plannedOut, addDays(today, 2));
  assert.equal(stay.nights, 2);
  assert.equal(stay.basePrice, 50000);
  assert.equal(stay.pct, 40);
  assert.equal(stay.total, 40000); // round(50000*40/100)=20000/night x 2
  assert.equal(stay.status, "in");
  assert.equal(stay.guests.length, 2);
  const room = st.rooms.find((r) => r.number === 101);
  assert.equal(room.occ, "occupied");
  assert.equal(st.counts.occupied, 1);
  // Explicit depart date is honoured.
  await makeReady(s, ownerJar, 102);
  const depart = addDays(today, 5);
  const ci2 = await s.req(recJar, "POST", "/api/checkin", {
    room: 102, nights: 3, pct: 100, depart, guests: [{ name: "Guest Three", idNum: "ID-3" }],
  });
  assert.equal(ci2.status, 200);
  st = await getState(s, recJar);
  assert.equal(st.stays.find((x) => x.id === ci2.data.stayId).plannedOut, depart);
  // Check out the first stay.
  const co = await s.req(recJar, "POST", "/api/checkout", { stayId });
  assert.equal(co.status, 200);
  st = await getState(s, recJar);
  const out = st.stays.find((x) => x.id === stayId);
  assert.equal(out.status, "out");
  assert.ok(out.checkOutAt);
  assert.equal(out.checkOutAt.slice(0, 10), today);
  const roomAfter = st.rooms.find((r) => r.number === 101);
  assert.equal(roomAfter.occ, "vacant");
  assert.equal(roomAfter.hk, "dirty");
  assert.equal(roomAfter.insp, "awaiting");
  // Second check-out -> 400.
  const co2 = await s.req(recJar, "POST", "/api/checkout", { stayId });
  assert.equal(co2.status, 400);
  // Report for today: 2 check-ins, 1 check-out, revenue = one night each.
  const rep = await s.req(ownerJar, "GET", "/api/report?date=" + today);
  assert.equal(rep.status, 200);
  assert.equal(rep.data.ins.length, 2);
  assert.equal(rep.data.outs.length, 1);
  // Same-day in/out still counts as occupying that night (v1.7 reportData:
  // checkout date == check-in date counts), so both stays are "during".
  assert.equal(rep.data.during.length, 2);
  assert.equal(rep.data.revenue, 70000); // 20000 (101 at 40%) + 50000 (102 at 100%)
  assert.equal(rep.data.counts.occupied, 1);
  // Past date with no snapshot -> noHistory.
  const old = await s.req(ownerJar, "GET", "/api/report?date=2020-01-01");
  assert.equal(old.data.noHistory, true);
  assert.equal(old.data.counts, null);
  // CSV download.
  const csv = await s.req(ownerJar, "GET", "/api/report.csv?date=" + today);
  assert.equal(csv.status, 200);
  assert.ok(String(csv.headers.get("content-disposition")).includes("smallstay-report-" + today + ".csv"));
  assert.ok(String(csv.data).includes("Guest One"));
});

test("duplicate active stay 409; check-in to non-ready room 400", async (t) => {
  const s = await start(t);
  const ownerJar = await setupHotel(s);
  await makeStaff(s, ownerJar, { name: "Rana", username: "rana", pin: "5678", role: "reception" });
  const recJar = await loginAs(s, "rana", "5678");
  // Room 102 is fresh: clean but awaiting inspection -> not ready.
  const notReady = await s.req(recJar, "POST", "/api/checkin", {
    room: 102, nights: 1, pct: 100, guests: [{ name: "G", idNum: "ID" }],
  });
  assert.equal(notReady.status, 400);
  // Missing guest id -> 400.
  await makeReady(s, ownerJar, 101);
  const noId = await s.req(recJar, "POST", "/api/checkin", {
    room: 101, nights: 1, pct: 100, guests: [{ name: "G", idNum: "" }],
  });
  assert.equal(noId.status, 400);
  const badPct = await s.req(recJar, "POST", "/api/checkin", {
    room: 101, nights: 1, pct: 101, guests: [{ name: "G", idNum: "ID" }],
  });
  assert.equal(badPct.status, 400);
  const okR = await s.req(recJar, "POST", "/api/checkin", {
    room: 101, nights: 1, pct: 100, guests: [{ name: "G", idNum: "ID" }],
  });
  assert.equal(okR.status, 200);
  const dup = await s.req(recJar, "POST", "/api/checkin", {
    room: 101, nights: 1, pct: 100, guests: [{ name: "H", idNum: "ID2" }],
  });
  assert.equal(dup.status, 409);
});

test("housekeeping start/finish: who+when, checklist required, minutes recorded", async (t) => {
  const s = await start(t);
  const ownerJar = await setupHotel(s);
  const hk = await makeStaff(s, ownerJar, { name: "Sara", username: "sara", pin: "5678", role: "housekeeper" });
  const hkJar = await loginAs(s, "sara", "5678");
  // Room 101 fresh: clean/awaiting. Start cleaning.
  const startR = await s.req(hkJar, "POST", "/api/housekeeping/start", { room: 101 });
  assert.equal(startR.status, 200);
  let st = await getState(s, hkJar);
  let room = st.rooms.find((r) => r.number === 101);
  assert.equal(room.hk, "cleaning");
  assert.equal(room.cleanStartedBy, hk.id);
  assert.ok(room.cleanStartedAt);
  assert.equal(room.assignedTo, hk.id);
  // Finish with empty checklist -> 400.
  const early = await s.req(hkJar, "POST", "/api/housekeeping/finish", { room: 101 });
  assert.equal(early.status, 400);
  assert.equal(early.data.error, "Finish the whole checklist first.");
  // Tick 4 of 5 -> still 400.
  for (let i = 0; i < 4; i++) {
    const tg = await s.req(hkJar, "POST", "/api/housekeeping/checklist", { room: 101, index: i });
    assert.equal(tg.status, 200);
  }
  const early2 = await s.req(hkJar, "POST", "/api/housekeeping/finish", { room: 101 });
  assert.equal(early2.status, 400);
  // Bad checklist index -> 400.
  const badIdx = await s.req(hkJar, "POST", "/api/housekeeping/checklist", { room: 101, index: 9 });
  assert.equal(badIdx.status, 400);
  // Tick the last one, finish.
  await s.req(hkJar, "POST", "/api/housekeeping/checklist", { room: 101, index: 4 });
  const fin = await s.req(hkJar, "POST", "/api/housekeeping/finish", { room: 101 });
  assert.equal(fin.status, 200);
  st = await getState(s, hkJar);
  room = st.rooms.find((r) => r.number === 101);
  assert.equal(room.hk, "clean");
  assert.equal(room.insp, "awaiting");
  assert.equal(room.lastCleanedBy, hk.id);
  assert.ok(room.lastCleanedAt);
  assert.equal(typeof room.lastCleanMinutes, "number");
  assert.ok(room.lastCleanMinutes >= 0);
  assert.equal(room.cleanStartedAt, null);
  assert.equal(room.cleanStartedBy, null);
});

test("inspection Pass makes room Ready; Fail sends it back to cleaning", async (t) => {
  const s = await start(t);
  const ownerJar = await setupHotel(s);
  await makeStaff(s, ownerJar, { name: "Sam", username: "sam", pin: "5678", role: "supervisor" });
  const supJar = await loginAs(s, "sam", "5678");
  let st = await getState(s, ownerJar);
  assert.equal(st.counts.ready, 0); // fresh rooms are awaiting inspection
  const pass = await s.req(supJar, "POST", "/api/inspections", { room: 101, pass: true });
  assert.equal(pass.status, 200);
  st = await getState(s, ownerJar);
  assert.equal(st.rooms.find((r) => r.number === 101).insp, "passed");
  assert.equal(st.counts.ready, 1);
  // Fail: room 102 clean -> failed + dirty + checklist reset.
  const fail = await s.req(supJar, "POST", "/api/inspections", { room: 102, pass: false });
  assert.equal(fail.status, 200);
  st = await getState(s, ownerJar);
  const r102 = st.rooms.find((r) => r.number === 102);
  assert.equal(r102.insp, "failed");
  assert.equal(r102.hk, "dirty");
  assert.deepEqual(r102.checklist, [false, false, false, false, false]);
  // Housekeeper cannot inspect.
  await makeStaff(s, ownerJar, { name: "Sara", username: "sara", pin: "5678", role: "housekeeper" });
  const hkJar = await loginAs(s, "sara", "5678");
  const noPerm = await s.req(hkJar, "POST", "/api/inspections", { room: 103, pass: true });
  assert.equal(noPerm.status, 403);
});

test("ticket report/work/fixed/close flow; maintenance blocked from another worker's ticket", async (t) => {
  const s = await start(t);
  const ownerJar = await setupHotel(s);
  await makeStaff(s, ownerJar, { name: "Rana", username: "rana", pin: "5678", role: "reception" });
  await makeStaff(s, ownerJar, { name: "Sam", username: "sam", pin: "5678", role: "supervisor" });
  const m1 = await makeStaff(s, ownerJar, { name: "Maint One", username: "maint1", pin: "5678", role: "maintenance" });
  const m2 = await makeStaff(s, ownerJar, { name: "Maint Two", username: "maint2", pin: "5678", role: "maintenance" });
  const recJar = await loginAs(s, "rana", "5678");
  const rep = await s.req(recJar, "POST", "/api/tickets", { room: 101, type: "Water / plumbing", prio: "High", note: "Leak" });
  assert.equal(rep.status, 200);
  const tid = rep.data.id;
  // Bad type/prio rejected.
  assert.equal((await s.req(recJar, "POST", "/api/tickets", { room: 101, type: "Nope", prio: "High" })).status, 400);
  assert.equal((await s.req(recJar, "POST", "/api/tickets", { room: 101, type: "Water / plumbing", prio: "Nope" })).status, 400);
  // Owner assigns to maint1.
  const asg = await s.req(ownerJar, "POST", "/api/tickets/" + tid + "/assign", { staffId: m1.id });
  assert.equal(asg.status, 200);
  // maint2 (not assignee) is blocked.
  const m2Jar = await loginAs(s, "maint2", "5678");
  const blocked = await s.req(m2Jar, "POST", "/api/tickets/" + tid + "/status", { action: "working" });
  assert.equal(blocked.status, 403);
  // maint1 works it, fixes it -> check.
  const m1Jar = await loginAs(s, "maint1", "5678");
  assert.equal((await s.req(m1Jar, "POST", "/api/tickets/" + tid + "/status", { action: "working" })).status, 200);
  let st = await getState(s, ownerJar);
  assert.equal(st.tickets.find((x) => x.id === tid).status, "working");
  assert.equal((await s.req(m1Jar, "POST", "/api/tickets/" + tid + "/status", { action: "fixed" })).status, 200);
  st = await getState(s, ownerJar);
  assert.equal(st.tickets.find((x) => x.id === tid).status, "check");
  // Maintenance cannot close; supervisor can.
  assert.equal((await s.req(m1Jar, "POST", "/api/tickets/" + tid + "/status", { action: "close" })).status, 403);
  const supJar = await loginAs(s, "sam", "5678");
  assert.equal((await s.req(supJar, "POST", "/api/tickets/" + tid + "/status", { action: "close" })).status, 200);
  st = await getState(s, ownerJar);
  assert.equal(st.tickets.find((x) => x.id === tid).status, "closed");
  // Unassigned ticket: any maintenance worker may work it.
  const rep2 = await s.req(recJar, "POST", "/api/tickets", { room: 102, type: "TV / electric", prio: "Low" });
  assert.equal((await s.req(m2Jar, "POST", "/api/tickets/" + rep2.data.id + "/status", { action: "working" })).status, 200);
});

test("out-of-service + release blocked by blocking ticket, released after close", async (t) => {
  const s = await start(t);
  const ownerJar = await setupHotel(s);
  await makeStaff(s, ownerJar, { name: "Sam", username: "sam", pin: "5678", role: "supervisor" });
  await makeStaff(s, ownerJar, { name: "Maint One", username: "maint1", pin: "5678", role: "maintenance" });
  const m1Jar = await loginAs(s, "maint1", "5678");
  const supJar = await loginAs(s, "sam", "5678");
  // Maintenance reports (auto-assigned to self) then puts room out of service.
  const rep = await s.req(m1Jar, "POST", "/api/tickets", { room: 101, type: "Bathroom", prio: "Normal", note: "Shower broken" });
  assert.equal(rep.status, 200);
  const tid = rep.data.id;
  assert.equal((await s.req(m1Jar, "POST", "/api/tickets/" + tid + "/status", { action: "oos" })).status, 200);
  let st = await getState(s, ownerJar);
  assert.equal(st.rooms.find((r) => r.number === 101).access, "out");
  assert.equal(st.tickets.find((x) => x.id === tid).blocking, true);
  assert.equal(st.counts.oos, 1);
  // Release blocked while the blocking ticket is open.
  const blocked = await s.req(supJar, "POST", "/api/rooms/101/release");
  assert.equal(blocked.status, 400);
  // Fix -> check -> close clears blocking; then release works.
  assert.equal((await s.req(m1Jar, "POST", "/api/tickets/" + tid + "/status", { action: "fixed" })).status, 200);
  assert.equal((await s.req(supJar, "POST", "/api/tickets/" + tid + "/status", { action: "close" })).status, 200);
  st = await getState(s, ownerJar);
  assert.equal(st.tickets.find((x) => x.id === tid).blocking, false);
  assert.equal((await s.req(supJar, "POST", "/api/rooms/101/release")).status, 200);
  st = await getState(s, ownerJar);
  assert.equal(st.rooms.find((r) => r.number === 101).access, "in");
});

test("backup export/import round trip; restore signs everyone out", async (t) => {
  const s = await start(t);
  const ownerJar = await setupHotel(s);
  await makeStaff(s, ownerJar, { name: "Rana", username: "rana", pin: "5678", role: "reception" });
  const recJar = await loginAs(s, "rana", "5678");
  await makeReady(s, ownerJar, 101);
  await s.req(recJar, "POST", "/api/checkin", {
    room: 101, nights: 1, pct: 100, guests: [{ name: "Backup Guest", idNum: "ID-B" }],
  });
  const backup = await s.req(ownerJar, "GET", "/api/backup");
  assert.equal(backup.status, 200);
  assert.equal(backup.data.app, "smallstay-v1");
  assert.equal(backup.data.backupVersion, 3);
  assert.equal(backup.data.db.hotel.name, "Test Hotel");
  assert.equal(backup.data.db.stays.length, 1);
  assert.ok(backup.data.db.users.every((u) => u.pinHash), "backup carries hashed PINs");
  assert.equal(JSON.stringify(backup.data).includes('"pin":'), false, "no plaintext PIN in backup");
  // Change live data, then restore the backup.
  assert.equal((await s.req(ownerJar, "POST", "/api/settings/price", { price: 60000 })).status, 200);
  const restored = await s.req(ownerJar, "POST", "/api/restore", { payload: backup.data });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  // Everyone is signed out now (sessions deleted).
  assert.equal((await s.req(ownerJar, "GET", "/api/state")).status, 401);
  // Sign in again with the backup's accounts; price is back to 50000.
  const ownerJar2 = await loginAs(s, "owner", "1234");
  const st = await getState(s, ownerJar2);
  assert.equal(st.price, 50000);
  assert.equal(st.stays.length, 1);
  assert.equal(st.stays[0].guests[0].name, "Backup Guest");
  const recJar2 = await loginAs(s, "rana", "5678");
  assert.equal((await s.req(recJar2, "GET", "/api/state")).status, 200);
});

test("restore rejects invalid backups and leaves data unchanged", async (t) => {
  const s = await start(t);
  const ownerJar = await setupHotel(s);
  const backup = await s.req(ownerJar, "GET", "/api/backup");
  assert.equal(backup.status, 200);
  const before = await getState(s, ownerJar);
  // Wrong app id.
  const wrongApp = JSON.parse(JSON.stringify(backup.data));
  wrongApp.app = "other-app";
  const r1 = await s.req(ownerJar, "POST", "/api/restore", { payload: wrongApp });
  assert.equal(r1.status, 400);
  assert.ok(Array.isArray(r1.data.errors));
  // Bad room count.
  const badRooms = JSON.parse(JSON.stringify(backup.data));
  badRooms.db.rooms = badRooms.db.rooms.slice(0, 5);
  const r2 = await s.req(ownerJar, "POST", "/api/restore", { payload: badRooms });
  assert.equal(r2.status, 400);
  // Plaintext PIN in backup.
  const plainPin = JSON.parse(JSON.stringify(backup.data));
  plainPin.db.users[0].pin = "1234";
  const r3 = await s.req(ownerJar, "POST", "/api/restore", { payload: plainPin });
  assert.equal(r3.status, 400);
  // No owner in backup.
  const noOwner = JSON.parse(JSON.stringify(backup.data));
  noOwner.db.users = noOwner.db.users.filter((u) => u.role !== "owner");
  const r4 = await s.req(ownerJar, "POST", "/api/restore", { payload: noOwner });
  assert.equal(r4.status, 400);
  // Data unchanged after all rejections.
  const after = await getState(s, ownerJar);
  assert.equal(after.hotel.name, before.hotel.name);
  assert.equal(after.price, before.price);
  assert.equal(after.rooms.length, before.rooms.length);
  assert.equal(after.users.length, before.users.length);
});

test("demo data is separate from real data", async (t) => {
  const s = await start(t);
  const ownerJar = await setupHotel(s);
  const realBefore = await getState(s, ownerJar);
  assert.equal(realBefore.rooms.length, 30);
  assert.equal(realBefore.stays.length, 0);
  // Enter demo as reception.
  const demoJar = s.jar();
  const demo = await s.req(demoJar, "POST", "/api/demo/start", { role: "reception" });
  assert.equal(demo.status, 200);
  assert.equal(demo.data.mode, "demo");
  assert.equal(demo.data.user.role, "reception");
  const demoState = await getState(s, demoJar);
  assert.equal(demoState.hotel.name, "Demo Hotel");
  assert.equal(demoState.rooms.length, 30);
  assert.equal(demoState.stays.filter((x) => x.status === "in").length, 10);
  assert.equal(demoState.stays.length, 11); // 10 in + 1 checked out
  assert.equal(demoState.tickets.length, 6);
  assert.equal(demoState.counts.ready, 7); // ready indices [0,8,15,18,24,27,29]
  // Demo backup/restore/reset are disabled.
  assert.equal((await s.req(demoJar, "GET", "/api/backup")).status, 403);
  assert.equal((await s.req(demoJar, "POST", "/api/restore", { payload: {} })).status, 403);
  assert.equal((await s.req(demoJar, "POST", "/api/reset", { confirm: "DELETE" })).status, 403);
  // Demo check-in on ready room 101 (demo reception can check in).
  const ci = await s.req(demoJar, "POST", "/api/checkin", {
    room: 101, nights: 1, pct: 100, guests: [{ name: "Demo Guest", idNum: "ID-D" }],
  });
  assert.equal(ci.status, 200, JSON.stringify(ci.data));
  const demoAfter = await getState(s, demoJar);
  assert.equal(demoAfter.stays.filter((x) => x.status === "in").length, 11);
  // Exit demo; real data is untouched.
  assert.equal((await s.req(demoJar, "POST", "/api/demo/exit")).status, 200);
  const realAfter = await getState(s, ownerJar);
  assert.equal(realAfter.stays.length, 0);
  assert.equal(JSON.stringify(realAfter).includes("Demo Guest"), false);
  // Bad demo role -> 400.
  const badRole = await s.req(s.jar(), "POST", "/api/demo/start", { role: "wizard" });
  assert.equal(badRole.status, 400);
});

test("room type, price change, staff mode, reset", async (t) => {
  const s = await start(t);
  const ownerJar = await setupHotel(s);
  // Room type.
  const rt = await s.req(ownerJar, "POST", "/api/rooms/101/type", { type: "Twin" });
  assert.equal(rt.status, 200);
  assert.equal(rt.data.room.type, "Twin");
  assert.equal((await s.req(ownerJar, "POST", "/api/rooms/101/type", { type: "Triple" })).status, 400);
  // Price change affects new check-ins only.
  await makeStaff(s, ownerJar, { name: "Rana", username: "rana", pin: "5678", role: "reception" });
  const recJar = await loginAs(s, "rana", "5678");
  await makeReady(s, ownerJar, 101);
  await s.req(recJar, "POST", "/api/checkin", { room: 101, nights: 1, pct: 100, guests: [{ name: "G", idNum: "ID" }] });
  assert.equal((await s.req(recJar, "POST", "/api/settings/price", { price: 70000 })).status, 403);
  assert.equal((await s.req(ownerJar, "POST", "/api/settings/price", { price: 70000 })).status, 200);
  let st = await getState(s, ownerJar);
  assert.equal(st.price, 70000);
  assert.equal(st.stays[0].basePrice, 50000); // old stay unchanged
  // Staff mode switch.
  const hk = await makeStaff(s, ownerJar, { name: "Sara", username: "sara", pin: "5678", role: "housekeeper" });
  assert.equal((await s.req(ownerJar, "POST", "/api/staff/" + hk.id + "/mode", { mode: "full" })).status, 200);
  st = await getState(s, ownerJar);
  assert.equal(st.users.find((u) => u.id === hk.id).mode, "full");
  // Owner/manager mode cannot be changed.
  const ownerId = st.users.find((u) => u.username === "owner").id;
  assert.equal((await s.req(ownerJar, "POST", "/api/staff/" + ownerId + "/mode", { mode: "simple" })).status, 403);
  // Reset requires DELETE confirmation and owner only.
  assert.equal((await s.req(ownerJar, "POST", "/api/reset", { confirm: "no" })).status, 400);
  assert.equal((await s.req(ownerJar, "POST", "/api/reset", { confirm: "delete" })).status, 200);
  const status = await s.req(null, "GET", "/api/status");
  assert.deepEqual(status.data, { setupDone: false, hasConfig: false, hotelName: "" });
  assert.equal((await s.req(ownerJar, "GET", "/api/state")).status, 401);
});
