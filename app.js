// ==========================================================
// Module 5: Shift Handover & Reporting — Frontend Logic
// Talks to the Express backend via fetch()
// ==========================================================

const API = ""; // same-origin; change to e.g. "http://localhost:4000" if served separately
let currentHandoverId = null; // handover being built in "New Handover" view

// ---------- Utility ----------
function $(sel) { return document.querySelector(sel); }
function $all(sel) { return document.querySelectorAll(sel); }

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2500);
}

function badgeClass(value) {
  return "badge-" + String(value).toLowerCase().replace(/\s+/g, "-");
}

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(err.error || "Request failed");
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---------- Navigation ----------
function setView(view) {
  $all(".view").forEach((v) => v.classList.remove("active"));
  $all(".nav-item").forEach((n) => n.classList.remove("active"));
  $(`#view-${view}`).classList.add("active");

  // sidebar me sirf dashboard/new-handover/history hain; baaki views (all-tasks, all-incidents)
  // ke liye koi nav-item nahi hai, isliye check karke hi highlight karo
  const navItem = document.querySelector(`.nav-item[data-view="${view}"]`);
  if (navItem) navItem.classList.add("active");

  if (view === "dashboard") loadDashboard();
  if (view === "history") loadHistory();
  if (view === "all-tasks") loadAllTasks();
  if (view === "all-incidents") loadAllIncidents();
}

$all(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => setView(btn.dataset.view));
});
$("#btnGoNew").addEventListener("click", () => setView("new-handover"));

// "← Back to Dashboard" buttons (data-back attribute wale kisi bhi button ke liye)
document.addEventListener("click", (e) => {
  const backBtn = e.target.closest("[data-back]");
  if (backBtn) setView(backBtn.dataset.back);
});

// ---------- Live clock ----------
function tickClock() {
  const now = new Date();
  $("#liveClock").textContent = now.toLocaleTimeString("en-IN", { hour12: false });
  $("#liveDate").textContent = now.toLocaleDateString("en-IN", {
    weekday: "short", day: "2-digit", month: "short", year: "numeric",
  });
}
setInterval(tickClock, 1000);
tickClock();

// ==========================================================
// DASHBOARD VIEW
// ==========================================================
async function loadDashboard() {
  const handovers = await api("/api/handovers");
  loadEquipmentStatus(); // equipment panel alag se load hota hai, isse dashboard ka baaki data slow nahi hota

  const totalPending = handovers.reduce((sum, h) => sum + h.pendingTaskCount, 0);
  const totalOpenIncidents = handovers.reduce((sum, h) => sum + h.openIncidentCount, 0);
  const completed = handovers.filter((h) => h.status === "Completed").length;

  $("#statRow").innerHTML = `
    <div class="stat-card teal clickable" data-back="history">
      <div class="stat-value">${handovers.length}</div>
      <div class="stat-label">Total Handovers Logged</div>
    </div>
    <div class="stat-card amber clickable" data-back="all-tasks">
      <div class="stat-value">${totalPending}</div>
      <div class="stat-label">Pending Tasks Across Shifts</div>
    </div>
    <div class="stat-card red clickable" data-back="all-incidents">
      <div class="stat-value">${totalOpenIncidents}</div>
      <div class="stat-label">Open Incidents</div>
    </div>
    <div class="stat-card clickable" data-back="history">
      <div class="stat-value">${completed}</div>
      <div class="stat-label">Completed Handovers</div>
    </div>
  `;

  const body = $("#handoverTableBody");
  if (handovers.length === 0) {
    body.innerHTML = `<tr class="empty-row"><td colspan="7">No handovers logged yet. Create your first one.</td></tr>`;
    return;
  }

  body.innerHTML = handovers
    .map(
      (h) => `
    <tr>
      <td class="mono">${h.id}</td>
      <td>${h.shiftDate}</td>
      <td>${h.outgoingShift} → ${h.incomingShift}</td>
      <td>${h.pendingTaskCount}</td>
      <td>${h.openIncidentCount}</td>
      <td><span class="badge ${badgeClass(h.status)}">${h.status}</span></td>
      <td class="export-links">
        <a href="/api/handovers/${h.id}/export/pdf" target="_blank">PDF</a>
        <a href="/api/handovers/${h.id}/export/excel" target="_blank">Excel</a>
      </td>
    </tr>`
    )
    .join("");
}

// ==========================================================
// EQUIPMENT STATUS PANEL (imported refinery dataset)
// ==========================================================
async function loadEquipmentStatus() {
  const readings = await api("/api/equipment-status");
  const body = $("#equipmentTableBody");

  body.innerHTML = readings
    .map((r) => {
      const isWarning = r.status === "Warning";
      return `
      <tr>
        <td>${r.Refinery}</td>
        <td>${r.Crude_Type}</td>
        <td class="mono">${r.Date}</td>
        <td>${r["Temp_C"]}</td>
        <td>${r["Pressure_bar"]}</td>
        <td>${r["CDU_Load_%"]}</td>
        <td><span class="badge ${badgeClass(r.status)}">${r.status}</span></td>
        <td>
          ${isWarning ? `<button class="btn-small flag-incident-btn" data-refinery="${r.Refinery}" data-temp="${r["Temp_C"]}" data-pressure="${r["Pressure_bar"]}" data-load="${r["CDU_Load_%"]}">Flag as Incident</button>` : ""}
        </td>
      </tr>`;
    })
    .join("");

  body.querySelectorAll(".flag-incident-btn").forEach((btn) => {
    btn.addEventListener("click", () => flagEquipmentAsIncident(btn.dataset));
  });
}

function flagEquipmentAsIncident(data) {
  if (!currentHandoverId) {
    showToast("Pehle ek Naya Handover banao, phir isse incident ke roop me add karo.");
    setView("new-handover");
    return;
  }
  // Incident modal ko refinery reading ke details se pre-fill kar do
  $("#incidentTitle").value = `Abnormal reading — ${data.refinery} refinery`;
  $("#incidentSeverity").value = "High";
  $("#incidentDescription").value =
    `Temp: ${data.temp}°C, Pressure: ${data.pressure} bar, CDU Load: ${data.load}% — normal range se bahar. Refinery dataset se auto-flag kiya gaya.`;
  $("#incidentModal").classList.add("active");
}

// ==========================================================
// NEW HANDOVER VIEW
// ==========================================================

// default shift date = today
$("#shiftDate").value = new Date().toISOString().slice(0, 10);

$("#btnCreateHandover").addEventListener("click", async () => {
  const outgoingShift = $("#outgoingShift").value.trim();
  const incomingShift = $("#incomingShift").value.trim();
  const shiftDate = $("#shiftDate").value;

  if (!outgoingShift || !incomingShift || !shiftDate) {
    showToast("Please fill shift date, outgoing and incoming shift.");
    return;
  }

  try {
    const handover = await api("/api/handovers", {
      method: "POST",
      body: JSON.stringify({
        shiftDate,
        outgoingShift,
        incomingShift,
        outgoingSupervisor: $("#outgoingSupervisor").value.trim(),
        incomingSupervisor: $("#incomingSupervisor").value.trim(),
        supervisorRemarks: $("#supervisorRemarks").value.trim(),
        manualSummaryNote: $("#manualSummaryNote").value.trim(),
      }),
    });

    currentHandoverId = handover.id;
    $("#pendingContextPanel").style.display = "block";
    await refreshGeneratedPanel();
    showToast("Handover created. Add pending tasks and incidents below.");
  } catch (e) {
    showToast(e.message);
  }
});

async function refreshGeneratedPanel() {
  if (!currentHandoverId) return;
  const h = await api(`/api/handovers/${currentHandoverId}`);

  $("#generatedSummaryBox").textContent = h.summary;
  $("#createdStatusBadge").textContent = h.status;
  $("#createdStatusBadge").className = "badge badge-status " + badgeClass(h.status);

  // Tasks table
  const taskBody = $("#taskTableBody");
  taskBody.innerHTML = h.tasks.length
    ? h.tasks
        .map(
          (t) => `
        <tr>
          <td>${t.description}</td>
          <td>${t.assignedTo}</td>
          <td><span class="badge ${badgeClass(t.priority)}">${t.priority}</span></td>
          <td><span class="badge ${badgeClass(t.status)}">${t.status}</span></td>
          <td class="mono">${t.dueDate || "-"}</td>
          <td><button class="btn-icon" data-task-id="${t.id}" title="Remove">✕</button></td>
        </tr>`
        )
        .join("")
    : `<tr class="empty-row"><td colspan="6">No pending tasks added yet.</td></tr>`;

  taskBody.querySelectorAll("[data-task-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await api(`/api/tasks/${btn.dataset.taskId}`, { method: "DELETE" });
      await regenerateSummaryThen(refreshGeneratedPanel);
    });
  });

  // Incidents table
  const incBody = $("#incidentTableBody");
  incBody.innerHTML = h.incidents.length
    ? h.incidents
        .map(
          (i) => `
        <tr>
          <td>${i.title}</td>
          <td><span class="badge ${badgeClass(i.severity)}">${i.severity}</span></td>
          <td><span class="badge ${badgeClass(i.status)}">${i.status}</span></td>
          <td><button class="btn-icon" data-incident-id="${i.id}" title="Remove">✕</button></td>
        </tr>`
        )
        .join("")
    : `<tr class="empty-row"><td colspan="4">No incidents recorded yet.</td></tr>`;

  incBody.querySelectorAll("[data-incident-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await api(`/api/incidents/${btn.dataset.incidentId}`, { method: "DELETE" });
      await regenerateSummaryThen(refreshGeneratedPanel);
    });
  });
}

async function regenerateSummaryThen(callback) {
  await api(`/api/handovers/${currentHandoverId}`, {
    method: "PUT",
    body: JSON.stringify({
      regenerateSummary: true,
      manualSummaryNote: $("#manualSummaryNote").value.trim(),
    }),
  });
  if (callback) await callback();
}

// ---- Task modal ----
$("#btnAddTask").addEventListener("click", () => {
  $("#taskDescription").value = "";
  $("#taskAssignedTo").value = "";
  $("#taskPriority").value = "Medium";
  $("#taskDueDate").value = "";
  $("#taskModal").classList.add("active");
});
$("#btnCancelTask").addEventListener("click", () => $("#taskModal").classList.remove("active"));

$("#btnSaveTask").addEventListener("click", async () => {
  const description = $("#taskDescription").value.trim();
  if (!description) { showToast("Task description is required."); return; }

  try {
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        handoverId: currentHandoverId,
        description,
        assignedTo: $("#taskAssignedTo").value.trim() || "Unassigned",
        priority: $("#taskPriority").value,
        dueDate: $("#taskDueDate").value || null,
      }),
    });
    $("#taskModal").classList.remove("active");
    await regenerateSummaryThen(refreshGeneratedPanel);
    showToast("Task added.");
  } catch (e) {
    showToast(e.message);
  }
});

// ---- Incident modal ----
$("#btnAddIncident").addEventListener("click", () => {
  $("#incidentTitle").value = "";
  $("#incidentSeverity").value = "Medium";
  $("#incidentDescription").value = "";
  $("#incidentModal").classList.add("active");
});
$("#btnCancelIncident").addEventListener("click", () => $("#incidentModal").classList.remove("active"));

$("#btnSaveIncident").addEventListener("click", async () => {
  const title = $("#incidentTitle").value.trim();
  if (!title) { showToast("Incident title is required."); return; }

  try {
    await api("/api/incidents", {
      method: "POST",
      body: JSON.stringify({
        handoverId: currentHandoverId,
        title,
        severity: $("#incidentSeverity").value,
        description: $("#incidentDescription").value.trim(),
      }),
    });
    $("#incidentModal").classList.remove("active");
    await regenerateSummaryThen(refreshGeneratedPanel);
    showToast("Incident added.");
  } catch (e) {
    showToast(e.message);
  }
});

// ---- Finalize + export ----
$("#btnFinalizeHandover").addEventListener("click", async () => {
  if (!currentHandoverId) return;
  await api(`/api/handovers/${currentHandoverId}`, {
    method: "PUT",
    body: JSON.stringify({
      status: "Completed",
      supervisorRemarks: $("#supervisorRemarks").value.trim(),
    }),
  });
  await refreshGeneratedPanel();
  showToast("Handover marked as completed.");
  loadDashboard();
});

$("#btnExportPdfNew").addEventListener("click", () => {
  if (!currentHandoverId) return;
  window.open(`/api/handovers/${currentHandoverId}/export/pdf`, "_blank");
});
$("#btnExportExcelNew").addEventListener("click", () => {
  if (!currentHandoverId) return;
  window.open(`/api/handovers/${currentHandoverId}/export/excel`, "_blank");
});

// ==========================================================
// HISTORY VIEW
// ==========================================================
let historyCache = [];

async function loadHistory() {
  historyCache = await api("/api/handovers");
  renderHistory(historyCache);
}

function renderHistory(list) {
  const body = $("#historyTableBody");
  if (list.length === 0) {
    body.innerHTML = `<tr class="empty-row"><td colspan="6">No handovers found.</td></tr>`;
    return;
  }
  body.innerHTML = list
    .map(
      (h) => `
    <tr>
      <td class="mono">${h.id}</td>
      <td>${h.shiftDate}</td>
      <td>${h.outgoingShift} → ${h.incomingShift}</td>
      <td>${h.outgoingSupervisor || "-"} → ${h.incomingSupervisor || "-"}</td>
      <td><span class="badge ${badgeClass(h.status)}">${h.status}</span></td>
      <td class="export-links">
        <a href="/api/handovers/${h.id}/export/pdf" target="_blank">PDF</a>
        <a href="/api/handovers/${h.id}/export/excel" target="_blank">Excel</a>
      </td>
    </tr>`
    )
    .join("");
}

$("#historySearch").addEventListener("input", (e) => {
  const q = e.target.value.toLowerCase();
  const filtered = historyCache.filter((h) =>
    [h.id, h.outgoingShift, h.incomingShift, h.outgoingSupervisor, h.incomingSupervisor]
      .join(" ")
      .toLowerCase()
      .includes(q)
  );
  renderHistory(filtered);
});

// ==========================================================
// ALL PENDING TASKS VIEW (across every handover)
// ==========================================================
async function loadAllTasks() {
  const [handovers, tasks] = await Promise.all([api("/api/handovers"), api("/api/tasks")]);

  // handoverId -> handover lookup, taaki har task ke saath uski shift date/ID dikha sakein
  const handoverMap = {};
  handovers.forEach((h) => (handoverMap[h.id] = h));

  const pendingTasks = tasks
    .filter((t) => t.status !== "Completed")
    .sort((a, b) => (handoverMap[b.handoverId]?.createdAt || "").localeCompare(handoverMap[a.handoverId]?.createdAt || ""));

  const body = $("#allTasksTableBody");
  if (pendingTasks.length === 0) {
    body.innerHTML = `<tr class="empty-row"><td colspan="7">Koi pending task nahi hai.</td></tr>`;
    return;
  }

  body.innerHTML = pendingTasks
    .map((t) => {
      const h = handoverMap[t.handoverId];
      return `
      <tr>
        <td class="mono">${t.handoverId}</td>
        <td>${h ? h.shiftDate : "-"}</td>
        <td>${t.description}</td>
        <td>${t.assignedTo}</td>
        <td><span class="badge ${badgeClass(t.priority)}">${t.priority}</span></td>
        <td><span class="badge ${badgeClass(t.status)}">${t.status}</span></td>
        <td class="mono">${t.dueDate || "-"}</td>
      </tr>`;
    })
    .join("");
}

// ==========================================================
// ALL OPEN INCIDENTS VIEW (across every handover)
// ==========================================================
async function loadAllIncidents() {
  const [handovers, incidents] = await Promise.all([api("/api/handovers"), api("/api/incidents")]);

  const handoverMap = {};
  handovers.forEach((h) => (handoverMap[h.id] = h));

  const openIncidents = incidents
    .filter((i) => i.status !== "Closed")
    .sort((a, b) => (b.reportedAt || "").localeCompare(a.reportedAt || ""));

  const body = $("#allIncidentsTableBody");
  if (openIncidents.length === 0) {
    body.innerHTML = `<tr class="empty-row"><td colspan="6">Koi open incident nahi hai.</td></tr>`;
    return;
  }

  body.innerHTML = openIncidents
    .map((i) => {
      const h = handoverMap[i.handoverId];
      return `
      <tr>
        <td class="mono">${i.handoverId}</td>
        <td>${h ? h.shiftDate : "-"}</td>
        <td>${i.title}</td>
        <td><span class="badge ${badgeClass(i.severity)}">${i.severity}</span></td>
        <td><span class="badge ${badgeClass(i.status)}">${i.status}</span></td>
        <td>${i.description || "-"}</td>
      </tr>`;
    })
    .join("");
}

// ---------- Init ----------
loadDashboard();
