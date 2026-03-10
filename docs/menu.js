// menu.js — vuče podatke iz /menu API-ja i dinamički renderira stavke

// ─── Fetch i render menija ────────────────────────────────────────────────────

async function loadMenu() {
  try {
    const r = await fetch("https://moxiecph.onrender.com/menu");
    if (!r.ok) throw new Error("Menu fetch failed");
    const data = await r.json();

    const foodCats  = data.categories.filter(c => c.type === "food");
    const drinkCats = data.categories.filter(c => c.type === "drink");

    renderPage("food",   foodCats);
    renderPage("drinks", drinkCats);

  } catch (err) {
    console.error("loadMenu error:", err);
  }
}

function renderPage(pageId, categories) {
  // Pronađi <section class="paper front/back"> koji odgovara pageId
  const paper = document.querySelector(
    pageId === "food" ? ".paper.front" : ".paper.back"
  );
  if (!paper) return;

  // Pronađi naslov i page-nav (zadrži ih)
  const title   = paper.querySelector(".paper-title");
  const pageNav = paper.querySelector(".page-nav");

  // Obrisi stare kategorije (sve osim naslova i navigacije)
  Array.from(paper.children).forEach(el => {
    if (el !== title && el !== pageNav) el.remove();
  });

  // Dodaj kategorije i stavke
  for (const cat of categories) {
    const catEl = document.createElement("div");
    catEl.className = "menu-cat";
    catEl.innerHTML = `<div class="menu-cat-title">${cat.name}</div>`;

    for (const item of cat.items) {
      const itemEl = document.createElement("div");
      itemEl.className = "item";
      itemEl.dataset.key = item.slug;
      itemEl.innerHTML = `
        <div class="item-img">
          <img src="${item.photo_url || ""}" alt="${item.title}" loading="lazy">
        </div>
        <div class="item-body">
          <div class="item-row">
            <strong>${item.title}</strong>
            <span class="price">${item.price}</span>
          </div>
          <p>${item.description || ""}</p>
        </div>`;
      catEl.appendChild(itemEl);
    }

    // Umetni prije page-nav
    if (pageNav) paper.insertBefore(catEl, pageNav);
    else paper.appendChild(catEl);
  }
}

// ─── Klik na stavku → item.html ───────────────────────────────────────────────

document.addEventListener("click", (e) => {
  const item = e.target.closest(".item");
  if (!item) return;
  const key = item.dataset.key;
  if (!key) return;
  const paper = item.closest(".paper");
  const from  = paper?.classList.contains("back") ? "drinks" : "food";
  window.location.href = `item.html?id=${encodeURIComponent(key)}&from=${from}`;
});

// ─── Tab iz URL parametra (npr. ?tab=drinks) ──────────────────────────────────

(function () {
  const params = new URLSearchParams(location.search);
  const tab    = params.get("tab");
  if (!tab) return;
  const food   = document.getElementById("page-food");
  const drinks = document.getElementById("page-drinks");
  if (tab === "drinks" && drinks) drinks.checked = true;
  if (tab === "food"   && food)   food.checked   = true;
})();

// ─── Init ─────────────────────────────────────────────────────────────────────

loadMenu();