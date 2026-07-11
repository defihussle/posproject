require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

const app = express();
const PORT = process.env.PORT || 4000;

// --------------- Middleware ---------------
app.use(cors());
app.use(express.json());

// --------------- Postgres pool ---------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// --------------- Rate limiter (PIN-guessing protection) ---------------
// Tracks failed login attempts per IP. After 5 failures within 60s,
// the IP is blocked for 30s before it can try again.
const loginAttempts = new Map(); // key: IP, value: { count, firstAttempt, blockedUntil }

function checkRateLimit(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);

  if (!record) return { allowed: true };

  // Currently blocked?
  if (record.blockedUntil && now < record.blockedUntil) {
    const retryAfter = Math.ceil((record.blockedUntil - now) / 1000);
    return { allowed: false, retryAfter };
  }

  // Window expired — reset
  if (now - record.firstAttempt > 60_000) {
    loginAttempts.delete(ip);
    return { allowed: true };
  }

  // Under the limit?
  if (record.count < 5) return { allowed: true };

  // Just hit the limit — start 30s block
  record.blockedUntil = now + 30_000;
  const retryAfter = 30;
  return { allowed: false, retryAfter };
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);

  if (!record || now - record.firstAttempt > 60_000) {
    loginAttempts.set(ip, { count: 1, firstAttempt: now, blockedUntil: null });
  } else {
    record.count += 1;
  }
}

function clearAttempts(ip) {
  loginAttempts.delete(ip);
}

// --------------- Routes ---------------

// Health check — verifies DB connectivity
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", db: "connected" });
  } catch (err) {
    console.error("Health check failed:", err.message);
    res.status(503).json({ status: "error", db: "disconnected" });
  }
});

// Menu items
app.get("/api/menu", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM menu_items ORDER BY sort_order, name");
    res.json(rows);
  } catch (err) {
    console.error("Failed to fetch menu items:", err.message);
    res.status(500).json({ error: "Failed to fetch menu items" });
  }
});

// PIN login
app.post("/api/auth/login", async (req, res) => {
  const ip = req.ip;

  // Rate-limit check
  const rateCheck = checkRateLimit(ip);
  if (!rateCheck.allowed) {
    return res.status(429).json({
      success: false,
      message: "Too many failed attempts. Try again shortly.",
      retryAfter: rateCheck.retryAfter,
    });
  }

  const { pin } = req.body;
  if (!pin || typeof pin !== "string") {
    return res.status(400).json({ success: false, message: "PIN is required" });
  }

  try {
    // Fetch all active staff with their hashed PINs
    const { rows } = await pool.query(
      "SELECT id, name, role, location_id, pin_hash FROM staff WHERE active = true"
    );

    // Compare submitted PIN against each hash
    let matchedStaff = null;
    for (const staff of rows) {
      const isMatch = await bcrypt.compare(pin, staff.pin_hash);
      if (isMatch) {
        matchedStaff = staff;
        break;
      }
    }

    if (!matchedStaff) {
      recordFailedAttempt(ip);
      return res.status(401).json({ success: false, message: "PIN not recognized" });
    }

    // Success — clear rate-limit record for this IP
    clearAttempts(ip);

    // Return staff info WITHOUT pin_hash
    const { pin_hash, ...staffData } = matchedStaff;
    return res.json({ success: true, staff: staffData });
  } catch (err) {
    console.error("Login error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// --------------- Start server ---------------
app.listen(PORT, () => {
  console.log(`Narcos Tacos POS API running on http://localhost:${PORT}`);
});
