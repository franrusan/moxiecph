require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const path = require("path");
const helmet = require("helmet");
const expressBasicAuth = require("express-basic-auth");
const { body, query, validationResult } = require("express-validator");
const rateLimit = require("express-rate-limit");

// ─── App Setup ────────────────────────────────────────────────────────────────

const app = express();
app.set("trust proxy", 1);
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || "https://moxiecph-front.onrender.com",
  methods: ["GET", "POST", "OPTIONS"],
}));
app.use(express.json());

// ─── Database ─────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: true } : false,
});

// ─── Config ───────────────────────────────────────────────────────────────────

const MAX_TOTAL         = Number(process.env.MAX_TOTAL          || 50);
const MAX_PER_SLOT      = Number(process.env.MAX_PER_SLOT       || 30);
const DURATION_MINUTES  = Number(process.env.DURATION_MINUTES   || 120);
const SLOT_START_HOUR   = Number(process.env.SLOT_START_HOUR    || 17);
const SLOT_END_HOUR     = Number(process.env.SLOT_END_HOUR      || 23);

// ─── Rate Limiting ────────────────────────────────────────────────────────────

const reservationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { error: "Too many reservation attempts. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: "Too many requests. Please slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/availability", apiLimiter);
app.use("/reservations", reservationLimiter);

// ─── Admin Auth ───────────────────────────────────────────────────────────────

const adminAuth = expressBasicAuth({
  users: { [process.env.ADMIN_USER]: process.env.ADMIN_PASS },
  challenge: true,
  realm: "Admin",
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateSlots() {
  const slots = [];
  for (let h = SLOT_START_HOUR; h <= SLOT_END_HOUR; h++) {
    slots.push(`${String(h).padStart(2, "0")}:00`);
    if (h !== SLOT_END_HOUR) slots.push(`${String(h).padStart(2, "0")}:30`);
  }
  return slots;
}

const ALL_SLOTS = generateSlots();
const VALID_SLOT_SET = new Set(ALL_SLOTS);

function timeToMinutes(t) {
  const [hh, mm] = t.split(":").map(Number);
  return hh * 60 + mm;
}

function roundUpToNextHalfHour(minutes) {
  return Math.ceil(minutes / 30) * 30;
}

function getTodayString() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: "Invalid input.", details: errors.array() });
  }
  next();
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Admin page
app.get("/admin_page", adminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "admin_page.html"));
});

// Health check
app.get("/health", async (_req, res) => {
  try {
    const r = await pool.query("SELECT 1 AS ok");
    res.json({ ok: true, db: r.rows[0].ok === 1 });
  } catch {
    res.status(500).json({ ok: false });
  }
});

// GET /availability?date=YYYY-MM-DD&people=N
app.get(
  "/availability",
  [
    query("date")
      .matches(/^\d{4}-\d{2}-\d{2}$/)
      .withMessage("date must be in YYYY-MM-DD format"),
    query("people")
      .isInt({ min: 1, max: MAX_PER_SLOT })
      .withMessage(`people must be an integer between 1 and ${MAX_PER_SLOT}`),
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { date } = req.query;
      const ppl = Number(req.query.people);

      const { rows } = await pool.query(
        `SELECT to_char(res_time, 'HH24:MI') AS t, COALESCE(SUM(people), 0)::int AS total
         FROM reservations
         WHERE res_date = $1
         GROUP BY t`,
        [date]
      );

      const sumByTime = new Map(rows.map(r => [r.t, r.total]));

      let available = ALL_SLOTS.filter((slot) => {
        const slotBooked = sumByTime.get(slot) || 0;
        if (slotBooked + ppl > MAX_PER_SLOT) return false;

        const candStart = timeToMinutes(slot);
        const candEnd = candStart + DURATION_MINUTES;

        let overlappingBooked = 0;
        for (const t of ALL_SLOTS) {
          const start = timeToMinutes(t);
          const end = start + DURATION_MINUTES;
          if (start < candEnd && end > candStart) {
            overlappingBooked += sumByTime.get(t) || 0;
          }
        }

        return overlappingBooked + ppl <= MAX_TOTAL;
      });

      // Filter out past slots if booking for today
      if (date === getTodayString()) {
        const now = new Date();
        const nowMinutes = now.getHours() * 60 + now.getMinutes();
        const cutoff = roundUpToNextHalfHour(nowMinutes);
        available = available.filter(t => timeToMinutes(t) >= cutoff);
      }

      return res.json({
        date,
        people: ppl,
        maxPerSlot: MAX_PER_SLOT,
        maxTotal: MAX_TOTAL,
        durationMinutes: DURATION_MINUTES,
        available,
      });
    } catch (err) {
      console.error("GET /availability error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

// POST /reservations
app.post(
  "/reservations",
  [
    body("firstName")
      .trim()
      .notEmpty()
      .isLength({ max: 100 })
      .withMessage("firstName is required (max 100 chars)"),
    body("lastName")
      .trim()
      .notEmpty()
      .isLength({ max: 100 })
      .withMessage("lastName is required (max 100 chars)"),
    body("email")
      .trim()
      .isEmail()
      .normalizeEmail()
      .withMessage("A valid email address is required"),
    body("people")
      .isInt({ min: 1, max: MAX_PER_SLOT })
      .withMessage(`people must be between 1 and ${MAX_PER_SLOT}`),
    body("date")
      .matches(/^\d{4}-\d{2}-\d{2}$/)
      .withMessage("date must be in YYYY-MM-DD format"),
    body("time")
      .custom(val => VALID_SLOT_SET.has(val))
      .withMessage("time must be a valid reservation slot"),
  ],
  handleValidationErrors,
  async (req, res) => {
    const { firstName, lastName, email, date, time } = req.body;
    const ppl = Number(req.body.people);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");

      // Check per-slot capacity
      const slotRes = await client.query(
        `SELECT COALESCE(SUM(people), 0)::int AS total
         FROM reservations
         WHERE res_date = $1 AND res_time = $2::time`,
        [date, time]
      );
      if (slotRes.rows[0].total + ppl > MAX_PER_SLOT) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: `This time slot is full (max ${MAX_PER_SLOT} guests).` });
      }

      // Check restaurant-wide overlapping window capacity
      const winRes = await client.query(
        `SELECT COALESCE(SUM(people), 0)::int AS total
         FROM reservations
         WHERE res_date = $1
           AND res_time < ($2::time + make_interval(mins => $3))
           AND (res_time + make_interval(mins => $3)) > $2::time`,
        [date, time, DURATION_MINUTES]
      );
      if (winRes.rows[0].total + ppl > MAX_TOTAL) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: `The restaurant is fully booked during this period (max ${MAX_TOTAL} guests).` });
      }

      const ins = await client.query(
        `INSERT INTO reservations (first_name, last_name, email, people, res_date, res_time)
         VALUES ($1, $2, $3, $4, $5, $6::time)
         RETURNING id, created_at`,
        [firstName, lastName, email, ppl, date, time]
      );

      await client.query("COMMIT");
      return res.status(201).json({
        ok: true,
        reservationId: ins.rows[0].id,
        createdAt: ins.rows[0].created_at,
      });
    } catch (err) {
      await client.query("ROLLBACK");

      // Postgres serialization failure — safe to retry
      if (err.code === "40001") {
        return res.status(409).json({
          error: "Booking conflict detected. Please try again.",
          retryable: true,
        });
      }

      console.error("POST /reservations error:", err);
      return res.status(500).json({ error: "Failed to save reservation." });
    } finally {
      client.release();
    }
  }
);

// GET /admin/api/summary?date=YYYY-MM-DD
app.get("/admin/api/summary", adminAuth, async (req, res) => {
  try {
    const { date } = req.query;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "date is required (YYYY-MM-DD)" });
    }

    const q = await pool.query(
      `SELECT
         to_char(res_time, 'HH24:MI') AS time,
         COALESCE(SUM(people), 0)::int AS total_people,
         COALESCE(
           string_agg(
             (people::text || ' (' || first_name || ' ' || last_name || ')'),
             ', ' ORDER BY created_at
           ),
           ''
         ) AS parties
       FROM reservations
       WHERE res_date = $1
       GROUP BY time
       ORDER BY time`,
      [date]
    );

    const totalPeople = q.rows.reduce((acc, r) => acc + r.total_people, 0);
    res.json({ date, totalPeople, rows: q.rows });
  } catch (err) {
    console.error("GET /admin/api/summary error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /admin/api/stats
app.get("/admin/api/stats", adminAuth, async (_req, res) => {
  try {
    const q = await pool.query(
      `SELECT
         EXTRACT(ISODOW FROM res_date)::int AS dow,
         to_char(res_time, 'HH24:MI') AS time,
         COALESCE(SUM(people), 0)::int AS total_people
       FROM reservations
       GROUP BY dow, time
       ORDER BY dow, time`
    );
    res.json({ rows: q.rows });
  } catch (err) {
    console.error("GET /admin/api/stats error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── 404 catch-all ────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`API running on http://0.0.0.0:${PORT}`);
});