require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const path = require("path");
const app = express();
const helmet = require("helmet");

app.set("trust proxy", 1);
app.use(helmet());

app.use(cors({
  origin: "https://moxiecph-front.onrender.com",
  methods: ["GET","POST","PUT","DELETE","OPTIONS"],
}));

app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const MAX_TOTAL = Number(process.env.MAX_TOTAL || 50);
const MAX_PER_SLOT = Number(process.env.MAX_PER_SLOT || 30);
const DURATION_MINUTES = Number(process.env.DURATION_MINUTES || 120);

function basicAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [type, token] = header.split(" ");

  if (type !== "Basic" || !token) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Admin"');
    return res.status(401).send("Auth required");
  }

  const decoded = Buffer.from(token, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);

  if (user === process.env.ADMIN_USER && pass === process.env.ADMIN_PASS) {
    return next();
  }

  res.setHeader("WWW-Authenticate", 'Basic realm="Admin"');
  return res.status(401).send("Invalid credentials");
}

// Helper: generiraj slotove 17:00–23:00 svakih 30min
function generateSlots() {
  const slots = [];
  for (let h = 17; h <= 23; h++) {
    slots.push(`${String(h).padStart(2, "0")}:00`);
    if (h !== 23) slots.push(`${String(h).padStart(2, "0")}:30`);
  }
  return slots;
}
const ALL_SLOTS = generateSlots();

function timeToMinutes(t) {
  const [hh, mm] = t.split(":").map(Number);
  return hh * 60 + mm;
}

function roundUpToNextHalfHour(minutes) {
  return Math.ceil(minutes / 30) * 30;
}

app.get("/admin_page", basicAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "admin_page.html"));
});

// 1) GET available times
// /availability?date=2026-02-18&people=4
app.get("/availability", async (req, res) => {
  try {
    const { date, people } = req.query;
    const ppl = Number(people);

    if (!date || !people || !Number.isFinite(ppl) || ppl < 1) {
      return res.status(400).json({ error: "date i people su obavezni" });
    }

    // Zbroji ljude po slotu za taj datum
    const { rows } = await pool.query(
    `
    SELECT to_char(res_time, 'HH24:MI') AS t, COALESCE(SUM(people), 0) AS total
    FROM reservations
    WHERE res_date = $1
    GROUP BY t
    `,
    [date]
    );

    const sumByTime = new Map(rows.map(r => [r.t, Number(r.total)]));

    let available = ALL_SLOTS.filter((slot) => {
      // 1) limit po start slotu (max 30 u točno tom start terminu)
      const slotBooked = sumByTime.get(slot) || 0;
      if (slotBooked + ppl > MAX_PER_SLOT) return false;

      // 2) limit ukupno u restoranu u preklapajućem 2h prozoru (max 50)
      const candStart = timeToMinutes(slot);
      const candEnd = candStart + DURATION_MINUTES; // [candStart, candEnd)

      let overlappingBooked = 0;

      for (const t of ALL_SLOTS) {
        const start = timeToMinutes(t);
        const end = start + DURATION_MINUTES; // [start, end)

        const overlaps = start < candEnd && end > candStart;
        if (overlaps) overlappingBooked += (sumByTime.get(t) || 0);
      }

      if (overlappingBooked + ppl > MAX_TOTAL) return false;

      return true;
    });


        // --- sakrij prošla vremena ako je odabrani datum danas ---
    // --- sakrij prošla vremena ako je odabrani datum danas ---
const now = new Date();
const todayStr =
  `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;

if (date === todayStr) {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const cutoff = roundUpToNextHalfHour(nowMinutes); // npr. 20:10 -> 20:30
  available = available.filter(t => timeToMinutes(t) >= cutoff);
}

// jedini response
return res.json({
  date,
  people: ppl,
  maxPerSlot: MAX_PER_SLOT,
  maxTotal: MAX_TOTAL,
  durationMinutes: DURATION_MINUTES,
  available
});

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/admin/api/summary", basicAuth, async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: "date is required" });

const q = await pool.query(
  `
  SELECT
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
  ORDER BY time;
  `,
  [date]
);


    const totalPeople = q.rows.reduce((acc, r) => acc + Number(r.total_people), 0);
    res.json({ date, totalPeople, rows: q.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/admin/api/stats", basicAuth, async (_req, res) => {
  try {
    const q = await pool.query(`
      SELECT
        EXTRACT(ISODOW FROM res_date)::int AS dow,       -- 1=Mon ... 7=Sun
        to_char(res_time, 'HH24:MI') AS time,
        COALESCE(SUM(people), 0)::int AS total_people
      FROM reservations
      GROUP BY dow, time
      ORDER BY dow, time;
    `);

    res.json({ rows: q.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});
// 2) POST reservation
app.post("/reservations", async (req, res) => {
  try {
    const { firstName, lastName, email, people, date, time } = req.body;

    const ppl = Number(people);
    if (!firstName || !lastName || !email || !date || !time || !Number.isFinite(ppl)) {
      return res.status(400).json({ error: "Nedostaju polja" });
    }

    // 2a) Provjeri kapacitet za taj slot (transaction-safe)
    // Najjednostavnije (za start): SERIALIZABLE transakcija
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");

      const slotRes = await client.query(
        `SELECT COALESCE(SUM(people),0) AS total
        FROM reservations
        WHERE res_date = $1 AND res_time = $2::time`,
        [date, time]
        );
        const slotTotal = Number(slotRes.rows[0].total);
        if (slotTotal + ppl > MAX_PER_SLOT) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Slot je pun (max 30)" });
        }

      const winRes = await client.query(
        `SELECT COALESCE(SUM(people),0) AS total
        FROM reservations
        WHERE res_date = $1
          AND res_time < ($2::time + make_interval(mins => $3))
          AND (res_time + make_interval(mins => $3)) > $2::time`,
        [date, time, DURATION_MINUTES]
        );
        const winTotal = Number(winRes.rows[0].total);

        if (winTotal + ppl > MAX_TOTAL) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Restoran je pun (max 50 u tom periodu)" });
        }
      // 2b) Insert
      const ins = await client.query(
        `INSERT INTO reservations (first_name, last_name, email, people, res_date, res_time)
         VALUES ($1,$2,$3,$4,$5,$6::time)
         RETURNING id, created_at`,
        [firstName, lastName, email, ppl, date, time]
      );

      await client.query("COMMIT");
      return res.status(201).json({
        ok: true,
        reservationId: ins.rows[0].id,
        createdAt: ins.rows[0].created_at,
      });
    } catch (e) {
      await client.query("ROLLBACK");
      // SERIALIZABLE može baciti conflict -> probaj ponovno (za sad samo javimo)
      console.error(e);
      return res.status(500).json({ error: "Neuspjelo spremanje" });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/health", async (_req, res) => {
  try {
    const r = await pool.query("SELECT 1 AS ok");
    res.json({ ok: true, db: r.rows[0].ok === 1 });
  } catch {
    res.status(500).json({ ok: false });
  }
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`API running on http://0.0.0.0:${PORT}`);
});