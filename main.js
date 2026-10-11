/*
  KPL Karvetinagar Premier League
  Flow:  1) Register  ->  2) Pay (locked until registered)  ->
         3) Organiser confirms payment  ->  player appears in Registration List

  Fixes in this version:
  - Duplicate mobile numbers are rejected
  - Transaction ID / UTR is asked when the player taps "I have paid"
    (so the organiser can match it with PhonePe / Google Pay) and a
    Transaction ID can be used only once
  - All localStorage / sessionStorage calls are wrapped in try-catch
  - Name, village, email, date of birth and mobile are validated
  - Date of birth must give an age between MIN_AGE and MAX_AGE
  - Confirmation windows before registering and before "I have paid"
*/

/* ===== SETTINGS ===== */

const REGISTRATION_FEE = 800;
const PAY_UPI_ID = "9100399367@axl";
const PAY_NAME = "K VANITHA";

/* Paste your Google Apps Script web app URL here (see apps-script.gs).
   While it is empty, data is saved only in THIS browser (testing mode). */
const BACKEND_URL = "";

/* Organiser PIN used in testing mode. With BACKEND_URL, the PIN is
   the ADMIN_PIN written inside apps-script.gs. */
const ORGANISER_PIN = "1234";

/* Allowed player age (years) */
const MIN_AGE = 10;
const MAX_AGE = 70;

const ROLES = ["Batsman", "Bowler", "Wicketkeeper", "All-Rounder"];

const LOCAL_KEY = "KPL_REGISTRATIONS_V2";
const MY_KEY = "KPL_MY_REGISTRATION";
const PIN_KEY = "KPL_ORGANISER_PIN";


const $ = function (id) { return document.getElementById(id); };


/* ===== SAFE STORAGE (never throws, even in private mode) ===== */

const memoryStore = {};
const memorySession = {};

function lsGet(key) {
  try {
    const value = localStorage.getItem(key);
    if (value !== null && value !== undefined) { return value; }
  } catch (e) { /* storage blocked */ }
  return Object.prototype.hasOwnProperty.call(memoryStore, key) ? memoryStore[key] : null;
}

function lsSet(key, value) {
  memoryStore[key] = value;
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    return false;
  }
}

function lsRemove(key) {
  delete memoryStore[key];
  try { localStorage.removeItem(key); } catch (e) { /* storage blocked */ }
}

function ssGet(key) {
  try {
    const value = sessionStorage.getItem(key);
    if (value !== null && value !== undefined) { return value; }
  } catch (e) { /* storage blocked */ }
  return Object.prototype.hasOwnProperty.call(memorySession, key) ? memorySession[key] : null;
}

function ssSet(key, value) {
  memorySession[key] = value;
  try { sessionStorage.setItem(key, value); } catch (e) { /* storage blocked */ }
}

function ssRemove(key) {
  delete memorySession[key];
  try { sessionStorage.removeItem(key); } catch (e) { /* storage blocked */ }
}


/* ===== HELPERS ===== */

function money(amount) {
  return "₹" + Number(amount || 0).toLocaleString("en-IN");
}

function safe(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c];
  });
}

function showMessage(text, error) {
  const el = $("message");
  el.textContent = text;
  el.style.color = error ? "#dc2626" : "#16a34a";
}

/* remove control characters and extra spaces */
function cleanText(value) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* stop spreadsheet formulas in exported CSV (=, +, -, @) */
function csvCell(value) {
  let text = String(value == null ? "" : value);
  if (/^[=+\-@]/.test(text)) { text = "'" + text; }
  return '"' + text.replace(/"/g, '""') + '"';
}

/* scroll helper (uses smooth scrolling library when it is loaded) */
function goTo(id) {
  const target = $(id);
  if (!target) { return; }
  if (window.KPL_UX && window.KPL_UX.scrollTo) {
    window.KPL_UX.scrollTo("#" + id);
  } else {
    target.scrollIntoView({ behavior: "smooth" });
  }
}


/* ===== CONFIRMATION WINDOW + TOAST ===== */

let modalResolve = null;

function askConfirm(options) {

  return new Promise(function (resolve) {

    $("confirmTitle").textContent = options.title;
    $("confirmBody").innerHTML = options.html;
    $("confirmYes").textContent = options.yes || "Confirm";
    $("confirmNo").textContent = options.no || "Cancel";

    modalResolve = resolve;

    $("confirmModal").classList.remove("hide");
    document.body.classList.add("modal-open");

    $("confirmYes").focus();

  });

}

function closeConfirm(result) {

  $("confirmModal").classList.add("hide");
  document.body.classList.remove("modal-open");

  if (modalResolve) {
    const done = modalResolve;
    modalResolve = null;
    done(result);
  }

}

$("confirmYes").addEventListener("click", function () { closeConfirm(true); });

$("confirmNo").addEventListener("click", function () { closeConfirm(false); });

$("confirmModal").addEventListener("click", function (e) {
  if (e.target === $("confirmModal")) { closeConfirm(false); }
});

document.addEventListener("keydown", function (e) {
  if (e.key === "Escape" && modalResolve) { closeConfirm(false); }
});

let toastTimer = null;

function showToast(title, text) {

  $("toastTitle").textContent = title;
  $("toastText").textContent = text;
  $("toast").classList.add("show");

  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    $("toast").classList.remove("show");
  }, 6000);

}

$("toast").addEventListener("click", function () {
  $("toast").classList.remove("show");
});


/* ===== VALIDATION ===== */

/* letters from any language (English, Telugu, Hindi ...), spaces . ' - */
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'\-]{1,59}$/u;
const VILLAGE_RE = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .,'\-\/]{1,59}$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MOBILE_RE = /^[6-9][0-9]{9}$/;
const UTR_RE = /^[A-Za-z0-9]{8,30}$/;

const FIELD_IDS = ["name", "mobile", "email", "dob", "role", "village"];

function ageFromDob(dob) {

  const born = new Date(dob + "T00:00:00");

  if (isNaN(born.getTime())) { return null; }

  const now = new Date();
  let age = now.getFullYear() - born.getFullYear();
  const month = now.getMonth() - born.getMonth();

  if (month < 0 || (month === 0 && now.getDate() < born.getDate())) {
    age--;
  }

  return age;

}

function validateDob(dob) {

  if (!dob) { return "Please select the date of birth."; }

  const age = ageFromDob(dob);

  if (age === null) { return "Please enter a valid date of birth."; }

  if (age < 0) { return "Date of birth cannot be in the future."; }

  if (age < MIN_AGE) { return "Player must be at least " + MIN_AGE + " years old."; }

  if (age > MAX_AGE) { return "Please check the date of birth (maximum age is " + MAX_AGE + ")."; }

  return "";

}

function validateField(id, value) {

  if (id === "name") {
    if (!value) { return "Please enter the player's full name."; }
    if (value.length < 2) { return "The name is too short."; }
    if (!NAME_RE.test(value) || !/\p{L}.*\p{L}/u.test(value)) {
      return "Use letters only (spaces, dots and hyphens are fine).";
    }
    return "";
  }

  if (id === "mobile") {
    if (!value) { return "Please enter the mobile number."; }
    if (!MOBILE_RE.test(value)) {
      return "Enter a valid 10-digit mobile number starting with 6, 7, 8 or 9.";
    }
    return "";
  }

  if (id === "email") {
    if (!value) { return ""; }
    if (value.length > 80 || !EMAIL_RE.test(value)) {
      return "Enter a valid email address, or leave it empty.";
    }
    return "";
  }

  if (id === "dob") { return validateDob(value); }

  if (id === "role") {
    return ROLES.indexOf(value) >= 0 ? "" : "Please select a playing role.";
  }

  if (id === "village") {
    if (!value) { return "Please enter the village or area."; }
    if (!VILLAGE_RE.test(value)) {
      return "Use letters and numbers only (2 to 60 characters).";
    }
    return "";
  }

  return "";

}

function setError(id, message) {

  const input = $(id);
  const note = $("err-" + id);

  if (note) { note.textContent = message || ""; }

  if (input) {
    input.classList.toggle("invalid", !!message);
    input.setAttribute("aria-invalid", message ? "true" : "false");
  }

}

function clearErrors() {
  FIELD_IDS.concat(["payUtr"]).forEach(function (id) { setError(id, ""); });
}

function readForm() {

  let mobile = $("mobile").value.replace(/\D/g, "");

  /* pasted as +91 98765 43210 */
  if (mobile.length === 12 && mobile.indexOf("91") === 0) {
    mobile = mobile.slice(2);
  }

  return {
    name: cleanText($("name").value),
    mobile: mobile,
    email: cleanText($("email").value).toLowerCase(),
    dob: $("dob").value,
    role: $("role").value,
    village: cleanText($("village").value)
  };

}


/* ===== DATA LAYER (testing mode in this browser, or Google Sheet) ===== */

function localAll() {
  try { return JSON.parse(lsGet(LOCAL_KEY)) || []; }
  catch (e) { return []; }
}

const SAVE_FAILED =
  "Your browser is blocking storage (private mode or storage full), so this is kept only until you close the page.";

let storageWarned = false;

function localSave(rows) {

  const saved = lsSet(LOCAL_KEY, JSON.stringify(rows));

  /* never crash: keep working from memory and tell the person once */
  if (!saved && !storageWarned) {
    storageWarned = true;
    showToast("Private mode", SAVE_FAILED);
  }

  return saved;

}

async function api(action, data) {

  data = data || {};

  if (BACKEND_URL) {

    let res;

    const controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
    const timer = controller ? setTimeout(function () { controller.abort(); }, 20000) : null;

    try {
      res = await fetch(BACKEND_URL, {
        method: "POST",
        body: JSON.stringify(Object.assign({ action: action }, data)),
        signal: controller ? controller.signal : undefined
      });
    } catch (e) {
      throw new Error("Could not reach the server. Please check your internet and try again.");
    } finally {
      if (timer) { clearTimeout(timer); }
    }

    let json;

    try { json = await res.json(); }
    catch (e) { throw new Error("The server sent an unexpected answer. Please try again."); }

    if (!json.ok) { throw new Error(json.error || "Server error"); }

    return json;

  }

  /* testing mode */

  const rows = localAll();

  if (action === "register") {

    const p = data.player;

    if (rows.some(function (x) { return x.mobile === p.mobile; })) {
      throw new Error("This mobile number is already registered. If you need help, please contact the organisers.");
    }

    p.id = "r" + Date.now();
    p.status = "pending";
    p.utr = "";
    rows.unshift(p);

    localSave(rows);

    return { ok: true, id: p.id };

  }

  if (action === "status" || action === "submitted") {

    const r = rows.find(function (x) { return x.id === data.id; });

    if (!r) { throw new Error("Registration not found"); }

    if (action === "submitted" && r.status === "pending") {

      const utr = String(data.utr || "").trim();

      if (!UTR_RE.test(utr)) {
        throw new Error("Please enter a valid Transaction ID / UTR.");
      }

      const used = rows.some(function (x) {
        return x.id !== r.id && String(x.utr || "").toLowerCase() === utr.toLowerCase();
      });

      if (used) {
        throw new Error("This Transaction ID is already used for another registration.");
      }

      r.utr = utr;
      r.status = "submitted";

      localSave(rows);

    }

    return { ok: true, status: r.status };

  }

  if (action === "listPaid") {
    return {
      ok: true,
      rows: rows.filter(function (x) { return x.status === "paid"; })
        .map(function (x) {
          return { name: x.name, role: x.role, village: x.village, date: x.date };
        })
    };
  }

  /* organiser actions */

  if (data.pin !== ORGANISER_PIN) { throw new Error("Wrong PIN"); }

  if (action === "adminList") { return { ok: true, rows: rows }; }

  if (action === "approve") {
    const r = rows.find(function (x) { return x.id === data.id; });
    if (r) {
      r.status = "paid";
      localSave(rows);
    }
    return { ok: true };
  }

  if (action === "delete") {
    localSave(rows.filter(function (x) { return x.id !== data.id; }));
    return { ok: true };
  }

  throw new Error("Unknown action");
}


/* ===== PROGRESS STEPS (Register > Pay > Confirmed) ===== */

function renderStepper() {

  const status = myReg ? myReg.status : "";

  const state = { reg: "active", pay: "", done: "" };

  if (status === "pending") {
    state.reg = "done";
    state.pay = "active";
  }

  if (status === "submitted") {
    state.reg = "done";
    state.pay = "done";
    state.done = "active";
  }

  if (status === "paid") {
    state.reg = "done";
    state.pay = "done";
    state.done = "done";
  }

  [["stepReg", "reg"], ["stepPay", "pay"], ["stepDone", "done"]].forEach(function (pair) {

    const el = $(pair[0]);

    if (!el) { return; }

    el.classList.remove("done");
    el.classList.remove("active");

    if (state[pair[1]]) { el.classList.add(state[pair[1]]); }

  });

}


/* ===== STEP 1: REGISTRATION ===== */

const form = $("registrationForm");

/* only digits in the mobile box */
$("mobile").addEventListener("input", function () {
  const cleaned = $("mobile").value.replace(/\D/g, "").slice(0, 12);
  if (cleaned !== $("mobile").value) { $("mobile").value = cleaned; }
});

/* check a field when the player leaves it, clear the error while typing */
FIELD_IDS.forEach(function (id) {

  const input = $(id);

  input.addEventListener("blur", function () {
    const values = readForm();
    setError(id, validateField(id, values[id]));
  });

  input.addEventListener("input", function () {
    if (input.classList.contains("invalid")) { setError(id, ""); }
  });

});

function summaryRow(label, value) {
  return "<dt>" + safe(label) + "</dt><dd>" + safe(value) + "</dd>";
}

form.addEventListener("submit", async function (event) {

  event.preventDefault();

  /* hidden trap field: real people never fill it */
  if ($("website").value) { return; }

  const values = readForm();

  let firstBad = "";

  FIELD_IDS.forEach(function (id) {
    const problem = validateField(id, values[id]);
    setError(id, problem);
    if (problem && !firstBad) { firstBad = id; }
  });

  if (firstBad) {
    showMessage("Please fix the highlighted fields.", true);
    $(firstBad).focus();
    return;
  }

  const ok = await askConfirm({
    title: "Check your details",
    html:
      '<dl class="summary">' +
      summaryRow("Name", values.name) +
      summaryRow("Mobile", "+91 " + values.mobile) +
      summaryRow("Date of birth", values.dob) +
      summaryRow("Role", values.role) +
      summaryRow("Village / Area", values.village) +
      summaryRow("Fee", money(REGISTRATION_FEE)) +
      "</dl>" +
      "<p>After you continue, the ₹" + REGISTRATION_FEE + " payment opens. " +
      "You appear in the Registration List only after the organisers confirm your payment.</p>",
    yes: "Yes, continue",
    no: "Edit details"
  });

  if (!ok) { return; }

  const player = {
    name: values.name,
    mobile: values.mobile,
    email: values.email,
    dob: values.dob,
    role: values.role,
    village: values.village,
    amount: REGISTRATION_FEE,
    date: new Date().toLocaleDateString("en-IN")
  };

  const button = form.querySelector(".submit-btn");
  button.disabled = true;
  showMessage("Saving your registration...", false);

  try {

    const result = await api("register", { player: player });

    myReg = { id: result.id, name: values.name, mobile: values.mobile, status: "pending" };
    saveMy();

    form.reset();
    clearErrors();

    showMessage("✅ Registration received. Now pay ₹" + REGISTRATION_FEE + " to confirm your place.", false);
    showToast("Registration received", "Now pay ₹" + REGISTRATION_FEE + " to confirm your place.");

    renderPayment();

    goTo("payment");

  } catch (err) {

    showMessage("Could not save the registration: " + err.message, true);

  } finally {

    button.disabled = false;

  }

});


/* ===== STEP 2: PAYMENT (locked until registered) ===== */

let myReg = null;

try { myReg = JSON.parse(lsGet(MY_KEY)); } catch (e) { myReg = null; }

function saveMy() {
  if (myReg) { lsSet(MY_KEY, JSON.stringify(myReg)); }
  else { lsRemove(MY_KEY); }
}

function renderPayment() {

  const status = myReg ? myReg.status : "";

  $("payLocked").classList.toggle("hide", !!myReg);
  $("payOpen").classList.toggle("hide", status !== "pending");
  $("payDone").classList.toggle("hide", !(status === "submitted" || status === "paid"));

  if (myReg) {
    $("payName").value = myReg.name;
    $("payPhone").value = myReg.mobile;
  }

  if (status === "paid") {
    $("payDoneTitle").textContent = "Payment confirmed";
    $("payDoneText").textContent =
      "Your payment is confirmed. You are now in the Registration List.";
  }

  if (status === "submitted") {
    $("payDoneTitle").textContent = "Payment submitted";
    $("payDoneText").textContent =
      "The organisers will check your payment. Your name appears in the Registration List after they confirm it.";
  }

  renderStepper();

}

function payQuery() {
  return "pa=" + encodeURIComponent(PAY_UPI_ID) +
    "&pn=" + encodeURIComponent(PAY_NAME) +
    "&am=" + REGISTRATION_FEE +
    "&cu=INR&tn=" + encodeURIComponent("KPL " + (myReg ? myReg.name : "Registration"));
}

function guardPay(e) {
  if (e) { e.preventDefault(); }
  if (!myReg || myReg.status !== "pending") {
    alert("Please complete the registration first.");
    return false;
  }
  return true;
}

$("payNow").addEventListener("click", function (e) {
  if (guardPay(e)) { window.location.href = "upi://pay?" + payQuery(); }
});

$("payPhonePe").addEventListener("click", function (e) {
  if (guardPay(e)) { window.location.href = "phonepe://pay?" + payQuery(); }
});

$("payGPay").addEventListener("click", function (e) {
  if (guardPay(e)) { window.location.href = "tez://upi/pay?" + payQuery(); }
});

/* copy the UPI ID (for players who pay by typing it) */
$("copyUpi").addEventListener("click", async function () {

  let copied = false;

  try {
    await navigator.clipboard.writeText(PAY_UPI_ID);
    copied = true;
  } catch (e) {
    try {
      const temp = document.createElement("textarea");
      temp.value = PAY_UPI_ID;
      document.body.appendChild(temp);
      temp.select();
      copied = document.execCommand("copy");
      document.body.removeChild(temp);
    } catch (e2) { copied = false; }
  }

  $("copyUpi").textContent = copied ? "Copied ✓" : "Copy failed";

  setTimeout(function () { $("copyUpi").textContent = "Copy"; }, 2000);

});

$("payUtr").addEventListener("input", function () {
  if ($("payUtr").classList.contains("invalid")) { setError("payUtr", ""); }
});

$("paidBtn").addEventListener("click", async function () {

  if (!guardPay()) { return; }

  const utr = cleanText($("payUtr").value).replace(/\s/g, "");

  if (!UTR_RE.test(utr)) {
    setError("payUtr", "Enter the Transaction ID / UTR shown in your payment app (8 to 30 letters or numbers).");
    $("payUtr").focus();
    return;
  }

  setError("payUtr", "");

  const ok = await askConfirm({
    title: "Have you paid ₹" + REGISTRATION_FEE + "?",
    html:
      '<dl class="summary">' +
      summaryRow("Player", myReg.name) +
      summaryRow("Amount", money(REGISTRATION_FEE)) +
      summaryRow("Transaction ID", utr) +
      "</dl>" +
      "<p>Tap “Yes, I paid” only after the payment is done. The organisers match this " +
      "Transaction ID with their PhonePe / Google Pay records before confirming you.</p>",
    yes: "Yes, I paid",
    no: "Not yet"
  });

  if (!ok) { return; }

  try {

    await api("submitted", { id: myReg.id, utr: utr });

    myReg.status = "submitted";
    saveMy();
    renderPayment();

    showToast("Payment submitted", "The organisers will confirm it soon.");

  } catch (err) {

    setError("payUtr", err.message);

  }

});

$("newBtn").addEventListener("click", function () {
  myReg = null;
  saveMy();
  renderPayment();
  goTo("register");
});

async function refreshMyStatus() {

  if (!myReg || myReg.status === "paid") { return; }

  try {

    const r = await api("status", { id: myReg.id });

    if (r.status !== myReg.status) {
      myReg.status = r.status;
      saveMy();
    }

  } catch (e) {

    /* the organiser deleted this registration: start again */
    if (/not found/i.test(e.message)) {
      myReg = null;
      saveMy();
    }

  }

  renderPayment();

}


/* ===== STEP 3: CONFIRMED PLAYERS (public list) ===== */

let paidRows = [];

async function loadPaid() {
  try {
    const r = await api("listPaid");
    paidRows = r.rows || [];
  } catch (e) {
    paidRows = [];
  }
  displayRegistrations();
}

function displayRegistrations() {

  const search = $("search").value.toLowerCase().trim();

  const filtered = paidRows.filter(function (p) {
    return [p.name, p.role, p.village].some(function (v) {
      return String(v || "").toLowerCase().includes(search);
    });
  });

  $("playerTable").innerHTML = filtered.map(function (p, i) {
    return "<tr><td>" + (i + 1) + "</td><td><strong>" + safe(p.name) + "</strong></td><td>" +
      (safe(p.role) || "-") + "</td><td>" + (safe(p.village) || "-") + "</td><td>" +
      safe(p.date) + "</td></tr>";
  }).join("");

  $("empty").style.display = filtered.length === 0 ? "block" : "none";

  updateStatistics();

}

function updateStatistics() {

  const today = new Date().toLocaleDateString("en-IN");

  $("playerCount").textContent = paidRows.length;
  $("totalAmount").textContent = money(paidRows.length * REGISTRATION_FEE);
  $("todayCount").textContent = paidRows.filter(function (p) {
    return p.date === today;
  }).length;

}

$("search").addEventListener("input", displayRegistrations);


/* ===== ORGANISER: verify payments ===== */

let adminRows = [];
let adminPin = ssGet(PIN_KEY) || "";

const STATUS_TEXT = {
  pending: "Waiting for payment",
  submitted: "Paid? Verify now",
  paid: "Confirmed"
};

const STATUS_ORDER = { submitted: 0, pending: 1, paid: 2 };

async function loadAdmin(pin) {
  const r = await api("adminList", { pin: pin });
  adminRows = r.rows || [];
  adminPin = pin;
  ssSet(PIN_KEY, pin);
  $("orgPanel").classList.remove("hide");
  $("orgBtn").classList.add("hide");
  renderAdmin();
}

function renderAdmin() {

  const rows = adminRows.slice().sort(function (a, b) {
    return (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  });

  $("orgTable").innerHTML = rows.map(function (p) {
    const confirmBtn = p.status === "paid" ? "" :
      '<button class="ok" data-act="approve" data-id="' + safe(p.id) + '">Confirm Paid</button> ';
    return "<tr><td><strong>" + safe(p.name) + "</strong></td><td>" + safe(p.mobile) +
      "</td><td>" + safe(p.village) + "</td><td>" + safe(p.role) +
      "</td><td>" + (safe(p.utr) || "-") +
      '</td><td><span class="badge ' + safe(p.status) + '">' + (STATUS_TEXT[p.status] || safe(p.status)) +
      "</span></td><td>" + confirmBtn +
      '<button class="delete" data-act="delete" data-id="' + safe(p.id) + '">Delete</button></td></tr>';
  }).join("");

  $("orgEmpty").style.display = rows.length === 0 ? "block" : "none";

}

$("orgBtn").addEventListener("click", async function () {

  const pin = prompt("Enter organiser PIN");
  if (!pin) { return; }

  try { await loadAdmin(pin); }
  catch (err) { alert(err.message); }

});

$("orgLogout").addEventListener("click", function () {
  ssRemove(PIN_KEY);
  adminPin = "";
  adminRows = [];
  $("orgPanel").classList.add("hide");
  $("orgBtn").classList.remove("hide");
});

$("orgTable").addEventListener("click", async function (e) {

  const btn = e.target.closest("button[data-act]");
  if (!btn) { return; }

  const act = btn.dataset.act;
  const id = btn.dataset.id;

  if (act === "delete" && !confirm("Delete this registration?")) { return; }

  if (act === "approve" && !confirm("Confirm that you received ₹" + REGISTRATION_FEE + " for this player?")) { return; }

  try {
    await api(act, { id: id, pin: adminPin });
    await loadAdmin(adminPin);
    loadPaid();
  } catch (err) {
    alert(err.message);
  }

});

$("exportBtn").addEventListener("click", function () {

  if (adminRows.length === 0) {
    alert("No registrations to export.");
    return;
  }

  const headers = ["Name", "Mobile", "Email", "Date of Birth", "Role", "Village", "Amount", "UTR", "Status", "Date"];

  const lines = [headers].concat(adminRows.map(function (p) {
    return [p.name, p.mobile, p.email, p.dob, p.role, p.village, p.amount, p.utr, p.status, p.date];
  })).map(function (row) {
    return row.map(csvCell).join(",");
  }).join("\n");

  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob(["\ufeff" + lines], { type: "text/csv;charset=utf-8;" }));
  link.download = "KPL_Registrations.csv";
  link.click();
  URL.revokeObjectURL(link.href);

});


/* ===== FIXTURES: fade matches that are over ===== */

document.querySelectorAll(".fx-day").forEach(function (day) {
  if (new Date(day.dataset.date + "T23:59:59") < new Date()) {
    day.classList.add("past");
  }
});


/* ===== START ===== */

/* date of birth limits in the date picker */

(function setDobLimits() {

  const now = new Date();

  const latest = new Date(now.getFullYear() - MIN_AGE, now.getMonth(), now.getDate());
  const earliest = new Date(now.getFullYear() - MAX_AGE - 1, now.getMonth(), now.getDate());

  function iso(d) { return d.toISOString().split("T")[0]; }

  $("dob").max = iso(latest);
  $("dob").min = iso(earliest);

})();

renderPayment();
refreshMyStatus();
loadPaid();

if (adminPin) {
  loadAdmin(adminPin).catch(function () {
    ssRemove(PIN_KEY);
  });
}