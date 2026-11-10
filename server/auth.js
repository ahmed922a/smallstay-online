"use strict";
// Auth: bcrypt PIN hashing (cost 10), session cookies, login rate limiting.
// No PINs, tokens or guest data are ever logged.

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { can, canSeePrivate, fullMode } = require("./constants");

const BCRYPT_COST = 10;

function hashPin(pin) {
  return bcrypt.hashSync(pin, BCRYPT_COST);
}

// Verify a PIN against a user record. Supports bcrypt pinHash (current) and
// the legacy v1.7 salted SHA-256 cred object (restored v1.7 backups only).
function verifyPin(user, pin) {
  if (!user || typeof pin !== "string") return false;
  if (user.pinHash) {
    try { return bcrypt.compareSync(pin, user.pinHash); } catch (_) { return false; }
  }
  if (user.cred && user.cred.salt && user.cred.hash) {
    const h = crypto.createHash("sha256").update(user.cred.salt + "::" + pin + "::smallstay-v1").digest("hex");
    return h === user.cred.hash;
  }
  return false;
}

function uid(prefix) {
  return prefix + "_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1e6).toString(36);
}

// --- Cookie parsing (manual; no extra dependency) ---
function parseCookies(req) {
  const out = {};
  const header = req.headers && req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function sessionCookieHeader(token, { clear = false } = {}) {
  const secure = process.env.NODE_ENV === "production";
  if (clear) return "ss_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax" + (secure ? "; Secure" : "");
  return "ss_session=" + encodeURIComponent(token) + "; HttpOnly; Path=/; Max-Age=" + (7 * 24 * 60 * 60) + "; SameSite=Lax" + (secure ? "; Secure" : "");
}

// --- Login rate limit: max 10 failed attempts per 15 minutes,
// tracked separately per IP and per username. 429 after that.
// A successful login resets the counters for that IP + username.
// One limiter instance per app (createRateLimiter), so test servers
// with fresh state do not share failure counters.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED = 10;
function createRateLimiter() {
  const failures = new Map(); // key -> [timestamps]
  function prune(key) {
    const now = Date.now();
    const arr = (failures.get(key) || []).filter((t) => now - t < WINDOW_MS);
    failures.set(key, arr);
    return arr;
  }
  return {
    isRateLimited(ip, username) {
      const byIp = prune("ip:" + ip);
      const byUser = username ? prune("user:" + String(username).toLowerCase()) : [];
      return byIp.length >= MAX_FAILED || byUser.length >= MAX_FAILED;
    },
    recordFailedLogin(ip, username) {
      const now = Date.now();
      const ipArr = prune("ip:" + ip); ipArr.push(now); failures.set("ip:" + ip, ipArr);
      if (username) {
        const uArr = prune("user:" + String(username).toLowerCase());
        uArr.push(now); failures.set("user:" + String(username).toLowerCase(), uArr);
      }
    },
    resetLoginFailures(ip, username) {
      failures.delete("ip:" + ip);
      if (username) failures.delete("user:" + String(username).toLowerCase());
    },
  };
}

module.exports = {
  BCRYPT_COST, hashPin, verifyPin, uid,
  parseCookies, sessionCookieHeader,
  createRateLimiter,
  can, canSeePrivate, fullMode,
};
