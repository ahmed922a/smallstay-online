
"use strict";
/* Online version: no clean-template download. Data lives on the server. */
/* ================= Constants ================= */
var ROLES = ["owner","manager","supervisor","reception","housekeeper","maintenance"];
var ROLE_LABELS = {owner:"Owner", manager:"Manager", supervisor:"Supervisor", reception:"Reception", housekeeper:"Housekeeper", maintenance:"Maintenance"};
var CHECKLIST_ITEMS = ["Bathroom cleaned","Beds made / linen changed","Towels replaced","Floor vacuumed / mopped","Trash emptied & supplies refilled"];
var TICKET_TYPES = ["Water / plumbing","Air conditioning","Door / lock","TV / electric","Bathroom","Furniture","Other"];
var TICKET_PRIOS = ["Low","Normal","High","Urgent"];
var HK_VALS = ["dirty","cleaning","clean"], INSP_VALS = ["awaiting","passed","failed"], OCC_VALS = ["vacant","occupied"], ACC_VALS = ["in","out"];
var TICKET_STATUSES = ["open","working","parts","check","closed"];

/* ================= Centralized permissions =================
   Every mutating operation calls requirePerm() / can() itself.
   Hiding a button is never the only protection. */
var PERMS = {
  owner:      ["dashboard","rooms.view","room.type","housekeeping.view","hk.assign","hk.work","inspect","maintenance.view","ticket.report","ticket.work","ticket.close","ticket.assign","service.release","checkin","checkout","stays.view","reports","reports.csv","team.view","staff.manage","staff.mode","settings","price.change","backup","restore","reset","download"],
  manager:    ["dashboard","rooms.view","room.type","housekeeping.view","hk.assign","hk.work","inspect","maintenance.view","ticket.report","ticket.work","ticket.close","ticket.assign","service.release","checkin","checkout","stays.view","reports","reports.csv","team.view","staff.manage","staff.mode","settings","price.change","backup","restore","download"],
  supervisor: ["rooms.view","housekeeping.view","hk.assign","inspect","maintenance.view","ticket.report","ticket.close","service.release","stays.view","reports","download"],
  reception:  ["rooms.view","checkin","checkout","stays.view","ticket.report","download"],
  housekeeper:["rooms.view","hk.work","ticket.report","download"],
  maintenance:["rooms.view","ticket.report","ticket.work","download"]
};
function can(action){
  if (!currentUser) return false;
  var list = PERMS[currentUser.role] || [];
  return list.indexOf(action) >= 0;
}
function canSeePrivate(){ return !!currentUser && (currentUser.role==="owner" || currentUser.role==="manager" || currentUser.role==="reception"); }
function requirePerm(action){
  if (can(action)) return true;
  toast(t("noPermission"));
  return false;
}
function fullMode(){
  if (!currentUser) return false;
  if (currentUser.role==="owner" || currentUser.role==="manager") return true;
  return currentUser.mode === "full";
}

/* ================= Language storage only =================
   Language choice is the ONLY thing kept in localStorage.
   All hotel data lives on the server. */
var LANG_KEY = "ss_v1_lang";
function storeGet(k){ try { return window.localStorage.getItem(k); } catch(e){ return null; } }
function storeSet(k,v){ try { window.localStorage.setItem(k, v); return true; } catch(e){ return false; } }
function storeRemove(k){ try { window.localStorage.removeItem(k); } catch(e){} }
/* ================= Helpers ================= */
function $(id){ return document.getElementById(id); }
function hotelName(){ return (DB && DB.hotel && DB.hotel.name) || "SmallStay"; }
function hotelAddress(){ return (DB && DB.hotel && DB.hotel.address) || ""; }
function cur(){ return (DB && DB.currency) || "IQD"; }
function configTotal(cfg){ return cfg ? cfg.floorCount * cfg.roomsPerFloor : 0; }
function getFloors(){
  var cfg = DB && DB.config ? DB.config : null;
  if (!cfg) return [];
  var out = [];
  for (var i = 0; i < cfg.floorCount; i++){ var f = cfg.firstFloor + i; out.push({n:f, label:"Floor " + f, area:"Guest rooms", guest:true}); }
  return out;
}
function floorStructureText(){
  var cfg = DB && DB.config ? DB.config : null;
  if (!cfg) return t("floorStructureB");
  var first = cfg.firstFloor, last = first + cfg.floorCount - 1, total = configTotal(cfg);
  var s = "Guest rooms are only on Floors " + first + "–" + last + " — " + cfg.roomsPerFloor + " rooms per floor, " + total + " guest rooms in total, numbered by floor (Floor " + first + ": " + (first*100+1) + "–" + (first*100+cfg.roomsPerFloor) + ").";
  if (hotelAddress()) s += " " + hotelName() + ", " + hotelAddress() + ".";
  return s;
}
function esc(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function clone(o){ return JSON.parse(JSON.stringify(o)); }
function pad2(n){ return String(n).padStart(2,"0"); }
function todayStr(){ var d=new Date(); return d.getFullYear()+"-"+pad2(d.getMonth()+1)+"-"+pad2(d.getDate()); }
function dateOf(iso){ return iso ? String(iso).slice(0,10) : ""; }
function addDays(dateStr, n){ var d=new Date(dateStr+"T12:00:00"); d.setDate(d.getDate()+n); return d.getFullYear()+"-"+pad2(d.getMonth()+1)+"-"+pad2(d.getDate()); }
function fmtDT(iso){ if(!iso) return "—"; var d=new Date(iso); if(isNaN(d.getTime())) return esc(iso); return d.getFullYear()+"-"+pad2(d.getMonth()+1)+"-"+pad2(d.getDate())+" "+pad2(d.getHours())+":"+pad2(d.getMinutes()); }
function fmt(n){ return Number(n||0).toLocaleString("en-US"); }
function uid(prefix){ return prefix + "_" + Date.now().toString(36) + "_" + Math.floor(Math.random()*1e6).toString(36); }
var toastTimer=null;
function toast(msg){ var el=$("toast"); if(!el) return; el.textContent=msg; el.classList.remove("hidden"); clearTimeout(toastTimer); toastTimer=setTimeout(function(){ el.classList.add("hidden"); },3400); }

/* ================= Data model =================
room: {number, floor, type: null|"Single"|"Twin", occ, hk, insp, access, assignedTo: staffId|null, checklist:[bool x5]}
stay: {id, room, guests:[{name,idNum,contact,car}], checkInAt ISO|null, checkInDate, plannedOut, checkOutAt, nights, basePrice, pct, total, byIn, byOut, status:"in"|"out"}
ticket: {id, room, type, prio, status, note, reporterId, assigneeId, createdAt, history:[{at, byId, action}]}
user: {id, name, username, cred:{salt,hash}, role, mode:"simple"|"full"}
event: {at, kind, room, byId, text}                                        */
function roomByNum(n){ for (var i=0;i<rooms.length;i++) if (rooms[i].number===n) return rooms[i]; return null; }
function userById(id){ for (var i=0;i<USERS.length;i++) if (USERS[i].id===id) return USERS[i]; return null; }
function userName(id){ var u=userById(id); return u ? u.name : "—"; }
function activeStayForRoom(num){ for (var i=0;i<stays.length;i++) if (stays[i].room===num && stays[i].status==="in") return stays[i]; return null; }

/* Readiness — the ONLY definition. No manual "make ready" anywhere. */
function isReady(r){ return r.occ==="vacant" && r.hk==="clean" && r.insp==="passed" && r.access==="in"; }
function cannotReason(r){
  if (r.access==="out") return t("rsOos");
  if (r.occ==="occupied") return t("rsOccupied");
  if (r.hk==="dirty") return t("rsDirty");
  if (r.hk==="cleaning") return t("rsCleaning");
  if (r.insp!=="passed") return t("rsInsp");
  return "";
}
function roomState(r){
  if (r.access==="out") return {key:"oos", cls:"st-oos", label:t("stOos"), tag:"tag-red"};
  if (r.occ==="occupied") return {key:"occ", cls:"st-occ", label:t("stOccupied"), tag:"tag-orange"};
  if (r.hk==="dirty") return {key:"dirty", cls:"st-dirty", label:t("stDirty"), tag:"tag-amber"};
  if (r.hk==="cleaning") return {key:"cleaning", cls:"st-cleaning", label:t("stCleaning"), tag:"tag-blue"};
  if (r.insp!=="passed") return {key:"insp", cls:"st-insp", label:t("stInsp"), tag:"tag-purple"};
  return {key:"ready", cls:"st-ready", label:t("stReady"), tag:"tag-green"};
}
function counts(){
  var c={total:rooms.length, ready:0, dirty:0, oos:0, occupied:0, cleaning:0, insp:0, vacant:0};
  rooms.forEach(function(r){ if(isReady(r))c.ready++; if(r.hk==="dirty")c.dirty++; if(r.hk==="cleaning")c.cleaning++; if(r.insp==="awaiting"||r.insp==="failed")c.insp++; if(r.access==="out")c.oos++; if(r.occ==="occupied")c.occupied++; else c.vacant++; });
  return c;
}
function logEvent(kind, room, text){
  if (!DB) return;
  DB.events.push({at:new Date().toISOString(), kind:kind, room:room||null, byId:currentUser?currentUser.id:null, text:text||""});
  if (DB.events.length > 2000) DB.events = DB.events.slice(DB.events.length-2000);
}
function snapshotToday(){
  if (!DB || MODE!=="real") return;
  var c = counts(), d = todayStr();
  DB.snapshots[d] = {date:d, ready:c.ready, occupied:c.occupied, dirty:c.dirty, awaiting:c.insp, oos:c.oos, at:new Date().toISOString()};
}

/* ================= Server state (online version) =================
   All hotel data lives on the server. The browser keeps NO hotel data in
   localStorage (language choice is the only exception). After sign-in and
   after every successful mutation we re-fetch /api/state. */
var MODE = "real";
var DB = null, USERS = [], rooms = [], stays = [], tickets = [];
var currentUser = null, currentView = "dashboard";
var selectedFloor = null, showAll = false, arFloor = null;
var dmg = {room:null, type:null, prio:null};
var pendingRestore = null;
var STATUS = {setupDone:false, hasConfig:false, hotelName:""};
var PUBLIC_USERS = [];
var ME = null;

async function api(path, opts){
  opts = opts || {};
  var res = await fetch(path, {
    method: opts.method || "GET",
    headers: {"Content-Type":"application/json"},
    credentials: "same-origin",
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  var data = null;
  try { data = await res.json(); } catch(e){ data = null; }
  if (!res.ok){
    var err = new Error((data && data.error) || ("Request failed (" + res.status + ")"));
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}
function activateDB(db){
  DB = db; USERS = (db && db.users) || []; rooms = (db && db.rooms) || [];
  stays = (db && db.stays) || []; tickets = (db && db.tickets) || [];
}
function activateState(s){
  activateDB({
    config: s.config || null,
    hotel: s.hotel || {name:"", address:"", currency: s.currency || "IQD"},
    currency: s.currency || "IQD",
    price: (typeof s.price === "number") ? s.price : 0,
    startedAt: s.startedAt || null,
    users: s.users || [], rooms: s.rooms || [], stays: s.stays || [], tickets: s.tickets || [],
    snapshots:{}, events:[], counts: s.counts || null
  });
}
async function refreshState(){
  var s = await api("/api/state");
  activateState(s);
  return s;
}
/* Re-fetch state, then re-render. Fire-and-forget after a mutation. */
function saveAndRender(){
  refreshState().then(function(){ renderAll(); }).catch(function(e){ toast(e.message); });
}
function logEvent(){ /* events are logged server-side on every mutation */ }
function snapshotToday(){ /* snapshots are written server-side */ }
/* ================= i18n — one central dictionary ================= */
var I18N = {
en:{entrySub:"Staff Operations — SmallStay v1",entrySub2:"Private staff app. Not a public guest page.",
storageNoteT:"Your data is saved on the server.",storageNote:"Check-ins, guests, cleaning, inspections, maintenance, staff, room types and settings are saved on the server. They work on any device — sign in from any computer or phone and your hotel data is there. Use Backup in Settings to keep a safe copy.",
rawDownload:"Download raw saved data",
setupT:"First use — create your owner account",setupB:"There is no default password. Choose your own owner username and PIN (at least 4 characters). PINs are stored only as a salted hash — never in plain text. Write them down somewhere safe.",
yourName:"Your name",ownerUser:"Owner username",ownerPin:"Owner PIN (at least 4 characters)",pinAgain:"Type the PIN again",createOwner:"Create owner account & start",
signinT:"Sign in — real hotel data",whoSignin:"Who is signing in?",whoSigninB:"Tap your name, then type your PIN.",addWorkerT:"Add workers",addWorkerB:"Owner: give each worker their own username and PIN here. They sign in with it and see only their own work.",addWorkerBtn:"Add a worker",tryDemoLink:"Try demo — sample data",showDetails:"Tap to see all details",hideDetails:"Tap to hide details",idPhoto:"ID card photo",optional:"optional",removePhoto:"Remove photo",idPhotoNote:"Take a photo of the guest ID card, or choose one. It is saved inside the app with this stay, and it travels with the backup. The photo is made smaller before saving.",usingSince:"Using SmallStay since",cleanedBy:"Cleaned by",cleaningBy:"Cleaning by",startedAt:"Started",minWord:"min",soFar:"so far",avgClean:"Average cleaning time",avgWord:"average",roomsCleanedWord:"rooms cleaned",availableRooms:"Available rooms",signinB:"Sign in with the username and PIN made for this hotel. The owner makes staff accounts inside the app (Team page).",username:"Username",pin:"PIN",signin:"Sign in",
recoveryToggle:"Locked out? Start fresh — erase this hotel's data and set up again",recoveryWarn:"This erases ALL real hotel data saved on the server",recoveryWarn2:"staff accounts, rooms and room types, guests and stays, cleaning, inspections, maintenance tickets, reports and settings — and returns the app to first-use owner setup. It does not let anyone read the existing data. It cannot be undone. Download a backup first if you can still sign in.",
recStep1:"Step 1 of 2 — Are you sure?",recSure:"Yes, I am sure — continue",recStep2:"Step 2 of 2 — Type",recStep2b:"to confirm",recErase:"Erase all real data now",
tryDemo:"Try demo — sample data",demoNote:"The demo uses fictional sample data only, kept completely separate. It never reads, changes, backs up or restores your real hotel data. Exit demo returns to real sign-in. No account or PIN needed for the demo.",demoAs:"Demo — enter as a job (Simple mode)",demoAsSub:"Each worker sees their own work first, on one simple screen with big buttons, plus a “View all rooms” button to see every room's status. These buttons open the demo.",demoFull:"Full app, all sections — sample data",
howtoT:"How to use this app",howto1:"This is the online version — open it in any browser, on any computer or phone. No install and no files to copy. Your data is saved on the server, not in this browser.",howto2:"First time: set up your hotel in the Setup Wizard, then create your owner username and PIN. After that, sign in with them.",howto3:"Sign in from any device with your username and PIN — your data is on the server, so it follows you. Closing the browser does not lose it.",howto4:"To keep a safe copy: in Settings tap Download backup. To move to another server, restore that backup file there.",
staffWs:"Staff workspace",signOut:"Sign out",exitDemo:"Exit demo",
todayWork:"Today — what needs work",goFloor:"Go to a floor",goFloorSub:"Tap a floor number to open Rooms and see that floor's rooms and their condition.",
showAllFloors:"Show all floors",clearFloor:"Clear floor — show all rooms",floorsT:"Floors",floorsSub:"All rooms are shown. Tap a floor to see only that floor's rooms.",thFloor:"Floor",thArea:"Area / Use",thRooms:"Rooms",
cleaningTasks:"Cleaning tasks",hkSub:"Tap Start, do the checklist, then tap Finish — the room goes for inspection. It does not become ready by itself. Checklist progress is saved.",toInspect:"Rooms to inspect",inspSub:"Tap Pass — inspection is recorded as passed. Tap Fail — the room goes back for cleaning. A room is ready only when it is vacant, clean, passed inspection and in service.",
reportDamage:"Report a problem",reportSub:"Tap the room, tap the problem, tap the priority — then one big button. Notes are optional.",roomW:"Room",problemW:"Problem",priorityW:"Priority",noteOpt:"Note (optional)",reportBtn:"Report problem",
myTickets:"Repair tickets",ticketsSub:"Tap one big button on a ticket: Working on it, Fixed, Out of service, or Needs parts. “Fixed” sends the ticket for a check — it does not close it. Only Supervisor, Manager or Owner can close a checked ticket or send it back.",repairsCheck:"Repairs to check",repairsCheckSub:"A worker tapped “Fixed”. Check the room, then tap Checked — OK to close the ticket, or Not fixed yet to send it back.",assignT:"Unassigned repairs — assign a maintenance worker",releaseT:"Out-of-service rooms — release back into service",releaseSub:"Supervisor, Manager or Owner only. A room can be released only when it has no other unresolved blocking tickets.",
chooseReady:"Choose a room for check-in",readyOnly:"Only ready rooms show here: vacant, clean, inspection passed, and in service. The room is checked again when you save the check-in.",checkinForm:"Check-in",roomReadyOnly:"Room (ready rooms only)",nights:"Nights",departDate:"Planned departure date",guestPaysPct:"Guest pays % — the share the guest actually pays",mainGuest:"Guest details — main guest",checkIn:"Check in",inHouse:"In house now — check out",staysT:"Stays — current and checked out",
dailyReport:"Daily Report",reportConv:"Reporting convention: a “night” belongs to the date the night starts. “Revenue for this date” counts one night's agreed amount for each room occupied that night — never the whole multi-night stay total. Check-ins and check-outs are listed by the date they actually happened.",dateW:"Date",csvBtn:"Download CSV",
accountsT:"Staff accounts — sign-in usernames & PINs",accountsB:"Owner or Manager creates each worker's account here. Each person signs in with their own username and PIN. PINs are stored only as salted hashes and are never shown in lists or exports. Owner and Manager always use the full app; working staff start in Simple mode — only Owner/Manager can switch a worker to Full mode.",
fullName:"Full name",pinSet:"PIN (at least 4 characters)",roleW:"Job / role",createStaff:"Create staff account",teamT:"Team — who sees what",teamB:"Working staff in Simple mode see only their own work, with a button to view all rooms. Full mode still respects each role's permissions.",
floorStructureT:"Hotel floor structure",floorStructureB:"Guest rooms are set in the Setup Wizard. The floors, room count and room numbers for this hotel are shown in Settings once the hotel is set up.",
photosT:"Hotel photos",capExterior:"Hotel — exterior",capLobby:"Lobby — Ground Floor",capAtrium:"Hotel atrium",capSeating:"Lobby seating",twinGalleryT:"Twin Room — example photos (general gallery, not a specific room)",capTwin:"Twin Room — example photo",
priceT:"Room price",priceB:"Default price per room per night. Changing it affects new check-ins only — amounts already agreed on existing stays never change.",pricePerNight:"Price per night",savePrice:"Save price",
yourDataT:"Your data on this computer",yourDataB:"Real hotel data is saved on the server. Sign in from any computer or phone with your username and PIN and your data is there. It is not saved in this browser. Use Backup below to keep a safe copy.",
securityB:"Honest security note: PINs are stored as salted hashes on the server, never in plain text, and every action checks the signed-in role on the server inside the operation itself, not just by hiding buttons.",
backupT:"Backup & Restore",backupB:"Download backup saves all real hotel data — rooms, room types, guests and stays, cleaning, inspections, maintenance, staff accounts (hashed PINs only) and settings — as one versioned file. Restore validates the file first and replaces the real data only if the file is fully valid. Backup and restore require a signed-in Owner or Manager and are disabled in demo.",downloadBackup:"Download backup",restoreBtn:"Restore from backup…",restoreWarn:"This replaces ALL real hotel data on the server with the backup. Your demo is not affected.",restoreYes:"Yes — restore this backup",cancel:"Cancel",
downloadT:"Download this app",downloadB:"Downloads a clean copy of the app file, generated from the untouched template captured before any data was shown. It contains no guest information, no PINs or hashes, no saved records and no form values.",v3notesT:"SmallStay v1 — what it does, tests, and limits",
freshT:"Start fresh — erase all real data",freshB:"Owner only. This erases all real hotel data on the server — accounts, rooms, guests, stays, tickets and settings — and returns the app to first-use owner setup. The demo is not affected. Download a backup first if you may need this data again. This cannot be undone.",freshBtn:"Start fresh — erase all real data…",
viewAllRooms:"View all rooms",allRoomsT:"All rooms — view only",allRoomsSub:"Tap a floor to see its rooms and their status. Guest names only — no private details.",backToWork:"Back to my work",close:"Close",
nav_dashboard:"Dashboard",nav_rooms:"Rooms",nav_housekeeping:"Housekeeping",nav_inspections:"Inspections",nav_maintenance:"Maintenance",nav_checkin:"Reception / Stays",nav_reports:"Reports",nav_team:"Team",nav_settings:"Settings & Help",nav_easy:"My work",
stReady:"Ready",stDirty:"Dirty — needs cleaning",stCleaning:"Cleaning in progress",stInsp:"Awaiting inspection",stOos:"Out of service",stOccupied:"Occupied",
rsOos:"Out of service",rsOccupied:"Occupied",rsDirty:"Dirty / needs cleaning",rsCleaning:"Cleaning in progress — not ready yet",rsInsp:"Inspection not passed yet",
noPermission:"You do not have permission to do this.",typeToConfirm:"To confirm",single:"Single",twin:"Twin",room:"Room",floor:"Floor",
start:"Start",finish:"Finish — send for inspection",passBtn:"Pass",failBtn:"Fail — back to cleaning",
working:"Working on it",fixed:"Fixed",oosBtn:"Out of service",parts:"Needs parts",checkedOk:"Checked — OK",notFixed:"Not fixed yet",
assignBtn:"Assign",releaseBtn:"Release into service",checkOut:"Check out",
addGuest:"Add another guest",removeGuest:"Remove",guestN:"Additional guest",guestsInRoom:"guests in this room",
gName:"Full name",gId:"ID number",gContact:"Contact number",gCar:"Car number",
errName:"Please enter the main guest's full name.",errId:"Please enter the main guest's ID number.",errExtra:"Every additional guest needs a full name and an ID number.",errRoomNotReady:"That room is no longer ready — pick another ready room.",errDupStay:"This room already has a guest checked in.",errPct:"Guest pays % must be between 0 and 100.",
checkedIn:"Checked in",checkedOut:"Checked out — room is now Dirty and awaiting inspection.",savedOk:"Saved.",
noReadyRooms:"No rooms ready for check-in",noTasks:"Nothing here right now.",overdue:"OVERDUE",
byStaff:"by",totalPaid:"Total agreed",perNight:"per night",nightWord:"night(s)",
repCheckins:"Check-ins on this date",repCheckouts:"Check-outs on this date",repInhouse:"Rooms occupied during this date / night",repLive:"Current occupancy right now (live)",repRevenue:"Revenue for this date (one night per occupied room)",repCounts:"Room counts",repNoHist:"Status counts for past dates come from daily snapshots saved by SmallStay. Dates before SmallStay use cannot be reconstructed and are not invented.",
readyW:"Ready",occupiedW:"Occupied",dirtyW:"Dirty",awaitingW:"Awaiting inspection",oosW:"Out of service",
openTickets:"Open maintenance tickets",outstandingCleaning:"Outstanding cleaning tasks",
typeWarn:"Room types are not confirmed for {n} room(s). The Owner must confirm each floor's room type in Rooms before those rooms are sold as Single or Twin.",
modeSimple:"Simple mode",modeFull:"Full mode",switchFull:"Switch to Full",switchSimple:"Switch to Simple",removeAcc:"Remove account",noPinSet:"No PIN set — owner must reset",
wrongPin:"Wrong username or PIN.",fillAll:"Please fill all fields.",pinShort:"PIN must be at least 4 characters.",pinMismatch:"The two PINs do not match.",userTaken:"That username is already used.",
demoDisabled:"This is disabled in demo — demo cannot touch real hotel data.",
backupDone:"Backup downloaded.",restoreInvalid:"Restore rejected — the file is not a valid SmallStay backup:",restoreOk:"Backup restored.",
priceSaved:"Price saved. Existing stays keep their agreed amounts.",
released:"Room released into service.",releaseBlocked:"Cannot release — this room still has unresolved blocking tickets:",ticketClosed:"Ticket closed.",sentBack:"Ticket sent back for more work.",fixedSent:"Marked Fixed — sent for a supervisor check. The room is not ready from this alone.",
reportFiled:"Problem reported.",cleaningDone:"Cleaning finished — room sent for inspection.",inspPassed:"Inspection passed.",inspFailed:"Inspection failed — room sent back to cleaning.",
cleaningStarted:"Cleaning started.",modeSwitched:"Mode updated.",staffCreated:"Staff account created.",staffRemoved:"Account removed.",
searchStayPh:"Search room or guest name…",demoBarT:"Demo — sample data (fictional)",demoBarB:"Demo never touches real hotel data. Backup, restore and real-data administration are disabled in demo.",realBarT:"Real hotel data — saved on the server"
},
ar:{entrySub:"عمليات الموظفين — SmallStay v1",entrySub2:"تطبيق خاص بالموظفين. ليست صفحة عامة للضيوف.",
storageNoteT:"بياناتك موجودة في هذا المتصفح، على هذا الكمبيوتر فقط.",storageNote:"تسجيلات الوصول والضيوف والتنظيف والفحص والصيانة والموظفون وأنواع الغرف والإعدادات محفوظة على هذا الكمبيوتر وتبقى عند إغلاق الملف وإعادة فتحه. لا تتم مزامنتها إلى كمبيوتر أو هاتف آخر. استخدم النسخ الاحتياطي في الإعدادات لنقل بياناتك أو حفظ نسخة آمنة. لا تستخدم التصفح الخاص للبيانات الحقيقية.",
setupT:"الاستخدام الأول — أنشئ حساب المالك",setupB:"لا توجد كلمة مرور افتراضية. اختر اسم مستخدم ورقم PIN خاصين بك (4 أحرف على الأقل). تُحفظ أرقام PIN مشفرة فقط — وليست نصاً عادياً أبداً.",
yourName:"اسمك",ownerUser:"اسم مستخدم المالك",ownerPin:"رقم PIN للمالك (4 أحرف على الأقل)",pinAgain:"اكتب الرقم مرة أخرى",createOwner:"إنشاء حساب المالك والبدء",
signinT:"تسجيل الدخول — بيانات الفندق الحقيقية",signinB:"سجل الدخول باسم المستخدم ورقم PIN المنشأين على هذا الكمبيوتر. المالك ينشئ حسابات الموظفين داخل التطبيق (صفحة الفريق).",username:"اسم المستخدم",pin:"رقم PIN",signin:"تسجيل الدخول",
tryDemo:"جرّب العرض التجريبي — بيانات عينة",demoAs:"العرض التجريبي — ادخل حسب الوظيفة (الوضع البسيط)",viewAllRooms:"عرض كل الغرف",backToWork:"العودة إلى عملي",close:"إغلاق",
nav_dashboard:"لوحة القيادة",nav_rooms:"الغرف",nav_housekeeping:"التدبير المنزلي",nav_inspections:"الفحوصات",nav_maintenance:"الصيانة",nav_checkin:"الاستقبال / الإقامات",nav_reports:"التقارير",nav_team:"الفريق",nav_settings:"الإعدادات والمساعدة",nav_easy:"عملي",
stReady:"جاهزة",stDirty:"متسخة — تحتاج تنظيفاً",stCleaning:"التنظيف جارٍ",stInsp:"بانتظار الفحص",stOos:"خارج الخدمة",stOccupied:"مشغولة",
rsOos:"خارج الخدمة",rsOccupied:"مشغولة",rsDirty:"متسخة / تحتاج تنظيفاً",rsCleaning:"التنظيف جارٍ — ليست جاهزة بعد",rsInsp:"لم تنجح في الفحص بعد",
noPermission:"ليس لديك صلاحية للقيام بذلك.",saveFail:"⚠ تحذير: تعذر حفظ التغييرات على هذا الكمبيوتر (التخزين محظور أو ممتلئ).",
todayWork:"اليوم — ما يحتاج إلى عمل",goFloor:"اذهب إلى طابق",goFloorSub:"اضغط رقم الطابق لفتح الغرف ورؤية غرف ذلك الطابق وحالتها.",
cleaningTasks:"مهام التنظيف",hkSub:"اضغط ابدأ، أكمل قائمة التحقق، ثم اضغط إنهاء — تذهب الغرفة للفحص. لا تصبح جاهزة وحدها. تقدم القائمة محفوظ.",toInspect:"غرف للفحص",
reportDamage:"الإبلاغ عن مشكلة",myTickets:"تذاكر الإصلاح",repairsCheck:"إصلاحات للتحقق",chooseReady:"اختر غرفة لتسجيل الوصول",checkinForm:"تسجيل الوصول",inHouse:"النزلاء الآن — تسجيل المغادرة",dailyReport:"التقرير اليومي",
start:"ابدأ",finish:"إنهاء — إرسال للفحص",passBtn:"ناجح",failBtn:"راسب — عودة للتنظيف",working:"جارٍ العمل عليه",fixed:"تم الإصلاح",oosBtn:"خارج الخدمة",parts:"يحتاج قطع غيار",checkedOk:"تم التحقق — جيد",notFixed:"لم يُصلح بعد",
checkOut:"تسجيل المغادرة",addGuest:"إضافة ضيف آخر",removeGuest:"إزالة",guestsInRoom:"ضيوف في هذه الغرفة",gName:"الاسم الكامل",gId:"رقم الهوية",gContact:"رقم الاتصال",gCar:"رقم السيارة",
errName:"يرجى إدخال الاسم الكامل للضيف الرئيسي.",errId:"يرجى إدخال رقم هوية الضيف الرئيسي.",errExtra:"كل ضيف إضافي يحتاج اسماً كاملاً ورقم هوية.",errRoomNotReady:"هذه الغرفة لم تعد جاهزة — اختر غرفة جاهزة أخرى.",errDupStay:"هذه الغرفة فيها ضيف مسجل بالفعل.",
typeToConfirm:"بانتظار التأكيد",single:"مفردة",twin:"مزدوجة",room:"غرفة",floor:"طابق",signOut:"تسجيل الخروج",exitDemo:"خروج من العرض التجريبي",demoBarT:"عرض تجريبي — بيانات عينة (خيالية)",demoBarB:"العرض التجريبي لا يمس بيانات الفندق الحقيقية أبداً. النسخ الاحتياطي والاستعادة وإدارة البيانات الحقيقية معطلة في العرض التجريبي.",realBarT:"بيانات الفندق الحقيقية — محفوظة على هذا الكمبيوتر",
checkedIn:"تم تسجيل الوصول",checkedOut:"تم تسجيل المغادرة — الغرفة الآن متسخة وبانتظار الفحص.",noReadyRooms:"لا توجد غرف جاهزة لتسجيل الوصول",noTasks:"لا يوجد شيء هنا الآن.",overdue:"متأخر",wrongPin:"اسم المستخدم أو رقم PIN غير صحيح.",cancel:"إلغاء"
},
ku:{entrySub:"کارەکانی ستاف — SmallStay v1",entrySub2:"ئەپێکی تایبەتی ستافە. پەڕەی گشتی میوان نییە.",
storageNoteT:"داتاکانت لەم وێبگەڕەدان، تەنها لەم کۆمپیوتەرە.",storageNote:"هاتنەژوورەوە و میوان و پاککردنەوە و پشکنین و چاککردنەوە و ستاف و جۆری ژوور و ڕێکخستنەکان لەم کۆمپیوتەرە هەڵدەگیرێن و دەمێننەوە کاتێک فایلەکە دادەخەیت و دەیکەیتەوە. بۆ کۆمپیوتەر یان مۆبایلێکی تر ناگوازرێتەوە. لە ڕێکخستنەکان پاڵپشتی بەکاربهێنە بۆ گواستنەوە. گەڕانی تایبەت بۆ داتای ڕاستەقینە بەکارمەهێنە.",
setupT:"یەکەم بەکارهێنان — هەژماری خاوەن دروست بکە",setupB:"هیچ وشەی نهێنی بنەڕەتی نییە. ناوی بەکارهێنەر و PIN ی خۆت هەڵبژێرە (لانیکەم 4 پیت). PIN تەنها بە هاش هەڵدەگیرێت — هەرگیز بە دەقی سادە نا.",
yourName:"ناوەکەت",ownerUser:"ناوی بەکارهێنەری خاوەن",ownerPin:"PINی خاوەن (لانیکەم 4 پیت)",pinAgain:"PINەکە دووبارە بنووسە",createOwner:"هەژماری خاوەن دروست بکە و دەستپێبکە",
signinT:"چوونەژوورەوە — داتای ڕاستەقینەی هۆتێل",signinB:"بە ناوی بەکارهێنەر و PIN بچۆرە ژوورەوە کە لەم کۆمپیوتەرە دروستکراون. خاوەن لەناو ئەپەکە هەژماری ستاف دروست دەکات (پەڕەی تیم).",username:"ناوی بەکارهێنەر",pin:"PIN",signin:"چوونەژوورەوە",
tryDemo:"نموونە تاقیبکەرەوە — داتای نموونەیی",demoAs:"نموونە — بچۆرە ژوورەوە بەپێی کار (دۆخی سادە)",viewAllRooms:"هەموو ژوورەکان ببینە",backToWork:"گەڕانەوە بۆ کارەکەم",close:"داخستن",
nav_dashboard:"داشبۆرد",nav_rooms:"ژوورەکان",nav_housekeeping:"پاککردنەوە",nav_inspections:"پشکنینەکان",nav_maintenance:"چاککردنەوە",nav_checkin:"پێشوازی / مانەوەکان",nav_reports:"ڕاپۆرتەکان",nav_team:"تیم",nav_settings:"ڕێکخستن و یارمەتی",nav_easy:"کارەکەم",
stReady:"ئامادەیە",stDirty:"پیسە — پێویستی بە پاککردنەوەیە",stCleaning:"پاککردنەوە بەردەوامە",stInsp:"چاوەڕوانی پشکنینە",stOos:"لە خزمەت دەرەیە",stOccupied:"داگیرکراوە",
rsOos:"لە خزمەت دەرەیە",rsOccupied:"داگیرکراوە",rsDirty:"پیسە / پێویستی بە پاککردنەوەیە",rsCleaning:"پاککردنەوە بەردەوامە — هێشتا ئامادە نییە",rsInsp:"هێشتا لە پشکنین دەرنەچووە",
noPermission:"مۆڵەتت نییە بۆ ئەم کارە.",saveFail:"⚠ ئاگاداری: گۆڕانکارییەکان نەتوانرا لەم کۆمپیوتەرە هەڵبگیرێن (هەڵگرتن بلۆککراوە یان پڕە).",
todayWork:"ئەمڕۆ — چی پێویستی بە کارە",goFloor:"بڕۆ بۆ نهۆمێک",goFloorSub:"ژمارەی نهۆم دابگرە بۆ کردنەوەی ژوورەکان و بینینی ژوورەکانی ئەو نهۆمە.",
cleaningTasks:"ئەرکەکانی پاککردنەوە",hkSub:"دەستپێبکە دابگرە، لیستی پشکنین تەواو بکە، پاشان کۆتایی دابگرە — ژوورەکە دەچێت بۆ پشکنین. بە خۆی ئامادە نابێت. پێشکەوتنی لیستەکە هەڵدەگیرێت.",toInspect:"ژوورەکان بۆ پشکنین",
reportDamage:"هەواڵدانی کێشە",myTickets:"تکێتەکانی چاککردنەوە",repairsCheck:"چاککردنەوەکان بۆ دڵنیابوون",chooseReady:"ژوورێک هەڵبژێرە بۆ هاتنەژوورەوە",checkinForm:"هاتنەژوورەوە",inHouse:"میوانانی ئێستا — چوونەدەرەوە",dailyReport:"ڕاپۆرتی ڕۆژانە",
start:"دەستپێبکە",finish:"کۆتایی — بنێرە بۆ پشکنین",passBtn:"سەرکەوتوو",failBtn:"شکست — گەڕانەوە بۆ پاککردنەوە",working:"کاری لەسەر دەکرێت",fixed:"چاککرایەوە",oosBtn:"لە خزمەت دەرە",parts:"پێویستی بە پارچەیە",checkedOk:"پشکنرا — باشە",notFixed:"هێشتا چاک نەکراوەتەوە",
checkOut:"چوونەدەرەوە",addGuest:"میوانێکی تر زیاد بکە",removeGuest:"لابردن",guestsInRoom:"میوان لەم ژوورە",gName:"ناوی تەواو",gId:"ژمارەی ناسنامە",gContact:"ژمارەی پەیوەندی",gCar:"ژمارەی ئۆتۆمبێل",
errName:"تکایە ناوی تەواوی میوانی سەرەکی بنووسە.",errId:"تکایە ژمارەی ناسنامەی میوانی سەرەکی بنووسە.",errExtra:"هەر میوانێکی زیادە پێویستی بە ناوی تەواو و ژمارەی ناسنامەیە.",errRoomNotReady:"ئەم ژوورە ئیتر ئامادە نییە — ژوورێکی ئامادەی تر هەڵبژێرە.",errDupStay:"ئەم ژوورە پێشتر میوانی تێدایە.",
typeToConfirm:"چاوەڕوانی پشتڕاستکردنەوە",single:"تاک",twin:"دوانە",room:"ژوور",floor:"نهۆم",signOut:"چوونەدەرەوە",exitDemo:"دەرچوون لە نموونە",demoBarT:"نموونە — داتای نموونەیی (خەیاڵی)",demoBarB:"نموونە هەرگیز دەست لە داتای ڕاستەقینەی هۆتێل نادات. پاڵپشتی و گەڕاندنەوە و بەڕێوەبردنی داتای ڕاستەقینە لە نموونەدا ناچالاکن.",realBarT:"داتای ڕاستەقینەی هۆتێل — لەم کۆمپیوتەرە هەڵگیراوە",
checkedIn:"هاتنەژوورەوە تۆمارکرا",checkedOut:"چوونەدەرەوە تۆمارکرا — ژوورەکە ئێستا پیسە و چاوەڕوانی پشکنینە.",noReadyRooms:"هیچ ژوورێکی ئامادە نییە بۆ هاتنەژوورەوە",noTasks:"لێرە هیچ نییە ئێستا.",overdue:"دواکەوتووە",wrongPin:"ناوی بەکارهێنەر یان PIN هەڵەیە.",cancel:"هەڵوەشاندنەوە"
}};
var LANG = "en";
try { LANG = window.localStorage.getItem(LANG_KEY) || "en"; } catch(e){ LANG = "en"; }
if (["en","ar","ku"].indexOf(LANG) < 0) LANG = "en";
/* These strings changed for the online version (server storage, not this
   browser). Always show the English wording for them, even in ar/ku,
   rather than the old browser-storage text. */
var EN_ONLY_KEYS = ["storageNote","storageNoteT","howto1","howto3","howto4","realBarT","yourDataB","securityB","signinB","recoveryWarn","freshB","restoreWarn"];
function t(k){ if (EN_ONLY_KEYS.indexOf(k) >= 0) return I18N.en[k] || k; return (I18N[LANG] && I18N[LANG][k]) || I18N.en[k] || k; }
function applyLang(){
  document.querySelectorAll("[data-i18n]").forEach(function(el){ var v = t(el.getAttribute("data-i18n")); if (v) el.textContent = v; });
  document.querySelectorAll(".langbtn").forEach(function(b){ b.classList.toggle("active", b.getAttribute("data-lang")===LANG); });
  document.documentElement.lang = LANG === "en" ? "en" : (LANG === "ar" ? "ar" : "ckb");
  document.documentElement.dir = (LANG === "en") ? "ltr" : "rtl";
}
function setLang(l){
  LANG = l;
  storeSet(LANG_KEY, l);
  /* Rebuild the shared guest-field labels in the new language WITHOUT losing
     anything typed: snapshot the values, rebuild, restore them verbatim.
     Guest-entered names/IDs are never translated or altered. */
  var gf = $("ciGuestFields");
  if (gf && gf.dataset.built){
    var snap = null;
    try {
      snap = {name:$("ciName").value, id:$("ciId").value, contact:$("ciContact").value, car:$("ciCar").value, extras:[]};
      var ns = document.querySelectorAll("#ciExtras .ciExName"), is = document.querySelectorAll("#ciExtras .ciExId");
      for (var i=0;i<ns.length;i++) snap.extras.push({n:ns[i].value, d:is[i].value});
    } catch(e){ snap = null; }
    gf.dataset.built = ""; gf.innerHTML = "";
    if (currentUser) renderCheckin();
    if (snap){
      $("ciName").value = snap.name; $("ciId").value = snap.id; $("ciContact").value = snap.contact; $("ciCar").value = snap.car;
      snap.extras.forEach(function(x){ addExtraGuest("ci"); });
      var ns2 = document.querySelectorAll("#ciExtras .ciExName"), is2 = document.querySelectorAll("#ciExtras .ciExId");
      snap.extras.forEach(function(x, i){ if (ns2[i]) ns2[i].value = x.n; if (is2[i]) is2[i].value = x.d; });
    }
  }
  applyLang();
  renderAll();
}
/* ================= Navigation ================= */
var NAV = [
  {id:"dashboard", perm:"dashboard", icon:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></svg>'},
  {id:"rooms", perm:"rooms.view", icon:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="7" width="18" height="10" rx="2"/><path d="M3 13h18"/></svg>'},
  {id:"housekeeping", perm:"housekeeping.view", icon:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20l6-1L21 8a2.1 2.1 0 0 0-3-3L7 16l-1 6z"/></svg>'},
  {id:"inspections", perm:"inspect", icon:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 12l2 2 4-4"/></svg>'},
  {id:"maintenance", perm:"maintenance.view", icon:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4L14 13l-3-3 3.7-3.7z"/></svg>'},
  {id:"checkin", perm:"stays.view", icon:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 8a6 6 0 1 1 6 6"/><path d="M2 12h10"/><circle cx="17" cy="12" r="1.4"/></svg>'},
  {id:"reports", perm:"reports", icon:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/></svg>'},
  {id:"team", perm:"team.view", icon:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.2 3.4-5 6.5-5s5.7 1.8 6.5 5"/><path d="M16 5a3.5 3.5 0 0 1 0 7M18.5 15.3c1.7.7 2.7 2.2 3 4.7"/></svg>'},
  {id:"settings", perm:"settings", icon:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.4 2.7h4l.4-2.7a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.07-.4.1-.8.1-1.2z"/></svg>'}
];
var TITLES = {dashboard:"nav_dashboard", rooms:"nav_rooms", housekeeping:"nav_housekeeping", inspections:"nav_inspections", maintenance:"nav_maintenance", checkin:"nav_checkin", reports:"nav_reports", team:"nav_team", settings:"nav_settings", easy:"nav_easy", allrooms:"viewAllRooms"};
function navVisible(){
  if (!currentUser) return [];
  if (!fullMode()) return [{id:"easy"}];
  return NAV.filter(function(n){ return can(n.perm); });
}
function buildNav(){
  var nav = $("mainNav"); nav.innerHTML = "";
  navVisible().forEach(function(n){
    var b = document.createElement("button");
    b.className = "navbtn" + (currentView===n.id ? " active" : "");
    b.innerHTML = (n.icon || "") + "<span>" + esc(t("nav_"+n.id) || n.id) + "</span>";
    b.addEventListener("click", function(){ showView(n.id); });
    nav.appendChild(b);
  });
}
function showView(v){
  currentView = v;
  ["dashboard","rooms","housekeeping","inspections","maintenance","checkin","reports","team","settings","easy","allrooms"].forEach(function(id){
    var el = $("view-"+id); if (el) el.classList.toggle("hidden", id !== v);
  });
  $("viewTitle").textContent = t(TITLES[v] || "nav_dashboard");
  var dh = $("dashHero"); if (dh) dh.classList.toggle("hidden", v !== "dashboard"); /* v1.7 fix: dashHero photo was removed in the SmallStay rebrand, so guard it - unguarded it threw in showView() and stopped the menu + every view from rendering */
  buildNav();
  renderAll();
}
function updateModeUI(){
  var bar = $("dataBar"), tag = $("modeTag");
  if (MODE === "demo"){
    bar.className = "filebar"; $("dataBarTitle").textContent = t("demoBarT");
    $("dataBarSub").textContent = t("demoBarB");
    $("btnExitDemo").classList.remove("hidden");
    tag.className = "tag tag-amber"; tag.textContent = "DEMO";
    $("sideModeText").textContent = t("demoBarT");
  } else {
    bar.className = "filebar real";
    $("dataBarTitle").textContent = t("realBarT");
    $("dataBarSub").textContent = currentUser ? (currentUser.name + " · " + (ROLE_LABELS[currentUser.role]||currentUser.role) + (fullMode() ? "" : " · " + t("modeSimple"))) : "";
    $("btnExitDemo").classList.add("hidden");
    tag.className = "tag tag-green"; tag.textContent = hotelName();
    var hn = $("hotelNameEl"); if (hn) hn.textContent = hotelName();
    var vs = $("viewSub"); if (vs) vs.textContent = hotelName() + (hotelAddress() ? " — " + hotelAddress() : "");
    $("sideModeText").textContent = t("realBarT");
  }
  var unconfirmed = rooms.filter(function(r){ return !r.type; }).length;
  var warn = $("typeWarnBar");
  if (currentUser && can("room.type") && unconfirmed > 0){
    warn.innerHTML = esc(t("typeWarn").replace("{n}", unconfirmed)) + ' <button class="bigbtn btn-dark btn-sm" id="btnGotoTypes" style="margin-inline-start:8px">' + esc(t("nav_rooms")) + "</button>";
    warn.classList.remove("hidden");
    $("btnGotoTypes").addEventListener("click", function(){ showView("rooms"); });
  } else warn.classList.add("hidden");
}

/* ================= Entry / auth ================= */
function renderWhoList(){
  var host = $("whoList"); if (!host) return;
  host.innerHTML = "";
  var users = PUBLIC_USERS || [];
  users.forEach(function(u){
    var b = document.createElement("button");
    b.className = "pickbtn"; b.type = "button";
    b.textContent = u.name + " · " + (ROLE_LABELS[u.role] || u.role);
    b.addEventListener("click", function(){
      $("siUser").value = u.username;
      var pin = $("siPin"); if (pin){ pin.value = ""; pin.focus(); } /* clear the old PIN, so tapping another name cannot sign in with the previous person's PIN */
      var m = $("siMsg"); if (m) m.textContent = "";
    });
    host.appendChild(b);
  });
  if (!users.length) host.innerHTML = '<div class="emptybox">' + esc(t("noTasks")) + "</div>";
}
function renderEntry(){
  $("entry").classList.remove("hidden"); $("app").classList.add("hidden");
  renderWhoList();
  var needWizard = !STATUS.hasConfig;
  $("wizardBox").classList.toggle("hidden", !needWizard);
  $("setupBox").classList.toggle("hidden", !STATUS.hasConfig || STATUS.setupDone);
  $("signinBox").classList.toggle("hidden", !STATUS.hasConfig || !STATUS.setupDone);
  applyLang();
}
function enterApp(user){
  currentUser = user;
  $("entry").classList.add("hidden"); $("app").classList.remove("hidden");
  updateModeUI();
  showView(fullMode() ? (can("dashboard") ? "dashboard" : (navVisible()[0] ? navVisible()[0].id : "easy")) : "easy");
}
async function exitToEntry(){
  try {
    if (MODE === "demo") await api("/api/demo/exit", {method:"POST"});
    else await api("/api/auth/logout", {method:"POST"});
  } catch(e){ /* already signed out — just show the entry screen */ }
  currentUser = null; MODE = "real"; ME = null;
  DB = null; USERS = []; rooms = []; stays = []; tickets = [];
  await refreshEntry();
}
async function refreshEntry(){
  var statusOk = true;
  try { STATUS = await api("/api/status"); }
  catch(e){ STATUS = {setupDone:false, hasConfig:false, hotelName:""}; statusOk = false; }
  var me = null;
  try { me = await api("/api/auth/me"); } catch(e){ me = null; }
  if (me && me.user){
    ME = me;
    MODE = me.mode || "real";
    try {
      await refreshState();
      enterApp(me.user);
      return;
    } catch(e){ /* session looked valid but state failed — fall through to entry */ }
  }
  if (STATUS.hasConfig && STATUS.setupDone){
    try { PUBLIC_USERS = await api("/api/users/public"); } catch(e){ PUBLIC_USERS = []; }
  } else PUBLIC_USERS = [];
  if (!statusOk) toast("Cannot reach the server — check your connection and reload the page.");
  renderEntry();
}
async function doWizard(){
  var name = $("wzHotelName").value.trim(), addr = $("wzAddress").value.trim(), curr = $("wzCurrency").value;
  var price = parseInt($("wzPrice").value, 10), first = parseInt($("wzFirstFloor").value, 10);
  var count = parseInt($("wzFloorCount").value, 10), per = parseInt($("wzRoomsPerFloor").value, 10);
  var msg = $("wzMsg");
  if (!name){ msg.textContent = t("fillAll"); return; }
  if (curr !== "IQD" && curr !== "USD"){ msg.textContent = "Choose IQD or USD."; return; }
  if (isNaN(price) || price <= 0 || price > 100000000){ msg.textContent = "Enter a room price above 0."; return; }
  if (isNaN(first) || first < 0 || first > 20){ msg.textContent = "First floor must be 0 to 20."; return; }
  if (isNaN(count) || count < 1 || count > 12){ msg.textContent = "Guest floors must be 1 to 12."; return; }
  if (isNaN(per) || per < 1 || per > 12){ msg.textContent = "Rooms per floor must be 1 to 12."; return; }
  msg.textContent = "";
  try {
    await api("/api/setup/wizard", {method:"POST", body:{hotelName:name, address:addr, currency:curr, price:price, firstFloor:first, floorCount:count, roomsPerFloor:per}});
  } catch(e){ msg.textContent = e.message; return; }
  await refreshEntry();
  toast(t("savedOk"));
}
async function doSetup(){
  var name = $("suName").value.trim(), user = $("suUser").value.trim().toLowerCase(), p1 = $("suPin").value, p2 = $("suPin2").value;
  var msg = $("suMsg");
  if (!name || !user || !p1){ msg.textContent = t("fillAll"); return; }
  if (p1.length < 4){ msg.textContent = t("pinShort"); return; }
  if (p1 !== p2){ msg.textContent = t("pinMismatch"); return; }
  msg.textContent = "";
  var res;
  try { res = await api("/api/setup/owner", {method:"POST", body:{name:name, username:user, pin:p1, pin2:p2}}); }
  catch(e){ msg.textContent = e.message; return; }
  MODE = "real";
  try { await refreshState(); } catch(e){ msg.textContent = e.message; return; }
  enterApp(res.user);
  toast(t("savedOk"));
}
async function doSignin(){
  var user = $("siUser").value.trim().toLowerCase(), pin = $("siPin").value;
  var msg = $("siMsg");
  if (!user || !pin){ msg.textContent = t("wrongPin"); return; }
  msg.textContent = "";
  var res;
  try { res = await api("/api/auth/login", {method:"POST", body:{username:user, pin:pin}}); }
  catch(e){ msg.textContent = (e.status === 401) ? t("wrongPin") : e.message; return; }
  MODE = "real";
  try { await refreshState(); } catch(e){ msg.textContent = e.message; return; }
  enterApp(res.user);
}
async function enterDemo(role){
  var res;
  try { res = await api("/api/demo/start", {method:"POST", body:{role:role}}); }
  catch(e){ toast(e.message); return; }
  MODE = "demo";
  try { await refreshState(); } catch(e){ toast(e.message); return; }
  enterApp(res.user);
}
async function eraseAllRealData(){
  /* Owner-only server reset. From the entry screen (signed out) the server
     refuses this — the owner must sign in first and erase from Settings. */
  try {
    await api("/api/reset", {method:"POST", body:{confirm:"DELETE"}});
  } catch(e){
    toast(e.status === 401 ? "Sign in as the owner first, then erase from Settings." : e.message);
    return;
  }
  currentUser = null; MODE = "real"; ME = null;
  var rb = $("recoveryBox"); if (rb) rb.classList.add("hidden");
  var rt = $("recoveryText"); if (rt) rt.value = "";
  await refreshEntry();
  toast(t("savedOk"));
}
/* ================= Shared render helpers ================= */
function statCard(num, lbl, cls){ return '<div class="stat' + (cls ? " " + cls : "") + '"><div class="num num-ltr">' + esc(num) + '</div><div class="lbl">' + esc(lbl) + "</div></div>"; }
function statusTags(r){
  var tags = [];
  tags.push('<span class="tag ' + (r.occ==="occupied" ? "tag-orange" : "tag-grey") + '">' + esc(r.occ==="occupied" ? t("stOccupied") : t("stReady") === "Ready" ? "Vacant" : "Vacant") + "</span>");
  return tags.join(" ");
}
function roomStatusLine(r){
  var bits = [];
  bits.push(r.occ === "occupied" ? t("stOccupied") : "Vacant");
  bits.push(r.hk === "clean" ? "Clean" : (r.hk === "cleaning" ? t("stCleaning") : t("stDirty")));
  bits.push(r.insp === "passed" ? "Inspection passed" : (r.insp === "failed" ? "Inspection failed" : t("stInsp")));
  bits.push(r.access === "out" ? t("stOos") : "In service");
  return bits.join(" · ");
}
function guestsPublicHTML(s){
  /* Names only — safe for every role. */
  return s.guests.map(function(g){ return esc(g.name); }).join(", ");
}
function guestsPrivateHTML(s){
  if (!canSeePrivate()) return guestsPublicHTML(s);
  return s.guests.map(function(g){
    var photo = g.idPhoto ? '<div><img src="' + esc(g.idPhoto) + '" alt="' + esc(t("idPhoto")) + '" style="max-width:180px;border:1px solid var(--line);border-radius:8px;margin:4px 0" /></div>' : "";
    var parts = ["<strong>" + esc(g.name) + "</strong>"];
    if (g.idNum) parts.push(t("gId") + ': <span class="num-ltr">' + esc(g.idNum) + "</span>");
    if (g.contact) parts.push(t("gContact") + ': <span class="num-ltr">' + esc(g.contact) + "</span>");
    if (g.car) parts.push(t("gCar") + ': <span class="num-ltr">' + esc(g.car) + "</span>");
    return parts.join(" · ") + photo;
  }).join("<br />");
}
function stayMoneyLine(s){
  if (!canSeePrivate()) return "";
  if (s.basePrice == null) return "";
  var perNight = Math.round(s.basePrice * s.pct / 100);
  return '<div class="line small">' + fmt(s.basePrice) + " " + cur() + " × " + s.pct + "% = <strong>" + fmt(perNight) + " " + cur() + "</strong> " + esc(t("perNight")) + " · " + s.nights + " " + esc(t("nightWord")) + " · " + esc(t("totalPaid")) + ": <strong>" + fmt(s.total) + " " + cur() + "</strong></div>";
}

/* ================= Dashboard ================= */
function renderDashboard(){
  if (!$("dashStats")) return;
  var c = counts();
  $("dashStats").innerHTML = statCard(c.ready, t("readyW")) + statCard(c.occupied, t("occupiedW"), "stat-occ") + statCard(c.dirty, t("dirtyW")) + statCard(c.insp, t("awaitingW")) + statCard(c.oos, t("oosW")) + statCard(rooms.filter(function(r){return !r.type;}).length, t("typeToConfirm"));
  var work = [];
  var overdue = stays.filter(function(s){ return s.status==="in" && s.plannedOut < todayStr(); });
  if (overdue.length) work.push('<div class="itemrow"><h4>' + esc(t("overdue")) + " — " + overdue.length + '</h4><div class="small">' + overdue.map(function(s){ return esc(t("room")) + " " + s.room + " (" + esc(s.guests[0].name) + ", " + esc(t("departDate")) + ": " + s.plannedOut + ")"; }).join("<br />") + "</div></div>");
  var dirty = rooms.filter(function(r){ return r.hk==="dirty" || r.hk==="cleaning"; });
  if (dirty.length) work.push('<div class="itemrow"><h4>' + esc(t("outstandingCleaning")) + " — " + dirty.length + '</h4><div class="small">' + dirty.map(function(r){ return esc(t("room")) + " " + r.number + (r.assignedTo ? " — " + esc(userName(r.assignedTo)) : ""); }).join("<br />") + "</div></div>");
  var insp = rooms.filter(function(r){ return r.hk==="clean" && r.insp!=="passed" && r.access==="in"; });
  if (insp.length) work.push('<div class="itemrow"><h4>' + esc(t("awaitingW")) + " — " + insp.length + '</h4><div class="small">' + insp.map(function(r){ return esc(t("room")) + " " + r.number; }).join(", ") + "</div></div>");
  var open = tickets.filter(function(x){ return x.status!=="closed"; });
  if (open.length) work.push('<div class="itemrow"><h4>' + esc(t("openTickets")) + " — " + open.length + '</h4><div class="small">' + open.map(function(x){ return esc(t("room")) + " " + x.room + " — " + esc(x.type) + " (" + esc(x.status) + ")"; }).join("<br />") + "</div></div>");
  $("dashWork").innerHTML = work.length ? work.join("") : '<div class="emptybox">' + esc(t("noTasks")) + "</div>";
  var sp = $("staffPanel"); if (sp) sp.classList.toggle("hidden", !can("staff.manage"));
  var df = $("dashFloors"); df.innerHTML = "";
  getFloors().forEach(function(f){
    var b = document.createElement("button"); b.className = "pickbtn"; b.textContent = t("floor") + " " + f.n;
    b.addEventListener("click", function(){ selectedFloor = f.n; showAll = false; showView("rooms"); });
    df.appendChild(b);
  });
}

/* ================= Rooms ================= */
function renderFloorsTable(){
  var tb = $("floorsTable"); tb.innerHTML = "";
  getFloors().forEach(function(f){
    var tr = document.createElement("tr");
    tr.className = "floorrow" + (selectedFloor === f.n ? " sel" : "");
    var roomsTxt = f.guest ? (f.n*100+1) + "–" + (f.n*100+(DB && DB.config ? DB.config.roomsPerFloor : 12)) : "—";
    var occN = f.guest ? rooms.filter(function(r){ return r.floor === f.n && r.occ === "occupied"; }).length : 0;
    var occBadge = occN ? ' <span class="tag tag-orange">' + occN + " " + esc(t("stOccupied")) + "</span>" : "";
    tr.innerHTML = '<td class="floorname">' + esc(f.label) + '</td><td>' + esc(f.area) + '</td><td><span class="num-ltr">' + roomsTxt + "</span>" + occBadge + "</td>";
    if (f.guest) tr.addEventListener("click", function(){ selectedFloor = f.n; showAll = false; renderAll(); });
    tb.appendChild(tr);
  });
}
async function setRoomType(num, type){
  if (!requirePerm("room.type")) return;
  try { await api("/api/rooms/" + num + "/type", {method:"POST", body:{type: type || null}}); }
  catch(e){ toast(e.message); return; }
  saveAndRender();
}
function visibleRooms(){
  var ft = $("fType").value, fs = $("fStatus").value, q = $("fSearch").value.trim();
  return rooms.filter(function(r){
    if (!showAll && selectedFloor !== null && r.floor !== selectedFloor) return false; /* v1.7: no floor picked = show all rooms, not none */
    if (ft === "none" && r.type) return false;
    if (ft && ft !== "none" && r.type !== ft) return false;
    if (fs === "ready" && !isReady(r)) return false;
    if (fs === "dirty" && r.hk !== "dirty") return false;
    if (fs === "cleaning" && r.hk !== "cleaning") return false;
    if (fs === "insp" && !(r.hk === "clean" && r.insp !== "passed")) return false;
    if (fs === "oos" && r.access !== "out") return false;
    if (fs === "occupied" && r.occ !== "occupied") return false;
    if (fs === "vacant" && r.occ !== "vacant") return false;
    if (q && String(r.number).indexOf(q) < 0) return false;
    return true;
  });
}
function roomCard(r){
  var st = roomState(r);
  var card = document.createElement("button");
  card.className = "roomcard " + st.cls; card.type = "button";
  var stay = activeStayForRoom(r.number);
  var html = '<div style="display:flex;justify-content:space-between;align-items:center"><span class="rnum num-ltr">' + r.number + '</span><span class="tag ' + st.tag + '">' + esc(st.label) + "</span></div>";
  html += '<div class="line small">' + esc(t("floor")) + " " + r.floor + " · " + esc(r.type || t("typeToConfirm")) + "</div>";
  html += '<div class="line small">' + esc(roomStatusLine(r)) + "</div>";
  if (stay) html += '<div class="line small">' + esc(guestsPublicHTML(stay)) + (stay.plannedOut < todayStr() ? ' <span class="tag tag-red">' + esc(t("overdue")) + "</span>" : "") + "</div>";
  if (isReady(r)) html += '<div class="canbook">' + esc(t("stReady")) + "</div>";
  else if (r.occ === "occupied" && r.access !== "out") html += '<div class="occbox">' + esc(t("stOccupied")) + "</div>";
  else html += '<div class="cannot">' + esc(cannotReason(r)) + "</div>";
  card.innerHTML = html;
  card.addEventListener("click", function(){ openRoom(r.number); });
  return card;
}
function renderRooms(){
  var c = counts();
  $("roomStats").innerHTML = statCard(c.total, "Rooms") + statCard(c.ready, t("readyW")) + statCard(c.occupied, t("occupiedW"), "stat-occ") + statCard(c.dirty, t("dirtyW")) + statCard(c.insp, t("awaitingW")) + statCard(c.oos, t("oosW"));
  renderFloorsTable();
  $("btnClearFloor").classList.toggle("hidden", selectedFloor === null && !showAll);
  var area = $("roomsArea"); area.innerHTML = "";
  /* v1.7: rooms always show on opening Rooms - no floor click needed.
     Picking a floor filters to that floor; Clear floor shows all again. */
  var list = visibleRooms();
  if (!list.length){ area.innerHTML = '<div class="emptybox">' + esc(t("noTasks")) + "</div>"; return; }
  var grid = document.createElement("div"); grid.className = "roomgrid";
  list.forEach(function(r){ grid.appendChild(roomCard(r)); });
  area.appendChild(grid);
}
function openRoom(num){
  var r = roomByNum(num); if (!r) return;
  var st = roomState(r);
  var stay = activeStayForRoom(num);
  var html = '<p><span class="tag ' + st.tag + '">' + esc(st.label) + '</span> <span class="small muted">' + esc(roomStatusLine(r)) + "</span></p>";
  var ct3 = cleanTimeText(r); if (ct3) html += '<p class="small">' + ct3 + "</p>";
  html += '<p class="small">' + esc(t("floor")) + " " + r.floor + " · " + esc(t("roomW")) + ' <span class="num-ltr">' + r.number + "</span></p>";
  if (can("room.type")){
    html += '<label class="small" style="font-weight:700">Room type<select id="rmType" style="width:100%;margin-top:5px"><option value="">' + esc(t("typeToConfirm")) + '</option><option value="Single"' + (r.type==="Single"?" selected":"") + ">Single</option><option value='Twin'" + (r.type==="Twin"?" selected":"") + ">Twin</option></select></label>";
  } else {
    html += '<p class="small">' + esc(r.type || t("typeToConfirm")) + "</p>";
  }
  if (stay){
    html += "<h4 style='margin:12px 0 4px'>" + esc(t("inHouse")) + "</h4><div class='small'>" + guestsPrivateHTML(stay) + "</div>";
    html += '<div class="small">' + esc(t("checkinForm")) + ": " + esc(stay.checkInAt ? fmtDT(stay.checkInAt) : stay.checkInDate) + " · " + esc(t("departDate")) + ": " + esc(stay.plannedOut) + "</div>";
    html += stayMoneyLine(stay);
    if (stay.byIn) html += '<div class="small muted">' + esc(t("checkinForm")) + " " + esc(t("byStaff")) + " " + esc(userName(stay.byIn)) + "</div>";
  }
  var roomTickets = tickets.filter(function(x){ return x.room === num && x.status !== "closed"; });
  if (roomTickets.length){
    html += "<h4 style='margin:12px 0 4px'>" + esc(t("openTickets")) + "</h4>" + roomTickets.map(function(x){ return '<div class="small">' + esc(x.type) + " — " + esc(x.status) + " (" + esc(x.prio) + ")</div>"; }).join("");
  }
  if (r.access === "out" && can("service.release")){
    html += '<div style="margin-top:12px"><button class="bigbtn btn-green" id="rmRelease">' + esc(t("releaseBtn")) + "</button></div>";
  }
  if (isReady(r) && can("checkin")){
    html += '<div style="margin-top:12px"><button class="bigbtn btn-teal" id="rmCheckin">' + esc(t("checkIn")) + "</button></div>";
  }
  $("rmTitle").textContent = t("roomW") + " " + num;
  $("rmBody").innerHTML = html;
  $("roomModal").classList.remove("hidden");
  var sel = $("rmType");
  if (sel) sel.addEventListener("change", function(){ setRoomType(num, sel.value); $("roomModal").classList.add("hidden"); });
  var rel = $("rmRelease");
  if (rel) rel.addEventListener("click", function(){ releaseRoom(num).then(function(ok){ if (ok) $("roomModal").classList.add("hidden"); }); });
  var ci = $("rmCheckin");
  if (ci) ci.addEventListener("click", function(){ $("roomModal").classList.add("hidden"); showView("checkin"); var s = $("ciRoom"); if (s){ s.value = String(num); updateCalc("ci"); } });
}
/* ================= Housekeeping operations ================= */
function cleanMinutes(r){ /* minutes from start to finish, 1 decimal; null when the start was not recorded */
  if (!r.cleanStartedAt) return null;
  var m = (new Date() - new Date(r.cleanStartedAt)) / 60000;
  return Math.round(m * 10) / 10;
}
function cleanTimeText(r){ /* who cleaned it + how long, or who is cleaning it now + for how long */
  if (r.hk === "cleaning" && r.cleanStartedAt){
    var el = Math.round(((new Date() - new Date(r.cleanStartedAt)) / 60000) * 10) / 10;
    return t("cleaningBy") + " " + userName(r.cleanStartedBy) + " · " + esc(t("startedAt")) + " " + fmtDT(r.cleanStartedAt) + " · " + el + " " + t("minWord") + " " + t("soFar");
  }
  if (r.lastCleanedBy){
    var mins = (r.lastCleanMinutes == null) ? "—" : r.lastCleanMinutes;
    return t("cleanedBy") + " " + userName(r.lastCleanedBy) + " · " + mins + " " + t("minWord") + (r.lastCleanedAt ? " · " + fmtDT(r.lastCleanedAt) : "");
  }
  return "";
}
async function hkStart(num){
  if (!requirePerm("hk.work")) return;
  try { await api("/api/housekeeping/start", {method:"POST", body:{room:num}}); }
  catch(e){ toast(e.message); return; }
  saveAndRender(); toast(t("cleaningStarted"));
}
async function hkToggleItem(num, idx){
  if (!requirePerm("hk.work")) return;
  try { await api("/api/housekeeping/checklist", {method:"POST", body:{room:num, index:idx}}); }
  catch(e){ toast(e.message); return; }
  saveAndRender();
}
async function hkFinish(num){
  if (!requirePerm("hk.work")) return;
  try { await api("/api/housekeeping/finish", {method:"POST", body:{room:num}}); }
  catch(e){ toast(e.message); return; }
  saveAndRender(); toast(t("cleaningDone"));
}
async function hkAssign(num, staffId){
  if (!requirePerm("hk.assign")) return;
  try { await api("/api/housekeeping/assign", {method:"POST", body:{room:num, staffId: staffId || null}}); }
  catch(e){ toast(e.message); return; }
  saveAndRender(); toast(t("savedOk"));
}
function housekeepers(){ return USERS.filter(function(u){ return u.role === "housekeeper"; }); }
function hkCard(r, forWorker){
  var host = document.createElement("div"); host.className = "itemrow";
  var mine = r.assignedTo === currentUser.id;
  var html = "<h4>" + esc(t("roomW")) + ' <span class="num-ltr">' + r.number + "</span> " + '<span class="tag ' + roomState(r).tag + '">' + esc(roomState(r).label) + "</span></h4>";
  html += '<div class="small muted">' + esc(roomStatusLine(r)) + "</div>";
  var ct = cleanTimeText(r); if (ct) html += '<div class="small">' + ct + "</div>";
  if (r.assignedTo) html += '<div class="small">' + esc(t("cleaningTasks")) + " — " + esc(userName(r.assignedTo)) + "</div>";
  host.innerHTML = html;
  if (r.hk === "cleaning" || r.hk === "dirty"){
    var ul = document.createElement("ul"); ul.className = "checklist";
    CHECKLIST_ITEMS.forEach(function(item, idx){
      var li = document.createElement("li"); if (r.checklist[idx]) li.className = "done";
      li.innerHTML = "<span>" + esc(item) + "</span>";
      var b = document.createElement("button"); b.className = "bigbtn " + (r.checklist[idx] ? "btn-ghost" : "btn-teal") + " btn-sm";
      b.textContent = r.checklist[idx] ? "✓" : "Done";
      b.disabled = !(can("hk.work") && (!forWorker || mine || !r.assignedTo));
      b.addEventListener("click", function(){ hkToggleItem(r.number, idx); });
      li.appendChild(b); ul.appendChild(li);
    });
    host.appendChild(ul);
  }
  var row = document.createElement("div"); row.className = "btnrow";
  if (r.hk === "dirty" && can("hk.work") && (!forWorker || mine || !r.assignedTo)){
    var sb = document.createElement("button"); sb.className = "bigbtn btn-blue"; sb.textContent = t("start");
    sb.addEventListener("click", function(){ hkStart(r.number); }); row.appendChild(sb);
  }
  if (r.hk === "cleaning" && can("hk.work") && (!forWorker || mine || !r.assignedTo)){
    var fb = document.createElement("button"); fb.className = "bigbtn btn-teal"; fb.textContent = t("finish");
    fb.addEventListener("click", function(){ hkFinish(r.number); }); row.appendChild(fb);
  }
  host.appendChild(row);
  if (can("hk.assign")){
    var sel = document.createElement("select");
    sel.setAttribute("aria-label", "Assign cleaning");
    sel.innerHTML = '<option value="">— Unassigned —</option>' + housekeepers().map(function(u){ return '<option value="' + u.id + '"' + (r.assignedTo === u.id ? " selected" : "") + ">" + esc(u.name) + "</option>"; }).join("");
    sel.addEventListener("change", function(){ hkAssign(r.number, sel.value); });
    var wrap = document.createElement("div"); wrap.style.marginTop = "10px";
    wrap.innerHTML = '<span class="small" style="font-weight:700">' + esc(t("assignBtn")) + ": </span>";
    wrap.appendChild(sel); host.appendChild(wrap);
  }
  return host;
}
function renderHousekeeping(){
  var host = $("hkList"); host.innerHTML = "";
  var cleaned = rooms.filter(function(r){ return r.lastCleanMinutes != null; });
  if (cleaned.length){
    var avg = cleaned.reduce(function(a, r){ return a + r.lastCleanMinutes; }, 0) / cleaned.length;
    var byWho = {};
    cleaned.forEach(function(r){ var k = r.lastCleanedBy || "?"; byWho[k] = byWho[k] || {n:0, t:0}; byWho[k].n++; byWho[k].t += r.lastCleanMinutes; });
    var lines = Object.keys(byWho).map(function(k){ var w = byWho[k]; return esc(userName(k)) + ": " + (Math.round((w.t / w.n) * 10) / 10) + " " + esc(t("minWord")) + " " + esc(t("avgWord")) + " · " + w.n + " " + esc(t("roomsCleanedWord")); }).join("<br />");
    var sum = document.createElement("div"); sum.className = "small";
    sum.innerHTML = "<strong>" + esc(t("avgClean")) + ": " + (Math.round(avg * 10) / 10) + " " + esc(t("minWord")) + "</strong> · " + cleaned.length + " " + esc(t("roomsCleanedWord")) + "<br />" + lines;
    host.appendChild(sum);
  }
  var tasks = rooms.filter(function(r){ return r.hk === "dirty" || r.hk === "cleaning"; });
  if (currentUser.role === "housekeeper") tasks = tasks.filter(function(r){ return r.assignedTo === currentUser.id || !r.assignedTo; });
  if (!tasks.length){ var eb = document.createElement("div"); eb.className = "emptybox"; eb.textContent = t("noTasks"); host.appendChild(eb); return; } /* v1.7 fix: append, do not overwrite - overwriting wiped the average summary above */
  tasks.forEach(function(r){ host.appendChild(hkCard(r, currentUser.role === "housekeeper")); });
}

/* ================= Inspections ================= */
async function inspectRoom(num, pass){
  if (!requirePerm("inspect")) return;
  try { await api("/api/inspections", {method:"POST", body:{room:num, pass:!!pass}}); }
  catch(e){ toast(e.message); return; }
  saveAndRender(); toast(pass ? t("inspPassed") : t("inspFailed"));
}
function renderInspections(){
  var host = $("inspList"); host.innerHTML = "";
  var list = rooms.filter(function(r){ return r.hk === "clean" && r.insp !== "passed"; });
  if (!list.length){ host.innerHTML = '<div class="emptybox">' + esc(t("noTasks")) + "</div>"; return; }
  list.forEach(function(r){
    var row = document.createElement("div"); row.className = "itemrow";
    var ct2 = cleanTimeText(r);
    row.innerHTML = "<h4>" + esc(t("roomW")) + ' <span class="num-ltr">' + r.number + "</span></h4><div class='small muted'>" + esc(roomStatusLine(r)) + "</div>" + (ct2 ? "<div class='small'>" + ct2 + "</div>" : "");
    var br = document.createElement("div"); br.className = "btnrow";
    var pb = document.createElement("button"); pb.className = "bigbtn btn-green"; pb.textContent = t("passBtn");
    pb.addEventListener("click", function(){ inspectRoom(r.number, true); });
    var fb = document.createElement("button"); fb.className = "bigbtn btn-amber"; fb.textContent = t("failBtn");
    fb.addEventListener("click", function(){ inspectRoom(r.number, false); });
    br.appendChild(pb); br.appendChild(fb); row.appendChild(br);
    host.appendChild(row);
  });
}

/* ================= Maintenance operations ================= */
function ticketById(id){ for (var i=0;i<tickets.length;i++) if (tickets[i].id===id) return tickets[i]; return null; }
function ticketHistory(x, action){ x.history.push({at:new Date().toISOString(), byId:currentUser ? currentUser.id : null, action:action}); }
async function reportTicket(){
  if (!requirePerm("ticket.report")) return;
  if (!dmg.room || !dmg.type || !dmg.prio){ toast("Pick a room, a problem and a priority first."); return; }
  try {
    await api("/api/tickets", {method:"POST", body:{room:dmg.room, type:dmg.type, prio:dmg.prio, note:$("dmgNote").value.trim()}});
  } catch(e){ toast(e.message); return; }
  dmg = {room:null, type:null, prio:null}; $("dmgNote").value = "";
  saveAndRender(); toast(t("reportFiled"));
}
async function ticketSetStatus(id, action){
  if (action === "working" || action === "parts" || action === "fixed" || action === "oos"){
    if (!requirePerm("ticket.work")) return;
  } else if (action === "close" || action === "back"){
    if (!requirePerm("ticket.close")) return;
  }
  try { await api("/api/tickets/" + id + "/status", {method:"POST", body:{action:action}}); }
  catch(e){ toast(e.message); return; }
  saveAndRender();
  if (action === "fixed") toast(t("fixedSent"));
  else if (action === "close") toast(t("ticketClosed"));
  else if (action === "back") toast(t("sentBack"));
}
async function ticketAssign(id, staffId){
  if (!requirePerm("ticket.assign")) return;
  try { await api("/api/tickets/" + id + "/assign", {method:"POST", body:{staffId: staffId || null}}); }
  catch(e){ toast(e.message); return; }
  saveAndRender(); toast(t("savedOk"));
}
function blockingTicketsFor(roomNum, exceptId){
  return tickets.filter(function(x){ return x.room === roomNum && x.status !== "closed" && x.blocking && x.id !== exceptId; });
}
async function releaseRoom(num){
  if (!requirePerm("service.release")) return false;
  try { await api("/api/rooms/" + num + "/release", {method:"POST", body:{}}); }
  catch(e){ toast(e.message); return false; }
  saveAndRender(); toast(t("released"));
  return true;
}
function closeBlockingAndRelease(ticketId){
  /* Closing a blocking ticket clears its blocking flag on the server. */
  ticketSetStatus(ticketId, "close");
}
function ticketCard(x, opts){
  opts = opts || {};
  var host = document.createElement("div"); host.className = "itemrow";
  var html = "<h4>" + esc(t("roomW")) + ' <span class="num-ltr">' + x.room + "</span> — " + esc(x.type) + ' <span class="tag ' + (x.status==="closed" ? "tag-green" : x.status==="check" ? "tag-purple" : "tag-amber") + '">' + esc(x.status) + "</span></h4>";
  html += '<div class="small muted">' + esc(x.prio) + " · " + esc(fmtDT(x.createdAt)) + " · " + esc(t("byStaff")) + " " + esc(userName(x.reporterId)) + (x.assigneeId ? " · → " + esc(userName(x.assigneeId)) : "") + "</div>";
  if (x.note) html += '<div class="small">' + esc(x.note) + "</div>";
  if (x.history && x.history.length){
    html += '<div class="small muted" style="margin-top:6px">' + x.history.map(function(h){ return esc(fmtDT(h.at)) + " — " + esc(h.action) + " (" + esc(userName(h.byId)) + ")"; }).join("<br />") + "</div>";
  }
  host.innerHTML = html;
  var row = document.createElement("div"); row.className = "btnrow";
  function mk(label, cls, fn){ var b = document.createElement("button"); b.className = "bigbtn " + cls; b.textContent = label; b.addEventListener("click", fn); row.appendChild(b); }
  if (opts.checkMode){
    if (can("ticket.close")){
      mk(t("checkedOk"), "btn-green", function(){ closeBlockingAndRelease(x.id); });
      mk(t("notFixed"), "btn-amber", function(){ ticketSetStatus(x.id, "back"); });
    }
  } else if (x.status !== "closed" && x.status !== "check" && can("ticket.work")){
    mk(t("working"), "btn-blue", function(){ ticketSetStatus(x.id, "working"); });
    mk(t("fixed"), "btn-green", function(){ ticketSetStatus(x.id, "fixed"); });
    mk(t("oosBtn"), "btn-red", function(){ ticketSetStatus(x.id, "oos"); });
    mk(t("parts"), "btn-amber", function(){ ticketSetStatus(x.id, "parts"); });
  }
  host.appendChild(row);
  if (opts.assignMode && can("ticket.assign")){
    var sel = document.createElement("select"); sel.setAttribute("aria-label", "Assign maintenance worker");
    var maints = USERS.filter(function(u){ return u.role === "maintenance"; });
    sel.innerHTML = '<option value="">— Unassigned —</option>' + maints.map(function(u){ return '<option value="' + u.id + '"' + (x.assigneeId === u.id ? " selected" : "") + ">" + esc(u.name) + "</option>"; }).join("");
    sel.addEventListener("change", function(){ ticketAssign(x.id, sel.value); });
    var wrap = document.createElement("div"); wrap.style.marginTop = "10px";
    wrap.innerHTML = '<span class="small" style="font-weight:700">' + esc(t("assignBtn")) + ": </span>";
    wrap.appendChild(sel); host.appendChild(wrap);
  }
  return host;
}
function pickRow(hostId, items, getVal, setVal){
  var host = $(hostId); if (!host) return; host.innerHTML = "";
  items.forEach(function(it){
    var b = document.createElement("button"); b.className = "pickbtn" + (getVal() === it ? " sel" : ""); b.textContent = it;
    b.addEventListener("click", function(){ setVal(it); renderMaintenance(); });
    host.appendChild(b);
  });
}
function renderMaintenance(){
  var sel = $("dmgRooms");
  if (sel){
    var cur = sel.value;
    sel.innerHTML = rooms.map(function(r){ return '<option value="' + r.number + '"' + (dmg.room === r.number ? " selected" : "") + ">" + t("roomW") + " " + r.number + "</option>"; }).join("");
    if (cur) sel.value = cur;
    if (!dmg.room && sel.value) dmg.room = parseInt(sel.value, 10);
  }
  pickRow("dmgTypes", TICKET_TYPES, function(){ return dmg.type; }, function(v){ dmg.type = v; });
  pickRow("dmgPrio", TICKET_PRIOS, function(){ return dmg.prio; }, function(v){ dmg.prio = v; });
  var list = $("ticketList"); list.innerHTML = "";
  var mine = tickets.filter(function(x){ return x.status !== "closed" && x.status !== "check"; });
  if (currentUser.role === "maintenance") mine = mine.filter(function(x){ return x.assigneeId === currentUser.id || !x.assigneeId; });
  if (!mine.length) list.innerHTML = '<div class="emptybox">' + esc(t("noTasks")) + "</div>";
  mine.forEach(function(x){ list.appendChild(ticketCard(x, {})); });
  var checks = tickets.filter(function(x){ return x.status === "check"; });
  var cl = $("checkList"); cl.innerHTML = "";
  $("checkPanel").classList.toggle("hidden", !can("ticket.close"));
  if (!checks.length) cl.innerHTML = '<div class="emptybox">' + esc(t("noTasks")) + "</div>";
  checks.forEach(function(x){ cl.appendChild(ticketCard(x, {checkMode:true})); });
  var unassigned = tickets.filter(function(x){ return !x.assigneeId && x.status !== "closed"; });
  $("assignPanel").classList.toggle("hidden", !(can("ticket.assign") && unassigned.length));
  var al = $("assignList"); al.innerHTML = "";
  unassigned.forEach(function(x){ al.appendChild(ticketCard(x, {assignMode:true})); });
  var oosRooms = rooms.filter(function(r){ return r.access === "out"; });
  $("releasePanel").classList.toggle("hidden", !(can("service.release") && oosRooms.length));
  var rl = $("releaseList"); rl.innerHTML = "";
  oosRooms.forEach(function(r){
    var row = document.createElement("div"); row.className = "itemrow";
    var blockers = tickets.filter(function(x){ return x.room === r.number && x.status !== "closed" && x.blocking; });
    row.innerHTML = "<h4>" + esc(t("roomW")) + ' <span class="num-ltr">' + r.number + "</span></h4>" +
      (blockers.length ? '<div class="small errtext">' + esc(t("releaseBlocked")) + " " + blockers.map(function(x){ return "#" + x.id + " " + esc(x.type) + " (" + esc(x.status) + ")"; }).join(", ") + "</div>" : '<div class="small">' + esc(t("releaseBtn")) + "</div>");
    var br = document.createElement("div"); br.className = "btnrow";
    var b = document.createElement("button"); b.className = "bigbtn btn-green"; b.textContent = t("releaseBtn");
    b.disabled = blockers.length > 0;
    b.addEventListener("click", function(){ releaseRoom(r.number); });
    br.appendChild(b); row.appendChild(br);
    rl.appendChild(row);
  });
}
/* ================= Guest fields component (shared by every check-in flow) ================= */
function guestFieldsHTML(p){
  return '<div class="formgrid">' +
    '<label>' + esc(t("gName")) + ' *<input id="' + p + 'Name" type="text" autocomplete="name" /></label>' +
    '<label>' + esc(t("gId")) + ' *<input id="' + p + 'Id" type="text" /></label>' +
    '<label>' + esc(t("gContact")) + '<input id="' + p + 'Contact" type="tel" /></label>' +
    '<label>' + esc(t("gCar")) + '<input id="' + p + 'Car" type="text" /></label></div>' +
    '<div style="margin-top:10px"><label class="small" style="font-weight:700">' + esc(t("idPhoto")) + ' <span class="muted">(' + esc(t("optional")) + ')</span></label>' +
    '<div style="display:flex;gap:10px;align-items:flex-start;margin-top:5px"><img id="' + p + 'IdPhotoPreview" class="hidden" alt="" style="width:140px;height:auto;border:1px solid var(--line);border-radius:8px" />' +
    '<div><input id="' + p + 'IdPhoto" type="file" accept="image/*" capture="environment" />' +
    '<div style="margin-top:6px"><button type="button" class="bigbtn btn-ghost btn-sm hidden" id="' + p + 'IdPhotoRemove">' + esc(t("removePhoto")) + '</button></div>' +
    '<p class="small muted" style="margin:6px 0 0">' + esc(t("idPhotoNote")) + '</p></div></div></div>' +
    '<div id="' + p + 'Extras"></div>' +
    '<p class="small muted" style="margin:10px 0 4px"><span id="' + p + 'Count">1</span> ' + esc(t("guestsInRoom")) + '</p>' +
    '<div style="margin:0 0 6px"><button type="button" class="bigbtn btn-dark" id="' + p + 'AddGuest">' + esc(t("addGuest")) + '</button></div>';
}
function extraRowHTML(p){
  return '<div class="formgrid" style="margin-top:10px;border-top:1px dashed var(--line);padding-top:10px">' +
    '<label>' + esc(t("guestN") === "Additional guest" ? "Additional guest — " : "") + esc(t("gName")) + ' *<input type="text" class="' + p + 'ExName" /></label>' +
    '<label>' + esc(t("gId")) + ' *<input type="text" class="' + p + 'ExId" /></label>' +
    '<div><button type="button" class="bigbtn btn-ghost btn-sm ' + p + 'ExRemove">' + esc(t("removeGuest")) + '</button></div></div>';
}
function updateGuestCount(p){
  var extras = document.querySelectorAll("#" + p + "Extras ." + p + "ExName").length;
  var el = $(p + "Count"); if (el) el.textContent = String(1 + extras);
}
function addExtraGuest(p){
  var host = $(p + "Extras"); if (!host) return;
  var div = document.createElement("div");
  div.innerHTML = extraRowHTML(p);
  var node = div.firstChild;
  host.appendChild(node);
  node.querySelector("." + p + "ExRemove").addEventListener("click", function(){ node.remove(); updateGuestCount(p); });
  updateGuestCount(p);
}
/* ID card photos: kept in memory while typing, saved inside the stay on check-in.
   Photos are shrunk (max 900px, JPEG) before saving so they do not fill the storage. */
var guestIdPhotos = {};
function downscalePhoto(file, done){
  var reader = new FileReader();
  reader.onload = function(){
    var img = new Image();
    img.onload = function(){
      var max = 900, w = img.width, h = img.height;
      if (w > max || h > max){ var k = Math.min(max / w, max / h); w = Math.round(w * k); h = Math.round(h * k); }
      var cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      cv.getContext("2d").drawImage(img, 0, 0, w, h);
      done(cv.toDataURL("image/jpeg", 0.72));
    };
    img.onerror = function(){ done(reader.result); };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}
function initGuestFields(p){
  $(p + "GuestFields") && 0;
  var add = $(p + "AddGuest");
  if (add) add.addEventListener("click", function(){ addExtraGuest(p); });
  var inp = $(p + "IdPhoto"), prev = $(p + "IdPhotoPreview"), rem = $(p + "IdPhotoRemove");
  if (inp) inp.addEventListener("change", function(){
    var f = inp.files && inp.files[0]; if (!f) return;
    downscalePhoto(f, function(dataUrl){
      guestIdPhotos[p] = dataUrl;
      if (prev){ prev.src = dataUrl; prev.classList.remove("hidden"); }
      if (rem) rem.classList.remove("hidden");
    });
  });
  if (rem) rem.addEventListener("click", function(){
    guestIdPhotos[p] = null;
    if (inp) inp.value = "";
    if (prev){ prev.src = ""; prev.classList.add("hidden"); }
    rem.classList.add("hidden");
  });
  if (guestIdPhotos[p] && prev){ prev.src = guestIdPhotos[p]; prev.classList.remove("hidden"); if (rem) rem.classList.remove("hidden"); }
  updateGuestCount(p);
}
function readGuests(p){
  /* Returns {guests, error} — validation shared by all check-in flows.
     Entered values are read from the live form and never cleared on error,
     so a failed save keeps everything the user typed. */
  var name = $(p + "Name").value.trim(), idNum = $(p + "Id").value.trim();
  if (!name) return {error: t("errName")};
  if (!idNum) return {error: t("errId")};
  var guests = [{name:name, idNum:idNum, contact:$(p + "Contact").value.trim(), car:$(p + "Car").value.trim()}];
  if (guestIdPhotos[p]) guests[0].idPhoto = guestIdPhotos[p]; /* v1.7: ID card photo saved inside the stay */
  var names = document.querySelectorAll("#" + p + "Extras ." + p + "ExName");
  var ids = document.querySelectorAll("#" + p + "Extras ." + p + "ExId");
  for (var i=0;i<names.length;i++){
    var n = names[i].value.trim(), d = ids[i].value.trim();
    if (!n || !d) return {error: t("errExtra")};
    guests.push({name:n, idNum:d, contact:"", car:""});
  }
  return {guests: guests};
}
function clearGuestFields(p){
  guestIdPhotos[p] = null;
  var inp = $(p + "IdPhoto"); if (inp) inp.value = "";
  var prev = $(p + "IdPhotoPreview"); if (prev){ prev.src = ""; prev.classList.add("hidden"); }
  var rem = $(p + "IdPhotoRemove"); if (rem) rem.classList.add("hidden");
  ["Name","Id","Contact","Car"].forEach(function(k){ var el = $(p + k); if (el) el.value = ""; });
  var ex = $(p + "Extras"); if (ex) ex.innerHTML = "";
  updateGuestCount(p);
}

/* ================= Check-in / check-out operations ================= */
async function doCheckIn(roomNum, nights, pct, depart, guests, errHostId){
  if (!requirePerm("checkin")) return false;
  function fail(msg){ if (errHostId){ var e = $(errHostId); e.textContent = msg; e.classList.remove("hidden"); } else toast(msg); return false; }
  nights = Math.max(1, parseInt(nights, 10) || 1);
  pct = Number(pct);
  if (isNaN(pct) || pct < 0 || pct > 100) return fail(t("errPct"));
  try {
    await api("/api/checkin", {method:"POST", body:{room:roomNum, nights:nights, pct:pct, depart: depart || undefined, guests:guests}});
  } catch(e){ return fail(e.message); }
  await refreshState(); renderAll();
  toast(t("checkedIn") + " — " + t("roomW") + " " + roomNum);
  return true;
}
async function doCheckOut(stayId){
  if (!requirePerm("checkout")) return;
  try { await api("/api/checkout", {method:"POST", body:{stayId:stayId}}); }
  catch(e){ toast(e.message); return; }
  saveAndRender(); toast(t("checkedOut"));
}
function calcHTML(price, pct, nights){
  var perNight = Math.round(price * pct / 100);
  return fmt(price) + " " + cur() + " × " + pct + "% = <span class='paid'>" + fmt(perNight) + " " + cur() + "</span> " + esc(t("perNight")) +
    ' <span class="disc">(' + fmt(price - perNight) + " " + cur() + " off)</span><br />" + nights + " " + esc(t("nightWord")) + " · " + esc(t("totalPaid")) + ": <strong>" + fmt(perNight * nights) + " " + cur() + "</strong>";
}
function updateCalc(p){
  if (!DB) return;
  var roomSel = $(p + "Room"), nightsEl = $(p + "Nights"), pctEl = $(p + "Pct"), box = $(p + "Calc");
  if (!box) return;
  var pct = Math.min(100, Math.max(0, Number(pctEl.value) || 0));
  var nights = Math.max(1, parseInt(nightsEl.value, 10) || 1);
  box.innerHTML = calcHTML(DB.price, pct, nights);
  var dep = $(p + "Depart");
  if (dep && !dep.dataset.touched) dep.value = addDays(todayStr(), nights);
}

/* ================= Reception renders ================= */
function renderCheckin(){
  var ready = rooms.filter(isReady);
  $("readyCountTag").textContent = "Ready rooms: " + ready.length;
  var area = $("readyRoomsArea");
  if (!ready.length) area.innerHTML = '<div class="emptybox">' + esc(t("noReadyRooms")) + "</div>";
  else {
    var grid = document.createElement("div"); grid.className = "roomgrid";
    ready.forEach(function(r){
      var b = document.createElement("button"); b.type = "button"; b.className = "roomcard st-ready";
      b.innerHTML = '<span class="rnum num-ltr">' + r.number + '</span><div class="line small">' + esc(t("floor")) + " " + r.floor + " · " + esc(r.type || t("typeToConfirm")) + '</div><div class="canbook">' + esc(t("stReady")) + "</div>"; /* v1.7: floor number on the card */
      b.addEventListener("click", function(){ $("ciRoom").value = String(r.number); updateCalc("ci"); window.scrollTo({top: $("ciRoom").getBoundingClientRect().top + window.scrollY - 120, behavior:"smooth"}); });
      grid.appendChild(b);
    });
    area.innerHTML = ""; area.appendChild(grid);
  }
  var sel = $("ciRoom"), prev = sel.value;
  sel.innerHTML = ready.map(function(r){ return '<option value="' + r.number + '">Room ' + r.number + " — " + esc(t("floor")) + " " + r.floor + " — " + esc(r.type || t("typeToConfirm")) + "</option>"; }).join(""); /* v1.7: floor number in the list */
  if (prev && ready.some(function(r){ return String(r.number) === prev; })) sel.value = prev;
  if (!$("ciGuestFields").dataset.built){ $("ciGuestFields").innerHTML = guestFieldsHTML("ci"); $("ciGuestFields").dataset.built = "1"; initGuestFields("ci"); }
  updateCalc("ci");
  renderInHouse(); renderStays();
}
function stayRowHTML(s, withCheckout, collapsed){
  var overdueTag = (s.status === "in" && s.plannedOut < todayStr()) ? ' <span class="tag tag-red">' + esc(t("overdue")) + "</span>" : "";
  var head = "<h4>" + esc(t("roomW")) + ' <span class="num-ltr">' + s.room + "</span>" + overdueTag + ' <span class="tag ' + (s.status === "in" ? "tag-orange" : "tag-grey") + '">' + (s.status === "in" ? esc(t("stOccupied")) : esc(t("checkedOut") === "Checked out — room is now Dirty and awaiting inspection." ? "Checked out" : "Checked out")) + "</span></h4>";
  var details = '<div class="small">' + guestsPrivateHTML(s) + "</div>";
  details += '<div class="small muted">' + esc(t("checkinForm")) + ": " + esc(s.checkInAt ? fmtDT(s.checkInAt) : s.checkInDate + (s.migratedNoTime ? " (time not recorded)" : "")) + " · " + esc(t("departDate")) + ": " + esc(s.plannedOut) + (s.checkOutAt ? " · " + esc(t("checkOut")) + ": " + esc(fmtDT(s.checkOutAt)) : "") + "</div>";
  details += stayMoneyLine(s);
  if (s.byIn) details += '<div class="small muted">' + esc(t("checkinForm")) + " " + esc(t("byStaff")) + " " + esc(userName(s.byIn)) + (s.byOut ? " · " + esc(t("checkOut")) + " " + esc(t("byStaff")) + " " + esc(userName(s.byOut)) : "") + "</div>";
  var row = document.createElement("div"); row.className = "itemrow" + (s.status === "in" ? " occ-row" : "");
  if (collapsed){
    /* v1.7: checked-out stays show only room + name + status. Tap the row to see all details. */
    var mainName = (s.guests && s.guests[0]) ? s.guests[0].name : "";
    row.style.cursor = "pointer";
    row.innerHTML = head + '<div class="small"><strong>' + esc(mainName) + "</strong></div>";
    var hint = document.createElement("div"); hint.className = "small muted"; hint.textContent = t("showDetails");
    row.appendChild(hint);
    var det = document.createElement("div"); det.className = "stayDetails hidden"; det.innerHTML = details;
    row.appendChild(det);
    row.addEventListener("click", function(){
      var open = det.classList.toggle("hidden");
      hint.textContent = open ? t("showDetails") : t("hideDetails");
    });
    return row;
  }
  row.innerHTML = head + details;
  if (withCheckout && s.status === "in" && can("checkout")){
    var br = document.createElement("div"); br.className = "btnrow";
    var b = document.createElement("button"); b.className = "bigbtn btn-red"; b.textContent = t("checkOut");
    b.addEventListener("click", function(){ doCheckOut(s.id); });
    br.appendChild(b); row.appendChild(br);
  }
  return row;
}
function renderInHouse(){
  var host = $("inHouseList"); host.innerHTML = "";
  var list = stays.filter(function(s){ return s.status === "in"; });
  if (!list.length){ host.innerHTML = '<div class="emptybox">' + esc(t("noTasks")) + "</div>"; return; }
  list.forEach(function(s){ host.appendChild(stayRowHTML(s, true)); });
}
function renderStays(){
  var host = $("staysList"); if (!host) return; host.innerHTML = "";
  var q = ($("staySearch").value || "").toLowerCase(), d = $("stayDate").value, f = $("stayFilter").value;
  var list = stays.filter(function(s){
    if (f === "in" && s.status !== "in") return false;
    if (f === "out" && s.status !== "out") return false;
    if (f === "overdue" && !(s.status === "in" && s.plannedOut < todayStr())) return false;
    if (q && String(s.room).indexOf(q) < 0 && s.guests.map(function(g){ return g.name.toLowerCase(); }).join(" ").indexOf(q) < 0) return false;
    if (d && !(s.checkInDate <= d && (s.checkOutAt ? dateOf(s.checkOutAt) >= d : s.plannedOut >= d))) return false;
    return true;
  });
  if (!list.length){ host.innerHTML = '<div class="emptybox">' + esc(t("noTasks")) + "</div>"; return; }
  list.slice().reverse().forEach(function(s){ host.appendChild(stayRowHTML(s, true, s.status === "out")); }); /* v1.7: checked-out rows start collapsed */
}

/* ================= Daily Report ================= */
function reportData(date){
  var ins = stays.filter(function(s){ return s.checkInDate === date; });
  var outs = stays.filter(function(s){ return s.checkOutAt && dateOf(s.checkOutAt) === date; });
  /* A stay occupies the night of `date` when it started on/before that date and
     had not ended before that night: check-out day itself is not an occupied
     night (except a same-day in/out), and an overdue stay still in house counts. */
  var during = stays.filter(function(s){
    if (s.checkInDate > date) return false;
    if (s.checkOutAt){
      var co = dateOf(s.checkOutAt);
      return co > date || co === s.checkInDate;
    }
    if (s.status === "in") return true; /* still in house (incl. overdue) */
    return s.plannedOut > date;
  });
  var revenue = 0;
  during.forEach(function(s){ revenue += Math.round(s.basePrice * s.pct / 100); });
  return {ins:ins, outs:outs, during:during, revenue:revenue};
}
function stayTableRows(list){
  if (!list.length) return '<p class="small muted">' + esc(t("noTasks")) + "</p>";
  var rows = list.map(function(s){
    var perNight = Math.round(s.basePrice * s.pct / 100);
    var guestsCell = canSeePrivate() ? guestsPrivateHTML(s) : guestsPublicHTML(s);
    var money = canSeePrivate() ? (fmt(s.basePrice) + " × " + s.pct + "% = " + fmt(perNight) + " " + cur()) : "—";
    return "<tr><td class='num-ltr'>" + s.room + "</td><td>" + guestsCell + "</td><td>" + esc(s.checkInDate) + "</td><td>" + esc(s.plannedOut) + "</td><td>" + money + "</td><td>" + esc(s.byIn ? userName(s.byIn) : "—") + "</td></tr>";
  }).join("");
  return '<div class="report-scroll"><table><thead><tr><th>' + esc(t("roomW")) + "</th><th>Guest</th><th>" + esc(t("checkinForm")) + "</th><th>" + esc(t("departDate")) + "</th><th>" + cur() + " / night</th><th>" + esc(t("byStaff")) + "</th></tr></thead><tbody>" + rows + "</tbody></table></div>";
}
async function renderReports(){
  try {
    var date = $("repDate").value || todayStr();
    var data = null;
    try { data = await api("/api/report?date=" + encodeURIComponent(date)); } catch(e){ data = null; }
    var local = reportData(date);
    var ins = (data && data.ins) || local.ins;
    var outs = (data && data.outs) || local.outs;
    var during = (data && data.during) || local.during;
    var revenue = (data && typeof data.revenue === "number") ? data.revenue : local.revenue;
    var isToday = date === todayStr();
    var sc = (data && (data.counts || data.snapshot)) || null;
    var c = counts();
    var countsHTML;
    if (isToday){
      countsHTML = statCard(c.ready, t("readyW")) + statCard(c.occupied, t("occupiedW"), "stat-occ") + statCard(c.dirty, t("dirtyW")) + statCard(c.insp, t("awaitingW")) + statCard(c.oos, t("oosW"));
    } else if (sc){
      countsHTML = statCard(sc.ready, t("readyW")) + statCard(sc.occupied, t("occupiedW"), "stat-occ") + statCard(sc.dirty, t("dirtyW")) + statCard(sc.awaiting != null ? sc.awaiting : sc.insp, t("awaitingW")) + statCard(sc.oos, t("oosW"));
    } else if (data && data.noHistory){
      countsHTML = '<div class="warnpanel" style="grid-column:1/-1">' + esc(t("repNoHist")) + "</div>";
    } else {
      countsHTML = statCard(c.ready, t("readyW")) + statCard(c.occupied, t("occupiedW"), "stat-occ") + statCard(c.dirty, t("dirtyW")) + statCard(c.insp, t("awaitingW")) + statCard(c.oos, t("oosW"));
    }
    $("repTotals").innerHTML = countsHTML +
      statCard(ins.length, t("repCheckins")) + statCard(outs.length, t("repCheckouts")) +
      statCard(during.length, t("repInhouse"), "stat-occ") + statCard(c.occupied + " / " + rooms.length, t("repLive"), "stat-occ") +
      (canSeePrivate() ? statCard(fmt(revenue) + " " + cur(), t("repRevenue")) : "");
    var open = tickets.filter(function(x){ return x.status !== "closed"; });
    var cleaning = rooms.filter(function(r){ return r.hk === "dirty" || r.hk === "cleaning"; });
    var oosRooms = rooms.filter(function(r){ return r.access === "out"; });
    var html = "";
    html += "<h4 style='margin:16px 0 4px'>" + esc(t("repCheckins")) + "</h4>" + stayTableRows(ins);
    html += "<h4 style='margin:16px 0 4px'>" + esc(t("repCheckouts")) + "</h4>" + stayTableRows(outs);
    html += "<h4 style='margin:16px 0 4px'>" + esc(t("repInhouse")) + "</h4>" + stayTableRows(during);
    html += "<h4 style='margin:16px 0 4px'>" + esc(t("openTickets")) + " (" + open.length + ")</h4>" +
      (open.length ? open.map(function(x){ return '<div class="small">' + esc(t("roomW")) + " " + x.room + " — " + esc(x.type) + " (" + esc(x.status) + ", " + esc(x.prio) + ")</div>"; }).join("") : '<p class="small muted">' + esc(t("noTasks")) + "</p>");
    html += "<h4 style='margin:16px 0 4px'>" + esc(t("oosW")) + " (" + oosRooms.length + ")</h4>" +
      (oosRooms.length ? '<div class="small">' + oosRooms.map(function(r){ return esc(t("roomW")) + " " + r.number; }).join(", ") + "</div>" : '<p class="small muted">' + esc(t("noTasks")) + "</p>");
    html += "<h4 style='margin:16px 0 4px'>" + esc(t("outstandingCleaning")) + " (" + cleaning.length + ")</h4>" +
      (cleaning.length ? '<div class="small">' + cleaning.map(function(r){ return esc(t("roomW")) + " " + r.number + (r.assignedTo ? " — " + esc(userName(r.assignedTo)) : ""); }).join("<br />") + "</div>" : '<p class="small muted">' + esc(t("noTasks")) + "</p>");
    if (MODE === "demo") html += '<p class="small muted" style="margin-top:12px">Demo data — fictional sample only.</p>';
    $("repBody").innerHTML = html;
    $("btnCsv").style.display = can("reports.csv") ? "" : "none";
  } catch(e){ toast(e.message); }
}
function csvCell(v){
  var s = String(v == null ? "" : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; /* spreadsheet formula protection */
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
async function downloadCSV(){
  if (!requirePerm("reports.csv")) return;
  var date = $("repDate").value || todayStr();
  var res;
  try { res = await fetch("/api/report.csv?date=" + encodeURIComponent(date), {credentials:"same-origin"}); }
  catch(e){ toast(e.message); return; }
  if (!res.ok){ var d = await res.json().catch(function(){ return {}; }); toast(d.error || t("noPermission")); return; }
  await downloadBlobResponse(res, "smallstay-report-" + date + ".csv");
  toast(t("savedOk"));
}
function downloadBlob(text, name, type){
  var blob = new Blob([text], {type: type || "text/plain"});
  var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 400);
}
/* ================= Team / staff management ================= */
async function createStaff(){
  if (!requirePerm("staff.manage")) return;
  var name = $("acName").value.trim(), user = $("acUser").value.trim().toLowerCase(), pin = $("acPin").value, role = $("acRole").value;
  var msg = $("acMsg");
  if (!name || !user || !pin){ msg.textContent = t("fillAll"); return; }
  if (pin.length < 4){ msg.textContent = t("pinShort"); return; }
  if (role === "owner" && currentUser.role !== "owner"){ msg.textContent = t("noPermission"); return; }
  msg.textContent = "";
  try { await api("/api/staff", {method:"POST", body:{name:name, username:user, pin:pin, role:role}}); }
  catch(e){ msg.textContent = e.message; return; }
  $("acName").value = ""; $("acUser").value = ""; $("acPin").value = "";
  saveAndRender(); toast(t("staffCreated"));
}
async function removeStaff(id){
  if (!requirePerm("staff.manage")) return;
  if (id === currentUser.id){ toast(t("noPermission")); return; }
  try { await api("/api/staff/" + id, {method:"DELETE"}); }
  catch(e){ toast(e.message); return; }
  saveAndRender(); toast(t("staffRemoved"));
}
async function setStaffMode(id, mode){
  if (!requirePerm("staff.mode")) return;
  var u = userById(id); if (!u) return;
  if (u.role === "owner" || u.role === "manager"){ toast(t("noPermission")); return; }
  try { await api("/api/staff/" + id + "/mode", {method:"POST", body:{mode:mode}}); }
  catch(e){ toast(e.message); return; }
  saveAndRender(); toast(t("modeSwitched"));
}
function renderTeam(){
  var list = $("accountsList"); if (!list) return;
  $("accountsPanel").classList.toggle("hidden", !can("team.view"));
  $("acFormWrap").classList.toggle("hidden", !can("staff.manage"));
  list.innerHTML = "";
  USERS.forEach(function(u){
    var row = document.createElement("div"); row.className = "itemrow";
    var html = "<h4>" + esc(u.name) + ' <span class="tag tag-grey">' + esc(ROLE_LABELS[u.role] || u.role) + "</span> " +
      '<span class="tag ' + (fullModeFor(u) ? "tag-blue" : "tag-amber") + '">' + esc(fullModeFor(u) ? t("modeFull") : t("modeSimple")) + "</span></h4>";
    html += '<div class="small muted">' + esc(t("username")) + ': <span class="num-ltr">' + esc(u.username) + "</span></div>"; /* server users never carry PIN data */
    row.innerHTML = html;
    var br = document.createElement("div"); br.className = "btnrow";
    if (can("staff.mode") && u.role !== "owner" && u.role !== "manager"){
      var mb = document.createElement("button"); mb.className = "bigbtn btn-ghost btn-sm";
      mb.textContent = u.mode === "full" ? t("switchSimple") : t("switchFull");
      mb.addEventListener("click", function(){ setStaffMode(u.id, u.mode === "full" ? "simple" : "full"); });
      br.appendChild(mb);
    }
    if (can("staff.manage") && u.id !== currentUser.id){
      var rb = document.createElement("button"); rb.className = "bigbtn btn-red btn-sm"; rb.textContent = t("removeAcc");
      rb.addEventListener("click", function(){ removeStaff(u.id); });
      br.appendChild(rb);
    }
    row.appendChild(br);
    list.appendChild(row);
  });
  var tl = $("teamList"); tl.innerHTML = "";
  USERS.forEach(function(u){
    var row = document.createElement("div"); row.className = "itemrow";
    row.innerHTML = "<h4>" + esc(u.name) + "</h4><div class='small'>" + esc(ROLE_LABELS[u.role] || u.role) + " · " + esc(fullModeFor(u) ? t("modeFull") : t("modeSimple")) + "</div>" +
      '<div class="small muted">' + esc(roleSeesText(u.role)) + "</div>";
    tl.appendChild(row);
  });
}
function fullModeFor(u){ return u.role === "owner" || u.role === "manager" || u.mode === "full"; }
function roleSeesText(role){
  return {owner:"Full app — everything, including backup, restore and start fresh.",
    manager:"Full app — everything except start fresh (owner only).",
    supervisor:"Rooms, housekeeping assignment, inspections, maintenance checks and service release, reports. No private guest details or payments.",
    reception:"Reception / Stays — check-in, check-out, guest details for their work.",
    housekeeper:"Simple: my cleaning tasks. Guest names only — no private details.",
    maintenance:"Simple: my repair tickets with big buttons. Guest names only — no private details."}[role] || "";
}

/* ================= Backup / restore ================= */
async function downloadBlobResponse(res, name){
  var blob = await res.blob();
  var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 400);
}
async function doBackup(){
  if (MODE === "demo"){ toast(t("demoDisabled")); return; }
  if (!requirePerm("backup")) return;
  var res;
  try { res = await fetch("/api/backup", {credentials:"same-origin"}); }
  catch(e){ toast(e.message); return; }
  if (!res.ok){ var d = await res.json().catch(function(){ return {}; }); toast(d.error || t("noPermission")); return; }
  await downloadBlobResponse(res, "smallstay-backup-" + todayStr() + ".json");
  toast(t("backupDone"));
}
function handleRestoreFile(file){
  if (MODE === "demo"){ toast(t("demoDisabled")); return; }
  if (!requirePerm("restore")) return;
  var reader = new FileReader();
  reader.onload = function(){
    var payload;
    try { payload = JSON.parse(reader.result); }
    catch(e){ showRestoreError([t("restoreInvalid") + " not JSON."]); return; }
    if (!payload || !payload.db){ showRestoreError([t("restoreInvalid") + " missing data."]); return; }
    pendingRestore = payload;
    $("restoreError").classList.add("hidden");
    $("restoreSummary").textContent = "Backup from " + (payload.exportedAt || "?") + " — " + (payload.db.rooms ? payload.db.rooms.length : 0) + " rooms, " + (payload.db.users ? payload.db.users.length : 0) + " staff, " + (payload.db.stays ? payload.db.stays.length : 0) + " stays, " + (payload.db.tickets ? payload.db.tickets.length : 0) + " tickets.";
    $("restoreConfirm").classList.remove("hidden");
  };
  reader.readAsText(file);
}
function showRestoreError(errs){
  var e = $("restoreError");
  e.textContent = errs.join(" ");
  e.classList.remove("hidden");
  $("restoreConfirm").classList.add("hidden");
  pendingRestore = null;
}
async function confirmRestore(){
  if (!requirePerm("restore")) return;
  if (!pendingRestore) return;
  try { await api("/api/restore", {method:"POST", body:{payload: pendingRestore}}); }
  catch(e){
    var errs = [t("restoreInvalid")];
    if (e.data && Array.isArray(e.data.errors)) errs = errs.concat(e.data.errors.slice(0, 6));
    else errs.push(e.message);
    showRestoreError(errs);
    return;
  }
  pendingRestore = null;
  $("restoreConfirm").classList.add("hidden");
  currentUser = null; MODE = "real"; ME = null;
  toast(t("restoreOk"));
  await refreshEntry(); /* restored accounts differ — sign in again with the backup's accounts */
}
/* ================= Settings renders ================= */
var V3_NOTES_HTML =
"<h4>Completed in SmallStay v1</h4><ul>" +
"<li>Setup Wizard first: hotel name, address, currency (IQD or USD), default price, first guest floor, number of guest floors, rooms per floor. Rooms are numbered by floor from that setup.</li>" +
"<li>Separate Occupancy / Housekeeping / Inspection / Service fields on every room. Ready = Vacant + Clean + Inspection Passed + In service. No manual “make ready”. Fresh installs start as Awaiting inspection.</li>" +
"<li>Permissions enforced inside every action (staff creation/removal, room types, check-in/out, inspection, ticket close, service release, pricing, backup, restore, reset) — not just hidden buttons.</li>" +
"<li>Demo is fully separate fictional data in its own memory: demo backup/restore/reset are disabled and can never touch real data. Demo occupancy is consistent — every occupied demo room has a matching active stay.</li>" +
"<li>PINs are salted SHA-256 hashes, never plaintext, never shown in lists, reports or CSV. No default credentials; the owner creates their own account on first use.</li>" +
"<li>Online version: data is saved on the server and works on any device. There is no app file to download.</li>" +
"<li>Check-in: main guest name/ID required, contact/car optional; “Add another guest” rows (name + ID required, removable, automatic count); typed input survives validation errors; readiness is rechecked at save; duplicate active stays blocked.</li>" +
"<li>Stays record check-in timestamp, planned departure, check-out timestamp, nights, agreed base price, guest-pays % and final total, and the staff member for each operation. Price changes never rewrite old stays.</li>" +
"<li>Reception / Stays module: current + checked-out stays, search by room/guest/date, overdue stays highlighted.</li>" +
"<li>Daily Report rebuilt: check-ins on the date, check-outs on the date, rooms occupied during that night, current live occupancy, and one-night-per-room revenue — multi-night totals are never labeled as one day's revenue. Historical room counts come only from SmallStay daily snapshots; older dates say so instead of inventing numbers. CSV export escapes correctly and prefixes formula-like cells.</li>" +
"<li>Housekeeping: tasks assigned by stable staff ID, assign/reassign by Owner/Manager/Supervisor, checklist progress is saved with the room and survives reopening. Finish → Awaiting inspection; Fail → back to cleaning.</li>" +
"<li>Maintenance: big-button flow (Working on it / Fixed / Out of service / Needs parts). Fixed → waiting for check; only Supervisor/Manager/Owner close or send back. Service release checks other unresolved blocking tickets. Every change is logged with time and staff.</li>" +
"<li>Staff modes: Owner/Manager always Full; workers start Simple; only Owner/Manager switch a worker's mode, saved per account. Simple mode keeps the worker's own tasks first, with a View-all-rooms screen.</li>" +
"<li>Privacy: Housekeeping/Maintenance see guest names only; Supervisor sees operational info without private details or payments — applied on screens, room details, reports and CSV.</li>" +
"<li>Saving: every save is checked; a red warning banner appears if a write fails. Damaged saved data is never auto-overwritten — recovery options are offered. Backup files are versioned and fully validated before restore; invalid backups are rejected without changing current data. SmallStay backups only — SmallStay SmallStay v1 backups are not imported.</li>" +
"<li>Languages: English, Arabic and Sorani Kurdish from one dictionary, with RTL layout; language choice is saved; room numbers, phones, IDs and amounts stay left-to-right. Guest-entered names/IDs are never translated.</li>" +
"</ul>" +
"<h4>Backup &amp; first use — simple steps</h4><ol>" +
"<li>First use: run the Setup Wizard, then create your owner username and PIN. There is no default password.</li>" +
"<li>Backup: sign in as Owner/Manager → Settings → Download backup. Keep the file safe.</li>" +
"<li>Restore: sign in as Owner/Manager → Settings → Restore from backup → confirm. Then sign in with the accounts from the backup.</li>" +
"</ol>" +
"<h4>Honest limitations of this online version</h4><ul>" +
"<li>Data lives on the server. If the server is down or you have no internet, you cannot open the app — but your data is still safe on the server.</li>" +
"<li>Permissions and hashed PINs are checked on the server, but anyone who knows a PIN can sign in as that person — keep PINs private and give each worker their own account.</li>" +
"<li>Clearing this browser's data does not erase hotel data (it is on the server), but you will need to sign in again.</li>" +
"<li>No Booking.com / channel-manager sync, no online guest booking page. Floors and room numbers are fixed by the Setup Wizard — changing them means starting fresh (back up first).</li>" +
"</ul>";
function renderSettings(){
  if (DB) $("setPrice").value = DB.price;
  var fsEl = document.querySelector('[data-i18n="floorStructureB"]');
  if (fsEl) fsEl.textContent = floorStructureText();
  var aboutEl = $("aboutHotelLine");
  if (aboutEl && DB && DB.config) aboutEl.textContent = hotelName() + (hotelAddress() ? " — " + hotelAddress() : "") + " · " + configTotal(DB.config) + " rooms · " + cur() + " " + fmt(DB.price) + " / night" + (DB.startedAt ? " · " + esc(t("usingSince")) + " " + dateOf(DB.startedAt) : "");
  var ppEl = document.querySelector('[data-i18n="pricePerNight"]');
  if (ppEl) ppEl.textContent = t("pricePerNight") + " (" + cur() + ")";
  $("freshPanel").classList.toggle("hidden", !(MODE === "real" && currentUser && currentUser.role === "owner"));
  $("backupPanel").style.opacity = MODE === "demo" ? ".55" : "1";
  $("pricePanel").classList.toggle("hidden", !can("price.change"));
  var mi = $("migrationInfo");
  if (DB.migrationNotes && DB.migrationNotes.length && MODE === "real"){
    mi.innerHTML = '<div class="warnpanel">Migration notes:<br />' + DB.migrationNotes.map(esc).join("<br />") + "</div>";
  } else mi.innerHTML = "";
  $("v3Notes").innerHTML = V3_NOTES_HTML;
}
async function savePrice(){
  if (!requirePerm("price.change")) return;
  var v = parseInt($("setPrice").value, 10);
  if (isNaN(v) || v < 0){ toast(t("errPct")); return; }
  try { await api("/api/settings/price", {method:"POST", body:{price:v}}); }
  catch(e){ toast(e.message); return; }
  saveAndRender(); toast(t("priceSaved"));
}
/* ================= Easy (Simple) mode ================= */
function renderEasy(){
  var role = currentUser.role;
  $("easyTitle").textContent = currentUser.name + " — " + (ROLE_LABELS[role] || role);
  var body = $("easyBody"); body.innerHTML = "";
  if (role === "housekeeper"){
    $("easySub").textContent = t("hkSub");
    var tasks = rooms.filter(function(r){ return (r.hk === "dirty" || r.hk === "cleaning") && (r.assignedTo === currentUser.id || !r.assignedTo); });
    if (!tasks.length) body.innerHTML = '<div class="emptybox">' + esc(t("noTasks")) + "</div>";
    tasks.forEach(function(r){ body.appendChild(hkCard(r, true)); });
  }
  else if (role === "maintenance"){
    $("easySub").textContent = t("ticketsSub");
    var wrap = document.createElement("div");
    wrap.innerHTML = '<div class="small" style="font-weight:700">1 — ' + esc(t("roomW")) + '</div>' +
      '<select id="ezDmgRoom" style="width:100%;max-width:430px;margin:6px 0 12px">' +
      rooms.map(function(r){ return '<option value="' + r.number + '"' + (dmg.room === r.number ? " selected" : "") + ">Room " + r.number + "</option>"; }).join("") + "</select>" +
      '<div class="small" style="font-weight:700">2 — ' + esc(t("problemW")) + '</div><div class="pickrow" id="ezDmgTypes"></div>' +
      '<div class="small" style="font-weight:700">3 — ' + esc(t("priorityW")) + '</div><div class="pickrow" id="ezDmgPrio"></div>' +
      '<input id="ezDmgNote" type="text" style="width:100%" placeholder="' + esc(t("noteOpt")) + '" value="' + esc(dmg.noteEz || "") + '" />';
    var rb = document.createElement("button"); rb.className = "bigbtn btn-red"; rb.style.marginTop = "12px"; rb.textContent = t("reportBtn");
    rb.addEventListener("click", function(){
      var sel = $("ezDmgRoom"), note = $("ezDmgNote");
      dmg.room = sel ? parseInt(sel.value, 10) : null;
      reportTicketEasy(note ? note.value : "");
    });
    wrap.appendChild(rb);
    body.appendChild(wrap);
    var ezNote = $("ezDmgNote");
    if (ezNote) ezNote.addEventListener("input", function(){ dmg.noteEz = this.value; });
    function ezPicks(){
      pickRow("ezDmgTypes", TICKET_TYPES, function(){ return dmg.type; }, function(v){ dmg.type = v; ezPicks(); });
      pickRow("ezDmgPrio", TICKET_PRIOS, function(){ return dmg.prio; }, function(v){ dmg.prio = v; ezPicks(); });
    }
    ezPicks();
    var mine = tickets.filter(function(x){ return x.status !== "closed" && x.status !== "check" && (x.assigneeId === currentUser.id || !x.assigneeId); });
    if (!mine.length) body.innerHTML += '<div class="emptybox">' + esc(t("noTasks")) + "</div>";
    mine.forEach(function(x){ body.appendChild(ticketCard(x, {})); });
  }
  else if (role === "supervisor"){
    $("easySub").textContent = t("inspSub");
    var list = rooms.filter(function(r){ return r.hk === "clean" && r.insp !== "passed"; });
    if (!list.length) body.innerHTML = '<div class="emptybox">' + esc(t("noTasks")) + "</div>";
    list.forEach(function(r){
      var row = document.createElement("div"); row.className = "itemrow";
      row.innerHTML = "<h4>" + esc(t("roomW")) + ' <span class="num-ltr">' + r.number + "</span></h4><div class='small muted'>" + esc(roomStatusLine(r)) + "</div>";
      var br = document.createElement("div"); br.className = "btnrow";
      var pb = document.createElement("button"); pb.className = "bigbtn btn-green"; pb.textContent = t("passBtn");
      pb.addEventListener("click", function(){ inspectRoom(r.number, true); });
      var fb = document.createElement("button"); fb.className = "bigbtn btn-amber"; fb.textContent = t("failBtn");
      fb.addEventListener("click", function(){ inspectRoom(r.number, false); });
      br.appendChild(pb); br.appendChild(fb); row.appendChild(br); body.appendChild(row);
    });
    var checks = tickets.filter(function(x){ return x.status === "check"; });
    if (checks.length){
      var h = document.createElement("h4"); h.textContent = t("repairsCheck"); h.style.margin = "16px 0 4px"; body.appendChild(h);
      checks.forEach(function(x){ body.appendChild(ticketCard(x, {checkMode:true})); });
    }
    var oosRooms = rooms.filter(function(r){ return r.access === "out"; });
    oosRooms.forEach(function(r){
      var blockers = tickets.filter(function(x){ return x.room === r.number && x.status !== "closed" && x.blocking; });
      var row2 = document.createElement("div"); row2.className = "itemrow";
      row2.innerHTML = "<h4>" + esc(t("roomW")) + ' <span class="num-ltr">' + r.number + "</span> — " + esc(t("stOos")) + "</h4>" + (blockers.length ? '<div class="small errtext">' + esc(t("releaseBlocked")) + "</div>" : "");
      var b = document.createElement("button"); b.className = "bigbtn btn-green"; b.textContent = t("releaseBtn"); b.disabled = blockers.length > 0;
      b.addEventListener("click", function(){ releaseRoom(r.number); });
      row2.appendChild(b); body.appendChild(row2);
    });
  }
  else if (role === "reception"){
    $("easySub").textContent = t("readyOnly");
    renderEasyReception(body);
  }
  else {
    $("easySub").textContent = "";
    body.innerHTML = '<div class="emptybox">' + esc(t("noTasks")) + "</div>";
  }
}
async function reportTicketEasy(noteVal){
  if (!requirePerm("ticket.report")) return;
  if (!dmg.room || !dmg.type || !dmg.prio){ toast("Pick a room, a problem and a priority first."); return; }
  try {
    await api("/api/tickets", {method:"POST", body:{room:dmg.room, type:dmg.type, prio:dmg.prio, note: noteVal || ""}});
  } catch(e){ toast(e.message); return; }
  dmg.type = null; dmg.prio = null; dmg.noteEz = "";
  saveAndRender(); toast(t("reportFiled"));
}
/* v1.7: available (Ready) rooms, grouped by floor with floor numbers.
   Tapping a room picks it in the check-in form. */
function availableRoomsHTML(){
  var ready = rooms.filter(isReady);
  if (!ready.length) return '<div class="emptybox">' + esc(t("noReadyRooms")) + "</div>";
  var byFloor = {};
  ready.forEach(function(r){ (byFloor[r.floor] = byFloor[r.floor] || []).push(r); });
  var h = '<h4 style="margin:12px 0 4px">' + esc(t("availableRooms")) + "</h4>";
  Object.keys(byFloor).sort(function(a, b){ return a - b; }).forEach(function(f){
    h += '<div class="small" style="font-weight:700;margin:8px 0 4px">' + esc(t("floor")) + " " + f + "</div>";
    h += '<div class="roomgrid">';
    byFloor[f].forEach(function(r){
      h += '<button type="button" class="roomcard st-ready" data-pickroom="' + r.number + '"><span class="rnum num-ltr">' + r.number + '</span><div class="line small">' + esc(t("floor")) + " " + r.floor + " · " + esc(r.type || t("typeToConfirm")) + '</div><div class="canbook">' + esc(t("stReady")) + "</div></button>";
    });
    h += "</div>";
  });
  return h;
}
function wirePickRooms(host, selectId, calcPrefix){
  host.querySelectorAll("[data-pickroom]").forEach(function(b){
    b.addEventListener("click", function(){
      var sel = $(selectId); if (sel) sel.value = b.getAttribute("data-pickroom");
      updateCalc(calcPrefix);
    });
  });
}
function renderEasyReception(body){
  var ready = rooms.filter(isReady);
  var html = '<p><span class="tag tag-green">Ready rooms: ' + ready.length + "</span></p>";
  html += availableRoomsHTML();
  html += '<div class="formgrid"><label>' + esc(t("roomReadyOnly")) + '<select id="ezRoom">' +
    ready.map(function(r){ return '<option value="' + r.number + '">Room ' + r.number + " — " + esc(t("floor")) + " " + r.floor + " — " + esc(r.type || t("typeToConfirm")) + "</option>"; }).join("") + "</select></label>" +
    '<label>' + esc(t("nights")) + '<input id="ezNights" type="number" min="1" value="1" /></label>' +
    '<label>' + esc(t("departDate")) + '<input id="ezDepart" type="date" /></label>' +
    '<label>' + esc(t("guestPaysPct")) + '<input id="ezPct" type="number" min="0" max="100" value="100" /></label></div>';
  html += '<h4 style="margin:12px 0 4px">' + esc(t("mainGuest")) + '</h4><div id="ezGuestFields">' + guestFieldsHTML("ez") + "</div>";
  html += '<p class="small errtext hidden" id="ezError"></p><div class="calcbox" id="ezCalc"></div>';
  html += '<button class="bigbtn btn-teal" id="ezCheckIn" style="width:100%">' + esc(t("checkIn")) + "</button>";
  html += '<h4 style="margin:18px 0 6px">' + esc(t("inHouse")) + '</h4><div id="ezInHouse"></div>';
  body.innerHTML = html;
  wirePickRooms(body, "ezRoom", "ez");
  initGuestFields("ez");
  ["ezRoom","ezNights","ezPct"].forEach(function(id){ $(id).addEventListener("input", function(){ updateCalc("ez"); }); });
  $("ezDepart").addEventListener("change", function(){ this.dataset.touched = "1"; });
  updateCalc("ez");
  $("ezCheckIn").addEventListener("click", async function(){
    var g = readGuests("ez");
    var err = $("ezError");
    if (g.error){ err.textContent = g.error; err.classList.remove("hidden"); return; }
    err.classList.add("hidden");
    await doCheckIn(parseInt($("ezRoom").value, 10), $("ezNights").value, $("ezPct").value, $("ezDepart").value, g.guests, "ezError");
  });
  var ih = $("ezInHouse");
  var list = stays.filter(function(s){ return s.status === "in"; });
  if (!list.length) ih.innerHTML = '<div class="emptybox">' + esc(t("noTasks")) + "</div>";
  list.forEach(function(s){ ih.appendChild(stayRowHTML(s, true)); });
}
function renderAllRooms(){
  var host = $("arFloors"); host.innerHTML = "";
  getFloors().forEach(function(f){
    var b = document.createElement("button"); b.className = "pickbtn" + (arFloor === f.n ? " sel" : "");
    b.textContent = t("floor") + " " + f.n;
    b.addEventListener("click", function(){ arFloor = f.n; renderAllRooms(); });
    host.appendChild(b);
  });
  var area = $("arArea"); area.innerHTML = "";
  if (arFloor === null){ area.innerHTML = '<div class="emptybox">' + esc(t("allRoomsSub")) + "</div>"; return; }
  var grid = document.createElement("div"); grid.className = "roomgrid";
  rooms.filter(function(r){ return r.floor === arFloor; }).forEach(function(r){
    var stay = activeStayForRoom(r.number);
    var card = document.createElement("div"); card.className = "roomcard " + roomState(r).cls;
    card.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center"><span class="rnum num-ltr">' + r.number + '</span><span class="tag ' + roomState(r).tag + '">' + esc(roomState(r).label) + '</span></div>' +
      '<div class="line small">' + esc(r.type || t("typeToConfirm")) + "</div>" +
      '<div class="line small">' + esc(roomStatusLine(r)) + "</div>" +
      (stay ? '<div class="line small">' + esc(guestsPublicHTML(stay)) + "</div>" : "");
    grid.appendChild(card);
  });
  area.appendChild(grid);
}

/* ================= Render root ================= */
function renderAll(){
  if (!currentUser) return;
  updateModeUI();
  buildNav();
  $("viewTitle").textContent = t(TITLES[currentView] || "nav_dashboard");
  applyLang();
  if (currentView === "dashboard" && can("dashboard")) renderDashboard();
  if (currentView === "rooms") renderRooms();
  if (currentView === "housekeeping") renderHousekeeping();
  if (currentView === "inspections") renderInspections();
  if (currentView === "maintenance") renderMaintenance();
  if (currentView === "checkin") renderCheckin();
  if (currentView === "reports") renderReports();
  if (currentView === "team") renderTeam();
  if (currentView === "settings") renderSettings();
  if (currentView === "easy") renderEasy();
  if (currentView === "allrooms") renderAllRooms();
}
/* ================= Wiring ================= */
function wire(){
  document.querySelectorAll(".langbtn").forEach(function(b){
    b.addEventListener("click", function(){ setLang(b.getAttribute("data-lang")); });
  });
  $("btnWizard").addEventListener("click", doWizard);
  $("wzCurrency").addEventListener("change", function(){
    var p = $("wzPrice");
    if (this.value === "USD" && p.value === "50000") p.value = "50";
    if (this.value === "IQD" && p.value === "50") p.value = "50000";
  });
  $("btnSetup").addEventListener("click", doSetup);
  $("btnSignin").addEventListener("click", doSignin);
  $("siPin").addEventListener("keydown", function(e){ if (e.key === "Enter") doSignin(); });
  $("btnDemo").addEventListener("click", function(){ enterDemo("owner"); });
  var dt = $("btnDemoToggle"); if (dt) dt.addEventListener("click", function(){ $("demoBox").classList.remove("hidden"); dt.classList.add("hidden"); });
  var gt = $("btnGoTeam"); if (gt) gt.addEventListener("click", function(){ showView("team"); });
  document.querySelectorAll(".rolebtn").forEach(function(b){
    b.addEventListener("click", function(){ enterDemo(b.getAttribute("data-role")); });
  });
  $("btnExit").addEventListener("click", exitToEntry);
  $("btnExitDemo").addEventListener("click", exitToEntry);
  /* sign-in recovery reset (owner must be signed in — see eraseAllRealData) */
  $("btnRecoveryToggle").addEventListener("click", function(){ $("recoveryBox").classList.toggle("hidden"); });
  $("btnRecoverySure").addEventListener("click", function(){ $("recoveryStep2").classList.remove("hidden"); });
  $("recoveryText").addEventListener("input", function(){
    var ok = this.value.trim().toUpperCase() === "DELETE";
    $("btnRecoveryErase").disabled = !ok; $("btnRecoveryErase").style.opacity = ok ? "1" : ".5";
  });
  $("btnRecoveryErase").addEventListener("click", function(){
    if ($("recoveryText").value.trim().toUpperCase() !== "DELETE") return;
    eraseAllRealData();
  });
  /* rooms */
  $("fType").addEventListener("change", renderAll);
  $("fStatus").addEventListener("change", renderAll);
  $("fSearch").addEventListener("input", renderRooms);
  $("btnShowAllFloors").addEventListener("click", function(){ showAll = true; selectedFloor = null; renderAll(); });
  $("btnClearFloor").addEventListener("click", function(){ showAll = true; selectedFloor = null; renderAll(); }); /* v1.7: clear = show all */
  /* maintenance report form */
  $("dmgRooms").addEventListener("change", function(){ dmg.room = parseInt(this.value, 10); });
  $("btnReportDmg").addEventListener("click", reportTicket);
  /* check-in board */
  ["ciRoom","ciNights","ciPct"].forEach(function(id){ $(id).addEventListener("input", function(){ updateCalc("ci"); }); });
  $("ciDepart").addEventListener("change", function(){ this.dataset.touched = "1"; });
  $("btnCheckIn").addEventListener("click", async function(){
    var g = readGuests("ci");
    var err = $("ciError");
    if (g.error){ err.textContent = g.error; err.classList.remove("hidden"); return; }
    err.classList.add("hidden");
    var ok = await doCheckIn(parseInt($("ciRoom").value, 10), $("ciNights").value, $("ciPct").value, $("ciDepart").value, g.guests, "ciError");
    if (ok) clearGuestFields("ci");
  });
  /* stays search */
  $("staySearch").addEventListener("input", renderStays);
  $("stayDate").addEventListener("change", renderStays);
  $("stayFilter").addEventListener("change", renderStays);
  /* reports */
  $("repDate").addEventListener("change", renderReports);
  $("btnCsv").addEventListener("click", downloadCSV);
  /* team */
  $("btnAddStaff").addEventListener("click", createStaff);
  /* settings */
  $("btnSavePrice").addEventListener("click", savePrice);
  $("btnBackup").addEventListener("click", doBackup);
  $("restoreFile").addEventListener("change", function(){ if (this.files && this.files[0]) handleRestoreFile(this.files[0]); this.value = ""; });
  $("btnRestoreYes").addEventListener("click", confirmRestore);
  $("btnRestoreNo").addEventListener("click", function(){ pendingRestore = null; $("restoreConfirm").classList.add("hidden"); });
  $("btnFreshStart").addEventListener("click", function(){
    if (!(MODE === "real" && currentUser && currentUser.role === "owner")){ toast(t("noPermission")); return; }
    $("freshConfirm").classList.remove("hidden");
  });
  $("btnFreshSure").addEventListener("click", function(){ $("freshStep2").classList.remove("hidden"); });
  $("freshText").addEventListener("input", function(){
    var ok = this.value.trim().toUpperCase() === "DELETE";
    $("btnFreshErase").disabled = !ok; $("btnFreshErase").style.opacity = ok ? "1" : ".5";
  });
  $("btnFreshErase").addEventListener("click", function(){
    if (!(MODE === "real" && currentUser && currentUser.role === "owner")){ toast(t("noPermission")); return; }
    if ($("freshText").value.trim().toUpperCase() !== "DELETE") return;
    eraseAllRealData();
  });
  /* easy / all rooms */
  $("btnEasyRooms").addEventListener("click", function(){ showView("allrooms"); });
  $("btnBackEasy").addEventListener("click", function(){ showView("easy"); });
  /* modal */
  $("rmClose").addEventListener("click", function(){ $("roomModal").classList.add("hidden"); });
  $("roomModal").addEventListener("click", function(e){ if (e.target === this) this.classList.add("hidden"); });
  document.addEventListener("keydown", function(e){ if (e.key === "Escape") $("roomModal").classList.add("hidden"); });
}
/* ================= Init ================= */
wire();
applyLang();
refreshEntry();
