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

// ─── Menu Management ──────────────────────────────────────────────────────────

let allCategories = [];
let allMenuItems  = [];
let editingItemId = null;

const menuListEl    = document.getElementById("menuList");
const menuFormEl    = document.getElementById("menuItemForm");
const formTitleEl   = document.getElementById("formTitle");
const cancelFormBtn = document.getElementById("cancelForm");
const addMealBtn    = document.getElementById("addMealBtn");
const addDrinkBtn   = document.getElementById("addDrinkBtn");
const addCatBtn     = document.getElementById("addCatBtn");
const catFormEl     = document.getElementById("categoryForm");
const cancelCatBtn  = document.getElementById("cancelCatForm");

async function loadMenuAdmin() {
  const auth = getAuthHeader();
  if (!auth) return;

  const [catRes, itemRes] = await Promise.all([
    fetch("/admin/api/categories", { cache: "no-store", headers: { Authorization: auth } }),
    fetch("/admin/api/menu",       { cache: "no-store", headers: { Authorization: auth } }),
  ]);

  const catData  = await catRes.json();
  const itemData = await itemRes.json();

  allCategories = catData.categories || [];
  allMenuItems  = itemData.items     || [];

  renderMenuList();
}

function renderMenuList() {
  const groups = new Map();
  for (const cat of allCategories) groups.set(cat.id, { cat, items: [] });
  for (const item of allMenuItems) {
    if (groups.has(item.category_id)) groups.get(item.category_id).items.push(item);
  }

  let html = "";
  for (const { cat, items } of groups.values()) {
    html += `
      <div class="menu-group">
        <div class="menu-group-header">
          <span class="menu-group-title">${cat.name}</span>
          <span class="menu-group-type">${cat.type === "food" ? "🍽️ Hrana" : "🍷 Piće"}</span>
          <button class="btn-icon btn-danger" onclick="deleteCategory(${cat.id})" title="Obriši kategoriju">✕</button>
        </div>`;
    if (!items.length) html += `<div class="menu-empty">Nema stavki u ovoj kategoriji.</div>`;
    for (const item of items) {
      html += `
        <div class="menu-row ${item.visible ? "" : "menu-row--hidden"}">
          <label class="toggle" title="${item.visible ? "Vidljivo" : "Skriveno"}">
            <input type="checkbox" ${item.visible ? "checked" : ""} onchange="toggleVisible(${item.id}, this)">
            <span class="toggle-track"></span>
          </label>
          <span class="menu-row-title">${item.title}</span>
          <span class="menu-row-price">${item.price}</span>
          <button class="btn-icon" onclick="openEditForm(${item.id})">✎</button>
          <button class="btn-icon btn-danger" onclick="deleteItem(${item.id})">✕</button>
        </div>`;
    }
    html += `</div>`;
  }

  if (menuListEl) menuListEl.innerHTML = html || `<div class="muted">Nema stavki.</div>`;
}

async function toggleVisible(id, checkbox) {
  const auth = getAuthHeader();
  if (!auth) return;
  try {
    const r = await fetch(`/admin/api/menu/${id}/visibility`, {
      method: "PATCH", headers: { Authorization: auth },
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    const item = allMenuItems.find(i => i.id === id);
    if (item) item.visible = data.visible;
    renderMenuList();
  } catch (err) {
    checkbox.checked = !checkbox.checked;
    alert("Greška: " + err.message);
  }
}

async function deleteItem(id) {
  if (!confirm("Obrisati ovu stavku?")) return;
  const auth = getAuthHeader();
  if (!auth) return;
  try {
    const r = await fetch(`/admin/api/menu/${id}`, { method: "DELETE", headers: { Authorization: auth } });
    if (!r.ok) { const d = await r.json(); throw new Error(d.error); }
    allMenuItems = allMenuItems.filter(i => i.id !== id);
    renderMenuList();
  } catch (err) { alert("Greška: " + err.message); }
}

async function deleteCategory(id) {
  if (!confirm("Obrisati ovu kategoriju? Mora biti prazna.")) return;
  const auth = getAuthHeader();
  if (!auth) return;
  try {
    const r = await fetch(`/admin/api/categories/${id}`, { method: "DELETE", headers: { Authorization: auth } });
    if (!r.ok) { const d = await r.json(); throw new Error(d.error); }
    allCategories = allCategories.filter(c => c.id !== id);
    renderMenuList();
  } catch (err) { alert("Greška: " + err.message); }
}

function buildCategoryOptions(selectedId = null, typeFilter = null) {
  return allCategories
    .filter(c => typeFilter ? c.type === typeFilter : true)
    .map(c => `<option value="${c.id}" ${c.id === selectedId ? "selected" : ""}>${c.name}</option>`)
    .join("");
}

function openAddForm(typeFilter) {
  editingItemId = null;
  formTitleEl.textContent = typeFilter === "food" ? "Dodaj jelo" : "Dodaj piće";
  document.getElementById("fi_category").innerHTML = buildCategoryOptions(null, typeFilter);
  document.getElementById("fi_title").value        = "";
  document.getElementById("fi_price").value        = "";
  document.getElementById("fi_desc").value         = "";
  document.getElementById("fi_photo").value        = "";
  document.getElementById("fi_ingredients").value  = "";
  document.getElementById("fi_steps").value        = "";
  document.getElementById("fi_visible").checked    = true;
  document.getElementById("dishFields").style.display = typeFilter === "food" ? "" : "none";
  menuFormEl.style.display = "";
  menuFormEl.scrollIntoView({ behavior: "smooth" });
}

function openEditForm(id) {
  const item = allMenuItems.find(i => i.id === id);
  if (!item) return;
  editingItemId = id;
  formTitleEl.textContent = "Uredi stavku";
  document.getElementById("fi_category").innerHTML  = buildCategoryOptions(item.category_id);
  document.getElementById("fi_title").value         = item.title;
  document.getElementById("fi_price").value         = item.price;
  document.getElementById("fi_desc").value          = item.description || "";
  document.getElementById("fi_photo").value         = item.photo_url || "";
  document.getElementById("fi_ingredients").value   = (item.ingredients || []).join("\n");
  document.getElementById("fi_steps").value         = (item.steps || []).join("\n");
  document.getElementById("fi_visible").checked     = item.visible;
  document.getElementById("dishFields").style.display = item.category_type === "food" ? "" : "none";
  menuFormEl.style.display = "";
  menuFormEl.scrollIntoView({ behavior: "smooth" });
}

cancelFormBtn?.addEventListener("click", () => { menuFormEl.style.display = "none"; });
addMealBtn?.addEventListener("click",  () => openAddForm("food"));
addDrinkBtn?.addEventListener("click", () => openAddForm("drink"));

document.getElementById("menuItemFormEl")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const auth = getAuthHeader();
  if (!auth) return;
  const payload = {
    category_id:  Number(document.getElementById("fi_category").value),
    title:        document.getElementById("fi_title").value.trim(),
    price:        document.getElementById("fi_price").value.trim(),
    description:  document.getElementById("fi_desc").value.trim(),
    photo_url:    document.getElementById("fi_photo").value.trim() || null,
    ingredients:  document.getElementById("fi_ingredients").value.split("\n").map(s => s.trim()).filter(Boolean),
    steps:        document.getElementById("fi_steps").value.split("\n").map(s => s.trim()).filter(Boolean),
    visible:      document.getElementById("fi_visible").checked,
  };
  try {
    const url    = editingItemId ? `/admin/api/menu/${editingItemId}` : "/admin/api/menu";
    const method = editingItemId ? "PUT" : "POST";
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify(payload),
    });
    if (!r.ok) { const d = await r.json(); throw new Error(d.error); }
    menuFormEl.style.display = "none";
    await loadMenuAdmin();
  } catch (err) { alert("Greška: " + err.message); }
});

addCatBtn?.addEventListener("click", () => {
  document.getElementById("ci_name").value = "";
  document.getElementById("ci_type").value = "food";
  catFormEl.style.display = "";
  catFormEl.scrollIntoView({ behavior: "smooth" });
});

cancelCatBtn?.addEventListener("click", () => { catFormEl.style.display = "none"; });

document.getElementById("categoryFormEl")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const auth = getAuthHeader();
  if (!auth) return;
  const payload = {
    name:       document.getElementById("ci_name").value.trim(),
    type:       document.getElementById("ci_type").value,
    sort_order: allCategories.length + 1,
  };
  try {
    const r = await fetch("/admin/api/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify(payload),
    });
    if (!r.ok) { const d = await r.json(); throw new Error(d.error); }
    catFormEl.style.display = "none";
    await loadMenuAdmin();
  } catch (err) { alert("Greška: " + err.message); }
});

loadMenuAdmin();

// ─── Reservation pills + modals ───────────────────────────────────────────────

let currentResId = null;

// Override loadSummary da renderira pill gumbe
const _origLoadSummary = loadSummary;
loadSummary = async function() {
  tbody.innerHTML = `<tr><td colspan="3" class="muted loading-text">Učitavam…</td></tr>`;
  sumPill.textContent = "";
  const auth = getAuthHeader();
  if (!auth) return;
  try {
    const r = await fetch(`/admin/api/summary?date=${encodeURIComponent(dateInput.value)}`, {
      cache: "no-store", headers: { Authorization: auth },
    });
    const data = await r.json();
    if (!r.ok) { tbody.innerHTML = `<tr><td colspan="3" class="muted">Greška: ${data.error || r.status}</td></tr>`; return; }
    if (!data.rows.length) { tbody.innerHTML = `<tr><td colspan="3" class="muted">Nema rezervacija za taj datum.</td></tr>`; return; }
    sumPill.textContent = `Ukupno: ${data.totalPeople} gostiju`;
    tbody.innerHTML = data.rows.map(row => `
      <tr>
        <td>${row.time}</td>
        <td>${row.total_people}</td>
        <td class="pills-cell">${renderPills(row.parties_data)}</td>
      </tr>`).join("");
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="3" class="muted">Greška pri dohvatu podataka.</td></tr>`;
    console.error("loadSummary:", err);
  }
};

function renderPills(partiesData) {
  if (!partiesData) return "";
  return partiesData.map(p =>
    `<button class="res-pill" data-id="${p.id}">${p.people} (${p.first_name} ${p.last_name})</button>`
  ).join("");
}

// Klik na pill
document.addEventListener("click", async (e) => {
  const pill = e.target.closest(".res-pill");
  if (!pill) return;
  const id = pill.dataset.id;
  await openResModal(id);
});

async function openResModal(id) {
  const auth = getAuthHeader();
  if (!auth) return;
  try {
    const r = await fetch(`/admin/api/reservations/${id}`, { headers: { Authorization: auth } });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    currentResId = id;
    document.getElementById("ri_name").textContent   = `${data.first_name} ${data.last_name}`;
    document.getElementById("ri_email").textContent  = data.email;
    document.getElementById("ri_date").textContent   = data.res_date;
    document.getElementById("ri_time").textContent   = data.res_time;
    document.getElementById("ri_people").textContent = data.people;
    document.getElementById("resModal").style.display = "flex";
  } catch (err) { alert("Greška: " + err.message); }
}

// Zatvori info modal
document.getElementById("resModalClose")?.addEventListener("click", () => {
  document.getElementById("resModal").style.display = "none";
});
document.getElementById("resModal")?.addEventListener("click", (e) => {
  if (e.target === e.currentTarget) e.currentTarget.style.display = "none";
});

// Otvori edit modal
document.getElementById("resEditBtn")?.addEventListener("click", () => {
  const date   = document.getElementById("ri_date").textContent;
  const time   = document.getElementById("ri_time").textContent;
  const people = document.getElementById("ri_people").textContent;
  document.getElementById("re_date").value   = date;
  document.getElementById("re_time").value   = time;
  document.getElementById("re_people").value = people;
  document.getElementById("resModal").style.display     = "none";
  document.getElementById("resEditModal").style.display = "flex";
});

// Zatvori edit modal
document.getElementById("resEditClose")?.addEventListener("click", () => {
  document.getElementById("resEditModal").style.display = "none";
});
document.getElementById("resEditCancelBtn")?.addEventListener("click", () => {
  document.getElementById("resEditModal").style.display = "none";
});
document.getElementById("resEditModal")?.addEventListener("click", (e) => {
  if (e.target === e.currentTarget) e.currentTarget.style.display = "none";
});

// Spremi izmjene
document.getElementById("resSaveBtn")?.addEventListener("click", async () => {
  const auth = getAuthHeader();
  if (!auth || !currentResId) return;
  const payload = {
    people:   Number(document.getElementById("re_people").value),
    res_date: document.getElementById("re_date").value,
    res_time: document.getElementById("re_time").value,
  };
  try {
    const r = await fetch(`/admin/api/reservations/${currentResId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify(payload),
    });
    if (!r.ok) { const d = await r.json(); throw new Error(d.error); }
    document.getElementById("resEditModal").style.display = "none";
    await loadSummary();
  } catch (err) { alert("Greška: " + err.message); }
});

// Obriši
document.getElementById("resDeleteBtn")?.addEventListener("click", async () => {
  if (!confirm("Obrisati ovu rezervaciju?")) return;
  const auth = getAuthHeader();
  if (!auth || !currentResId) return;
  try {
    const r = await fetch(`/admin/api/reservations/${currentResId}`, {
      method: "DELETE",
      headers: { Authorization: auth },
    });
    if (!r.ok) { const d = await r.json(); throw new Error(d.error); }
    document.getElementById("resModal").style.display = "none";
    await loadSummary();
  } catch (err) { alert("Greška: " + err.message); }
});

// ─── Nova rezervacija (admin) ─────────────────────────────────────────────────

document.getElementById("newResBtn")?.addEventListener("click", () => {
  const form = document.getElementById("newResForm");
  form.style.display = form.style.display === "none" ? "block" : "none";
  document.getElementById("newResMsg").textContent = "";
  document.getElementById("newResFormEl").reset();
});

document.getElementById("cancelNewRes")?.addEventListener("click", () => {
  document.getElementById("newResForm").style.display = "none";
  document.getElementById("newResMsg").textContent = "";
});

document.getElementById("newResFormEl")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const auth = getAuthHeader();
  if (!auth) return;

  const msg = document.getElementById("newResMsg");
  msg.style.color = "#f88";
  msg.textContent = "";

  const payload = {
    firstName: document.getElementById("nr_firstName").value.trim(),
    lastName:  document.getElementById("nr_lastName").value.trim(),
    email:     document.getElementById("nr_email").value.trim(),
    people:    Number(document.getElementById("nr_people").value),
    date:      document.getElementById("nr_date").value,
    time:      document.getElementById("nr_time").value,
  };

  if (!payload.time) { msg.textContent = "Odaberi vrijeme."; return; }

  try {
    const r = await fetch("/admin/api/reservations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) { msg.textContent = data.error || "Greška."; return; }

    msg.style.color = "#8f8";
    msg.textContent = "Rezervacija spremljena!";
    document.getElementById("newResFormEl").reset();

    // Ako je isti datum kao u filtru — osvježi tablicu
    if (payload.date === dateInput?.value) await loadSummary();

    setTimeout(() => {
      document.getElementById("newResForm").style.display = "none";
      msg.textContent = "";
    }, 1500);
  } catch (err) {
    msg.textContent = "Greška: " + err.message;
  }
});