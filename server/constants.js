"use strict";
// Shared constants — exact copy of SmallStay v1.7 values.

const ROLES = ["owner", "manager", "supervisor", "reception", "housekeeper", "maintenance"];
const CHECKLIST_ITEMS = [
  "Bathroom cleaned",
  "Beds made / linen changed",
  "Towels replaced",
  "Floor vacuumed / mopped",
  "Trash emptied & supplies refilled",
];
const TICKET_TYPES = [
  "Water / plumbing",
  "Air conditioning",
  "Door / lock",
  "TV / electric",
  "Bathroom",
  "Furniture",
  "Other",
];
const TICKET_PRIOS = ["Low", "Normal", "High", "Urgent"];
const TICKET_STATUSES = ["open", "working", "parts", "check", "closed"];
const HK_VALS = ["dirty", "cleaning", "clean"];
const INSP_VALS = ["awaiting", "passed", "failed"];
const OCC_VALS = ["vacant", "occupied"];
const ACC_VALS = ["in", "out"];

// Exact copy of the v1.7 PERMS map.
const PERMS = {
  owner: ["dashboard", "rooms.view", "room.type", "housekeeping.view", "hk.assign", "hk.work", "inspect", "maintenance.view", "ticket.report", "ticket.work", "ticket.close", "ticket.assign", "service.release", "checkin", "checkout", "stays.view", "reports", "reports.csv", "team.view", "staff.manage", "staff.mode", "settings", "price.change", "backup", "restore", "reset", "download"],
  manager: ["dashboard", "rooms.view", "room.type", "housekeeping.view", "hk.assign", "hk.work", "inspect", "maintenance.view", "ticket.report", "ticket.work", "ticket.close", "ticket.assign", "service.release", "checkin", "checkout", "stays.view", "reports", "reports.csv", "team.view", "staff.manage", "staff.mode", "settings", "price.change", "backup", "restore", "download"],
  supervisor: ["rooms.view", "housekeeping.view", "hk.assign", "inspect", "maintenance.view", "ticket.report", "ticket.close", "service.release", "stays.view", "reports", "download"],
  reception: ["rooms.view", "checkin", "checkout", "stays.view", "ticket.report", "download"],
  housekeeper: ["rooms.view", "hk.work", "ticket.report", "download"],
  maintenance: ["rooms.view", "ticket.report", "ticket.work", "download"],
};

function can(user, action) {
  if (!user) return false;
  const list = PERMS[user.role] || [];
  return list.indexOf(action) >= 0;
}
function canSeePrivate(user) {
  return !!user && (user.role === "owner" || user.role === "manager" || user.role === "reception");
}
function fullMode(user) {
  if (!user) return false;
  if (user.role === "owner" || user.role === "manager") return true;
  return user.mode === "full";
}

module.exports = {
  ROLES, CHECKLIST_ITEMS, TICKET_TYPES, TICKET_PRIOS, TICKET_STATUSES,
  HK_VALS, INSP_VALS, OCC_VALS, ACC_VALS, PERMS, can, canSeePrivate, fullMode,
};
