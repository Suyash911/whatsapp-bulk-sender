const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const multer = require("multer");
const ExcelJS = require("exceljs");
const QRCode = require("qrcode");
const { Server } = require("socket.io");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, "uploads");
const REPORT_DIR = path.join(ROOT, "reports");
const SESSION_DIR = path.join(ROOT, "sessions");
const DATA_DIR = path.join(ROOT, "data");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");

for (const dir of [UPLOAD_DIR, REPORT_DIR, SESSION_DIR, DATA_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 30 * 1024 * 1024 }
});

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(ROOT, "public")));
app.use("/reports", express.static(REPORT_DIR));

let accounts = loadAccounts();
let currentDraft = null;
const clients = new Map();
const broadcasts = new Map();

for (const account of accounts) {
  startAccountClient(account.id);
}

io.on("connection", (socket) => {
  socket.emit("accounts", accountSnapshots());
  socket.emit("broadcasts", broadcastSnapshots());
});

app.get("/api/accounts", (_req, res) => {
  res.json({ accounts: accountSnapshots() });
});

app.post("/api/accounts", (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) {
    return res.status(400).json({ error: "Account name is required." });
  }

  const account = {
    id: uniqueId(slugify(name) || "account"),
    name,
    createdAt: new Date().toISOString()
  };
  accounts.push(account);
  saveAccounts();
  startAccountClient(account.id);
  emitAccounts();

  res.json({ account: accountSnapshot(account.id) });
});

app.post("/api/accounts/:id/refresh", async (req, res) => {
  const account = getAccount(req.params.id);
  if (!account) {
    return res.status(404).json({ error: "Account not found." });
  }

  const state = clients.get(account.id);
  if (state?.ready) {
    return res.json({ ok: true, account: accountSnapshot(account.id), message: "Account is already linked." });
  }

  await restartAccountClient(account.id, { clearSession: true });
  res.json({ ok: true, account: accountSnapshot(account.id), message: "QR refresh started." });
});

app.delete("/api/accounts/:id", async (req, res) => {
  const account = getAccount(req.params.id);
  if (!account) {
    return res.status(404).json({ error: "Account not found." });
  }

  if (hasActiveBroadcastForAccount(account.id)) {
    return res.status(409).json({ error: "Stop the active or scheduled broadcast for this account first." });
  }

  const state = clients.get(account.id);
  if (state?.client) {
    try {
      await state.client.destroy();
    } catch (_error) {
      // If Chromium is already gone, continue removing the saved account.
    }
  }

  clients.delete(account.id);
  clearLocalSession(account.id);
  accounts = accounts.filter((item) => item.id !== account.id);
  saveAccounts();
  emitAccounts();

  res.json({ ok: true });
});

app.post(
  "/api/draft",
  upload.fields([
    { name: "excel", maxCount: 1 },
    { name: "media", maxCount: 1 }
  ]),
  async (req, res) => {
    const excel = req.files?.excel?.[0];
    const media = req.files?.media?.[0] || null;
    if (!excel) {
      return res.status(400).json({ error: "Excel file is required." });
    }

    try {
      const { sheetName, headers, rows } = await readSpreadsheet(excel.path, excel.originalname);
      if (!rows.length) {
        return res.status(400).json({ error: "The first sheet has no rows." });
      }

      currentDraft = {
        id: uniqueId("draft"),
        excel,
        media,
        sheetName,
        headers,
        rows,
        createdAt: new Date().toISOString()
      };

      res.json(draftSnapshot(currentDraft));
    } catch (error) {
      res.status(400).json({ error: `Could not read Excel file: ${error.message}` });
    }
  }
);

app.get("/api/draft", (_req, res) => {
  res.json({ loaded: Boolean(currentDraft), draft: currentDraft ? draftSnapshot(currentDraft) : null });
});

app.post("/api/broadcasts", (req, res) => {
  if (!currentDraft) {
    return res.status(400).json({ error: "Upload an Excel file first." });
  }

  const options = normalizeBroadcastOptions(req.body, currentDraft.headers);
  if (!getAccount(options.accountId)) {
    return res.status(400).json({ error: "Choose a saved WhatsApp account." });
  }
  const accountState = clients.get(options.accountId);
  if (!accountState?.ready) {
    return res.status(400).json({ error: "Selected WhatsApp account is not linked yet." });
  }
  if (!options.message && !currentDraft.media) {
    return res.status(400).json({ error: "Enter a message or attach media." });
  }
  if (!options.consentConfirmed) {
    return res.status(400).json({ error: "Confirm that these contacts opted in." });
  }
  if (hasActiveBroadcastForAccount(options.accountId)) {
    return res.status(409).json({ error: "This account already has a running or scheduled broadcast." });
  }

  const broadcast = {
    id: uniqueId("broadcast"),
    name: options.name,
    accountId: options.accountId,
    accountName: getAccount(options.accountId).name,
    rows: currentDraft.rows,
    headers: currentDraft.headers,
    mediaPath: currentDraft.media?.path || null,
    mediaName: currentDraft.media?.originalname || null,
    mediaMimeType: currentDraft.media?.mimetype || null,
    options,
    total: currentDraft.rows.length,
    sent: 0,
    failed: 0,
    skipped: 0,
    status: options.scheduledAt ? "scheduled" : "running",
    createdAt: new Date().toISOString(),
    scheduledAt: options.scheduledAt,
    startedAt: null,
    finishedAt: null,
    reportUrl: null,
    stopRequested: false,
    timer: null
  };

  broadcasts.set(broadcast.id, broadcast);
  emitBroadcasts();

  if (options.scheduledAt) {
    const waitMs = Math.max(0, new Date(options.scheduledAt).getTime() - Date.now());
    broadcast.timer = setTimeout(() => runBroadcast(broadcast.id), waitMs);
  } else {
    runBroadcast(broadcast.id);
  }

  res.json({ broadcast: broadcastSnapshot(broadcast) });
});

app.post("/api/broadcasts/:id/stop", (req, res) => {
  const broadcast = broadcasts.get(req.params.id);
  if (!broadcast) {
    return res.status(404).json({ error: "Broadcast not found." });
  }

  broadcast.stopRequested = true;
  if (broadcast.status === "scheduled" && broadcast.timer) {
    clearTimeout(broadcast.timer);
    broadcast.status = "stopped";
    broadcast.finishedAt = new Date().toISOString();
  }
  emitBroadcasts();
  res.json({ ok: true });
});

app.get("/api/broadcasts", (_req, res) => {
  res.json({ broadcasts: broadcastSnapshots() });
});

app.get("/api/reports", (_req, res) => {
  const files = fs
    .readdirSync(REPORT_DIR)
    .filter((file) => file.endsWith(".csv"))
    .sort()
    .reverse()
    .map((file) => ({
      name: file,
      url: `/reports/${file}`,
      createdAt: fs.statSync(path.join(REPORT_DIR, file)).mtime.toISOString()
    }));

  res.json({ files });
});

async function runBroadcast(id) {
  const broadcast = broadcasts.get(id);
  if (!broadcast || broadcast.status === "stopped") return;

  const state = clients.get(broadcast.accountId);
  if (!state?.ready || !state.client) {
    finishBroadcast(broadcast, [], "failed", "Selected account disconnected before sending.");
    return;
  }

  broadcast.status = "running";
  broadcast.startedAt = new Date().toISOString();
  emitBroadcasts();

  const report = [];
  const media = broadcast.mediaPath ? createMessageMedia(broadcast) : null;

  for (let index = 0; index < broadcast.rows.length; index += 1) {
    const row = broadcast.rows[index];

    if (broadcast.stopRequested) {
      report.push(reportRow(index, row, "", "skipped", "Stopped by user"));
      broadcast.skipped += 1;
      continue;
    }

    const number = normalizePhone(row[broadcast.options.phoneColumn], broadcast.options.defaultCountryCode);
    if (!number) {
      report.push(reportRow(index, row, "", "failed", "Missing or invalid phone number"));
      broadcast.failed += 1;
      emitBroadcasts();
      continue;
    }

    const message = renderTemplate(broadcast.options.message, row);

    try {
      await sendBroadcastMessage(broadcast, number, message, media);
      report.push(reportRow(index, row, number, "sent", ""));
      broadcast.sent += 1;
    } catch (error) {
      report.push(reportRow(index, row, number, "failed", error.message));
      broadcast.failed += 1;
    }

    emitBroadcasts();

    if (index < broadcast.rows.length - 1 && !broadcast.stopRequested) {
      await sleep(randomDelay(broadcast.options.minDelayMs, broadcast.options.maxDelayMs));
    }
  }

  const reportName = writeReport(report, broadcast);
  broadcast.status = broadcast.stopRequested ? "stopped" : "finished";
  broadcast.finishedAt = new Date().toISOString();
  broadcast.reportUrl = `/reports/${reportName}`;
  emitBroadcasts();
}

async function sendBroadcastMessage(broadcast, number, message, media) {
  try {
    await sendWithAccount(broadcast.accountId, number, message, media);
  } catch (error) {
    if (!isRecoverableWhatsAppError(error)) {
      throw error;
    }

    const state = clients.get(broadcast.accountId);
    if (state) {
      state.ready = false;
      state.message = "WhatsApp Web refreshed during sending. Reconnecting...";
      emitAccounts();
    }

    await restartAccountClient(broadcast.accountId);
    await waitForAccountReady(broadcast.accountId, 90000);
    await sendWithAccount(broadcast.accountId, number, message, media);
  }
}

async function sendWithAccount(accountId, number, message, media) {
  const state = clients.get(accountId);
  if (!state?.ready || !state.client) {
    throw new Error("Selected account is not ready.");
  }

  const numberId = await state.client.getNumberId(number);
  if (!numberId) {
    throw new Error("Number is not registered on WhatsApp");
  }

  if (media) {
    await state.client.sendMessage(numberId._serialized, media, { caption: message });
  } else {
    await state.client.sendMessage(numberId._serialized, message);
  }
}

function isRecoverableWhatsAppError(error) {
  const message = String(error?.message || error || "");
  return /detached Frame|Execution context was destroyed|Protocol error|Target closed|Session closed|Navigation failed/i.test(message);
}

function waitForAccountReady(accountId, timeoutMs) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const state = clients.get(accountId);
      if (state?.ready && state.client) {
        clearInterval(timer);
        resolve();
        return;
      }

      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error("WhatsApp Web did not reconnect in time."));
      }
    }, 1000);
  });
}

function createMessageMedia(broadcast) {
  const data = fs.readFileSync(broadcast.mediaPath).toString("base64");
  const mimeType = broadcast.mediaMimeType || mimeTypeFromFileName(broadcast.mediaName) || "application/octet-stream";
  const fileName = broadcast.mediaName || `attachment${extensionFromMimeType(mimeType)}`;
  return new MessageMedia(mimeType, data, fileName);
}

function mimeTypeFromFileName(fileName) {
  const extension = path.extname(fileName || "").toLowerCase();
  const mimeTypes = {
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  };
  return mimeTypes[extension] || "";
}

function extensionFromMimeType(mimeType) {
  const extensions = {
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx"
  };
  return extensions[mimeType] || "";
}

function finishBroadcast(broadcast, report, status, error) {
  const rows = report.length ? report : [reportRow(0, {}, "", status, error)];
  const reportName = writeReport(rows, broadcast);
  broadcast.status = status;
  broadcast.failed = broadcast.total;
  broadcast.finishedAt = new Date().toISOString();
  broadcast.reportUrl = `/reports/${reportName}`;
  emitBroadcasts();
}

function startAccountClient(accountId) {
  const existing = clients.get(accountId);
  if (existing?.starting || existing?.ready) return;

  const state = {
    accountId,
    client: null,
    ready: false,
    starting: true,
    qr: null,
    message: "Starting WhatsApp Web session..."
  };
  clients.set(accountId, state);
  emitAccounts();

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: accountId,
      dataPath: SESSION_DIR
    }),
    puppeteer: {
      headless: false,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    }
  });
  state.client = client;

  client.on("qr", async (qr) => {
    state.qr = await QRCode.toDataURL(qr);
    state.ready = false;
    state.starting = false;
    state.message = "Scan the QR code in WhatsApp.";
    emitAccounts();
  });

  client.on("ready", () => {
    state.ready = true;
    state.starting = false;
    state.qr = null;
    state.message = "WhatsApp Web is linked.";
    emitAccounts();
  });

  client.on("authenticated", () => {
    state.message = "Session authenticated.";
    emitAccounts();
  });

  client.on("auth_failure", (message) => {
    state.ready = false;
    state.starting = false;
    state.qr = null;
    state.message = `Authentication failed: ${message}`;
    emitAccounts();
  });

  client.on("disconnected", (reason) => {
    state.ready = false;
    state.starting = false;
    state.qr = null;
    state.message = `Disconnected: ${reason}`;
    emitAccounts();
  });

  client.initialize().catch((error) => {
    state.ready = false;
    state.starting = false;
    state.qr = null;
    state.message = `Could not start WhatsApp Web: ${error.message}`;
    emitAccounts();
  });
}

async function restartAccountClient(accountId, { clearSession = false } = {}) {
  const state = clients.get(accountId);
  if (state?.client) {
    try {
      await state.client.destroy();
    } catch (_error) {
      // Destroy can fail if Chromium is half-started; a fresh client can still be started.
    }
  }

  clients.delete(accountId);
  if (clearSession) {
    clearLocalSession(accountId);
  }
  startAccountClient(accountId);
}

function clearLocalSession(accountId) {
  const safeId = sanitizeId(accountId);
  const sessionPath = path.join(SESSION_DIR, `session-${safeId}`);
  if (!sessionPath.startsWith(SESSION_DIR) || !fs.existsSync(sessionPath)) {
    return;
  }
  fs.rmSync(sessionPath, { recursive: true, force: true });
}

function normalizeBroadcastOptions(body, headers) {
  const minDelaySeconds = Math.max(1, Number(body.minDelaySeconds || 8));
  const maxDelaySeconds = Math.max(minDelaySeconds, Number(body.maxDelaySeconds || 15));
  const scheduledAtRaw = String(body.scheduledAt || "").trim();
  const scheduledAt = scheduledAtRaw ? new Date(scheduledAtRaw) : null;

  return {
    accountId: sanitizeId(String(body.accountId || "")),
    name: String(body.name || "Broadcast").trim() || "Broadcast",
    phoneColumn: String(body.phoneColumn || autoPhoneColumn(headers)),
    defaultCountryCode: String(body.defaultCountryCode || "").replace(/\D/g, ""),
    message: String(body.message || "").trim(),
    minDelayMs: minDelaySeconds * 1000,
    maxDelayMs: maxDelaySeconds * 1000,
    scheduledAt: scheduledAt && !Number.isNaN(scheduledAt.getTime()) && scheduledAt.getTime() > Date.now()
      ? scheduledAt.toISOString()
      : null,
    consentConfirmed: body.consentConfirmed === true
  };
}

async function readSpreadsheet(filePath, originalName) {
  const workbook = new ExcelJS.Workbook();
  const extension = path.extname(originalName).toLowerCase();

  if (extension === ".csv") {
    const worksheet = await workbook.csv.readFile(filePath);
    return worksheetToObjects(worksheet, "CSV");
  }

  await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new Error("No worksheet found");
  }
  return worksheetToObjects(worksheet, worksheet.name);
}

function worksheetToObjects(worksheet, sheetName) {
  const headerRow = worksheet.getRow(1);
  const headers = [];

  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers[colNumber - 1] = cellToText(cell) || `Column ${colNumber}`;
  });

  const rows = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;

    const item = {};
    let hasValue = false;
    headers.forEach((header, index) => {
      const value = cellToText(row.getCell(index + 1));
      item[header] = value;
      if (value) hasValue = true;
    });

    if (hasValue) rows.push(item);
  });

  return { sheetName, headers, rows };
}

function cellToText(cell) {
  if (cell == null) return "";
  if (cell.text) return String(cell.text).trim();
  const value = cell.value;
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if (value.text) return String(value.text).trim();
    if (value.result != null) return String(value.result).trim();
    if (value.richText) return value.richText.map((part) => part.text || "").join("").trim();
  }
  return String(value).trim();
}

function autoPhoneColumn(headers) {
  return (
    headers.find((header) => /^(phone|mobile|whatsapp|contact|number)$/i.test(header.trim())) ||
    headers.find((header) => /(phone|mobile|whatsapp|contact|number)/i.test(header)) ||
    headers[0] ||
    ""
  );
}

function normalizePhone(value, defaultCountryCode) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  let digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  digits = digits.replace(/\D/g, "");
  if (defaultCountryCode && digits.length === 10) digits = `${defaultCountryCode}${digits}`;

  return digits.length >= 8 && digits.length <= 15 ? digits : "";
}

function renderTemplate(template, row) {
  return template.replace(/\{([^}]+)\}/g, (_match, key) => {
    const normalizedKey = key.trim();
    return row[normalizedKey] == null ? "" : String(row[normalizedKey]);
  });
}

function reportRow(index, row, number, status, error) {
  return {
    row: index + 2,
    name: row.Name || row.name || row.FullName || row.fullName || "",
    number,
    status,
    error,
    sentAt: new Date().toISOString()
  };
}

function writeReport(rows, broadcast) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeName = slugify(broadcast.name || "broadcast");
  const fileName = `whatsapp-report-${safeName}-${timestamp}.csv`;
  const filePath = path.join(REPORT_DIR, fileName);
  const headers = ["row", "name", "number", "status", "error", "sentAt"];
  const csv = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))
  ].join("\n");
  fs.writeFileSync(filePath, csv, "utf8");
  return fileName;
}

function csvCell(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function accountSnapshots() {
  return accounts.map((account) => accountSnapshot(account.id)).filter(Boolean);
}

function accountSnapshot(id) {
  const account = getAccount(id);
  if (!account) return null;
  const state = clients.get(id);
  return {
    ...account,
    ready: Boolean(state?.ready),
    starting: Boolean(state?.starting),
    qr: state?.qr || null,
    message: state?.message || "Not started"
  };
}

function broadcastSnapshots() {
  return Array.from(broadcasts.values()).map(broadcastSnapshot).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function broadcastSnapshot(broadcast) {
  return {
    id: broadcast.id,
    name: broadcast.name,
    accountId: broadcast.accountId,
    accountName: broadcast.accountName,
    total: broadcast.total,
    sent: broadcast.sent,
    failed: broadcast.failed,
    skipped: broadcast.skipped,
    status: broadcast.status,
    createdAt: broadcast.createdAt,
    scheduledAt: broadcast.scheduledAt,
    startedAt: broadcast.startedAt,
    finishedAt: broadcast.finishedAt,
    reportUrl: broadcast.reportUrl
  };
}

function draftSnapshot(draft) {
  return {
    id: draft.id,
    sheetName: draft.sheetName,
    headers: draft.headers,
    count: draft.rows.length,
    mediaName: draft.media?.originalname || null,
    preview: draft.rows.slice(0, 5)
  };
}

function emitAccounts() {
  io.emit("accounts", accountSnapshots());
}

function emitBroadcasts() {
  io.emit("broadcasts", broadcastSnapshots());
}

function hasActiveBroadcastForAccount(accountId) {
  return Array.from(broadcasts.values()).some((broadcast) => (
    broadcast.accountId === accountId && ["scheduled", "running"].includes(broadcast.status)
  ));
}

function getAccount(id) {
  return accounts.find((account) => account.id === sanitizeId(id));
}

function loadAccounts() {
  if (!fs.existsSync(ACCOUNTS_FILE)) {
    const legacyPath = path.join(SESSION_DIR, "session-bulk-sender");
    const initial = fs.existsSync(legacyPath)
      ? [{ id: "bulk-sender", name: "Default Account", createdAt: new Date().toISOString() }]
      : [];
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }

  try {
    return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
  } catch (_error) {
    return [];
  }
}

function saveAccounts() {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}

function uniqueId(prefix) {
  const base = sanitizeId(prefix) || "item";
  return `${base}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function sanitizeId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "");
}

function randomDelay(minDelayMs, maxDelayMs) {
  return Math.floor(Math.random() * (maxDelayMs - minDelayMs + 1)) + minDelayMs;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

server.listen(PORT, () => {
  console.log(`WhatsApp bulk sender running at http://localhost:${PORT}`);
});
