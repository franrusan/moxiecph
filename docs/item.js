// item.js — vuče podatke iz /menu/:slug API-ja

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
  const params = new URLSearchParams(location.search);
  const slug   = params.get("id");
  const from   = params.get("from") || "food";

  // back link
  const back = $("backToMenu");
  if (back) back.href = `menu.html?tab=${encodeURIComponent(from)}`;

  if (!slug) {
    if ($("itemTitle")) $("itemTitle").textContent = "Stavka nije pronađena.";
    return;
  }

  try {
    const r = await fetch(`https://moxiecph.onrender.com/menu/${encodeURIComponent(slug)}`);
    if (!r.ok) throw new Error("Not found");
    const item = await r.json();

    // Popuni stranicu
    if ($("itemTitle"))    $("itemTitle").textContent    = item.title       || "—";
    if ($("itemPrice"))    $("itemPrice").textContent    = item.price       || "";
    if ($("itemDesc"))     $("itemDesc").textContent     = item.description || "";

    const img = $("itemPhoto");
    if (img) {
      img.src = item.photo_url || "";
      img.alt = item.title     || "Photo";
    }

    document.title = item.title || "Stavka";

    // Dish vs drink
    const dishOnly = $("dishOnly");
    if (item.category_type === "drink") {
      if (dishOnly) dishOnly.style.display = "none";
    } else {
      if (dishOnly) dishOnly.style.display = "";
      if ($("itemIngredients")) {
        $("itemIngredients").innerHTML = (item.ingredients || [])
          .map(x => `<li>${x}</li>`).join("");
      }
      if ($("itemSteps")) {
        $("itemSteps").innerHTML = (item.steps || [])
          .map((x, i) => `<li>${i + 1}. ${x}</li>`).join("");
      }
    }

  } catch (err) {
    if ($("itemTitle")) $("itemTitle").textContent = "Stavka nije pronađena.";
    console.error("item.js fetch error:", err);
  }
});