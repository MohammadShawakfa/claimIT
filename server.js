const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

ensureDataStore();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname);
      return;
    }

    await serveStatic(req, res, pathname);
  } catch (err) {
    if (err && err.message === "Invalid JSON body.") {
      sendJson(res, 400, { error: "Invalid JSON body." });
      return;
    }
    sendJson(res, 500, { error: "Internal server error." });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`WishNest server running at http://${HOST}:${PORT}`);
});

async function handleApi(req, res, pathname) {
  const db = readDb();
  const method = req.method || "GET";
  applyCors(req, res);
  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const user = getAuthedUser(req, db);

  if (method === "POST" && pathname === "/api/auth/signin") {
    const body = await readBody(req);
    const email = normalizeEmail(body.email);
    const name = String(body.name || "").trim();
    if (!isValidEmail(email)) {
      sendJson(res, 400, { error: "Valid email is required." });
      return;
    }

    let existing = db.users.find((entry) => entry.email === email);
    if (!existing) {
      if (!name) {
        sendJson(res, 400, { error: "Name is required for first sign in." });
        return;
      }
      existing = {
        id: uid("user"),
        name,
        email,
        createdAt: Date.now(),
      };
      db.users.push(existing);
    }

    const token = crypto.randomBytes(24).toString("hex");
    db.sessions.push({
      token,
      userId: existing.id,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    });
    writeDb(db);
    setSessionCookie(res, token);
    sendJson(res, 200, { user: toPublicUser(existing) });
    return;
  }

  if (method === "POST" && pathname === "/api/auth/signout") {
    const sid = parseCookies(req).sid;
    if (sid) {
      db.sessions = db.sessions.filter((session) => session.token !== sid);
      writeDb(db);
    }
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === "GET" && pathname === "/api/auth/me") {
    if (!user) {
      sendJson(res, 401, { error: "Unauthorized." });
      return;
    }
    sendJson(res, 200, { user: toPublicUser(user) });
    return;
  }

  const publicListMatch = pathname.match(/^\/api\/public\/lists\/([^/]+)$/);
  if (publicListMatch && method === "GET") {
    const listId = decodeURIComponent(publicListMatch[1]);
    const list = db.lists.find((entry) => entry.id === listId);
    if (!list) {
      sendJson(res, 404, { error: "List not found." });
      return;
    }
    sendJson(res, 200, { list: serializePublicList(list) });
    return;
  }

  const claimMatch = pathname.match(/^\/api\/public\/lists\/([^/]+)\/items\/([^/]+)\/claim$/);
  if (claimMatch && method === "POST") {
    const listId = decodeURIComponent(claimMatch[1]);
    const itemId = decodeURIComponent(claimMatch[2]);
    const list = db.lists.find((entry) => entry.id === listId);
    if (!list) {
      sendJson(res, 404, { error: "List not found." });
      return;
    }
    const item = list.items.find((entry) => entry.id === itemId);
    if (!item) {
      sendJson(res, 404, { error: "Item not found." });
      return;
    }

    const body = await readBody(req);
    const name = String(body.name || "").trim() || "Anonymous";
    item.claimers.push({ name, claimedAt: Date.now() });
    writeDb(db);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!user) {
    sendJson(res, 401, { error: "Unauthorized." });
    return;
  }

  if (method === "GET" && pathname === "/api/lists") {
    const lists = db.lists
      .filter((list) => list.ownerIds.includes(user.id))
      .map((list) => serializePrivateList(list, db));
    sendJson(res, 200, { lists });
    return;
  }

  if (method === "POST" && pathname === "/api/lists") {
    const body = await readBody(req);
    const title = String(body.title || "").trim();
    const description = String(body.description || "").trim();
    if (!title) {
      sendJson(res, 400, { error: "List title is required." });
      return;
    }

    const list = {
      id: uid("list"),
      title,
      description,
      ownerIds: [user.id],
      items: [],
      createdAt: Date.now(),
    };
    db.lists.unshift(list);
    writeDb(db);
    sendJson(res, 201, { list: serializePrivateList(list, db) });
    return;
  }

  const listMatch = pathname.match(/^\/api\/lists\/([^/]+)$/);
  if (listMatch) {
    const listId = decodeURIComponent(listMatch[1]);
    const list = db.lists.find((entry) => entry.id === listId);
    if (!list || !list.ownerIds.includes(user.id)) {
      sendJson(res, 404, { error: "List not found." });
      return;
    }
    if (method === "GET") {
      sendJson(res, 200, { list: serializePrivateList(list, db) });
      return;
    }
  }

  const collabMatch = pathname.match(/^\/api\/lists\/([^/]+)\/collaborators$/);
  if (collabMatch && method === "POST") {
    const listId = decodeURIComponent(collabMatch[1]);
    const list = db.lists.find((entry) => entry.id === listId);
    if (!list || !list.ownerIds.includes(user.id)) {
      sendJson(res, 404, { error: "List not found." });
      return;
    }

    const body = await readBody(req);
    const name = String(body.name || "").trim();
    const email = normalizeEmail(body.email);
    if (!name) {
      sendJson(res, 400, { error: "Collaborator name is required." });
      return;
    }
    if (!isValidEmail(email)) {
      sendJson(res, 400, { error: "Valid collaborator email is required." });
      return;
    }

    let collaborator = db.users.find((entry) => entry.email === email);
    if (!collaborator) {
      collaborator = {
        id: uid("user"),
        name,
        email,
        createdAt: Date.now(),
      };
      db.users.push(collaborator);
    }

    if (!list.ownerIds.includes(collaborator.id)) {
      list.ownerIds.push(collaborator.id);
    }
    writeDb(db);
    sendJson(res, 200, { list: serializePrivateList(list, db) });
    return;
  }

  const removeCollabMatch = pathname.match(/^\/api\/lists\/([^/]+)\/collaborators\/([^/]+)$/);
  if (removeCollabMatch && method === "DELETE") {
    const listId = decodeURIComponent(removeCollabMatch[1]);
    const collaboratorId = decodeURIComponent(removeCollabMatch[2]);
    const list = db.lists.find((entry) => entry.id === listId);
    if (!list || !list.ownerIds.includes(user.id)) {
      sendJson(res, 404, { error: "List not found." });
      return;
    }
    if (!list.ownerIds.includes(collaboratorId)) {
      sendJson(res, 404, { error: "Collaborator not found." });
      return;
    }
    if (collaboratorId === user.id) {
      sendJson(res, 400, { error: "You cannot remove yourself from this list." });
      return;
    }
    if (list.ownerIds.length <= 1) {
      sendJson(res, 400, { error: "A list must have at least one collaborator." });
      return;
    }

    list.ownerIds = list.ownerIds.filter((ownerId) => ownerId !== collaboratorId);
    writeDb(db);
    sendJson(res, 200, { list: serializePrivateList(list, db) });
    return;
  }

  const addItemMatch = pathname.match(/^\/api\/lists\/([^/]+)\/items$/);
  if (addItemMatch && method === "POST") {
    const listId = decodeURIComponent(addItemMatch[1]);
    const list = db.lists.find((entry) => entry.id === listId);
    if (!list || !list.ownerIds.includes(user.id)) {
      sendJson(res, 404, { error: "List not found." });
      return;
    }

    const body = await readBody(req);
    const name = String(body.name || "").trim();
    if (!name) {
      sendJson(res, 400, { error: "Item name is required." });
      return;
    }

    const item = {
      id: uid("item"),
      name,
      description: String(body.description || "").trim(),
      price: nonNegativeNumber(body.price),
      quantity: positiveInt(body.quantity),
      image: String(body.image || ""),
      productLink: normalizeUrl(String(body.productLink || "").trim()),
      claimers: [],
      createdAt: Date.now(),
    };
    list.items.unshift(item);
    writeDb(db);
    sendJson(res, 201, { item });
    return;
  }

  const ownerClaimMatch = pathname.match(/^\/api\/lists\/([^/]+)\/items\/([^/]+)\/claim$/);
  if (ownerClaimMatch) {
    const listId = decodeURIComponent(ownerClaimMatch[1]);
    const itemId = decodeURIComponent(ownerClaimMatch[2]);
    const list = db.lists.find((entry) => entry.id === listId);
    if (!list || !list.ownerIds.includes(user.id)) {
      sendJson(res, 404, { error: "List not found." });
      return;
    }
    const item = list.items.find((entry) => entry.id === itemId);
    if (!item) {
      sendJson(res, 404, { error: "Item not found." });
      return;
    }

    if (method === "POST") {
      const alreadyClaimedByOwner = item.claimers.some(
        (claimer) => claimer.source === "owner" && claimer.userId === user.id
      );
      if (!alreadyClaimedByOwner) {
        item.claimers.push({
          name: user.name,
          userId: user.id,
          source: "owner",
          claimedAt: Date.now(),
        });
        writeDb(db);
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "DELETE") {
      item.claimers = item.claimers.filter(
        (claimer) => !(claimer.source === "owner" && claimer.userId === user.id)
      );
      writeDb(db);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  const itemMatch = pathname.match(/^\/api\/lists\/([^/]+)\/items\/([^/]+)$/);
  if (itemMatch) {
    const listId = decodeURIComponent(itemMatch[1]);
    const itemId = decodeURIComponent(itemMatch[2]);
    const list = db.lists.find((entry) => entry.id === listId);
    if (!list || !list.ownerIds.includes(user.id)) {
      sendJson(res, 404, { error: "List not found." });
      return;
    }
    const item = list.items.find((entry) => entry.id === itemId);
    if (!item) {
      sendJson(res, 404, { error: "Item not found." });
      return;
    }

    if (method === "DELETE") {
      list.items = list.items.filter((entry) => entry.id !== itemId);
      writeDb(db);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "PATCH") {
      const body = await readBody(req);
      const name = String(body.name || "").trim();
      if (!name) {
        sendJson(res, 400, { error: "Item name is required." });
        return;
      }

      item.name = name;
      item.description = String(body.description || "").trim();
      item.price = nonNegativeNumber(body.price);
      item.quantity = positiveInt(body.quantity);
      item.productLink = normalizeUrl(String(body.productLink || "").trim());
      writeDb(db);
      sendJson(res, 200, { item });
      return;
    }
  }

  sendJson(res, 404, { error: "Not found." });
}

async function serveStatic(req, res, pathname) {
  const method = req.method || "GET";
  if (method !== "GET" && method !== "HEAD") {
    sendJson(res, 404, { error: "Not found." });
    return;
  }

  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(ROOT, `.${cleanPath}`);
  if (!filePath.startsWith(ROOT)) {
    sendJson(res, 403, { error: "Forbidden." });
    return;
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendJson(res, 404, { error: "File not found." });
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const type = mimeType(ext);
  const content = fs.readFileSync(filePath);
  res.writeHead(200, { "Content-Type": type });
  if (method === "HEAD") {
    res.end();
    return;
  }
  res.end(content);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readDb() {
  ensureDataStore();
  try {
    const raw = fs.readFileSync(DB_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      lists: Array.isArray(parsed.lists) ? parsed.lists : [],
    };
  } catch {
    return { users: [], sessions: [], lists: [] };
  }
}

function writeDb(db) {
  ensureDataStore();
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
}

function ensureDataStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_FILE)) {
    const initial = { users: [], sessions: [], lists: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2), "utf8");
  }
}

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function toPublicUser(user) {
  return { id: user.id, name: user.name, email: user.email };
}

function serializePrivateList(list, db) {
  const owners = list.ownerIds
    .map((ownerId) => db.users.find((entry) => entry.id === ownerId))
    .filter(Boolean)
    .map(toPublicUser);
  return {
    id: list.id,
    title: list.title,
    description: list.description,
    owners,
    items: list.items || [],
    createdAt: list.createdAt,
  };
}

function serializePublicList(list) {
  return {
    id: list.id,
    title: list.title,
    description: list.description,
    items: list.items || [],
    createdAt: list.createdAt,
  };
}

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  return raw.split(";").reduce((acc, part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return acc;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
}

function getAuthedUser(req, db) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  const session = db.sessions.find((entry) => entry.token === sid);
  if (!session) return null;
  return db.users.find((entry) => entry.id === session.userId) || null;
}

function setSessionCookie(res, token) {
  res.setHeader("Set-Cookie", `sid=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}

function normalizeEmail(emailRaw) {
  return String(emailRaw || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function nonNegativeNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function positiveInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

function normalizeUrl(raw) {
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.toString();
    }
  } catch {
    return "";
  }
  return "";
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function mimeType(ext) {
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  if (!isAllowedOrigin(origin)) return;

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
}

function isAllowedOrigin(origin) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}
