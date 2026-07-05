/**
 * Module 5: Shift Handover & Reporting
 * Backend Server - Express + JSON file storage
 *
 * Endpoints:
 *   GET    /api/handovers                -> list all handovers (with tasks + incidents summary)
 *   GET    /api/handovers/:id            -> get single handover with full tasks + incidents
 *   POST   /api/handovers                -> create a new handover (auto summary)
 *   PUT    /api/handovers/:id            -> update handover (e.g. supervisor remarks, status)
 *   DELETE /api/handovers/:id            -> delete a handover
 *
 *   GET    /api/tasks?handoverId=..      -> list pending tasks (optionally filtered)
 *   POST   /api/tasks                    -> add a pending task
 *   PUT    /api/tasks/:id                -> update task (status/priority/etc.)
 *   DELETE /api/tasks/:id                -> delete task
 *
 *   GET    /api/incidents?handoverId=..  -> list outstanding incidents
 *   POST   /api/incidents                -> add incident
 *   PUT    /api/incidents/:id            -> update incident
 *   DELETE /api/incidents/:id            -> delete incident
 *
 *   GET    /api/handovers/:id/export/pdf   -> download handover report as PDF
 *   GET    /api/handovers/:id/export/excel -> download handover report as Excel
 */

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const ExcelJS = require("exceljs");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 4000;
const DB_PATH = path.join(__dirname, "data", "db.json");
const EQUIPMENT_PATH = path.join(__dirname, "data", "equipment-status.json");

// Normal operating ranges, derived from the refinery dataset (5th-95th percentile).
// Reading outside these ranges is flagged as "Warning" so a supervisor can review it.
const THRESHOLDS = {
  "Temp_C": { low: 342.5, high: 387.5 },
  "Pressure_bar": { low: 1.6, high: 3.41 },
  "CDU_Load_%": { low: 76, high: 98.75 },
};

function computeEquipmentStatus(reading) {
  for (const field of Object.keys(THRESHOLDS)) {
    const { low, high } = THRESHOLDS[field];
    const value = reading[field];
    if (value < low || value > high) return "Warning";
  }
  return "Normal";
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- Simple JSON "database" helpers ----------
function readDB() {
  const raw = fs.readFileSync(DB_PATH, "utf-8");
  return JSON.parse(raw);
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), "utf-8");
}

function getHandoverWithDetails(db, id) {
  const handover = db.handovers.find((h) => h.id === id);
  if (!handover) return null;
  const tasks = db.tasks.filter((t) => t.handoverId === id);
  const incidents = db.incidents.filter((i) => i.handoverId === id);
  return { ...handover, tasks, incidents };
}

// Auto-generate a handover summary from tasks + incidents (simple rule-based composer)
function buildAutoSummary(db, handoverId, manualNote) {
  const tasks = db.tasks.filter((t) => t.handoverId === handoverId);
  const incidents = db.incidents.filter((i) => i.handoverId === handoverId);
  const pendingCount = tasks.filter((t) => t.status !== "Completed").length;
  const openIncidents = incidents.filter((i) => i.status !== "Closed").length;

  let summary = `Shift closed with ${tasks.length} logged task(s), ${pendingCount} still pending. `;
  summary += `${incidents.length} incident(s) recorded, ${openIncidents} remain open. `;
  if (manualNote) summary += manualNote;
  return summary;
}

// ---------------- EQUIPMENT STATUS (from imported refinery dataset) ----------------

app.get("/api/equipment-status", (req, res) => {
  const raw = fs.readFileSync(EQUIPMENT_PATH, "utf-8");
  const readings = JSON.parse(raw);
  const withStatus = readings
    .map((r) => ({ ...r, status: computeEquipmentStatus(r) }))
    .sort((a, b) => a.Refinery.localeCompare(b.Refinery));
  res.json(withStatus);
});

// ---------------- HANDOVER ROUTES ----------------

app.get("/api/handovers", (req, res) => {
  const db = readDB();
  const list = db.handovers.map((h) => {
    const tasks = db.tasks.filter((t) => t.handoverId === h.id);
    const incidents = db.incidents.filter((i) => i.handoverId === h.id);
    return {
      ...h,
      taskCount: tasks.length,
      pendingTaskCount: tasks.filter((t) => t.status !== "Completed").length,
      incidentCount: incidents.length,
      openIncidentCount: incidents.filter((i) => i.status !== "Closed").length,
    };
  });
  res.json(list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.get("/api/handovers/:id", (req, res) => {
  const db = readDB();
  const handover = getHandoverWithDetails(db, req.params.id);
  if (!handover) return res.status(404).json({ error: "Handover not found" });
  res.json(handover);
});

app.post("/api/handovers", (req, res) => {
  const db = readDB();
  const {
    shiftDate,
    outgoingShift,
    incomingShift,
    outgoingSupervisor,
    incomingSupervisor,
    supervisorRemarks,
    manualSummaryNote,
  } = req.body;

  if (!shiftDate || !outgoingShift || !incomingShift) {
    return res.status(400).json({ error: "shiftDate, outgoingShift and incomingShift are required" });
  }

  const newHandover = {
    id: "ho-" + uuidv4().slice(0, 8),
    shiftDate,
    outgoingShift,
    incomingShift,
    outgoingSupervisor: outgoingSupervisor || "",
    incomingSupervisor: incomingSupervisor || "",
    summary: buildAutoSummary(db, null, manualSummaryNote), // placeholder, refined below
    supervisorRemarks: supervisorRemarks || "",
    status: "Draft",
    createdAt: new Date().toISOString(),
  };

  db.handovers.push(newHandover);
  // regenerate summary now that handover id exists (tasks/incidents may reference it later)
  newHandover.summary = buildAutoSummary(db, newHandover.id, manualSummaryNote);
  writeDB(db);
  res.status(201).json(newHandover);
});

app.put("/api/handovers/:id", (req, res) => {
  const db = readDB();
  const idx = db.handovers.findIndex((h) => h.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Handover not found" });

  const updatable = [
    "outgoingSupervisor",
    "incomingSupervisor",
    "supervisorRemarks",
    "status",
    "summary",
  ];
  updatable.forEach((field) => {
    if (req.body[field] !== undefined) db.handovers[idx][field] = req.body[field];
  });

  // refresh auto summary unless a manual summary override was explicitly sent
  if (req.body.regenerateSummary) {
    db.handovers[idx].summary = buildAutoSummary(db, req.params.id, req.body.manualSummaryNote);
  }

  writeDB(db);
  res.json(db.handovers[idx]);
});

app.delete("/api/handovers/:id", (req, res) => {
  const db = readDB();
  db.handovers = db.handovers.filter((h) => h.id !== req.params.id);
  db.tasks = db.tasks.filter((t) => t.handoverId !== req.params.id);
  db.incidents = db.incidents.filter((i) => i.handoverId !== req.params.id);
  writeDB(db);
  res.status(204).send();
});

// ---------------- TASK ROUTES ----------------

app.get("/api/tasks", (req, res) => {
  const db = readDB();
  const { handoverId } = req.query;
  const tasks = handoverId ? db.tasks.filter((t) => t.handoverId === handoverId) : db.tasks;
  res.json(tasks);
});

app.post("/api/tasks", (req, res) => {
  const db = readDB();
  const { handoverId, description, assignedTo, priority, dueDate } = req.body;
  if (!handoverId || !description) {
    return res.status(400).json({ error: "handoverId and description are required" });
  }
  const task = {
    id: "tk-" + uuidv4().slice(0, 8),
    handoverId,
    description,
    assignedTo: assignedTo || "Unassigned",
    priority: priority || "Medium",
    status: "Pending",
    dueDate: dueDate || null,
  };
  db.tasks.push(task);
  writeDB(db);
  res.status(201).json(task);
});

app.put("/api/tasks/:id", (req, res) => {
  const db = readDB();
  const idx = db.tasks.findIndex((t) => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Task not found" });
  Object.assign(db.tasks[idx], req.body);
  writeDB(db);
  res.json(db.tasks[idx]);
});

app.delete("/api/tasks/:id", (req, res) => {
  const db = readDB();
  db.tasks = db.tasks.filter((t) => t.id !== req.params.id);
  writeDB(db);
  res.status(204).send();
});

// ---------------- INCIDENT ROUTES ----------------

app.get("/api/incidents", (req, res) => {
  const db = readDB();
  const { handoverId } = req.query;
  const incidents = handoverId ? db.incidents.filter((i) => i.handoverId === handoverId) : db.incidents;
  res.json(incidents);
});

app.post("/api/incidents", (req, res) => {
  const db = readDB();
  const { handoverId, title, severity, description } = req.body;
  if (!handoverId || !title) {
    return res.status(400).json({ error: "handoverId and title are required" });
  }
  const incident = {
    id: "inc-" + uuidv4().slice(0, 8),
    handoverId,
    title,
    severity: severity || "Low",
    status: "Open",
    reportedAt: new Date().toISOString(),
    description: description || "",
  };
  db.incidents.push(incident);
  writeDB(db);
  res.status(201).json(incident);
});

app.put("/api/incidents/:id", (req, res) => {
  const db = readDB();
  const idx = db.incidents.findIndex((i) => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Incident not found" });
  Object.assign(db.incidents[idx], req.body);
  writeDB(db);
  res.json(db.incidents[idx]);
});

app.delete("/api/incidents/:id", (req, res) => {
  const db = readDB();
  db.incidents = db.incidents.filter((i) => i.id !== req.params.id);
  writeDB(db);
  res.status(204).send();
});

// ---------------- EXPORT: PDF ----------------

app.get("/api/handovers/:id/export/pdf", (req, res) => {
  const db = readDB();
  const h = getHandoverWithDetails(db, req.params.id);
  if (!h) return res.status(404).json({ error: "Handover not found" });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=handover-${h.id}.pdf`);

  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);

  doc.fontSize(18).text("Shift Handover Report", { align: "center" });
  doc.moveDown();
  doc.fontSize(10).fillColor("#555").text(`Report ID: ${h.id}`, { align: "center" });
  doc.moveDown(1.5);

  doc.fillColor("#000").fontSize(12).text(`Shift Date: ${h.shiftDate}`);
  doc.text(`Outgoing Shift: ${h.outgoingShift}  (Supervisor: ${h.outgoingSupervisor || "-"})`);
  doc.text(`Incoming Shift: ${h.incomingShift}  (Supervisor: ${h.incomingSupervisor || "-"})`);
  doc.text(`Status: ${h.status}`);
  doc.moveDown();

  doc.fontSize(14).text("Handover Summary", { underline: true });
  doc.fontSize(11).text(h.summary || "No summary provided.");
  doc.moveDown();

  doc.fontSize(14).text("Supervisor Remarks", { underline: true });
  doc.fontSize(11).text(h.supervisorRemarks || "No remarks provided.");
  doc.moveDown();

  doc.fontSize(14).text(`Pending Tasks (${h.tasks.length})`, { underline: true });
  if (h.tasks.length === 0) {
    doc.fontSize(11).text("No pending tasks.");
  } else {
    h.tasks.forEach((t, i) => {
      doc
        .fontSize(11)
        .text(
          `${i + 1}. [${t.priority}] ${t.description} — Assigned: ${t.assignedTo} | Status: ${t.status} | Due: ${t.dueDate || "-"}`
        );
    });
  }
  doc.moveDown();

  doc.fontSize(14).text(`Outstanding Incidents (${h.incidents.length})`, { underline: true });
  if (h.incidents.length === 0) {
    doc.fontSize(11).text("No incidents recorded.");
  } else {
    h.incidents.forEach((inc, i) => {
      doc
        .fontSize(11)
        .text(
          `${i + 1}. [${inc.severity}] ${inc.title} — Status: ${inc.status}\n   ${inc.description || ""}`
        );
    });
  }

  doc.moveDown(2);
  doc.fontSize(9).fillColor("#888").text(`Generated on ${new Date().toLocaleString()}`, { align: "right" });

  doc.end();
});

// ---------------- EXPORT: EXCEL ----------------

app.get("/api/handovers/:id/export/excel", async (req, res) => {
  const db = readDB();
  const h = getHandoverWithDetails(db, req.params.id);
  if (!h) return res.status(404).json({ error: "Handover not found" });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Digital Logbook System";
  workbook.created = new Date();

  // Summary sheet
  const summarySheet = workbook.addWorksheet("Handover Summary");
  summarySheet.columns = [
    { header: "Field", key: "field", width: 25 },
    { header: "Value", key: "value", width: 70 },
  ];
  summarySheet.addRows([
    { field: "Report ID", value: h.id },
    { field: "Shift Date", value: h.shiftDate },
    { field: "Outgoing Shift", value: h.outgoingShift },
    { field: "Outgoing Supervisor", value: h.outgoingSupervisor },
    { field: "Incoming Shift", value: h.incomingShift },
    { field: "Incoming Supervisor", value: h.incomingSupervisor },
    { field: "Status", value: h.status },
    { field: "Summary", value: h.summary },
    { field: "Supervisor Remarks", value: h.supervisorRemarks },
  ]);
  summarySheet.getRow(1).font = { bold: true };

  // Tasks sheet
  const taskSheet = workbook.addWorksheet("Pending Tasks");
  taskSheet.columns = [
    { header: "Description", key: "description", width: 45 },
    { header: "Assigned To", key: "assignedTo", width: 20 },
    { header: "Priority", key: "priority", width: 12 },
    { header: "Status", key: "status", width: 14 },
    { header: "Due Date", key: "dueDate", width: 14 },
  ];
  taskSheet.addRows(h.tasks);
  taskSheet.getRow(1).font = { bold: true };

  // Incidents sheet
  const incidentSheet = workbook.addWorksheet("Outstanding Incidents");
  incidentSheet.columns = [
    { header: "Title", key: "title", width: 30 },
    { header: "Severity", key: "severity", width: 12 },
    { header: "Status", key: "status", width: 14 },
    { header: "Reported At", key: "reportedAt", width: 22 },
    { header: "Description", key: "description", width: 50 },
  ];
  incidentSheet.addRows(h.incidents);
  incidentSheet.getRow(1).font = { bold: true };

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader("Content-Disposition", `attachment; filename=handover-${h.id}.xlsx`);

  await workbook.xlsx.write(res);
  res.end();
});

app.listen(PORT, () => {
  console.log(`Shift Handover & Reporting server running at http://localhost:${PORT}`);
});
