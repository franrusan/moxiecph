document.addEventListener("DOMContentLoaded", () => {
  const API_BASE = "/api";

  // ====== Date: default today + min today + show picker on click ======
  function pad2(n) { return String(n).padStart(2, "0"); }

  const dateEl = document.getElementById("date");
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;

  if (dateEl) {
    dateEl.value = todayStr;
    dateEl.min = todayStr;

    // (opcionalno) auto-open date picker
    dateEl.addEventListener("click", () => {
      if (dateEl.showPicker) dateEl.showPicker();
    });
    dateEl.addEventListener("focus", () => {
      if (dateEl.showPicker) dateEl.showPicker();
    });
  }

  // ====== Custom select (cselect) logic ======
  function closeAllSelects(except = null) {
    document.querySelectorAll(".cselect.open").forEach((el) => {
      if (el !== except) {
        el.classList.remove("open");
        const btn = el.querySelector(".cselect-btn");
        if (btn) btn.setAttribute("aria-expanded", "false");
      }
    });
  }

  document.addEventListener("click", (e) => {
    const cs = e.target.closest(".cselect");
    if (!cs) { closeAllSelects(); return; }

    const btn = e.target.closest(".cselect-btn");
    if (btn) {
      const isOpen = cs.classList.contains("open");
      closeAllSelects(cs);
      cs.classList.toggle("open", !isOpen);
      btn.setAttribute("aria-expanded", String(!isOpen));
      return;
    }

    const opt = e.target.closest(".cselect-opt");
    if (opt) {
      const hidden = cs.querySelector('input[type="hidden"]');
      const valueSpan = cs.querySelector(".cselect-value");
      if (!hidden || !valueSpan) return;

      // ako je disabled (npr "Nema slobodnih termina")
      if (opt.dataset.disabled === "1") return;

      cs.querySelectorAll(".cselect-opt").forEach((o) => o.classList.remove("selected"));
      opt.classList.add("selected");

      hidden.value = opt.dataset.value || "";
      valueSpan.textContent = opt.textContent;

      cs.classList.remove("open");
      const b = cs.querySelector(".cselect-btn");
      if (b) b.setAttribute("aria-expanded", "false");

      // Nakon odabira people -> refresh availability
      if (cs.dataset.name === "people") {
        refreshAvailability();
      }
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAllSelects();
  });

  // ====== Availability (populate TIME custom dropdown from backend) ======
  const peopleHidden = document.getElementById("people"); // mora biti hidden input od people cselecta
  const timeHidden = document.getElementById("time");     // mora biti hidden input od time cselecta

  const timeCSelect = document.querySelector('.cselect[data-name="time"]');
  const timeList = timeCSelect?.querySelector(".cselect-list");
  const timeValueSpan = timeCSelect?.querySelector(".cselect-value");

  function resetTimeUI() {
    if (timeHidden) timeHidden.value = "";
    if (timeValueSpan) timeValueSpan.textContent = "Odaberi";
    if (timeCSelect) timeCSelect.querySelectorAll(".cselect-opt").forEach(o => o.classList.remove("selected"));
  }

  // Ako je user već imao odabran termin, a više nije dostupan -> reset
  function ensureTimeStillValid(availableTimes) {
    const current = timeHidden?.value || "";
    if (!current) return;
    if (!availableTimes.includes(current)) {
      resetTimeUI();
    }
  }

  function renderTimeOptions(times) {
    if (!timeList) return;

    timeList.innerHTML = "";

    if (!times || times.length === 0) {
      const li = document.createElement("li");
      li.className = "cselect-opt";
      li.textContent = "Nema slobodnih termina";
      li.style.opacity = "0.7";
      li.style.pointerEvents = "none";
      li.dataset.disabled = "1";
      timeList.appendChild(li);
    } else {
      for (const t of times) {
        const li = document.createElement("li");
        li.className = "cselect-opt";
        li.setAttribute("role", "option");
        li.dataset.value = t;
        li.textContent = t;
        timeList.appendChild(li);
      }
    }

    // Ne resetiramo bezveze ako je odabrani time i dalje validan
    ensureTimeStillValid(times || []);
    if (!timeHidden?.value) resetTimeUI();
  }

  async function refreshAvailability() {
    const date = dateEl?.value;
    const people = peopleHidden?.value;

    // Ako nije odabrano oboje, samo očisti time listu
    if (!date || !people) {
      renderTimeOptions([]);
      return;
    }

    try {
      const r = await fetch(
        `${API_BASE}/availability?date=${encodeURIComponent(date)}&people=${encodeURIComponent(people)}`,
        { cache: "no-store" }
      );
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || "Greška");

      const available = data.available || [];
      renderTimeOptions(available);

      // Ako je user imao odabrano vrijeme koje je nestalo, ovo ga resetira
      ensureTimeStillValid(available);

    } catch (err) {
      console.error(err);
      renderTimeOptions([]);
    }
  }

  if (dateEl) dateEl.addEventListener("change", refreshAvailability);

  // Po defaultu: dok ne odabereš people, time neka bude prazno
  renderTimeOptions([]);

  const dateIcon = document.querySelector(".date-wrap .date-icon");

  function openDatePicker() {
    if (!dateEl) return;
    // showPicker radi u nekim browserima; na iOS često fokus/tap otvara
    if (dateEl.showPicker) dateEl.showPicker();
    else dateEl.focus();
  }

  dateIcon?.addEventListener("click", openDatePicker);
  dateIcon?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") openDatePicker();
  });

  // ====== Submit -> POST /reservations ======
  const form = document.getElementById("reserveForm");
  const msg = document.getElementById("reserveMsg");

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (msg) msg.textContent = "";

    const payload = {
      firstName: document.getElementById("firstName")?.value.trim(),
      lastName: document.getElementById("lastName")?.value.trim(),
      email: document.getElementById("email")?.value.trim(),
      people: peopleHidden?.value,
      date: dateEl?.value,
      time: timeHidden?.value,
    };

    if (!payload.firstName || !payload.lastName || !payload.email || !payload.people || !payload.date || !payload.time) {
      if (msg) msg.textContent = "Molim ispuni ime, prezime, email te odaberi broj ljudi, datum i vrijeme.";
      return;
    }

    try {
      const r = await fetch(`${API_BASE}/reservations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await r.json();

      // Termin upravo popunjen (race condition)
      if (r.status === 409) {
        if (msg) msg.textContent = "Nažalost, termin je upravo popunjen. Odaberi drugi.";
        resetTimeUI();
        await refreshAvailability();

        // (opcionalno) odmah otvori dropdown s vremenima
        const btn = timeCSelect?.querySelector(".cselect-btn");
        if (timeCSelect && btn) {
          timeCSelect.classList.add("open");
          btn.setAttribute("aria-expanded", "true");
        }
        return;
      }

      if (!r.ok) throw new Error(data?.error || "Greška");

      if (msg) msg.textContent = "Rezervacija spremljena! Vidimo se 😊";
      form.reset();

      // vrati date na today + reset custom selects
      if (dateEl) {
        dateEl.value = todayStr;
        dateEl.min = todayStr;
      }

      if (peopleHidden) peopleHidden.value = "";
      resetTimeUI();

      const peopleValueSpan = document.querySelector('.cselect[data-name="people"] .cselect-value');
      if (peopleValueSpan) peopleValueSpan.textContent = "Odaberi";

      // očisti time listu dok opet ne odabere people
      renderTimeOptions([]);

    } catch (err) {
      console.error(err);
      if (msg) msg.textContent = "Greška pri slanju. Pokušaj ponovno.";
    }
  });
});