const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const DB = path.join(__dirname, "complaints.json");
const HOD_PASSWORD = process.env.HOD_PASSWORD || "hod123"; // CHANGE THIS
const tokens = new Set();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const load = () => (fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB)) : []);
const save = (data) => fs.writeFileSync(DB, JSON.stringify(data, null, 2));

function auth(req, res, next) {
  const t = (req.headers.authorization || "").replace("Bearer ", "");
  if (!tokens.has(t)) return res.status(401).json({ error: "Not logged in" });
  next();
}

// Student: submit complaint
app.post("/api/complaints", (req, res) => {
  const { room, type, description, name } = req.body;
  if (!room || !type) return res.status(400).json({ error: "Room and issue type are required" });
  const data = load();
  data.unshift({
    id: Date.now(),
    room: String(room).trim().slice(0, 40),
    type: String(type).slice(0, 20),
    description: String(description || "").trim().slice(0, 500),
    name: String(name || "").trim().slice(0, 60),
    status: "Pending",
    date: new Date().toISOString(),
  });
  save(data);
  res.json({ ok: true });
});

// HOD: login
app.post("/api/login", (req, res) => {
  if (req.body.password !== HOD_PASSWORD) return res.status(401).json({ error: "Wrong password" });
  const t = crypto.randomBytes(24).toString("hex");
  tokens.add(t);
  res.json({ token: t });
});

// HOD: list complaints
app.get("/api/complaints", auth, (req, res) => res.json(load()));

// HOD: change status
app.patch("/api/complaints/:id", auth, (req, res) => {
  const data = load();
  const c = data.find((x) => x.id === Number(req.params.id));
  if (!c) return res.status(404).json({ error: "Not found" });
  if (["Pending", "In Progress", "Fixed"].includes(req.body.status)) c.status = req.body.status;
  save(data);
  res.json(c);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Running on http://localhost:" + PORT));