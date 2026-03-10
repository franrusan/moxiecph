// ─── Config ───────────────────────────────────────────────────────────────────

const DOW_LABELS = ["Pon", "Uto", "Sri", "Čet", "Pet", "Sub", "Ned"];
const THEME_YELLOW      = "rgba(242,201,76,0.9)";
const THEME_YELLOW_SOFT = "rgba(242,201,76,0.25)";
const GRID_COLOR        = "rgba(255,255,255,0.07)";
const TICK_COLOR        = "rgba(255,255,255,0.65)";

// ─── Auth ─────────────────────────────────────────────────────────────────────

const getAuthHeader = (() => {
  let cached = null;
  return () => {
    if (cached) return cached;
    const user = prompt("Admin username:");
    const pass = prompt("Admin password:");
    if (!user || !pass) return null;
    cached = "Basic " + btoa(`${user}:${pass}`);
    return cached;
  };
})();

// ─── Helpers ──────────────────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, "0");

function todayString() {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

// ─── Summary ──────────────────────────────────────────────────────────────────

const dateInput = document.getElementById("d");
const tbody     = document.getElementById("tb");
const sumPill   = document.getElementById("sum");
const loadBtn   = document.getElementById("load");

dateInput.value = todayString();

async function loadSummary() {
  tbody.innerHTML = `<tr><td colspan="3" class="muted loading-text">Učitavam…</td></tr>`;
  sumPill.textContent = "";

  const auth = getAuthHeader();
  if (!auth) return;

  try {
    const r = await fetch(`/admin/api/summary?date=${encodeURIComponent(dateInput.value)}`, {
      cache: "no-store",
      headers: { Authorization: auth },
    });
    const data = await r.json();

    if (!r.ok) {
      tbody.innerHTML = `<tr><td colspan="3" class="muted">Greška: ${data.error || r.status}</td></tr>`;
      return;
    }

    if (!data.rows.length) {
      tbody.innerHTML = `<tr><td colspan="3" class="muted">Nema rezervacija za taj datum.</td></tr>`;
      return;
    }

    sumPill.textContent = `Ukupno: ${data.totalPeople} gostiju`;

    tbody.innerHTML = data.rows
      .map(
        (row) => `
        <tr>
          <td>${row.time}</td>
          <td>${row.total_people}</td>
          <td class="muted">${row.parties}</td>
        </tr>`
      )
      .join("");
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="3" class="muted">Greška pri dohvatu podataka.</td></tr>`;
    console.error("loadSummary:", err);
  }
}

loadBtn.addEventListener("click", loadSummary);

// ─── Stats ────────────────────────────────────────────────────────────────────

let statsGrid   = [];
let selectedDow  = null;
let selectedTime = null;
let chartDow     = null;
let chartTime    = null;

const filterBadge = document.getElementById("filterState");
const resetBtn    = document.getElementById("resetFilters");

function setFilterBadge() {
  const parts = [];
  if (selectedDow)  parts.push(`Dan: ${DOW_LABELS[selectedDow - 1]}`);
  if (selectedTime) parts.push(`Termin: ${selectedTime}`);
  filterBadge.textContent = parts.length ? parts.join(" | ") : "";
}

function computeTotals({ dow = null, time = null } = {}) {
  const filtered = statsGrid.filter((r) => {
    if (dow  && Number(r.dow)  !== dow)  return false;
    if (time && r.time         !== time) return false;
    return true;
  });

  const byDow = Array(7).fill(0);
  for (const r of filtered) byDow[Number(r.dow) - 1] += Number(r.total_people);

  const mapTime = new Map();
  for (const r of filtered) mapTime.set(r.time, (mapTime.get(r.time) || 0) + Number(r.total_people));

  const times  = Array.from(mapTime.keys()).sort();
  const byTime = times.map((t) => mapTime.get(t));

  return { byDow, times, byTime };
}

const commonOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { display: false },
    tooltip: {
      displayColors: false,
      callbacks: { label: (ctx) => ` ${ctx.raw} ljudi` },
    },
  },
  scales: {
    x: { ticks: { color: TICK_COLOR, font: { family: "'DM Mono', monospace", size: 11 } }, grid: { color: "rgba(0,0,0,0)" } },
    y: { beginAtZero: true, ticks: { color: TICK_COLOR, font: { family: "'DM Mono', monospace", size: 11 } }, grid: { color: GRID_COLOR } },
  },
};

function buildDataset(data) {
  return {
    label: "Ukupno ljudi",
    data,
    backgroundColor: THEME_YELLOW,
    hoverBackgroundColor: "rgba(242,201,76,1)",
    borderColor: THEME_YELLOW_SOFT,
    borderWidth: 1,
    borderRadius: 8,
  };
}

function renderCharts() {
  setFilterBadge();

  const dowData  = computeTotals({ time: selectedTime });
  const timeData = computeTotals({ dow: selectedDow });

  // Chart 1 – DOW
  const ctxDow = document.getElementById("chartDow").getContext("2d");
  if (chartDow) chartDow.destroy();
  chartDow = new Chart(ctxDow, {
    type: "bar",
    data: { labels: DOW_LABELS, datasets: [buildDataset(dowData.byDow)] },
    options: {
      ...commonOptions,
      onClick: (_e, elements) => {
        if (!elements?.length) return;
        const dow = elements[0].index + 1;
        selectedDow = selectedDow === dow ? null : dow;
        renderCharts();
      },
    },
  });

  // Chart 2 – TIME
  const ctxTime = document.getElementById("chartTime").getContext("2d");
  if (chartTime) chartTime.destroy();
  chartTime = new Chart(ctxTime, {
    type: "bar",
    data: { labels: timeData.times, datasets: [buildDataset(timeData.byTime)] },
    options: {
      ...commonOptions,
      onClick: (_e, elements) => {
        if (!elements?.length) return;
        const time = timeData.times[elements[0].index];
        selectedTime = selectedTime === time ? null : time;
        renderCharts();
      },
    },
  });
}

async function loadStats() {
  const auth = getAuthHeader();
  if (!auth) return;

  try {
    const r = await fetch("/admin/api/stats", {
      cache: "no-store",
      headers: { Authorization: auth },
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error || "Stats error");
    statsGrid = data.rows || [];
    renderCharts();
  } catch (err) {
    console.error("loadStats:", err);
  }
}

resetBtn?.addEventListener("click", () => {
  selectedDow  = null;
  selectedTime = null;
  renderCharts();
});

// ─── Init ─────────────────────────────────────────────────────────────────────

loadStats();