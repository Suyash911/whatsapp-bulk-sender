const socket = window.io ? io() : null;

const accountForm = document.getElementById("accountForm");
const draftForm = document.getElementById("draftForm");
const broadcastForm = document.getElementById("broadcastForm");
const accountsList = document.getElementById("accountsList");
const broadcastList = document.getElementById("broadcastList");
const accountSelect = document.getElementById("accountSelect");
const phoneColumn = document.getElementById("phoneColumn");
const previewMeta = document.getElementById("previewMeta");
const previewTable = document.getElementById("previewTable");
const reportsList = document.getElementById("reportsList");
const refreshReports = document.getElementById("refreshReports");
const toast = document.getElementById("toast");
const accountCount = document.getElementById("accountCount");
const linkedCount = document.getElementById("linkedCount");
const activeJobCount = document.getElementById("activeJobCount");

let accounts = [];
let broadcasts = [];
let toastTimer = null;

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("active"));
    document.querySelectorAll(".tab-page").forEach((page) => page.classList.remove("active"));
    button.classList.add("active");
    document.getElementById(`${button.dataset.tab}Tab`).classList.add("active");
  });
});

if (socket) {
  socket.on("accounts", (items) => {
    accounts = items;
    renderAccounts();
    renderAccountSelect();
    renderSidebar();
  });

  socket.on("broadcasts", (items) => {
    broadcasts = items;
    renderBroadcasts();
    renderSidebar();
    loadReports();
  });
}

accountForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(accountForm);

  try {
    const response = await fetch("/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: formData.get("name") })
    });
    await readJson(response);
    accountForm.reset();
    showToast("Account added. Scan the QR code when it appears.");
  } catch (error) {
    showToast(error.message);
  }
});

draftForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(draftForm);

  try {
    const response = await fetch("/api/draft", {
      method: "POST",
      body: formData
    });
    const data = await readJson(response);
    renderPreview(data);
    showToast(`Loaded ${data.count} contacts from ${data.sheetName}.`);
  } catch (error) {
    showToast(error.message);
  }
});

broadcastForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(broadcastForm);
  const payload = {
    name: formData.get("name"),
    accountId: formData.get("accountId"),
    phoneColumn: formData.get("phoneColumn"),
    defaultCountryCode: formData.get("defaultCountryCode"),
    minDelaySeconds: Number(formData.get("minDelaySeconds")),
    maxDelaySeconds: Number(formData.get("maxDelaySeconds")),
    scheduledAt: formData.get("scheduledAt"),
    message: formData.get("message"),
    consentConfirmed: formData.get("consentConfirmed") === "on"
  };

  try {
    const response = await fetch("/api/broadcasts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await readJson(response);
    showToast(`${data.broadcast.name} ${data.broadcast.status === "scheduled" ? "scheduled" : "started"}.`);
  } catch (error) {
    showToast(error.message);
  }
});

refreshReports.addEventListener("click", loadReports);

function renderAccounts() {
  accountsList.innerHTML = "";
  if (!accounts.length) {
    accountsList.innerHTML = '<span class="muted">No WhatsApp accounts added yet</span>';
    return;
  }

  for (const account of accounts) {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <div class="card-head">
        <div>
          <h3>${escapeHtml(account.name)}</h3>
          <p class="muted">${escapeHtml(account.message || "")}</p>
        </div>
        <span class="pill ${account.ready ? "ok" : ""}">${account.ready ? "Linked" : account.starting ? "Starting" : "Needs scan"}</span>
      </div>
      ${account.qr ? `<div class="qr-wrap"><img src="${account.qr}" alt="QR for ${escapeHtml(account.name)}" /></div>` : ""}
      <div class="card-actions">
        <button class="secondary refresh-account" type="button" data-id="${account.id}" ${account.ready ? "disabled" : ""}>Refresh QR</button>
        <button class="secondary delete-account" type="button" data-id="${account.id}">Delete</button>
      </div>
    `;
    accountsList.appendChild(card);
  }

  accountsList.querySelectorAll(".refresh-account").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const response = await fetch(`/api/accounts/${button.dataset.id}/refresh`, { method: "POST" });
        const data = await readJson(response);
        showToast(data.message || "QR refresh started.");
      } catch (error) {
        showToast(error.message);
        button.disabled = false;
      }
    });
  });

  accountsList.querySelectorAll(".delete-account").forEach((button) => {
    button.addEventListener("click", async () => {
      const account = accounts.find((item) => item.id === button.dataset.id);
      if (!account) return;

      if (!confirm(`Delete ${account.name}? This removes the saved WhatsApp session from this computer.`)) {
        return;
      }

      button.disabled = true;
      try {
        const response = await fetch(`/api/accounts/${button.dataset.id}`, { method: "DELETE" });
        await readJson(response);
        showToast(`Deleted ${account.name}.`);
      } catch (error) {
        showToast(error.message);
        button.disabled = false;
      }
    });
  });
}

function renderAccountSelect() {
  accountSelect.innerHTML = "";
  const linked = accounts.filter((account) => account.ready);
  if (!linked.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No linked account";
    accountSelect.appendChild(option);
    return;
  }

  for (const account of linked) {
    const option = document.createElement("option");
    option.value = account.id;
    option.textContent = account.name;
    accountSelect.appendChild(option);
  }
}

function renderBroadcasts() {
  broadcastList.innerHTML = "";
  if (!broadcasts.length) {
    broadcastList.innerHTML = '<span class="muted">No broadcasts yet</span>';
    return;
  }

  for (const job of broadcasts) {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <div class="card-head">
        <div>
          <h3>${escapeHtml(job.name)}</h3>
          <p class="muted">${escapeHtml(job.accountName)}${job.scheduledAt ? ` · ${new Date(job.scheduledAt).toLocaleString()}` : ""}</p>
        </div>
        <span class="pill ${job.status === "finished" ? "ok" : ""}">${escapeHtml(job.status)}</span>
      </div>
      <div class="job-grid">
        <span>Total <strong>${job.total}</strong></span>
        <span>Sent <strong>${job.sent}</strong></span>
        <span>Failed <strong>${job.failed}</strong></span>
        <span>Skipped <strong>${job.skipped}</strong></span>
      </div>
      <div class="card-actions">
        ${["scheduled", "running"].includes(job.status) ? `<button class="secondary stop-job" type="button" data-id="${job.id}">Stop</button>` : ""}
        ${job.reportUrl ? `<a href="${job.reportUrl}" download>Download report</a>` : ""}
      </div>
    `;
    broadcastList.appendChild(card);
  }

  broadcastList.querySelectorAll(".stop-job").forEach((button) => {
    button.addEventListener("click", async () => {
      await fetch(`/api/broadcasts/${button.dataset.id}/stop`, { method: "POST" });
      showToast("Broadcast stop requested.");
    });
  });
}

function renderPreview(data) {
  previewMeta.textContent = `${data.count} rows from ${data.sheetName}${data.mediaName ? ` with ${data.mediaName}` : ""}`;
  phoneColumn.innerHTML = "";

  for (const header of data.headers) {
    const option = document.createElement("option");
    option.value = header;
    option.textContent = header;
    if (/(phone|mobile|whatsapp|contact|number)/i.test(header)) option.selected = true;
    phoneColumn.appendChild(option);
  }

  const headers = data.headers.slice(0, 8);
  const thead = `<thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead>`;
  const tbody = data.preview
    .map((row) => `<tr>${headers.map((header) => `<td>${escapeHtml(row[header] ?? "")}</td>`).join("")}</tr>`)
    .join("");
  previewTable.innerHTML = `${thead}<tbody>${tbody}</tbody>`;
}

function renderSidebar() {
  accountCount.textContent = accounts.length;
  linkedCount.textContent = accounts.filter((account) => account.ready).length;
  activeJobCount.textContent = broadcasts.filter((job) => ["scheduled", "running"].includes(job.status)).length;
}

async function loadReports() {
  try {
    const response = await fetch("/api/reports");
    const data = await readJson(response);
    reportsList.innerHTML = "";
    if (!data.files.length) {
      reportsList.innerHTML = '<span class="muted">No reports yet</span>';
      return;
    }

    for (const file of data.files) {
      const link = document.createElement("a");
      link.href = file.url;
      link.download = file.name;
      link.textContent = `${file.name} (${new Date(file.createdAt).toLocaleString()})`;
      reportsList.appendChild(link);
    }
  } catch (error) {
    showToast(error.message);
  }
}

async function loadAccounts() {
  try {
    const response = await fetch("/api/accounts");
    const data = await readJson(response);
    accounts = data.accounts || [];
    renderAccounts();
    renderAccountSelect();
    renderSidebar();
  } catch (error) {
    showToast(error.message);
  }
}

async function loadBroadcasts() {
  try {
    const response = await fetch("/api/broadcasts");
    const data = await readJson(response);
    broadcasts = data.broadcasts || [];
    renderBroadcasts();
    renderSidebar();
  } catch (error) {
    showToast(error.message);
  }
}

async function readJson(response) {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();

  let data = null;
  if (contentType.includes("application/json") || text.trim().startsWith("{") || text.trim().startsWith("[")) {
    try {
      data = JSON.parse(text);
    } catch (_error) {
      data = null;
    }
  }

  if (!response.ok) {
    const message = data?.error || text.trim().slice(0, 200) || `HTTP ${response.status}`;
    throw new Error(message);
  }

  return data ?? {};
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 4200);
}

loadAccounts();
loadBroadcasts();
loadReports();

if (!socket) {
  setInterval(() => {
    loadAccounts();
    loadBroadcasts();
  }, 10000);
}
