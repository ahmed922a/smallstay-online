"use strict";
// Exact port of SmallStay v1.7 buildDemoDB() + DEMO_USERS + DEMO_CONFIG.
// Demo state is per-session, in memory only, and never touches SQLite.

const { buildRoomsBlank, todayStr, addDays, pad2, clone } = require("./logic");

const DEMO_USERS = [
  { id: "demo-owner", name: "Demo Owner", username: "demo-owner", pinHash: null, cred: null, role: "owner", mode: "full" },
  { id: "demo-manager", name: "Manager Demo", username: "demo-manager", pinHash: null, cred: null, role: "manager", mode: "full" },
  { id: "demo-reception", name: "Reception Demo", username: "demo-reception", pinHash: null, cred: null, role: "reception", mode: "simple" },
  { id: "demo-sara", name: "Sara (demo housekeeper)", username: "demo-sara", pinHash: null, cred: null, role: "housekeeper", mode: "simple" },
  { id: "demo-omar", name: "Omar (demo housekeeper)", username: "demo-omar", pinHash: null, cred: null, role: "housekeeper", mode: "simple" },
  { id: "demo-maint", name: "Maintenance Demo", username: "demo-maint", pinHash: null, cred: null, role: "maintenance", mode: "simple" },
  { id: "demo-super", name: "Supervisor Demo", username: "demo-super", pinHash: null, cred: null, role: "supervisor", mode: "simple" },
];

const DEMO_CONFIG = { firstFloor: 1, floorCount: 3, roomsPerFloor: 10, price: 50000, currency: "IQD" };

function buildDemoDB() {
  const rm = buildRoomsBlank(DEMO_CONFIG);
  const today = todayStr(), yday = addDays(today, -1);
  function setRoom(num, patch) {
    for (let i = 0; i < rm.length; i++) {
      if (rm[i].number === num) { for (const k in patch) rm[i][k] = patch[k]; }
    }
  }
  function rn(i) { return rm[i].number; }
  const occIdx = [1, 4, 9, 10, 11, 16, 19, 22, 25, 28];
  const demoStays = [];
  let sid = 1;
  const firstNames = ["Sample Guest A", "Sample Guest B", "Sample Guest C", "Sample Guest D", "Sample Guest E", "Sample Guest F", "Sample Guest G", "Sample Guest H", "Sample Guest I", "Sample Guest J"];
  occIdx.forEach((idx, i) => {
    const num = rn(idx);
    const startDate = i < 4 ? yday : today;
    const nights = i < 4 ? 3 : (1 + (i % 3));
    const pct = [40, 100, 70, 100, 50, 100, 80, 100, 60, 100][i];
    const guests = [{ name: firstNames[i], idNum: "ID-DEMO-" + (1000 + i), contact: "0770 000 00" + pad2(i + 1), car: i % 3 === 0 ? "Demo Car " + (100 + i) : "" }];
    if (i === 0) guests.push({ name: "Sample Guest A2", idNum: "ID-DEMO-2000", contact: "", car: "" });
    demoStays.push({
      id: sid++, room: num, guests,
      checkInAt: startDate + "T14:0" + (i % 10) + ":00", checkInDate: startDate,
      plannedOut: addDays(startDate, nights), checkOutAt: null, nights,
      basePrice: DEMO_CONFIG.price, pct,
      total: Math.round(DEMO_CONFIG.price * pct / 100) * nights,
      byIn: i % 2 ? "demo-owner" : "demo-reception", byOut: null, status: "in",
    });
    setRoom(num, { occ: "occupied", hk: "clean", insp: "passed", access: "in" });
  });
  // A checked-out stay yesterday for report history
  demoStays.push({
    id: sid++, room: rn(3),
    guests: [{ name: "Sample Guest K", idNum: "ID-DEMO-3000", contact: "0770 000 0099", car: "" }],
    checkInAt: yday + "T15:00:00", checkInDate: yday, plannedOut: today,
    checkOutAt: today + "T10:30:00", nights: 1,
    basePrice: DEMO_CONFIG.price, pct: 100, total: DEMO_CONFIG.price,
    byIn: "demo-reception", byOut: "demo-reception", status: "out",
  });
  // Work states
  setRoom(rn(2), { hk: "dirty", insp: "awaiting", assignedTo: "demo-sara" });
  setRoom(rn(7), { hk: "dirty", insp: "awaiting", assignedTo: "demo-omar" });
  setRoom(rn(12), { hk: "dirty", insp: "awaiting", assignedTo: null });
  setRoom(rn(5), { hk: "cleaning", insp: "awaiting", assignedTo: "demo-sara", checklist: [true, true, false, false, false] });
  setRoom(rn(13), { hk: "clean", insp: "awaiting" });
  setRoom(rn(17), { hk: "clean", insp: "awaiting" });
  setRoom(rn(20), { hk: "clean", insp: "failed", assignedTo: "demo-omar" });
  setRoom(rn(14), { access: "out", hk: "clean", insp: "awaiting" });
  setRoom(rn(23), { access: "out", hk: "dirty", insp: "awaiting", assignedTo: "demo-sara" });
  [0, 8, 15, 18, 24, 27, 29].forEach((i) => { setRoom(rn(i), { hk: "clean", insp: "passed" }); });
  const tk = [
    { id: 1, room: rn(14), type: "Water / plumbing", prio: "High", status: "open", note: "Tap leaking in bathroom.", reporterId: "demo-sara", assigneeId: "demo-maint", createdAt: today + "T09:00:00", blocking: true, history: [{ at: today + "T09:00:00", byId: "demo-sara", action: "Reported" }] },
    { id: 2, room: rn(9), type: "Air conditioning", prio: "Normal", status: "working", note: "Not cooling.", reporterId: "demo-reception", assigneeId: "demo-maint", createdAt: today + "T09:30:00", blocking: false, history: [{ at: today + "T09:30:00", byId: "demo-reception", action: "Reported" }, { at: today + "T10:00:00", byId: "demo-maint", action: "Working on it" }] },
    { id: 3, room: rn(21), type: "Door / lock", prio: "Urgent", status: "check", note: "Lock replaced, waiting for check.", reporterId: "demo-super", assigneeId: "demo-maint", createdAt: yday + "T16:00:00", blocking: false, history: [{ at: yday + "T16:00:00", byId: "demo-super", action: "Reported" }, { at: today + "T08:00:00", byId: "demo-maint", action: "Fixed — sent for check" }] },
    { id: 4, room: rn(7), type: "TV / electric", prio: "Low", status: "open", note: "TV not working.", reporterId: "demo-reception", assigneeId: null, createdAt: today + "T08:15:00", blocking: false, history: [{ at: today + "T08:15:00", byId: "demo-reception", action: "Reported" }] },
    { id: 5, room: rn(23), type: "Bathroom", prio: "Normal", status: "open", note: "Shower broken — room out of service.", reporterId: "demo-sara", assigneeId: "demo-maint", createdAt: today + "T07:40:00", blocking: true, history: [{ at: today + "T07:40:00", byId: "demo-sara", action: "Reported" }] },
    { id: 6, room: rn(10), type: "Bathroom", prio: "Normal", status: "closed", note: "Shower head loose — fixed and checked.", reporterId: "demo-sara", assigneeId: "demo-maint", createdAt: yday + "T11:00:00", blocking: false, history: [{ at: yday + "T11:00:00", byId: "demo-sara", action: "Reported" }, { at: yday + "T13:00:00", byId: "demo-maint", action: "Fixed — sent for check" }, { at: yday + "T14:00:00", byId: "demo-super", action: "Checked — OK, ticket closed" }] },
  ];
  return {
    v: 3, setupDone: true, config: DEMO_CONFIG,
    hotel: { name: "Demo Hotel", address: "", currency: DEMO_CONFIG.currency },
    currency: DEMO_CONFIG.currency, users: clone(DEMO_USERS), rooms: rm,
    stays: demoStays, tickets: tk, events: [],
    snapshots: {}, nextStayId: sid, nextTicketId: 7, price: DEMO_CONFIG.price,
    startedAt: null,
  };
}

module.exports = { buildDemoDB, DEMO_USERS, DEMO_CONFIG };
