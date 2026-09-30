// 抽签助手 · 共享版服务器（零依赖，直接用 Node 运行）
//
// 功能：多人共用一个抽签状态，内容与结果实时同步。
// 用法：node server.js
// 端口：可用环境变量 PORT 指定，默认 8080。

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 8080;
const ROOT = path.join(__dirname, "site");
const DATA_FILE = path.join(__dirname, "data.json");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

// ---- 共享状态（所有访客共用）----
let roundItems = []; // 本轮完整签列表
let pool = [];       // 剩余签（不重复模式下抽过会减少）
let mode = "unique"; // unique | repeat
let quantity = 1;    // 每次抽取数量
let history = [];    // [{ id, time, values }]
let revision = 0;    // 每次变化自增
let online = 0;      // 当前在线人数
let hostPassword = ""; // 主持人密码（只有知道密码的人能设置/抽签）

const clients = new Set(); // 所有 SSE 连接

function randInt(n) {
  return crypto.randomInt(n);
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function formatTime(d) {
  return pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " +
    pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}

function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map(function (s) { return String(s).trim(); })
    .filter(Boolean);
}

function newPassword() {
  return crypto.randomBytes(4).toString("hex");
}

function authorized(body) {
  return !!hostPassword && !!body && String(body.password) === hostPassword;
}

function initHostPassword() {
  if (process.env.HOST_PASSWORD && String(process.env.HOST_PASSWORD).trim()) {
    hostPassword = String(process.env.HOST_PASSWORD).trim();
    saveState();
  } else if (!hostPassword) {
    hostPassword = newPassword();
    saveState();
  }
}

// ---- 持久化 ----
function loadState() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const d = JSON.parse(raw);
    if (!d) return;
    if (typeof d.hostPassword === "string" && d.hostPassword) {
      hostPassword = d.hostPassword;
    }
    if (Array.isArray(d.roundItems)) {
      roundItems = normalizeItems(d.roundItems);
      pool = Array.isArray(d.pool) ? normalizeItems(d.pool) : roundItems.slice();
      mode = d.mode === "repeat" ? "repeat" : "unique";
      quantity = Math.max(1, parseInt(d.quantity, 10) || 1);
      history = Array.isArray(d.history) ? d.history : [];
    }
  } catch (e) {
    // 首次运行，没有存档，忽略
  }
}

function saveState() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({
      roundItems: roundItems,
      pool: pool,
      mode: mode,
      quantity: quantity,
      history: history,
      hostPassword: hostPassword
    }, null, 2));
  } catch (e) {
    // 存档失败不影响使用
  }
}

function publicState() {
  return {
    roundItems: roundItems,
    pool: pool,
    total: roundItems.length,
    remaining: mode === "unique" ? pool.length : roundItems.length,
    mode: mode,
    quantity: quantity,
    history: history,
    online: online,
    revision: revision,
    locked: !!hostPassword
  };
}

function bump() {
  revision++;
  saveState();
  broadcast();
}

// ---- 业务操作 ----
function setConfig(body) {
  const newItems = normalizeItems(body && body.items);
  const newMode = body && body.mode === "repeat" ? "repeat" : "unique";
  const newQty = Math.max(1, parseInt(body && body.quantity, 10) || 1);

  const itemsChanged = JSON.stringify(newItems) !== JSON.stringify(roundItems);

  roundItems = newItems;
  mode = newMode;
  quantity = newQty;

  if (itemsChanged) {
    // 换了内容 = 开启新一轮
    pool = newItems.slice();
    history = [];
  } else if (mode === "unique" && pool.length > roundItems.length) {
    // 安全兜底：池子异常时恢复为完整列表
    pool = roundItems.slice();
  }

  bump();
}

function doDraw() {
  if (roundItems.length === 0) {
    return { error: "请先设置抽签内容" };
  }

  if (mode === "unique") {
    if (pool.length === 0) {
      return { error: "签已全部抽完，请重新开始本轮" };
    }
    if (quantity > pool.length) {
      return { error: "剩余签不足，只剩 " + pool.length + " 个" };
    }
    const p = pool.slice();
    const values = [];
    for (let i = 0; i < quantity; i++) {
      const idx = randInt(p.length);
      values.push(p[idx]);
      p.splice(idx, 1);
    }
    pool = p;
    pushHistory(values);
  } else {
    const values = [];
    for (let i = 0; i < quantity; i++) {
      values.push(roundItems[randInt(roundItems.length)]);
    }
    pushHistory(values);
  }
  return null;
}

function pushHistory(values) {
  const id = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  history.unshift({
    id: id,
    time: formatTime(new Date()),
    values: values
  });
  history = history.slice(0, 200);
  bump();
}

function doUndo() {
  if (history.length === 0) {
    return { error: "没有可撤销的抽签" };
  }
  const last = history.shift();
  if (mode === "unique") {
    for (const v of last.values) pool.push(v);
  }
  bump();
  return null;
}

function resetRound() {
  pool = roundItems.slice();
  history = [];
  bump();
}

// ---- HTTP 工具 ----
function sendJSON(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise(function (resolve) {
    let data = "";
    req.on("data", function (c) {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on("end", function () {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        resolve({});
      }
    });
    req.on("error", function () { resolve({}); });
  });
}

function broadcast() {
  const msg = "data: " + JSON.stringify(publicState()) + "\n\n";
  for (const c of clients) {
    try { c.write(msg); } catch (e) { clients.delete(c); }
  }
}

function handleSSE(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write("retry: 3000\n\n");

  clients.add(res);
  online++;
  broadcast(); // 立即把当前状态（含在线人数）推给所有客户端

  const hb = setInterval(function () {
    try { res.write(": ping\n\n"); } catch (e) { /* ignore */ }
  }, 25000);

  req.on("close", function () {
    clearInterval(hb);
    clients.delete(res);
    online = Math.max(0, online - 1);
    broadcast();
  });
}

function serveStatic(req, res, pathname) {
  let urlPath = decodeURIComponent(pathname);
  if (urlPath === "/") urlPath = "/index.html";

  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("403 Forbidden");
    return;
  }

  fs.readFile(filePath, function (err, data) {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 未找到该页面");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    res.end(data);
  });
}

// ---- 路由 ----
const server = http.createServer(async function (req, res) {
  let pathname;
  try {
    pathname = new URL(req.url, "http://localhost").pathname;
  } catch (e) {
    pathname = "/";
  }
  const method = req.method;

  if (pathname === "/api/state" && method === "GET") {
    return sendJSON(res, 200, publicState());
  }
  if (pathname === "/api/auth" && method === "POST") {
    const body = await readBody(req);
    if (authorized(body)) return sendJSON(res, 200, { ok: true });
    return sendJSON(res, 401, { error: "密码错误" });
  }
  if (pathname === "/api/config" && method === "POST") {
    const body = await readBody(req);
    if (!authorized(body)) return sendJSON(res, 401, { error: "密码错误" });
    setConfig(body);
    return sendJSON(res, 200, publicState());
  }
  if (pathname === "/api/draw" && method === "POST") {
    const body = await readBody(req);
    if (!authorized(body)) return sendJSON(res, 401, { error: "密码错误" });
    const err = doDraw();
    if (err) return sendJSON(res, 400, { error: err.error });
    return sendJSON(res, 200, publicState());
  }
  if (pathname === "/api/undo" && method === "POST") {
    const body = await readBody(req);
    if (!authorized(body)) return sendJSON(res, 401, { error: "密码错误" });
    const err = doUndo();
    if (err) return sendJSON(res, 400, { error: err.error });
    return sendJSON(res, 200, publicState());
  }
  if (pathname === "/api/reset" && method === "POST") {
    const body = await readBody(req);
    if (!authorized(body)) return sendJSON(res, 401, { error: "密码错误" });
    resetRound();
    return sendJSON(res, 200, publicState());
  }
  if (pathname === "/api/events" && method === "GET") {
    return handleSSE(req, res);
  }

  return serveStatic(req, res, pathname);
});

loadState();
initHostPassword();
server.listen(PORT, "0.0.0.0", function () {
  console.log("抽签助手 · 共享版已启动 ✅");
  console.log("");
  console.log("  主持人密码: " + hostPassword + "   （只有主持人能设置和抽签，请勿泄露）");
  console.log("");
  console.log("  本机访问:   http://localhost:" + PORT);
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) ips.push(iface.address);
    }
  }
  ips.forEach(function (ip) {
    console.log("  局域网分享: http://" + ip + ":" + PORT);
  });
  if (ips.length === 0) {
    console.log("  （未检测到局域网 IP，请确认已连接 WiFi）");
  }
  console.log("");
  console.log("把分享地址发给所有人，即可共用同一份签、实时同步结果。");
  console.log("按 Ctrl+C 停止服务。");
});
