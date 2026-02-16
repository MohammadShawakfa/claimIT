const app = document.getElementById("app");
const isLocalHost = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
const isLocalPreview = isLocalHost && window.location.port && window.location.port !== "3000";
const API_BASE = isLocalPreview ? "http://127.0.0.1:3000/api" : "/api";

const state = {
  currentUser: null,
};

boot();

async function boot() {
  const params = new URLSearchParams(window.location.search);
  const listId = params.get("list");
  if (listId) {
    await renderViewer(listId);
    return;
  }

  try {
    const auth = await api("/auth/me");
    state.currentUser = auth.user;
  } catch {
    state.currentUser = null;
  }

  if (!state.currentUser) {
    renderLanding();
    return;
  }

  const manageId = params.get("manage");
  if (manageId) {
    await renderEditor(manageId);
    return;
  }

  await renderDashboard();
}

function render(templateId) {
  const tpl = document.getElementById(templateId);
  app.innerHTML = "";
  app.appendChild(tpl.content.cloneNode(true));
}

function renderLanding() {
  render("landing-template");
  const form = document.getElementById("auth-form");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const email = fd.get("email").toString().trim();
    const name = fd.get("name").toString().trim();
    if (!email) return;

    try {
      const auth = await api("/auth/signin", {
        method: "POST",
        body: { email, name },
      });
      state.currentUser = auth.user;
      await renderDashboard();
    } catch (err) {
      alert(err.message || "Could not sign in.");
    }
  });
}

async function renderDashboard() {
  render("dashboard-template");
  document.getElementById("creator-label").textContent = `${state.currentUser.name} (${state.currentUser.email})`;

  document.getElementById("sign-out").addEventListener("click", async () => {
    try {
      await api("/auth/signout", { method: "POST" });
    } catch {
      // no-op: continue sign-out flow client-side
    }
    state.currentUser = null;
    const url = new URL(window.location.href);
    url.searchParams.delete("manage");
    window.history.pushState({}, "", url);
    renderLanding();
  });

  const createForm = document.getElementById("create-list-form");
  createForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(createForm);
    const title = fd.get("title").toString().trim();
    const description = fd.get("description").toString().trim();
    if (!title) return;

    try {
      const created = await api("/lists", {
        method: "POST",
        body: { title, description },
      });
      const url = new URL(window.location.href);
      url.searchParams.set("manage", created.list.id);
      window.history.pushState({}, "", url);
      await renderEditor(created.list.id);
    } catch (err) {
      alert(err.message || "Could not create list.");
    }
  });

  const grid = document.getElementById("list-grid");
  try {
    const payload = await api("/lists");
    const lists = payload.lists;
    if (!lists.length) {
      grid.innerHTML = `<div class="empty">No lists yet. Create your first celebration list.</div>`;
      return;
    }

    grid.innerHTML = lists.map((list) => {
      const claimCount = list.items.reduce((sum, item) => sum + item.claimers.length, 0);
      const ownerNames = list.owners.map((owner) => owner.name).join(", ");
      return `<article class="card">
        <h3>${escapeHtml(list.title)}</h3>
        <p class="muted">${escapeHtml(list.description || "No description")}</p>
        <p class="meta">Owners: ${escapeHtml(ownerNames)}</p>
        <p class="meta">${list.items.length} items - ${claimCount} claims</p>
        <div class="row wrap">
          <button data-open="${list.id}">Manage</button>
          <button class="secondary" data-copy="${viewerLink(list.id)}">Copy share link</button>
        </div>
      </article>`;
    }).join("");

    grid.querySelectorAll("[data-open]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const listId = btn.getAttribute("data-open");
        const url = new URL(window.location.href);
        url.searchParams.set("manage", listId);
        window.history.pushState({}, "", url);
        await renderEditor(listId);
      });
    });

    grid.querySelectorAll("[data-copy]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await copy(btn.getAttribute("data-copy"));
        btn.textContent = "Copied";
        setTimeout(() => {
          btn.textContent = "Copy share link";
        }, 1200);
      });
    });
  } catch (err) {
    grid.innerHTML = `<div class="empty">${escapeHtml(err.message || "Could not load lists.")}</div>`;
  }
}

async function renderEditor(listId) {
  let list;
  try {
    const payload = await api(`/lists/${encodeURIComponent(listId)}`);
    list = payload.list;
  } catch {
    await renderDashboard();
    return;
  }

  render("list-editor-template");
  const ownerNames = list.owners.map((owner) => owner.name);

  document.getElementById("list-title-heading").textContent = list.title;
  document.getElementById("list-description").textContent = list.description || "No description.";
  document.getElementById("owner-line").textContent = `Collaborators: ${ownerNames.join(", ")}`;
  const collaboratorManager = document.getElementById("collaborator-manager");
  const collaboratorList = document.getElementById("collaborator-list");
  const toggleCollaboratorsBtn = document.getElementById("toggle-collaborators");
  let collaboratorsOpen = false;

  renderCollaboratorList(list, collaboratorList);
  toggleCollaboratorsBtn.addEventListener("click", () => {
    collaboratorsOpen = !collaboratorsOpen;
    collaboratorManager.classList.toggle("hidden", !collaboratorsOpen);
    toggleCollaboratorsBtn.textContent = collaboratorsOpen ? "Done" : "Edit collaborators";
  });

  collaboratorList.querySelectorAll("[data-remove-collaborator]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ownerId = btn.getAttribute("data-remove-collaborator");
      try {
        await api(`/lists/${encodeURIComponent(listId)}/collaborators/${encodeURIComponent(ownerId)}`, {
          method: "DELETE",
        });
        await renderEditor(listId);
      } catch (err) {
        alert(err.message || "Could not remove collaborator.");
      }
    });
  });

  const share = document.getElementById("share-link");
  share.value = viewerLink(list.id);

  document.getElementById("copy-link").addEventListener("click", async () => {
    await copy(share.value);
  });

  document.getElementById("back-dashboard").addEventListener("click", async () => {
    const url = new URL(window.location.href);
    url.searchParams.delete("manage");
    window.history.pushState({}, "", url);
    await renderDashboard();
  });

  const collaboratorForm = document.getElementById("add-collaborator-form");
  collaboratorForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(collaboratorForm);
    const name = fd.get("collaboratorName").toString().trim();
    const email = fd.get("collaboratorEmail").toString().trim();
    if (!name || !email) return;

    try {
      await api(`/lists/${encodeURIComponent(listId)}/collaborators`, {
        method: "POST",
        body: { name, email },
      });
      await renderEditor(listId);
    } catch (err) {
      alert(err.message || "Could not add collaborator.");
    }
  });

  const addItemForm = document.getElementById("add-item-form");
  addItemForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(addItemForm);
    const imageFile = fd.get("imageFile");
    const image = imageFile && imageFile.size > 0 ? await fileToDataUrl(imageFile) : "";
    const productLink = normalizeExternalUrl(fd.get("productLink").toString().trim());

    const item = {
      name: fd.get("name").toString().trim(),
      description: fd.get("description").toString().trim(),
      price: Number(fd.get("price")) || 0,
      quantity: Math.max(1, Number(fd.get("quantity")) || 1),
      image,
      productLink,
    };
    if (!item.name) return;

    try {
      await api(`/lists/${encodeURIComponent(listId)}/items`, {
        method: "POST",
        body: item,
      });
      await renderEditor(listId);
    } catch (err) {
      alert(err.message || "Could not add item.");
    }
  });

  const itemsWrap = document.getElementById("creator-items");
  if (!list.items.length) {
    itemsWrap.innerHTML = `<div class="empty">No items yet. Add your first wish above.</div>`;
    return;
  }

  itemsWrap.innerHTML = list.items
    .map((item) => creatorItemMarkup(item, state.currentUser.id))
    .join("");

  itemsWrap.querySelectorAll("[data-delete-item]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const itemId = btn.getAttribute("data-delete-item");
      try {
        await api(`/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`, {
          method: "DELETE",
        });
        await renderEditor(listId);
      } catch (err) {
        alert(err.message || "Could not delete item.");
      }
    });
  });

  itemsWrap.querySelectorAll("[data-edit-item]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const itemId = btn.getAttribute("data-edit-item");
      const item = list.items.find((entry) => entry.id === itemId);
      if (!item) return;

      const name = prompt("Item name", item.name);
      if (!name) return;
      const description = prompt("Description", item.description || "") || "";
      const price = Number(prompt("Price", String(item.price)) || item.price) || 0;
      const quantity = Math.max(1, Number(prompt("Quantity", String(item.quantity)) || item.quantity));
      const productLink = normalizeExternalUrl(prompt("Product link", item.productLink || "") || "");

      try {
        await api(`/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`, {
          method: "PATCH",
          body: {
            name: name.trim(),
            description: description.trim(),
            price,
            quantity,
            productLink,
          },
        });
        await renderEditor(listId);
      } catch (err) {
        alert(err.message || "Could not update item.");
      }
    });
  });

  itemsWrap.querySelectorAll("[data-claim-owner]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const itemId = btn.getAttribute("data-claim-owner");
      try {
        await api(`/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}/claim`, {
          method: "POST",
        });
        await renderEditor(listId);
      } catch (err) {
        alert(err.message || "Could not claim item.");
      }
    });
  });

  itemsWrap.querySelectorAll("[data-unclaim-owner]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const itemId = btn.getAttribute("data-unclaim-owner");
      try {
        await api(`/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}/claim`, {
          method: "DELETE",
        });
        await renderEditor(listId);
      } catch (err) {
        alert(err.message || "Could not remove your claim.");
      }
    });
  });
}

function renderCollaboratorList(list, mount) {
  const rows = list.owners.map((owner) => {
    const isSelf = owner.id === state.currentUser.id;
    const removeButton = isSelf
      ? `<button class="secondary" disabled>You</button>`
      : `<button class="danger" data-remove-collaborator="${owner.id}">Remove</button>`;
    return `<div class="row between center collaborator-row">
      <div>
        <div class="item-title">${escapeHtml(owner.name)}</div>
        <div class="meta">${escapeHtml(owner.email)}</div>
      </div>
      ${removeButton}
    </div>`;
  }).join("");

  mount.innerHTML = rows || `<div class="empty">No collaborators yet.</div>`;
}

async function renderViewer(listId) {
  let list;
  try {
    const payload = await api(`/public/lists/${encodeURIComponent(listId)}`);
    list = payload.list;
  } catch {
    app.innerHTML = `<section class="panel"><div class="empty">This list was not found.</div></section>`;
    return;
  }

  render("viewer-template");
  document.getElementById("viewer-list-title").textContent = list.title;
  document.getElementById("viewer-list-desc").textContent = list.description || "";

  const itemsWrap = document.getElementById("viewer-items");
  if (!list.items.length) {
    itemsWrap.innerHTML = `<div class="empty">This list has no items yet.</div>`;
    return;
  }

  itemsWrap.innerHTML = list.items.map((item) => viewerItemMarkup(list.id, item)).join("");

  itemsWrap.querySelectorAll("[data-claim-item]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const itemId = btn.getAttribute("data-claim-item");
      const name = (prompt("Optional: your name") || "").trim();
      try {
        await api(`/public/lists/${encodeURIComponent(list.id)}/items/${encodeURIComponent(itemId)}/claim`, {
          method: "POST",
          body: { name },
        });
        await renderViewer(list.id);
      } catch (err) {
        alert(err.message || "Could not claim item.");
      }
    });
  });
}

function creatorItemMarkup(item, currentUserId) {
  const claimCount = item.claimers.length;
  const claimed = claimCount > 0;
  const claimedByCurrentOwner = item.claimers.some(
    (claimer) => claimer.source === "owner" && claimer.userId === currentUserId
  );
  return `<article class="item-card">
    ${item.image ? `<img alt="${escapeHtml(item.name)}" src="${escapeAttr(item.image)}" onerror="this.style.display='none'">` : ""}
    <div class="item-body">
      <div class="row between center">
        <span class="item-title">${escapeHtml(item.name)}</span>
        <span class="tag ${claimed ? "claimed" : ""}">${claimed ? "Claimed" : "Open"}</span>
      </div>
      <p class="muted">${escapeHtml(item.description || "No notes")}</p>
      <p class="meta">$${item.price.toFixed(2)} - Need ${item.quantity} - Claimed ${claimCount}</p>
      <p class="claimers">${claimed ? `Contributors: ${escapeHtml(item.claimers.map((c) => c.name).join(", "))}` : "No one has claimed this yet."}</p>
      <div class="row wrap">
        ${
          claimedByCurrentOwner
            ? `<button class="secondary" data-unclaim-owner="${item.id}">Unclaim</button>`
            : `<button data-claim-owner="${item.id}">Claim as owner</button>`
        }
        ${item.productLink ? `<a class="button-link secondary" href="${escapeAttr(item.productLink)}" target="_blank" rel="noopener noreferrer">Open item link</a>` : ""}
        <button class="secondary" data-edit-item="${item.id}">Edit</button>
        <button class="danger" data-delete-item="${item.id}">Delete</button>
      </div>
    </div>
  </article>`;
}

function viewerItemMarkup(listId, item) {
  const claimCount = item.claimers.length;
  const claimed = claimCount > 0;
  return `<article class="item-card">
    ${item.image ? `<img alt="${escapeHtml(item.name)}" src="${escapeAttr(item.image)}" onerror="this.style.display='none'">` : ""}
    <div class="item-body">
      <div class="row between center">
        <span class="item-title">${escapeHtml(item.name)}</span>
        <span class="tag ${claimed ? "claimed" : ""}">${claimed ? `${claimCount} claim${claimCount > 1 ? "s" : ""}` : "Open"}</span>
      </div>
      <p class="muted">${escapeHtml(item.description || "No notes")}</p>
      <p class="meta">$${item.price.toFixed(2)} - Need ${item.quantity} - Claimed ${claimCount}</p>
      <p class="claimers">${claimed ? `Contributors: ${escapeHtml(item.claimers.map((c) => c.name).join(", "))}` : "No one has claimed this yet."}</p>
      ${item.productLink ? `<a class="button-link secondary" href="${escapeAttr(item.productLink)}" target="_blank" rel="noopener noreferrer">Open item link</a>` : ""}
      <button data-claim-item="${item.id}" data-list-id="${listId}">I Got It!</button>
    </div>
  </article>`;
}

function viewerLink(listId) {
  const url = new URL(window.location.href);
  url.searchParams.delete("manage");
  url.searchParams.set("list", listId);
  return url.toString();
}

async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    credentials: "include",
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const data = await readJson(res);
  if (!res.ok) {
    throw new Error(data.error || "Request failed.");
  }
  return data;
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const helper = document.createElement("textarea");
    helper.value = text;
    document.body.appendChild(helper);
    helper.select();
    document.execCommand("copy");
    helper.remove();
  }
}

function normalizeExternalUrl(raw) {
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.toString();
    }
    return "";
  } catch {
    return "";
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read image file."));
    reader.readAsDataURL(file);
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}
