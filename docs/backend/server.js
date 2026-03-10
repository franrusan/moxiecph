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
app.use(helmet({
  contentSecurityPolicy: false, // Needed to allow CDN scripts in admin page
}));
app.use(cors({
  origin: process.env.CORS_ORIGIN || "https://moxiecph-front.onrender.com",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
}));
app.use(express.json());

// ─── Database ─────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Fix: allows self-signed certs on Render
});

// ─── Config ───────────────────────────────────────────────────────────────────

const MAX_TOTAL         = Number(process.env.MAX_TOTAL          || 50);
const MAX_PER_SLOT      = Number(process.env.MAX_PER_SLOT       || 30);
const DURATION_MINUTES  = Number(process.env.DURATION_MINUTES   || 120);
const SLOT_START_HOUR   = Number(process.env.SLOT_START_HOUR    || 17);
const SLOT_END_HOUR     = Number(process.env.SLOT_END_HOUR      || 23);

// ─── Rate Limiting ────────────────────────────────────────────────────────────

const reservationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
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

// ─── Static Admin Files ───────────────────────────────────────────────────────

// Serve admin.css and admin.js only to authenticated users
app.get("/admin.css", adminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "admin.css"));
});

app.get("/admin.js", adminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "admin.js"));
});

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
    body("firstName").trim().notEmpty().isLength({ max: 100 }),
    body("lastName").trim().notEmpty().isLength({ max: 100 }),
    body("email").trim().isEmail().normalizeEmail(),
    body("people").isInt({ min: 1, max: MAX_PER_SLOT }),
    body("date").matches(/^\d{4}-\d{2}-\d{2}$/),
    body("time").custom(val => VALID_SLOT_SET.has(val)).withMessage("Invalid time slot"),
  ],
  handleValidationErrors,
  async (req, res) => {
    const { firstName, lastName, email, date, time } = req.body;
    const ppl = Number(req.body.people);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");

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
      if (err.code === "40001") {
        return res.status(409).json({ error: "Booking conflict detected. Please try again.", retryable: true });
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
         json_agg(
           json_build_object(
             'id', id,
             'first_name', first_name,
             'last_name', last_name,
             'people', people
           ) ORDER BY created_at
         ) AS parties_data
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

// ─── Public Menu ──────────────────────────────────────────────────────────────

// GET /menu — sve vidljive stavke grupirane po kategoriji
app.get("/menu", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         m.id, m.slug, m.title, m.description, m.price, m.photo_url,
         m.ingredients, m.steps,
         c.id AS category_id, c.name AS category_name, c.type AS category_type
       FROM menu_items m
       JOIN categories c ON c.id = m.category_id
       WHERE m.visible = true
       ORDER BY c.sort_order, m.sort_order`
    );

    // Grupiraj po kategoriji
    const grouped = [];
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.category_id)) {
        const cat = { id: r.category_id, name: r.category_name, type: r.category_type, items: [] };
        map.set(r.category_id, cat);
        grouped.push(cat);
      }
      map.get(r.category_id).items.push({
        id: r.id, slug: r.slug, title: r.title,
        description: r.description, price: r.price, photo_url: r.photo_url,
        ingredients: r.ingredients, steps: r.steps,
      });
    }

    res.json({ categories: grouped });
  } catch (err) {
    console.error("GET /menu error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /menu/:slug — jedna stavka
app.get("/menu/:slug", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         m.id, m.slug, m.title, m.description, m.price, m.photo_url,
         m.ingredients, m.steps,
         c.name AS category_name, c.type AS category_type
       FROM menu_items m
       JOIN categories c ON c.id = m.category_id
       WHERE m.slug = $1 AND m.visible = true`,
      [req.params.slug]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("GET /menu/:slug error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Admin Menu API ───────────────────────────────────────────────────────────

// GET /admin/api/menu — sve stavke (i nevidljive)
app.get("/admin/api/menu", adminAuth, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         m.id, m.slug, m.title, m.description, m.price, m.photo_url,
         m.ingredients, m.steps, m.visible, m.sort_order,
         c.id AS category_id, c.name AS category_name, c.type AS category_type
       FROM menu_items m
       JOIN categories c ON c.id = m.category_id
       ORDER BY c.sort_order, m.sort_order`
    );
    res.json({ items: rows });
  } catch (err) {
    console.error("GET /admin/api/menu error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /admin/api/menu — dodaj stavku
app.post("/admin/api/menu", adminAuth, [
  body("title").trim().notEmpty().isLength({ max: 200 }),
  body("category_id").isInt({ min: 1 }),
  body("price").trim().notEmpty().isLength({ max: 50 }),
  body("description").optional().trim().isLength({ max: 500 }),
  body("photo_url").optional({ nullable: true, checkFalsy: true }).trim(),
  body("ingredients").optional().isArray(),
  body("steps").optional().isArray(),
  body("visible").optional().isBoolean(),
], handleValidationErrors, async (req, res) => {
  try {
    const { title, category_id, price, description = "", photo_url = null,
            ingredients = [], steps = [], visible = true } = req.body;

    // Generiraj slug iz naslova
    const baseSlug = title.toLowerCase()
      .replace(/[čć]/g, "c").replace(/[šś]/g, "s").replace(/[žź]/g, "z").replace(/đ/g, "d")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

    // Osiguraj jedinstvenost sluga
    const existing = await pool.query("SELECT slug FROM menu_items WHERE slug LIKE $1", [`${baseSlug}%`]);
    const slug = existing.rows.length ? `${baseSlug}-${existing.rows.length + 1}` : baseSlug;

    const { rows } = await pool.query(
      `INSERT INTO menu_items (category_id, slug, title, description, price, photo_url, ingredients, steps, visible)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [category_id, slug, title, description, price, photo_url,
       JSON.stringify(ingredients), JSON.stringify(steps), visible]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("POST /admin/api/menu error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// PUT /admin/api/menu/:id — uredi stavku
app.put("/admin/api/menu/:id", adminAuth, [
  body("title").trim().notEmpty().isLength({ max: 200 }),
  body("category_id").isInt({ min: 1 }),
  body("price").trim().notEmpty().isLength({ max: 50 }),
  body("description").optional().trim().isLength({ max: 500 }),
  body("photo_url").optional({ nullable: true, checkFalsy: true }).trim(),
  body("ingredients").optional().isArray(),
  body("steps").optional().isArray(),
  body("visible").optional().isBoolean(),
], handleValidationErrors, async (req, res) => {
  try {
    const { title, category_id, price, description = "",
            photo_url = null, ingredients = [], steps = [], visible = true } = req.body;

    const { rows } = await pool.query(
      `UPDATE menu_items SET
         category_id = $1, title = $2, description = $3, price = $4,
         photo_url = $5, ingredients = $6, steps = $7, visible = $8
       WHERE id = $9 RETURNING *`,
      [category_id, title, description, price, photo_url,
       JSON.stringify(ingredients), JSON.stringify(steps), visible, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("PUT /admin/api/menu/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// PATCH /admin/api/menu/:id/visibility — toggle visible
app.patch("/admin/api/menu/:id/visibility", adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE menu_items SET visible = NOT visible WHERE id = $1 RETURNING id, title, visible`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("PATCH /admin/api/menu/:id/visibility error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /admin/api/menu/:id — obriši stavku
app.delete("/admin/api/menu/:id", adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "DELETE FROM menu_items WHERE id = $1 RETURNING id", [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /admin/api/menu/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Admin Categories API ─────────────────────────────────────────────────────

// GET /admin/api/categories
app.get("/admin/api/categories", adminAuth, async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM categories ORDER BY sort_order");
    res.json({ categories: rows });
  } catch (err) {
    console.error("GET /admin/api/categories error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/categories — public (za forme na frontendu)
app.get("/api/categories", async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM categories ORDER BY sort_order");
    res.json({ categories: rows });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// POST /admin/api/categories — dodaj kategoriju
app.post("/admin/api/categories", adminAuth, [
  body("name").trim().notEmpty().isLength({ max: 100 }),
  body("type").isIn(["food", "drink"]),
  body("sort_order").optional().isInt({ min: 0 }),
], handleValidationErrors, async (req, res) => {
  try {
    const { name, type, sort_order = 0 } = req.body;
    const { rows } = await pool.query(
      "INSERT INTO categories (name, type, sort_order) VALUES ($1, $2, $3) RETURNING *",
      [name, type, sort_order]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("POST /admin/api/categories error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /admin/api/categories/:id
app.delete("/admin/api/categories/:id", adminAuth, async (req, res) => {
  try {
    // Provjeri ima li stavki u kategoriji
    const check = await pool.query("SELECT COUNT(*) FROM menu_items WHERE category_id = $1", [req.params.id]);
    if (parseInt(check.rows[0].count) > 0) {
      return res.status(409).json({ error: "Kategorija ima stavke — prvo ih obriši ili premjesti." });
    }
    await pool.query("DELETE FROM categories WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /admin/api/categories/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});


// ─── Admin Reservations API ───────────────────────────────────────────────────

// GET /admin/api/reservations/:id
app.get("/admin/api/reservations/:id", adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, first_name, last_name, email, people,
              res_date::text AS res_date,
              to_char(res_time, 'HH24:MI') AS res_time
       FROM reservations WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("GET /admin/api/reservations/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// PUT /admin/api/reservations/:id
app.put("/admin/api/reservations/:id", adminAuth, [
  body("people").isInt({ min: 1, max: 100 }),
  body("res_date").matches(/^\d{4}-\d{2}-\d{2}$/),
  body("res_time").custom(val => VALID_SLOT_SET.has(val)).withMessage("Invalid time slot"),
], handleValidationErrors, async (req, res) => {
  try {
    const { people, res_date, res_time } = req.body;
    const { rows } = await pool.query(
      `UPDATE reservations SET people=$1, res_date=$2, res_time=$3::time
       WHERE id=$4 RETURNING id`,
      [people, res_date, res_time, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("PUT /admin/api/reservations/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /admin/api/reservations/:id
app.delete("/admin/api/reservations/:id", adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "DELETE FROM reservations WHERE id=$1 RETURNING id", [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /admin/api/reservations/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /admin/api/reservations — admin kreira rezervaciju bez provjere kapaciteta
app.post("/admin/api/reservations", adminAuth, [
  body("firstName").trim().notEmpty().isLength({ max: 100 }),
  body("lastName").trim().notEmpty().isLength({ max: 100 }),
  body("email").trim().isEmail().normalizeEmail(),
  body("people").isInt({ min: 1, max: 100 }),
  body("date").matches(/^\d{4}-\d{2}-\d{2}$/),
  body("time").custom(val => VALID_SLOT_SET.has(val)).withMessage("Invalid time slot"),
], handleValidationErrors, async (req, res) => {
  const { firstName, lastName, email, date, time } = req.body;
  const ppl = Number(req.body.people);
  try {
    const ins = await pool.query(
      `INSERT INTO reservations (first_name, last_name, email, people, res_date, res_time)
       VALUES ($1, $2, $3, $4, $5, $6::time)
       RETURNING id, created_at`,
      [firstName, lastName, email, ppl, date, time]
    );
    res.status(201).json({ ok: true, reservationId: ins.rows[0].id });
  } catch (err) {
    console.error("POST /admin/api/reservations error:", err);
    res.status(500).json({ error: "Failed to save reservation." });
  }
});

// ─── 404 ──────────────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`API running on http://0.0.0.0:${PORT}`);
});