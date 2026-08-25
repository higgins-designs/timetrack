import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, DB_SCHEMA } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  db: { schema: DB_SCHEMA },
  auth: { persistSession: true, autoRefreshToken: true },
});

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- state
let bootedUid = null;     // guards against re-booting on token refresh
let me = null;
let projects = [];        // pickable projects (active/on_hold, assigned)
let labelCache = {};      // id -> label, incl. projects that left the picker
let running = null;       // the live timer entry, if any
let paused = null;        // a timer banked mid-session, waiting to resume
let dayDate = ymd(new Date());   // the day the entry panel is showing
let dayEntries = [];
let weekStart = startOfWeek(new Date());
let weekEntries = [];     // FINISHED entries for the week
let weekRunning = [];     // LIVE timers in the week - must be visible to the grid
let tick = null;
const savingCells = new Set();
// Grid rows for projects with no hours yet this week. Without these the grid can
// only show work you have already logged, which on an empty tracker is nothing.
const extraRows = new Set();

// ------------------------------------------------------------- helpers

// Local calendar date, never UTC: a 7pm Austin entry must not land on tomorrow.
function ymd(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function parseYmd(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function startOfWeek(d) {                    // Monday
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function hhmmss(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n) => String(n).padStart(2, "0");
  return `${Math.floor(s / 3600)}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}
function hrs(minutes) {
  if (!minutes) return "";
  return (minutes / 60).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}
function projLabel(p) {
  return p.is_overhead ? p.name : `${p.number} — ${p.name}`;
}
function labelFor(projectId) {
  const p = projects.find((x) => String(x.id) === String(projectId));
  if (p) return projLabel(p);
  return labelCache[projectId] || `Project #${projectId}`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const KIND_LABEL = {
  design: "Design", review: "Review", coordination: "Coordination",
  site_visit: "Site visit", rfi: "RFI", admin: "Admin", other: "Other",
};
// One source for the work kinds. There used to be three — this map plus two
// hand-written <select> blocks in the markup — which had to be kept in step.
document.querySelectorAll("select[data-kinds]").forEach((sel) => {
  sel.innerHTML = Object.entries(KIND_LABEL)
    .map(([k, l]) => `<option value="${k}">${l}</option>`).join("");
});

let toastTimer = null;
function toast(msg, kind = "ok") {
  const t = $("toast");
  t.textContent = msg;
  t.className = "show" + (kind === "err" ? " err" : kind === "warn" ? " warn" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), kind === "ok" ? 2600 : 6000);
}
function fail(where, error) {
  console.error(where, error);
  toast(`${where}: ${(error && error.message) || error}`, "err");
}

// ----------------------------------------------------------------- auth

let signupMode = false;

$("toggle-mode").addEventListener("click", (e) => {
  e.preventDefault();
  signupMode = !signupMode;
  document.querySelectorAll(".signup-only").forEach((n) => n.classList.toggle("hidden", !signupMode));
  $("login-btn").textContent = signupMode ? "Create account" : "Sign in";
  $("toggle-mode").textContent = signupMode
    ? "Already have an account? Sign in"
    : "Need an account? Sign up";
  $("password").autocomplete = signupMode ? "new-password" : "current-password";
  $("login-msg").textContent = "";
});

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("login-btn");
  btn.disabled = true;
  $("login-msg").textContent = "";
  const email = $("email").value.trim();
  const password = $("password").value;
  try {
    if (signupMode) {
      const { error } = await sb.auth.signUp({
        email, password,
        options: { data: { full_name: $("fullname").value.trim() || email } },
      });
      $("login-msg").innerHTML = error
        ? `<span style="color:var(--err)">${escapeHtml(error.message)}</span>`
        : `<span style="color:var(--warn)">Account created. Check your email for a
           confirmation link, then an admin has to activate you before you can log time.</span>`;
      return;
    }
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) $("login-msg").innerHTML = `<span style="color:var(--err)">${escapeHtml(error.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
});

$("signout").addEventListener("click", async () => {
  await sb.auth.signOut();
  location.reload();
});

// Only react to a genuine identity change. Supabase fires this for
// TOKEN_REFRESHED and on every tab refocus; re-booting there used to reset the
// manual-entry date and wipe whatever was being typed into the week grid.
sb.auth.onAuthStateChange((_evt, session) => {
  if (!session) { bootedUid = null; showLogin(); return; }
  if (session.user.id === bootedUid) return;
  boot(session.user.id);
});

function showLogin(message) {
  $("login").classList.remove("hidden");
  $("app").classList.add("hidden");
  if (message) $("login-msg").innerHTML = message;
}

// ----------------------------------------------------------------- boot

async function boot(uid) {
  bootedUid = uid;                       // set first: blocks re-entrant boots
  const { data: emp, error } = await sb
    .from("employees")
    .select("id, email, full_name, role, active, rate_class")
    .eq("id", uid)                       // admins can read everyone; this view is personal
    .maybeSingle();

  // Any failure here must land somewhere visible. Previously both panes stayed
  // hidden and the page went blank with only a transient toast.
  if (error) {
    bootedUid = null;
    return showLogin(`<span style="color:var(--err)">Could not load your profile:
      ${escapeHtml(error.message)}</span>`);
  }
  if (!emp) {
    bootedUid = null;
    return showLogin(`<span style="color:var(--err)">You are signed in, but have no
      employee record yet. An admin needs to add you.</span>`);
  }
  if (!emp.active) {
    bootedUid = null;
    return showLogin(`<span style="color:var(--warn)">Your account is not active yet.
      An admin has to switch it on before you can log time.<br><br>
      <b>If you are the first person here</b>, there is no admin to do it — run
      <code>supabase/bootstrap_admin.sql</code> once.</span>`);
  }

  me = emp;
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("who").textContent = `${me.full_name}${me.role === "admin" ? " · admin" : ""}`;
  $("m-date").value = ymd(new Date());
  dayDate = ymd(new Date());

  await loadProjects();
  await Promise.all([loadRunning(), loadDay(), loadWeek(), loadDrafts()]);
  if (me.role === "admin") {
    $("admin-card").classList.remove("hidden");
    $("tab-people-btn").classList.remove("hidden");
    $("tab-proposals-btn").classList.remove("hidden");
    $("letter-card").classList.remove("hidden");
    await loadPeople();
  }
  initVisitForm();   // needs projects, and people if this is an admin
  initHoursControls();
  initTodo();        // needs projects and people too
  await loadTasks();
  renderProjectContext();
  await loadOverview();   // Overview is the landing tab
}

// The dashboard's working context for whatever project is selected: phase,
// client and the current next action, so you can see what a job is waiting on
// without leaving the timer.
function renderProjectContext() {
  const box = $("proj-context");
  if (!box) return;
  const p = projects.find((x) => String(x.id) === String($("proj").value));
  if (!p || (!p.phase && !p.client && !p.next_action)) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  box.innerHTML =
    `${p.phase ? `<span class="tag sched">${escapeHtml(p.phase)}</span>` : ""}` +
    `${p.client ? `<span class="small muted"> ${escapeHtml(p.client)}</span>` : ""}` +
    `${p.next_action ? `<div class="small" style="margin-top:6px">
        <b>Next:</b> ${escapeHtml(p.next_action)}</div>` : ""}`;
}

$("proj").addEventListener("change", () => {
  renderProjectContext();
  // Picking a project here also gives it a row in the week grid, so the fastest
  // surface in the app is reachable without first logging time the slow way.
  if ($("proj").value) { extraRows.add(String($("proj").value)); renderWeek(); }
});

// ------------------------------------------------------- project combobox
// Every project you have access to, including closed ones — a warranty visit or
// a late correction lands on a job that closed months ago, and it still has to
// be loggable. Grouped so the live work stays at the top of a long list.
//
// This replaced a <select>. With 296 projects a native picker is unusable: its
// type-ahead matches from the start of the option text, the text starts with the
// project number, and nobody remembers that 1007 Jewell is 26036. It also always
// has something selected, so a hurried click on Start logged an hour against
// whichever job sorted first. This starts empty and matches anywhere.

const combos = new Map();       // hidden input id -> { list, filtered, hi }

const GROUP_ORDER = [
  ["Active", (p) => !p.is_overhead && p.status === "active"],
  ["On hold", (p) => !p.is_overhead && p.status === "on_hold"],
  ["Overhead", (p) => p.is_overhead],
  ["Closed", (p) => !p.is_overhead && p.status === "closed"],
];

function comboMatches(list, q) {
  const needle = q.trim().toLowerCase();
  const out = [];
  for (const [label, test] of GROUP_ORDER) {
    const items = list.filter((p) => test(p) &&
      (!needle || `${p.number || ""} ${p.name}`.toLowerCase().includes(needle)));
    if (items.length) out.push([label, items]);
  }
  return out;
}

function fillProjectCombo(hidden, list) {
  if (!hidden) return;
  const c = combos.get(hidden.id);
  if (c) { c.source = list; return; }
  attachCombo(hidden, list);
}

function attachCombo(hidden, list) {
  const q = $(`${hidden.id}-q`);
  const box = $(`${hidden.id}-list`);
  if (!q || !box) return;

  const c = { source: list, flat: [], hi: -1, open: false };
  combos.set(hidden.id, c);

  // Prefer this combo's own list: the assignment picker is loaded from a wider
  // query than the global `projects`, so labelFor can come up empty there.
  const labelOf = (id) => {
    const p = c.source.find((x) => String(x.id) === String(id));
    return p ? projLabel(p) : labelFor(id);
  };

  function open() {
    render();
    box.classList.remove("hidden");
    q.setAttribute("aria-expanded", "true");
    c.open = true;
  }
  function close() {
    box.classList.add("hidden");
    q.setAttribute("aria-expanded", "false");
    c.open = false;
    c.hi = -1;
  }
  function render() {
    const groups = comboMatches(c.source, q.value);
    c.flat = groups.flatMap(([, items]) => items);
    if (c.hi >= c.flat.length) c.hi = c.flat.length - 1;
    if (!c.flat.length) {
      box.innerHTML = `<div class="none">No project matches that.</div>`;
      return;
    }
    let i = -1;
    box.innerHTML = groups.map(([label, items]) =>
      `<div class="grp">${label} (${items.length})</div>` +
      items.map((p) => {
        i += 1;
        return `<div class="opt${i === c.hi ? " on" : ""}" data-i="${i}" role="option">${
          p.is_overhead ? "" : `<span class="n">${escapeHtml(p.number || "")}</span>`
        }${escapeHtml(p.name)}</div>`;
      }).join("")).join("");
    const on = box.querySelector(".opt.on");
    if (on) on.scrollIntoView({ block: "nearest" });
  }
  function choose(i) {
    const p = c.flat[i];
    if (!p) return;
    hidden.value = p.id;
    q.value = projLabel(p);
    close();
    hidden.dispatchEvent(new Event("change", { bubbles: true }));
  }

  q.addEventListener("focus", open);
  q.addEventListener("input", () => {
    // Typing invalidates the selection: the text and the id must never disagree,
    // or a stale id gets submitted with a label that says something else.
    if (hidden.value) { hidden.value = ""; hidden.dispatchEvent(new Event("change", { bubbles: true })); }
    c.hi = q.value.trim() ? 0 : -1;
    if (!c.open) open(); else render();
  });
  q.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!c.open) return open();
      c.hi = Math.max(0, Math.min(c.flat.length - 1, c.hi + (e.key === "ArrowDown" ? 1 : -1)));
      render();
    } else if (e.key === "Enter") {
      if (c.open && c.hi >= 0) { e.preventDefault(); choose(c.hi); }
    } else if (e.key === "Escape") {
      if (c.open) { e.preventDefault(); close(); }
    }
  });
  q.addEventListener("blur", () => {
    // Let a click on an option land first.
    setTimeout(() => {
      close();
      // Snap the text back to whatever is actually selected, so a half-typed
      // query never sits there looking like a choice.
      q.value = hidden.value ? labelOf(hidden.value) : "";
    }, 120);
  });
  box.addEventListener("mousedown", (e) => {
    const opt = e.target.closest(".opt");
    if (!opt) return;
    e.preventDefault();            // keep focus, so blur does not undo the pick
    choose(Number(opt.dataset.i));
  });
}

// Set a combo's value from code — used when a form needs to preselect a job.
function setCombo(hiddenId, projectId) {
  const hidden = $(hiddenId);
  const q = $(`${hiddenId}-q`);
  if (!hidden || !q) return;
  hidden.value = projectId == null ? "" : String(projectId);
  q.value = projectId == null ? "" : labelFor(projectId);
  hidden.dispatchEvent(new Event("change", { bubbles: true }));
}

async function loadProjects() {
  const { data, error } = await sb
    .from("projects")
    .select("id, number, name, is_overhead, status, phase, client, next_action")
    .order("is_overhead", { ascending: true })
    .order("number", { ascending: false });

  if (error) return fail("Loading projects", error);
  projects = data || [];
  for (const p of projects) labelCache[p.id] = projLabel(p);

  if (!projects.length) toast("No projects are assigned to you yet.", "warn");

  fillProjectCombo($("proj"), projects);
  fillProjectCombo($("m-proj"), projects);
  fillProjectCombo($("wk-proj"), projects);
}

// Labels for projects that have time logged but have dropped out of the picker
// (closed, or unassigned since). Without this their hours vanish from the grid.
async function ensureLabels(ids) {
  const missing = [...new Set(ids.map(String))].filter((id) => !labelCache[id]);
  if (!missing.length) return;
  const { data } = await sb
    .from("projects")
    .select("id, number, name, is_overhead")
    .in("id", missing);
  for (const p of data || []) labelCache[p.id] = projLabel(p);
  // RLS may hide it entirely; still show the hours under a neutral label.
  for (const id of missing) if (!labelCache[id]) labelCache[id] = `Project #${id}`;
}

// ---------------------------------------------------------------- timer

const TIMER_COLS = "id, project_id, task_kind, notes, started_at, work_date, accrued_seconds, minutes";

// A paused timer is stored in the finished shape — minutes and ended_at set —
// with paused_at marking it as resumable. That keeps it legal under
// time_entries_finished_or_running without relaxing anything, and it means a
// paused timer that is never resumed is simply a completed entry.
async function loadRunning() {
  const [{ data: live, error: e1 }, { data: held, error: e2 }] = await Promise.all([
    sb.from("time_entries").select(TIMER_COLS)
      .eq("employee_id", me.id).is("ended_at", null).not("started_at", "is", null).maybeSingle(),
    sb.from("time_entries").select(TIMER_COLS)
      .eq("employee_id", me.id).not("paused_at", "is", null).maybeSingle(),
  ]);
  if (e1) return fail("Checking the running timer", e1);
  if (e2) return fail("Checking for a paused timer", e2);
  running = live || null;
  paused = held || null;
  renderTimer();
}

// Milliseconds on the clock face: what was banked before the current pause,
// plus the segment running now.
function elapsedMs(entry, live) {
  const banked = (entry.accrued_seconds || 0) * 1000;
  return live ? banked + (Date.now() - new Date(entry.started_at).getTime()) : banked;
}

function renderTimer() {
  const box = $("timer");
  clearInterval(tick);
  const entry = running || paused;

  $("stop-btn").classList.toggle("hidden", !entry);
  $("pause-btn").classList.toggle("hidden", !running);
  $("resume-btn").classList.toggle("hidden", !paused || Boolean(running));

  if (!entry) {
    box.classList.add("idle");
    box.classList.remove("held");
    $("elapsed").textContent = "0:00:00";
    $("timer-what").innerHTML =
      `<div class="proj">Nothing running</div>
       <div class="sub">Pick a project below and start the clock.</div>`;
    return;
  }

  box.classList.remove("idle");
  box.classList.toggle("held", Boolean(paused && !running));
  $("timer-what").innerHTML =
    `<div class="proj">${escapeHtml(labelFor(entry.project_id))}${
      paused && !running ? ` <span class="tag nb">paused</span>` : ""}</div>
     <div class="sub">${escapeHtml(KIND_LABEL[entry.task_kind] || entry.task_kind)}${
       entry.notes ? " · " + escapeHtml(entry.notes) : ""
     }${paused && !running ? " · resume or stop it" : ""}</div>`;

  const paint = () => ($("elapsed").textContent = hhmmss(elapsedMs(entry, Boolean(running))));
  paint();
  // A paused clock does not move, so there is nothing to tick.
  if (running) tick = setInterval(paint, 1000);
}

$("pause-btn").addEventListener("click", async () => {
  $("pause-btn").disabled = true;
  try {
    if (!running) return toast("There is no running timer to pause.", "warn");
    const now = new Date();
    const total = (running.accrued_seconds || 0) +
      Math.floor((now - new Date(running.started_at)) / 1000);

    // Banked in SECONDS. The minutes value has to be set for the row to satisfy
    // time_entries_finished_or_running, but it is provisional — the real
    // round-up happens once, on the final stop. Rounding on every pause would
    // let five pauses invent five minutes.
    const { data, error } = await sb.from("time_entries")
      .update({
        ended_at: now.toISOString(),
        minutes: Math.max(1, Math.ceil(total / 60)),
        accrued_seconds: total,
        paused_at: now.toISOString(),
      })
      .eq("id", running.id)
      .is("ended_at", null)              // a stale tab cannot pause a stopped entry
      .select("id");

    if (error) return fail("Pausing the timer", error);
    if (!data || !data.length) {
      return toast("That timer was already stopped somewhere else.", "warn");
    }
    toast(`Paused at ${hhmmss(total * 1000)}.`);
  } finally {
    await loadRunning();
    await Promise.all([loadDay(), loadWeek()]);
    $("pause-btn").disabled = false;
  }
});

$("resume-btn").addEventListener("click", async () => {
  $("resume-btn").disabled = true;
  try {
    if (!paused) return toast("There is no paused timer.", "warn");
    // Back to the running shape. The unique running index is what stops this
    // from creating a second live timer, so a failure here is the database
    // refusing correctly rather than something to work around.
    const { data, error } = await sb.from("time_entries")
      .update({
        started_at: new Date().toISOString(),
        ended_at: null,
        minutes: null,
        paused_at: null,
      })
      .eq("id", paused.id)
      .not("paused_at", "is", null)      // only resume something still paused
      .select("id");

    if (error) return fail("Resuming the timer", error);
    if (!data || !data.length) {
      return toast("That timer is no longer paused — nothing was changed.", "warn");
    }
    toast("Resumed.");
  } finally {
    await loadRunning();
    await Promise.all([loadDay(), loadWeek()]);
    $("resume-btn").disabled = false;
  }
});

$("start-btn").addEventListener("click", async () => {
  const projectId = $("proj").value;
  if (!projectId) return toast("Pick a project first.", "err");

  $("start-btn").disabled = true;
  try {
    // Only one timer may run at a time, so a switch means closing the old one.
    if (running) {
      const stopped = await stopRunning();
      if (!stopped) return;              // finally-block still reconciles the UI
    }
    // A paused timer is already saved; starting something else just finalises
    // it. Leaving paused_at set would strand it against the one-paused index.
    if (paused) {
      const { error: e } = await sb.from("time_entries")
        .update({ paused_at: null }).eq("id", paused.id);
      if (e) return fail("Closing the paused timer", e);
      toast("The paused timer was left as recorded.", "warn");
    }
    const { error } = await sb.from("time_entries").insert({
      employee_id: me.id,
      project_id: Number(projectId),
      work_date: ymd(new Date()),
      started_at: new Date().toISOString(),
      task_kind: $("kind").value,
      notes: $("notes").value.trim() || null,
    });
    if (error) {
      // The previous timer is already saved. Say so, or the user assumes
      // nothing happened and the phantom clock keeps ticking.
      return fail("Starting the timer (any previous timer was stopped and saved)", error);
    }
    $("notes").value = "";
    toast("Timer started.");
  } finally {
    // Always reconcile against the server, on every path including errors.
    await loadRunning();
    await Promise.all([loadDay(), loadWeek()]);
    $("start-btn").disabled = false;
  }
});

$("stop-btn").addEventListener("click", async () => {
  $("stop-btn").disabled = true;
  try {
    if (await stopRunning()) toast("Timer stopped.");
  } finally {
    await loadRunning();
    await Promise.all([loadDay(), loadWeek()]);
    $("stop-btn").disabled = false;
  }
});

async function stopRunning() {
  // Stopping a paused timer just settles it: the time is already banked and the
  // row is already in the finished shape, so only the marker has to go.
  if (!running && paused) {
    const { data, error } = await sb.from("time_entries")
      .update({ paused_at: null }).eq("id", paused.id)
      .not("paused_at", "is", null).select("id");
    if (error) { fail("Stopping the timer", error); return false; }
    paused = null;
    return Boolean(data && data.length);
  }
  if (!running) {
    // Never report success for a stop that wrote nothing.
    toast("There was no running timer to stop.", "warn");
    return false;
  }
  const ended = new Date();
  const started = new Date(running.started_at);
  // Everything banked across earlier pauses, plus this segment. Round up ONCE,
  // here, so a 40-second call is a minute rather than nothing — and so a
  // pause-heavy hour is not inflated a minute at a time.
  const total = (running.accrued_seconds || 0) + Math.floor((ended - started) / 1000);
  const minutes = Math.max(1, Math.ceil(total / 60));

  // `.is("ended_at", null)` is what stops a stale tab from rewriting an entry
  // that was already closed elsewhere and inflating its minutes.
  const { data, error } = await sb
    .from("time_entries")
    .update({ ended_at: ended.toISOString(), minutes, accrued_seconds: total })
    .eq("id", running.id)
    .is("ended_at", null)
    .select("id");

  if (error) { fail("Stopping the timer", error); return false; }
  if (!data || !data.length) {
    toast("That timer was already stopped somewhere else — nothing was changed.", "warn");
    running = null;
    return false;
  }
  running = null;
  return true;
}

// ------------------------------------------------------- day entry panel

async function loadDay() {
  const { data, error } = await sb
    .from("time_entries")
    .select("id, project_id, task_kind, notes, minutes, started_at, ended_at, billable")
    .eq("employee_id", me.id)
    .eq("work_date", dayDate)
    // Drafts live in their own panel until accepted. A reconstructed guess
    // sitting in the day total would be indistinguishable from a logged hour.
    .eq("confirmed", true)
    .order("created_at", { ascending: true });

  if (error) return fail("Loading the day", error);
  dayEntries = data || [];
  await ensureLabels(dayEntries.map((e) => e.project_id));
  renderDay();
}

function renderDay() {
  const d = parseYmd(dayDate);
  const isToday = dayDate === ymd(new Date());
  $("day-date").textContent =
    (isToday ? "Today · " : "") +
    d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  $("day-today-btn").classList.toggle("hidden", isToday);

  const done = dayEntries.filter((e) => e.minutes != null);
  const live = dayEntries.filter((e) => e.minutes == null);
  const body = $("day-body");
  body.innerHTML = "";
  $("day-empty").classList.toggle("hidden", done.length > 0 || live.length > 0);
  $("day-table").classList.toggle("hidden", done.length === 0 && live.length === 0);

  let total = 0;
  for (const e of live) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(labelFor(e.project_id))}</td>
      <td><span class="tag">${escapeHtml(KIND_LABEL[e.task_kind] || e.task_kind)}</span></td>
      <td class="small muted">${e.notes ? escapeHtml(e.notes) : ""}</td>
      <td class="num muted">running</td><td></td>`;
    body.appendChild(tr);
  }
  for (const e of done) {
    total += e.minutes;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(labelFor(e.project_id))}</td>
      <td><span class="tag">${escapeHtml(KIND_LABEL[e.task_kind] || e.task_kind)}</span>
          ${e.billable ? "" : '<span class="tag nb">non-billable</span>'}</td>
      <td class="small muted">${e.notes ? escapeHtml(e.notes) : ""}</td>
      <td class="num">${hrs(e.minutes)}</td>
      <td class="right"><button class="btn ghost sm" data-del="${e.id}">Delete</button></td>`;
    body.appendChild(tr);
  }
  if (done.length) {
    const tr = document.createElement("tr");
    tr.className = "totals";
    tr.innerHTML = `<td colspan="3">Total</td><td class="num">${hrs(total)}</td><td></td>`;
    body.appendChild(tr);
  }

  body.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", () => deleteEntry(b.dataset.del)));
}

$("day-today-btn").addEventListener("click", async () => {
  dayDate = ymd(new Date());
  await loadDay();
});

async function deleteEntry(id) {
  const e = dayEntries.find((x) => String(x.id) === String(id));
  const what = e ? `${hrs(e.minutes)} h on ${labelFor(e.project_id)}` : "this entry";
  if (!confirm(`Delete ${what}? This cannot be undone.`)) return;
  // .select() so an RLS-filtered delete cannot report success having matched
  // nothing — "Deleted." on a row that is still there is worse than an error.
  const { data, error } = await sb.from("time_entries").delete().eq("id", id).select("id");
  if (error) return fail("Deleting the entry", error);
  await Promise.all([loadDay(), loadWeek()]);
  if (!data || !data.length) return toast("Nothing was deleted — that entry is not yours.", "warn");
  toast("Entry deleted.");
}

// ----------------------------------------------------------- manual add

$("add-btn").addEventListener("click", async () => {
  const hours = parseFloat($("m-hours").value);
  if (!(hours > 0)) return toast("Enter hours greater than zero.", "err");
  if (!$("m-proj").value) return toast("Pick a project first.", "err");

  $("add-btn").disabled = true;
  try {
    const { error } = await sb.from("time_entries").insert({
      employee_id: me.id,
      project_id: Number($("m-proj").value),
      work_date: $("m-date").value,
      minutes: Math.round(hours * 60),
      ended_at: new Date().toISOString(),   // marks it complete; started_at stays null
      task_kind: $("m-kind").value,
      notes: $("m-notes").value.trim() || null,
    });
    if (error) return fail("Adding time", error);
    $("m-hours").value = "";
    $("m-notes").value = "";
    dayDate = $("m-date").value;            // show the day it landed on
    await Promise.all([loadDay(), loadWeek()]);
    toast("Time added.");
  } finally {
    $("add-btn").disabled = false;
  }
});

// ------------------------------------------------------- draft entries
// Days reconstructed by tools/backfill-evidence.mjs from records that already
// exist — file mtimes under a project folder, sent mail, visit and deliverable
// logs. They land confirmed=false and are excluded from the day panel, the week
// grid and every report until a person accepts one.
//
// The hours are inferred. Nothing in any of those sources records duration, so
// the suggestion is a starting point and the evidence is shown verbatim beside
// it — the point is to make a day cheap to reconstruct, not to invent a
// timesheet.

let drafts = [];

async function loadDrafts() {
  const { data, error } = await sb
    .from("time_entries")
    .select("id, project_id, work_date, minutes, task_kind, notes, source")
    .eq("employee_id", me.id)
    .eq("confirmed", false)
    .order("work_date", { ascending: false })
    .order("id", { ascending: true });

  if (error) return fail("Loading reconstructed days", error);
  drafts = data || [];
  await ensureLabels(drafts.map((d) => d.project_id));
  renderDrafts();
}

function renderDrafts() {
  $("drafts-card").classList.toggle("hidden", drafts.length === 0);
  if (!drafts.length) return;

  const hoursTotal = drafts.reduce((a, d) => a + d.minutes, 0);
  $("drafts-count").textContent =
    `— ${drafts.length} to review, about ${hrs(hoursTotal)} h`;

  $("drafts-body").innerHTML = drafts.map((d) => `
    <tr data-draft="${d.id}">
      <td class="small">${escapeHtml(d.work_date)}</td>
      <td>${escapeHtml(labelFor(d.project_id))}</td>
      <td class="num"><input type="number" step="0.25" min="0.25" data-dhours="${d.id}"
            value="${(d.minutes / 60).toFixed(2).replace(/\.?0+$/, "")}"
            style="width:72px;text-align:right"></td>
      <td><select data-dkind="${d.id}" style="padding:3px 6px;font-size:13px;min-width:104px">
        ${Object.entries(KIND_LABEL).map(([k, l]) =>
          `<option value="${k}"${k === d.task_kind ? " selected" : ""}>${l}</option>`).join("")}
      </select></td>
      <td class="small muted" style="max-width:520px">${escapeHtml(d.notes || "")}</td>
      <td class="right" style="white-space:nowrap">
        <button class="btn sm" data-dkeep="${d.id}">Keep</button>
        <button class="btn ghost sm" data-ddrop="${d.id}">Drop</button>
      </td>
    </tr>`).join("");

  $("drafts-body").querySelectorAll("[data-dkeep]").forEach((b) =>
    b.addEventListener("click", () => keepDraft(b.dataset.dkeep)));
  $("drafts-body").querySelectorAll("[data-ddrop]").forEach((b) =>
    b.addEventListener("click", () => dropDraft(b.dataset.ddrop)));
}

async function keepDraft(id) {
  const hoursInput = $(`drafts-body`).querySelector(`[data-dhours="${id}"]`);
  const kind = $(`drafts-body`).querySelector(`[data-dkind="${id}"]`).value;
  const parsed = parseFloat(hoursInput.value);
  if (!(parsed > 0)) return toast("Enter hours greater than zero.", "err");

  // source stays 'backfill'. Accepting it means the hours are now Ben's number,
  // not that the entry stopped being a reconstruction.
  const { data, error } = await sb.from("time_entries")
    .update({ confirmed: true, minutes: Math.round(parsed * 60), task_kind: kind })
    .eq("id", id)
    .select("id");
  if (error) return fail("Keeping that entry", error);
  if (!data || !data.length) return toast("That entry is no longer there.", "warn");

  drafts = drafts.filter((d) => String(d.id) !== String(id));
  renderDrafts();
  await Promise.all([loadDay(), loadWeek()]);
  toast("Kept.");
}

async function dropDraft(id) {
  const { data, error } = await sb.from("time_entries").delete().eq("id", id).select("id");
  if (error) return fail("Dropping that entry", error);
  if (!data || !data.length) return toast("That entry is no longer there.", "warn");
  drafts = drafts.filter((d) => String(d.id) !== String(id));
  renderDrafts();
  toast("Dropped.");
}

$("drafts-dismiss-all").addEventListener("click", async () => {
  if (!drafts.length) return;
  if (!confirm(`Drop all ${drafts.length} reconstructed days? They can be rebuilt ` +
               `by running tools/backfill-evidence.mjs again, but anything you have ` +
               `already corrected here is lost.`)) return;
  const ids = drafts.map((d) => d.id);
  const { data, error } = await sb.from("time_entries").delete().in("id", ids).select("id");
  if (error) return fail("Dropping the drafts", error);
  drafts = [];
  renderDrafts();
  toast(`Dropped ${(data || []).length}.`);
});

// ------------------------------------------------------------ week grid

$("wk-prev").addEventListener("click", () => { weekStart = addDays(weekStart, -7); loadWeek(); });
$("wk-next").addEventListener("click", () => { weekStart = addDays(weekStart, 7); loadWeek(); });

async function loadWeek() {
  const from = ymd(weekStart);
  const to = ymd(addDays(weekStart, 6));
  const { data, error } = await sb
    .from("time_entries")
    .select("id, project_id, work_date, minutes, started_at, ended_at")
    .eq("employee_id", me.id)
    .eq("confirmed", true)                 // drafts are not hours yet
    .gte("work_date", from)
    .lte("work_date", to)
    .order("id", { ascending: true });     // stable order: saveCell picks manual[0]

  if (error) return fail("Loading the week", error);
  const all = data || [];
  // Running timers are kept, not filtered away: a cell that hides a live timer
  // invites the user to type the same hours in again and double-count them.
  weekEntries = all.filter((e) => e.minutes != null);
  weekRunning = all.filter((e) => e.minutes == null);
  await ensureLabels(all.map((e) => e.project_id));
  renderWeek();
}

function weekRows() {
  const ids = new Set(weekEntries.map((e) => String(e.project_id)));
  for (const e of weekRunning) ids.add(String(e.project_id));
  for (const id of extraRows) ids.add(String(id));
  if ($("proj").value) ids.add(String($("proj").value));
  // Built from the entries, NOT from the picker, so hours on a project that has
  // since been closed or unassigned still appear and still count.
  return [...ids].map((id) => ({ id, label: labelFor(id) }))
                 .sort((a, b) => a.label.localeCompare(b.label));
}

$("wk-addrow").addEventListener("click", () => {
  const id = $("wk-proj").value;
  if (!id) return toast("Pick a project first.", "err");
  extraRows.add(String(id));
  setCombo("wk-proj", null);
  renderWeek();
  const cell = document.querySelector(
    `#week-body input[data-proj="${id}"][data-date="${ymd(new Date())}"]`);
  if (cell) cell.focus();          // land on today, ready to type
});

function renderWeek() {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  $("wk-label").textContent =
    `${weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ` +
    `${days[6].toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;

  $("week-head").innerHTML =
    `<th style="min-width:210px">Project</th>` +
    days.map((d) => {
      const today = ymd(d) === ymd(new Date());
      return `<th class="num"${today ? ' style="color:var(--teal-lt)"' : ""}>
                ${d.toLocaleDateString(undefined, { weekday: "short" })}
                <div class="small" style="font-weight:400">${d.getDate()}</div></th>`;
    }).join("") + `<th class="num">Total</th>`;

  const rows = weekRows();
  const body = $("week-body");
  body.innerHTML = "";

  for (const r of rows) {
    let cells = "";
    for (const d of days) {
      const key = ymd(d);
      const mine = weekEntries.filter(
        (e) => String(e.project_id) === r.id && e.work_date === key);
      const liveHere = weekRunning.some(
        (e) => String(e.project_id) === r.id && e.work_date === key);
      const timerMin = mine.filter((e) => e.started_at).reduce((a, e) => a + e.minutes, 0);
      const totalMin = mine.reduce((a, e) => a + e.minutes, 0);
      const val = hrs(totalMin);
      cells += `<td class="num ${timerMin && timerMin === totalMin ? "locked" : ""}">
        <input type="number" step="0.25" min="0" value="${val}"
               data-proj="${r.id}" data-date="${key}" data-timer="${timerMin}"
               ${liveHere ? "disabled" : ""}
               title="${liveHere ? "A timer is running here — stop it first"
                                 : timerMin ? (timerMin / 60).toFixed(2) + "h from the timer" : ""}">
        </td>`;
    }
    const rowTotal = weekEntries
      .filter((e) => String(e.project_id) === r.id)
      .reduce((a, e) => a + e.minutes, 0);
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(r.label)}</td>${cells}` +
                   `<td class="num"><strong>${hrs(rowTotal)}</strong></td>`;
    body.appendChild(tr);
  }

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="9" class="empty">No time this week.</td></tr>`;
  }
  renderWeekTotals(days);

  body.querySelectorAll("input[data-proj]").forEach((inp) => {
    inp.addEventListener("change", () => saveCell(inp));
    // Typing replaces the cell rather than appending to what is already there.
    inp.addEventListener("focus", () => inp.select());
    // Opening the day panel is on CLICK, not focus. On focus it fired once per
    // cell while tabbing across a row — seven round trips and the panel above
    // jumping under your hands, which made keyboard entry unusable.
    inp.addEventListener("click", async () => {
      if (inp.dataset.date !== dayDate) { dayDate = inp.dataset.date; await loadDay(); }
    });
    inp.addEventListener("keydown", (e) => gridKey(e, inp));
  });
}

// Enter moves down the column, shift+Enter up; Tab already moves across. Leaving
// the cell is what fires `change`, so the move saves the value on its way out.
//
// Deliberately not bound to the up/down arrows: these are number inputs, where
// those keys natively step the value, and silently turning "nudge to 2.5" into
// "jump to another project" is the kind of thing you only notice at invoicing.
function gridKey(e, inp) {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const col = [...document.querySelectorAll(
    `#week-body input[data-date="${inp.dataset.date}"]`)];
  const dir = e.shiftKey ? -1 : 1;
  for (let i = col.indexOf(inp) + dir; i >= 0 && i < col.length; i += dir) {
    if (!col[i].disabled) return col[i].focus();
  }
  inp.blur();                      // end of the column: commit and step out
}

// Totals come from weekEntries directly, so they can never under-report what a
// rendered row happens to omit.
function renderWeekTotals(days) {
  const perDay = days.map((d) => {
    const key = ymd(d);
    return weekEntries.filter((e) => e.work_date === key).reduce((a, e) => a + e.minutes, 0);
  });
  const grand = weekEntries.reduce((a, e) => a + e.minutes, 0);
  $("week-foot").innerHTML =
    `<td>Total</td>` + perDay.map((m) => `<td class="num">${hrs(m)}</td>`).join("") +
    `<td class="num">${hrs(grand)}</td>`;
}

async function saveCell(inp) {
  const projectId = Number(inp.dataset.proj);
  const workDate = inp.dataset.date;
  const cellKey = `${projectId}|${workDate}`;
  if (savingCells.has(cellKey)) return;          // no overlapping saves per cell

  const raw = inp.value.trim();
  // Blank means "I did not mean to change this". Only an explicit 0 clears a day,
  // otherwise a stray keystroke silently deletes the day's entries.
  if (raw === "") { renderWeek(); return; }

  const parsed = parseFloat(raw);
  if (Number.isNaN(parsed) || parsed < 0) {
    toast("Enter a number of hours, or 0 to clear the day.", "err");
    renderWeek();
    return;
  }
  const newTotal = Math.round(parsed * 60);

  savingCells.add(cellKey);
  inp.disabled = true;
  try {
    // Re-read this cell from the server rather than trusting the cached
    // snapshot, which may be a round trip out of date.
    const { data: current, error: readErr } = await sb
      .from("time_entries")
      .select("id, minutes, started_at, ended_at")
      .eq("employee_id", me.id)
      .eq("project_id", projectId)
      .eq("work_date", workDate)
      // Same filter as the grid it is reconciling against. Without it, typing
      // into a cell would silently edit a draft entry the cell never showed.
      .eq("confirmed", true)
      .order("id", { ascending: true });
    if (readErr) return fail("Checking that day", readErr);

    const rows = current || [];
    if (rows.some((e) => e.minutes == null)) {
      toast("A timer is running on that project and day — stop it first.", "warn");
      return;
    }
    const timerMin = rows.filter((e) => e.started_at).reduce((a, e) => a + e.minutes, 0);
    const manual = rows.filter((e) => !e.started_at);
    const manualMin = manual.reduce((a, e) => a + e.minutes, 0);

    if (newTotal < timerMin) {
      toast(`That day already has ${(timerMin / 60).toFixed(2)} h from the timer. ` +
            `Open the day above to delete those entries if the total should be lower.`, "err");
      return;
    }
    const target = newTotal - timerMin;
    if (target === manualMin) return;

    if (!manual.length) {
      if (target <= 0) return;
      const { error } = await sb.from("time_entries").insert({
        employee_id: me.id, project_id: projectId, work_date: workDate,
        minutes: target, ended_at: new Date().toISOString(), task_kind: "other",
        notes: "entered on the week grid",
      });
      if (error) return fail("Saving that cell", error);
    } else if (target <= 0) {
      if (manual.length > 1 &&
          !confirm(`Clearing this removes ${manual.length} entries ` +
                   `(${hrs(manualMin)} h). Continue?`)) return;
      const { error } = await sb.from("time_entries").delete().in("id", manual.map((e) => e.id));
      if (error) return fail("Clearing that cell", error);
    } else {
      const others = manualMin - manual[0].minutes;
      const firstShouldBe = target - others;
      if (firstShouldBe <= 0) {
        toast("That day has several manual entries — open the day above and edit them.", "warn");
        return;
      }
      const { error } = await sb.from("time_entries")
        .update({ minutes: firstShouldBe }).eq("id", manual[0].id);
      if (error) return fail("Saving that cell", error);
    }
    toast("Saved.");
  } finally {
    savingCells.delete(cellKey);
    inp.disabled = false;
    // Refresh data, but do not blow away a cell the user has already moved on to.
    await loadWeekPreservingFocus();
    await loadDay();
  }
}

// A full re-render wipes whatever is being typed into the next cell, so restore
// focus and any uncommitted value afterwards.
async function loadWeekPreservingFocus() {
  const active = document.activeElement;
  const inGrid = active && active.matches && active.matches("#week-body input[data-proj]");
  const keep = inGrid
    ? { proj: active.dataset.proj, date: active.dataset.date, value: active.value }
    : null;
  await loadWeek();
  if (!keep) return;
  const again = document.querySelector(
    `#week-body input[data-proj="${keep.proj}"][data-date="${keep.date}"]`);
  if (again) {
    if (keep.value !== "") again.value = keep.value;
    again.focus();
  }
}

// ----------------------------------------------------------------- tabs

document.querySelectorAll("#tabs .tab").forEach((b) =>
  b.addEventListener("click", () => showTab(b.dataset.tab)));

function showTab(name) {
  document.querySelectorAll("#tabs .tab").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === name));
  for (const p of ["overview", "todo", "time", "visits", "hours", "proposals", "people"]) {
    $(`panel-${p}`).classList.toggle("hidden", p !== name);
  }
  if (name === "overview") loadOverview();
  if (name === "todo") loadTasks();
  if (name === "visits") loadVisits();
  if (name === "hours") loadHours();
  if (name === "proposals") loadProposals();
}

// ---------------------------------------------------------------- to do
// The app owns this list (Ben, 2026-08-19). `commitments` is still the
// read-only dashboard mirror; `tasks` is the thing you work from.
//
// Buckets are derived HERE, every render, from due_date against today's LOCAL
// date, and are never stored.
//
// `commitments` stores its bucket at import time. Checked against the Austin
// date it was written on, it was exactly right — 0 of 85 rows disagreed. The
// problem is that it can only stay right until midnight: the value is a fact
// about the day it was written, and nothing recomputes it. Deriving costs
// nothing and cannot drift.
//
// Local, not UTC: the server's current_date rolls over at 7pm Austin, so a task
// due today would read as overdue all evening.
//
// One deliberate difference from the dashboard: it has a "stale" bucket for
// anything more than 14 days late, and this does not. Late is late — a separate
// heading for the oldest work is a place for it to go quiet.

let tasks = [];
let todoBucketFilter = "";     // set by clicking a tile

const TODO_BUCKETS = [
  { key: "overdue", label: "Overdue", cls: "late" },
  { key: "today", label: "Today", cls: "now" },
  { key: "this_week", label: "Next 7 days", cls: "" },
  { key: "later", label: "Later", cls: "" },
  { key: "someday", label: "No date", cls: "" },
];

function bucketOf(task) {
  if (task.status !== "open") return "done";
  if (!task.due_date) return "someday";
  const today = ymd(new Date());
  if (task.due_date < today) return "overdue";
  if (task.due_date === today) return "today";
  return task.due_date <= ymd(addDays(new Date(), 7)) ? "this_week" : "later";
}

async function loadTasks() {
  const { data, error } = await sb
    .from("tasks")
    .select(`id, title, project_id, due_date, status, priority, assignee_id,
             kind, notes, source, completed_at`)
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("id", { ascending: true });
  if (error) return fail("Loading the to-do list", error);
  tasks = data || [];
  await ensureLabels(tasks.map((t) => t.project_id).filter(Boolean));
  renderTodoProjectFilter();
  renderTodo();
  renderTodoBadge();
}

// The count on the tab itself, so you do not have to open it to know.
function renderTodoBadge() {
  const late = tasks.filter((t) => t.status === "open" && bucketOf(t) === "overdue").length;
  const el = $("tab-todo-count");
  el.textContent = late ? ` ${late}` : "";
  el.style.color = late ? "var(--clay-soft)" : "";
}

function visibleTasks() {
  const who = $("td-filter-who").value;
  const proj = $("td-filter-proj").value;
  const showDone = $("td-show-done").checked;
  return tasks.filter((t) =>
    (showDone || t.status === "open") &&
    (!who || (who === "none" ? !t.assignee_id : t.assignee_id === who)) &&
    (!proj || String(t.project_id) === proj));
}

function renderTodo() {
  const rows = visibleTasks();
  const counts = {};
  for (const t of rows) counts[bucketOf(t)] = (counts[bucketOf(t)] || 0) + 1;

  $("td-scope").textContent = `· ${rows.filter((t) => t.status === "open").length} open`;

  // Tiles are buttons. Pressing one narrows the list below; pressing it again
  // clears. This is the thing that looked clickable and was not.
  $("td-tiles").innerHTML = TODO_BUCKETS.map((b) => `
    <div class="stat click ${b.cls === "late" ? "fail" : b.cls === "now" ? "warn" : ""}
                ${todoBucketFilter === b.key ? "on" : ""}"
         role="button" tabindex="0" data-bucket="${b.key}"
         title="Show only ${b.label.toLowerCase()}">
      <div class="n">${counts[b.key] || 0}</div><div class="k">${b.label}</div>
    </div>`).join("");
  $("td-tiles").querySelectorAll("[data-bucket]").forEach((el) => {
    const pick = () => {
      todoBucketFilter = todoBucketFilter === el.dataset.bucket ? "" : el.dataset.bucket;
      renderTodo();
    };
    el.addEventListener("click", pick);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); }
    });
  });

  const shown = todoBucketFilter ? rows.filter((t) => bucketOf(t) === todoBucketFilter) : rows;
  const groups = [...TODO_BUCKETS, { key: "done", label: "Finished", cls: "" }]
    .map((b) => [b, shown.filter((t) => bucketOf(t) === b.key)])
    .filter(([, list]) => list.length);

  $("td-empty").classList.toggle("hidden", groups.length > 0);
  $("td-lists").innerHTML = groups.map(([b, list]) => `
    <div class="tgroup ${b.cls}">
      <div class="gh">${b.label} <span>${list.length}</span></div>
      ${list.map(taskRow).join("")}
    </div>`).join("");

  wireTaskRows();
}

function taskRow(t) {
  const who = people.find((p) => p.id === t.assignee_id);
  const done = t.status !== "open";
  const bits = [];
  if (t.project_id) {
    bits.push(`<a data-goproj="${t.project_id}">${escapeHtml(labelFor(t.project_id))}</a>`);
  }
  if (t.notes) bits.push(escapeHtml(t.notes));
  if (t.source === "dashboard") bits.push(`<span class="tag">from the dashboard</span>`);

  return `
    <div class="trow ${done ? "done" : ""} ${bucketOf(t) === "overdue" ? "overdue" : ""}">
      <input type="checkbox" data-tdone="${t.id}" ${done ? "checked" : ""}
             title="${done ? "Reopen" : "Mark finished"}">
      <div class="body">
        <div class="ttitle ${t.priority === "high" && !done ? "hi" : ""}">${escapeHtml(t.title)}</div>
        ${bits.length ? `<div class="meta">${bits.join(" · ")}</div>` : ""}
      </div>
      <div class="ctl">
        <input type="date" data-tdue="${t.id}" value="${t.due_date || ""}"
               title="Due date — clear it to move this to No date">
        <select data-twho="${t.id}" title="Who is doing it">
          <option value="">Unassigned</option>
          ${people.filter((p) => p.active).map((p) =>
            `<option value="${p.id}"${p.id === t.assignee_id ? " selected" : ""}
             >${escapeHtml(p.full_name.split(" ")[0])}</option>`).join("")}
        </select>
        <!-- A bare "!" told you nothing about which state you were in. -->
        <button class="btn ghost sm" data-tflag="${t.id}"
                title="${t.priority === "high" ? "Set back to normal priority" : "Mark high priority"}"
                style="${t.priority === "high" ? "color:var(--warn);border-color:var(--warn)" : ""}"
          >${t.priority === "high" ? "High" : "Normal"}</button>
        <button class="btn ghost sm" data-tdrop="${t.id}" title="Drop this task">Drop</button>
      </div>
    </div>`;
}

function wireTaskRows() {
  const box = $("td-lists");
  box.querySelectorAll("[data-tdone]").forEach((c) =>
    c.addEventListener("change", () => saveTask(c.dataset.tdone,
      c.checked
        ? { status: "done", completed_at: new Date().toISOString() }
        : { status: "open", completed_at: null })));
  box.querySelectorAll("[data-tdue]").forEach((i) =>
    i.addEventListener("change", () => saveTask(i.dataset.tdue, { due_date: i.value || null })));
  box.querySelectorAll("[data-twho]").forEach((s) =>
    s.addEventListener("change", () => saveTask(s.dataset.twho, { assignee_id: s.value || null })));
  box.querySelectorAll("[data-tflag]").forEach((b) =>
    b.addEventListener("click", () => {
      const t = tasks.find((x) => String(x.id) === String(b.dataset.tflag));
      saveTask(b.dataset.tflag, { priority: t && t.priority === "high" ? "normal" : "high" });
    }));
  box.querySelectorAll("[data-tdrop]").forEach((b) =>
    b.addEventListener("click", () => dropTask(b.dataset.tdrop)));
  box.querySelectorAll("[data-goproj]").forEach((a) =>
    a.addEventListener("click", () => goToProject(a.dataset.goproj)));
}

async function saveTask(id, patch) {
  const { data, error } = await sb.from("tasks").update(patch).eq("id", id).select("id");
  if (error) return fail("Saving that task", error);
  if (!data || !data.length) return toast("That did not save — the task is not yours to edit.", "warn");
  await loadTasks();
}

async function dropTask(id) {
  const t = tasks.find((x) => String(x.id) === String(id));
  if (!confirm(`Drop "${t ? t.title : "this task"}"?\n\nIt stays on record as dropped ` +
               `rather than being deleted, so you can still see it was asked for.`)) return;
  // 'dropped' rather than DELETE: losing the record that something was ever
  // asked for is worse than a slightly longer list.
  const { data, error } = await sb.from("tasks")
    .update({ status: "dropped", completed_at: null }).eq("id", id).select("id");
  if (error) return fail("Dropping that task", error);
  if (!data || !data.length) return toast("That did not save — the task is not yours to edit.", "warn");
  await loadTasks();
  toast("Dropped.");
}

$("td-add").addEventListener("click", async () => {
  const title = $("td-title").value.trim();
  if (!title) return toast("Say what needs doing first.", "err");
  $("td-add").disabled = true;
  try {
    const { error } = await sb.from("tasks").insert({
      title,
      project_id: $("td-proj").value ? Number($("td-proj").value) : null,
      due_date: $("td-due").value || null,
      assignee_id: $("td-who").value || null,
      priority: $("td-priority").value,
      created_by: me.id,
      source: "app",
    });
    if (error) return fail("Adding the task", error);
    $("td-title").value = "";
    $("td-due").value = "";
    setCombo("td-proj", null);
    await loadTasks();
    toast("Added.");
  } finally {
    $("td-add").disabled = false;
  }
});

$("td-title").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); $("td-add").click(); }
});

function initTodo() {
  const whoOpts = `<option value="">anyone</option>` +
    people.filter((p) => p.active)
          .map((p) => `<option value="${p.id}"${p.id === me.id ? " selected" : ""}
           >${escapeHtml(p.full_name)}</option>`).join("");
  $("td-who").innerHTML = whoOpts;
  $("td-filter-who").innerHTML =
    `<option value="">Everyone</option><option value="none">Nobody yet</option>` +
    people.filter((p) => p.active)
          .map((p) => `<option value="${p.id}">${escapeHtml(p.full_name)}</option>`).join("");
  fillProjectCombo($("td-proj"), projects);
  for (const id of ["td-filter-who", "td-filter-proj", "td-show-done"]) {
    $(id).addEventListener("change", renderTodo);
  }
}

// Filter the to-do list to a project and show it. Called from anywhere a
// project name appears, so a name on screen is a way in rather than a label.
function goToProject(projectId) {
  const sel = $("td-filter-proj");
  if (![...sel.options].some((o) => o.value === String(projectId))) {
    sel.insertAdjacentHTML("beforeend",
      `<option value="${projectId}">${escapeHtml(labelFor(projectId))}</option>`);
  }
  sel.value = String(projectId);
  todoBucketFilter = "";
  showTab("todo");
  renderTodo();
}

function renderTodoProjectFilter() {
  const sel = $("td-filter-proj");
  const keep = sel.value;
  const ids = [...new Set(tasks.map((t) => t.project_id).filter(Boolean))]
    .map(String).sort((a, b) => labelFor(a).localeCompare(labelFor(b)));
  sel.innerHTML = `<option value="">All projects</option>` +
    ids.map((id) => `<option value="${id}">${escapeHtml(labelFor(id))}</option>`).join("");
  if (keep) sel.value = keep;
}

// -------------------------------------------------------------- overview
// Mirrors the project dashboard's front page: the urgency tiles, what is
// overdue, what is booked, and where the work sits by phase.

const PHASE_COLOR = {
  waiting: "#75695F", "initial design": "#4E8A94", revision: "#C08D7C",
  sent: "#3E7A4E", CA: "#16424B",
};

async function loadOverview() {
  // Reads `tasks`, not `commitments`. The mirror's stored buckets were correct
  // on the day they were written and go stale silently afterwards; these are
  // derived from the local date on every render. It also folds the dashboard's
  // "stale" bucket into Overdue, so the count here is higher than the mirror's
  // by however many items are more than a fortnight late.
  const { data: vis, error } = await sb
    .from("site_visits").select("id, project_id, visit_date, start_time, attendee_name, visit_type")
    .gte("visit_date", ymd(new Date())).order("visit_date").limit(12);
  if (error) return fail("Loading the schedule", error);
  if (!tasks.length) await loadTasks();
  await ensureLabels((vis || []).map((v) => v.project_id));

  const open = tasks.filter((t) => t.status === "open");
  seedWeekRows(open, vis || []);
  renderOvTiles(open);
  renderOvAttention(open);
  renderOvSchedule(vis || []);
  renderOvWorking(open);
  renderOvPhases();
}

// An empty week grid is the whole adoption problem: the fastest way to log time
// is a grid cell, and a cell only exists for a project you have already logged
// against. So open the week on the jobs that are actually live — anything with a
// commitment due about now, plus anything with a site visit this week. Seeded
// once, and only ever added to, so a row you dismissed by not typing in it does
// not come back mid-week.
let seededWeekRows = false;
function seedWeekRows(openTasks, visits) {
  if (seededWeekRows) return;
  seededWeekRows = true;

  const hot = new Set(["overdue", "today", "this_week"]);
  for (const t of openTasks) {
    if (t.project_id && hot.has(bucketOf(t))) extraRows.add(String(t.project_id));
  }
  const weekEnd = ymd(addDays(weekStart, 6));
  for (const v of visits) {
    if (v.project_id && v.visit_date <= weekEnd) extraRows.add(String(v.project_id));
  }
  if (extraRows.size) renderWeek();
}

// Every tile is a button through to that list. They have always looked like
// buttons; until now pressing one did nothing, so you could read the overdue
// count and have no way to reach the items behind it.
function renderOvTiles(open) {
  const n = (b) => open.filter((t) => bucketOf(t) === b).length;
  $("ov-tiles").innerHTML = TODO_BUCKETS.map((b) => `
    <div class="stat click ${b.cls === "late" ? "fail" : b.cls === "now" ? "warn" : ""}"
         role="button" tabindex="0" data-ovbucket="${b.key}"
         title="Open the ${b.label.toLowerCase()} list">
      <div class="n">${n(b.key)}</div><div class="k">${b.label}</div>
    </div>`).join("");

  $("ov-tiles").querySelectorAll("[data-ovbucket]").forEach((el) => {
    const go = () => {
      todoBucketFilter = el.dataset.ovbucket;
      $("td-filter-proj").value = "";
      showTab("todo");
      renderTodo();
    };
    el.addEventListener("click", go);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
    });
  });
}

// Days from today, computed now rather than read from a column written days ago.
function daysLeft(task) {
  if (!task.due_date) return null;
  return Math.round((parseYmd(task.due_date) - parseYmd(ymd(new Date()))) / 86400000);
}

function ageCell(t) {
  const d = daysLeft(t);
  if (d == null) return `<td class="age ok">—</td>`;
  if (d < 0) return `<td class="age">${Math.abs(d)}d over</td>`;
  if (d === 0) return `<td class="age soon">today</td>`;
  return `<td class="age ok">${d}d</td>`;
}

function renderOvAttention(open) {
  const rank = { overdue: 0, today: 1, this_week: 2 };
  const rows = open.filter((t) => bucketOf(t) in rank)
    .sort((a, b) => (rank[bucketOf(a)] - rank[bucketOf(b)]) ||
                    ((daysLeft(a) ?? 0) - (daysLeft(b) ?? 0)));
  $("ov-att-count").textContent = rows.length ? `— ${rows.length}` : "";
  $("ov-attention-empty").classList.toggle("hidden", rows.length > 0);
  // Whole rows are a way in: tick it off here, or click the project to see
  // everything outstanding on that job.
  $("ov-attention").innerHTML = rows.map((t) => `
    <tr>${ageCell(t)}
      <td>${t.project_id
              ? `<b><a data-goproj="${t.project_id}" style="color:var(--teal-lt);cursor:pointer"
                   >${escapeHtml(labelFor(t.project_id))}</a></b><br>` : ""}
          <!-- Its own attribute, not the to-do list's: two controls in two
               panels sharing one selector is a trap for anything that looks
               them up by attribute. -->
          <label style="cursor:pointer">
            <input type="checkbox" data-ovdone="${t.id}" style="margin-right:6px">
            ${escapeHtml(t.title)}
          </label>
          ${t.due_date ? `<div class="small muted">${escapeHtml(t.due_date)}</div>` : ""}</td>
    </tr>`).join("");

  $("ov-attention").querySelectorAll("[data-ovdone]").forEach((c) =>
    c.addEventListener("change", () => saveTask(c.dataset.ovdone,
      { status: "done", completed_at: new Date().toISOString() })));
  $("ov-attention").querySelectorAll("[data-goproj]").forEach((a) =>
    a.addEventListener("click", () => goToProject(a.dataset.goproj)));
}

function renderOvSchedule(vs) {
  $("ov-schedule-empty").classList.toggle("hidden", vs.length > 0);
  $("ov-schedule").innerHTML = vs.map((v) => `
    <tr>
      <td class="age ok" style="width:74px">${escapeHtml(v.visit_date.slice(5).replace("-", "/"))}
        <div>${v.start_time ? escapeHtml(v.start_time.slice(0, 5)) : "all day"}</div></td>
      <td><b>${escapeHtml(labelFor(v.project_id))}</b>
        <div class="small muted">${escapeHtml(v.visit_type)} · ${escapeHtml(v.attendee_name)}</div></td>
    </tr>`).join("");
}

function renderOvWorking(open) {
  // Grouped by project. Grouping by person is what the dashboard does, but the
  // per-person split is not in this data and inventing one would be a guess.
  const byProject = {};
  for (const t of open.filter((x) => ["overdue", "today"].includes(bucketOf(x)))) {
    const k = t.project_id ? labelFor(t.project_id) : "No project";
    (byProject[k] ||= []).push(t);
  }
  const blocks = Object.entries(byProject)
    .sort((a, b) => b[1].length - a[1].length).slice(0, 8);
  $("ov-working").innerHTML = blocks.length
    ? blocks.map(([proj, list]) => `
        <div class="who-block">
          <div class="nm">${list[0].project_id
            ? `<a data-goproj="${list[0].project_id}" style="color:var(--teal-lt);cursor:pointer"
                 >${escapeHtml(proj)}</a>` : escapeHtml(proj)}
            ${list.length > 3 ? `<span class="muted small"> · ${list.length}</span>` : ""}</div>
          <ul>${list.slice(0, 3).map((t) => `<li>${escapeHtml(t.title)}</li>`).join("")}</ul>
        </div>`).join("")
    : `<span class="muted small">Nothing pressing.</span>`;

  $("ov-working").querySelectorAll("[data-goproj]").forEach((a) =>
    a.addEventListener("click", () => goToProject(a.dataset.goproj)));
}

function renderOvPhases() {
  const live = projects.filter((p) => !p.is_overhead && p.status === "active" && p.phase);
  const counts = {};
  for (const p of live) counts[p.phase] = (counts[p.phase] || 0) + 1;
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((a, [, n]) => a + n, 0);
  if (!total) {
    $("ov-phasebar").innerHTML = `<span class="muted small">No phase data yet.</span>`;
    return;
  }
  $("ov-phasebar").innerHTML =
    `<div class="phasebar">${entries.map(([ph, n]) =>
      `<span style="width:${(n / total) * 100}%;background:${PHASE_COLOR[ph] || "#8A8078"}"
             title="${escapeHtml(ph)}: ${n}">${(n / total) > 0.06 ? n : ""}</span>`).join("")}</div>` +
    `<div class="legend">${entries.map(([ph, n]) =>
      `<span><i style="background:${PHASE_COLOR[ph] || "#8A8078"}"></i>${escapeHtml(ph)} · ${n}</span>`
      ).join("")}</div>`;
}

// --------------------------------------------------------------- hours
// "Hours against contract", never "Billing". HD prices design work as a fixed
// fee derived from an hour estimate and settled at signature — so hours logged
// afterwards are what the fee cost to earn, not an amount anyone owes. The one
// thing this view must never do is multiply hours by a rate and render it as
// money due against a design phase.
//
// §5.3 draws the line: RFI responses, submittal review and additional services
// are hourly at the agreement's rate. A site visit is per-visit at the
// contracted rate regardless of what triggered it, and never $175/hour.

// §5.1 rate card. The internal cost figures are for margin analysis and never
// appear in a client document.
const RATE = {
  engineer: { bill: 175, cost: 100 },
  drafter: { bill: 90, cost: 30 },
};
// The kinds §5.3 allows to bill hourly. Everything else is inside the fee.
const HOURLY_KINDS = new Set(["rfi", "review", "other"]);
const DISPOSITION = {
  "": "Undecided",
  inside_fee: "Inside the fee",
  billable: "Bills per visit",
  not_billable: "Not billable",
};

let hoursRows = [];        // time_entries in range, confirmed only
let hoursVisits = [];      // site_visits in range
let contractOf = {};       // project_id -> the confirmed signed proposal, if any

// "" = everyone. An employee is pinned to themselves by RLS anyway; this only
// changes what an admin is looking at.
function whoFilter() {
  return me.role === "admin" ? ($("h-who").value || "") : me.id;
}
function personRows() {
  const who = whoFilter();
  return who ? hoursRows.filter((r) => r.employee_id === who) : hoursRows;
}
function personVisits() {
  const who = whoFilter();
  if (!who) return hoursVisits;
  const p = personById(who);
  const name = (p && p.full_name || "").toLowerCase();
  // attendee_id is null on the imported history, which is most of it, so fall
  // back to the name the log recorded.
  return hoursVisits.filter((v) => v.attendee_id === who ||
    (v.attendee_name || "").toLowerCase() === name);
}
function personById(id) {
  return people.find((x) => x.id === id) || (id === me.id ? me : null);
}
let hoursBilling = {};     // visit_id -> {rate, rate_basis, disposition}. Admin only.

function hoursRange() {
  const from = $("h-from").value;
  const to = $("h-to").value;
  return { from: from || "1900-01-01", to: to || "2999-12-31" };
}

function setQuickRange(which) {
  const now = new Date();
  const first = (y, m) => ymd(new Date(y, m, 1));
  const ranges = {
    mtd: [first(now.getFullYear(), now.getMonth()), ymd(now)],
    "last-month": [first(now.getFullYear(), now.getMonth() - 1),
                   ymd(new Date(now.getFullYear(), now.getMonth(), 0))],
    90: [ymd(addDays(now, -90)), ymd(now)],
    ytd: [first(now.getFullYear(), 0), ymd(now)],
    all: ["", ""],
  };
  const [from, to] = ranges[which] || ranges.mtd;
  $("h-from").value = from;
  $("h-to").value = to;
}

async function loadHours() {
  const { from, to } = hoursRange();

  // RLS gives an employee only their own entries, so a non-admin is looking at
  // their own hours. Say which, rather than letting a partial view read as a
  // firm-wide one that has lost rows.
  $("hrs-scope").textContent = me.role === "admin"
    ? "· firm-wide" : `· your hours only`;
  document.querySelectorAll(".admin-hours").forEach((n) =>
    n.classList.toggle("hidden", me.role !== "admin"));

  const [{ data: te, error: e1 }, { data: sv, error: e2 }] = await Promise.all([
    sb.from("time_entries")
      .select("id, employee_id, project_id, work_date, minutes, task_kind, notes, billable, source, confirmed")
      .eq("confirmed", true)          // a reconstructed guess is not an hour
      .not("minutes", "is", null)     // a running timer has no hours yet
      .gte("work_date", from).lte("work_date", to)
      .order("work_date", { ascending: false }),
    sb.from("site_visits")
      .select("id, project_id, visit_date, visit_type, attendee_name, outcome")
      .gte("visit_date", from).lte("visit_date", to)
      .order("visit_date", { ascending: false }),
  ]);
  if (e1) return fail("Loading hours", e1);
  if (e2) return fail("Loading visits", e2);

  hoursRows = te || [];
  hoursVisits = sv || [];
  await ensureLabels([...hoursRows.map((r) => r.project_id),
                      ...hoursVisits.map((v) => v.project_id)]);

  // Only a CONFIRMED link to a SIGNED proposal may supply a rate. Everything
  // else is address-matched guesswork, and billing off it puts a fee on the
  // wrong job — 1007 Jewell would inherit $150 from a stair addendum.
  contractOf = {};
  if (me.role === "admin") {
    const { data: props } = await sb.from("proposals")
      .select("id, number, status, design_fee, visit_rate, hourly_rate, project_id, link_confidence")
      .not("project_id", "is", null);
    for (const p of props || []) {
      if (p.status !== "signed" || p.link_confidence !== "confirmed") continue;
      // Two signed proposals on one job is a question, not an answer.
      contractOf[p.project_id] = contractOf[p.project_id] === undefined ? p : null;
    }
    // Its own copy, not the visits tab's: that one does not read disposition,
    // so reusing it would render every visit as "not decided".
    const { data: bill } = await sb.from("site_visit_billing")
      .select("visit_id, rate, rate_basis, disposition");
    hoursBilling = {};
    for (const b of bill || []) hoursBilling[b.visit_id] = b;
  }

  renderHours();
}

// Everything on the tab reads the same person filter, so they can never
// disagree about who is being looked at.
function renderHours() {
  renderHoursStats();
  renderPerson();
  renderHoursByProject();
  renderAdditionalServices();
  renderVisitWorksheet();
  renderMargin();
}

// ------------------------------------------------- one person's time
// What they worked on, whether the days are complete, what it cost, and how
// much of it was site visits — which bill per visit, so those hours are inside
// a fee rather than being desk time anyone would invoice hourly.

function renderPerson() {
  const who = whoFilter();
  const card = $("person-card");
  // For an employee the whole tab is already their own; a second panel saying
  // so would just be the same numbers twice.
  const show = Boolean(who) && me.role === "admin";
  card.classList.toggle("hidden", !show);
  document.querySelectorAll(".admin-hours-col").forEach((n) =>
    n.classList.toggle("hidden", me.role !== "admin"));
  if (!show) return;

  const p = personById(who);
  const rows = personRows();
  const visits = personVisits();
  const { from, to } = hoursRange();

  $("person-name").textContent = p ? p.full_name : "—";
  $("person-range").textContent =
    `— ${from === "1900-01-01" ? "everything" : from} to ${to === "2999-12-31" ? "now" : to}`;

  const deskMin = rows.filter((r) => r.task_kind !== "site_visit")
                      .reduce((a, r) => a + r.minutes, 0);
  const visitMin = rows.filter((r) => r.task_kind === "site_visit")
                       .reduce((a, r) => a + r.minutes, 0);
  const days = new Set(rows.map((r) => r.work_date));
  const projects = new Set(rows.map((r) => r.project_id));
  const cover = coverage(rows, from, to);

  $("person-stats").innerHTML = `
    <div class="stat"><div class="n">${hrs(deskMin + visitMin) || "0"}</div>
      <div class="k">Hours logged</div></div>
    <div class="stat"><div class="n">${days.size}</div><div class="k">Days with time</div></div>
    <div class="stat ${cover.empty.length ? "fail" : ""}"><div class="n">${cover.empty.length}</div>
      <div class="k">Weekdays with none</div></div>
    <div class="stat"><div class="n">${projects.size}</div><div class="k">Projects</div></div>
    <div class="stat"><div class="n">${hrs(visitMin) || "0"}</div>
      <div class="k">Of that, site visits</div></div>
    <div class="stat"><div class="n">${visits.length}</div><div class="k">Visits attended</div></div>`;

  renderPersonDays(cover);
  renderPersonProjects(rows);
}

// One cell per calendar day in the range. Weekends are drawn but never counted
// as missing — HD does not have a stated working week, and calling a Saturday a
// gap would be inventing a rule.
function coverage(rows, from, to) {
  const byDay = {};
  for (const r of rows) byDay[r.work_date] = (byDay[r.work_date] || 0) + r.minutes;

  const dates = Object.keys(byDay).sort();
  const start = from === "1900-01-01" ? (dates[0] || ymd(new Date())) : from;
  const endWanted = to === "2999-12-31" ? ymd(new Date()) : to;
  // Never call a day in the future a missing day.
  const end = endWanted > ymd(new Date()) ? ymd(new Date()) : endWanted;

  const cells = [];
  const empty = [];
  let d = parseYmd(start);
  const last = parseYmd(end);
  // A guard, not a policy: a range of everything on a long history would
  // otherwise draw thousands of cells.
  for (let i = 0; d <= last && i < 400; i++, d = addDays(d, 1)) {
    const key = ymd(d);
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    const minutes = byDay[key] || 0;
    cells.push({ key, date: d, weekend, minutes });
    if (!weekend && !minutes) empty.push(key);
  }
  return { cells, empty, truncated: d <= last };
}

function renderPersonDays(cover) {
  const targetRaw = parseFloat($("person-target").value);
  const target = targetRaw > 0 ? targetRaw * 60 : null;

  $("person-days").innerHTML = `<div class="daygrid">${cover.cells.map((c) => {
    let cls = "";
    if (c.weekend) cls = "weekend";
    else if (!c.minutes) cls = "none";
    else if (target && c.minutes < target) cls = "short";
    else cls = "ok";
    return `<div class="d ${cls}" title="${c.key}">
      <div class="dt">${c.date.toLocaleDateString(undefined, { weekday: "short" })} ${c.date.getDate()}</div>
      <div class="h">${c.minutes ? hrs(c.minutes) : "—"}</div>
    </div>`;
  }).join("")}</div>`;

  const bits = [];
  if (cover.empty.length) {
    bits.push(`<b>${cover.empty.length} weekday${cover.empty.length === 1 ? "" : "s"} with no time at all</b>`);
  } else {
    bits.push("Every weekday in this range has something on it");
  }
  if (target) bits.push(`amber is under ${hrs(target)} h`);
  else bits.push(`set a number above to flag short days &mdash; there is no house standard, so nothing is assumed`);
  if (cover.truncated) bits.push(`<b>range truncated at 400 days</b>`);
  bits.push("weekends are drawn but never counted as missing");
  $("person-days-note").innerHTML = bits.join(" · ") + ".";
}

function renderPersonProjects(rows) {
  const who = whoFilter();
  const cls = (personById(who) || {}).rate_class || null;
  const bill = cls && RATE[cls] ? RATE[cls].bill : null;

  const by = {};
  for (const r of rows) {
    const b = (by[r.project_id] ||= { desk: 0, visit: 0, kinds: {} });
    if (r.task_kind === "site_visit") b.visit += r.minutes; else b.desk += r.minutes;
    b.kinds[r.task_kind] = (b.kinds[r.task_kind] || 0) + r.minutes;
  }
  const entries = Object.entries(by).sort((a, b) => (b[1].desk + b[1].visit) - (a[1].desk + a[1].visit));

  $("person-proj-body").innerHTML = entries.length
    ? entries.map(([pid, b]) => {
        const total = b.desk + b.visit;
        // Cost the desk hours only. Visit time is inside a per-visit fee, so
        // multiplying it by an hourly rate would double-count the visit.
        const cost = bill != null ? (b.desk / 60) * bill : null;
        return `
          <tr>
            <td>${escapeHtml(labelFor(pid))}</td>
            <td class="num">${hrs(b.desk)}</td>
            <td class="num muted">${hrs(b.visit)}</td>
            <td class="num"><strong>${hrs(total)}</strong></td>
            <td class="num admin-hours-col${me.role === "admin" ? "" : " hidden"}">${
              cost == null
                ? `<span class="muted small" title="No rate class set for this person">—</span>`
                : `$${Math.round(cost).toLocaleString()}`}</td>
            <td class="small muted">${Object.entries(b.kinds)
              .sort((x, y) => y[1] - x[1])
              .map(([k]) => escapeHtml(KIND_LABEL[k] || k)).join(", ")}</td>
          </tr>`;
      }).join("")
    : `<tr><td colspan="6" class="empty">No hours logged in this range.</td></tr>`;
}

function rateClassOf(employeeId) {
  const p = people.find((x) => x.id === employeeId) || (employeeId === me.id ? me : null);
  return (p && p.rate_class) || "engineer";
}

function renderHoursStats() {
  const rowsAll = personRows();
  const total = rowsAll.reduce((a, r) => a + r.minutes, 0);
  const projectCount = new Set(rowsAll.map((r) => r.project_id)).size;
  const hourly = rowsAll.filter((r) => HOURLY_KINDS.has(r.task_kind))
                        .reduce((a, r) => a + r.minutes, 0);
  const nonBillable = rowsAll.filter((r) => !r.billable).reduce((a, r) => a + r.minutes, 0);

  $("hrs-stats").innerHTML = `
    <div class="stat"><div class="n">${hrs(total) || "0"}</div><div class="k">Hours logged</div></div>
    <div class="stat"><div class="n">${projectCount}</div><div class="k">Projects</div></div>
    <div class="stat"><div class="n">${hrs(hourly) || "0"}</div>
      <div class="k">Potential additional-service hours</div></div>
    <div class="stat"><div class="n">${hrs(total - hourly) || "0"}</div>
      <div class="k">Inside a fixed fee</div></div>
    <div class="stat"><div class="n">${personVisits().length}</div><div class="k">Site visits</div></div>
    ${nonBillable ? `<div class="stat warn"><div class="n">${hrs(nonBillable)}</div>
      <div class="k">Marked non-billable</div></div>` : ""}`;
}

// The contract cell: which proposal governs this job, and how sure we are.
function contractCell(projectId) {
  const c = contractOf[projectId];
  if (c === null) {
    return `<span class="tag nb" title="More than one confirmed signed proposal on this job">several</span>`;
  }
  if (!c) return `<span class="muted small">not confirmed</span>`;
  return `<span class="mono small">${escapeHtml(c.number)}</span>
          <span class="tag ok">signed</span>`;
}

const KIND_ORDER = ["design", "review", "coordination", "site_visit", "rfi", "admin", "other"];

function renderHoursByProject() {
  const kindFilter = $("h-kind").value;
  const scoped = personRows();
  const rows = kindFilter ? scoped.filter((r) => r.task_kind === kindFilter) : scoped;

  const byProject = {};
  for (const r of rows) {
    const b = (byProject[r.project_id] ||= { kinds: {}, total: 0, who: new Set() });
    b.kinds[r.task_kind] = (b.kinds[r.task_kind] || 0) + r.minutes;
    b.total += r.minutes;
    b.who.add(r.employee_id);
  }
  const entries = Object.entries(byProject).sort((a, b) => b[1].total - a[1].total);

  $("hrs-empty").classList.toggle("hidden", entries.length > 0);
  $("hrs-table").classList.toggle("hidden", entries.length === 0);
  $("hrs-body").innerHTML = entries.map(([pid, b]) => `
    <tr>
      <td>${escapeHtml(labelFor(pid))}</td>
      <td>${contractCell(pid)}</td>
      ${KIND_ORDER.map((k) => `<td class="num">${hrs(b.kinds[k] || 0)}</td>`).join("")}
      <td class="num"><strong>${hrs(b.total)}</strong></td>
      <td class="small muted">${[...b.who].map((id) => {
        const p = people.find((x) => x.id === id);
        return escapeHtml(p ? p.full_name.split(" ")[0] : "—");
      }).join(", ")}</td>
    </tr>`).join("");

  const foot = KIND_ORDER.map((k) =>
    rows.filter((r) => r.task_kind === k).reduce((a, r) => a + r.minutes, 0));
  $("hrs-foot").innerHTML = `<td colspan="2">Total</td>` +
    foot.map((m) => `<td class="num">${hrs(m)}</td>`).join("") +
    `<td class="num">${hrs(foot.reduce((a, b) => a + b, 0))}</td><td></td>`;
}

function renderAdditionalServices() {
  const rows = personRows().filter((r) => HOURLY_KINDS.has(r.task_kind));
  $("hrs-as-empty").classList.toggle("hidden", rows.length > 0);
  $("hrs-as-table").classList.toggle("hidden", rows.length === 0);

  $("hrs-as-body").innerHTML = rows.map((r) => {
    const c = contractOf[r.project_id];
    // Never fall back to a firm-wide default: several agreements are $150/hour
    // and a $175 assumption overbills every one of them silently.
    const rate = c && c.hourly_rate
      ? `$${c.hourly_rate}`
      : `<span class="muted small" title="No confirmed signed proposal states one — read the agreement">rate not on file</span>`;
    const p = people.find((x) => x.id === r.employee_id);
    return `
      <tr>
        <td class="small">${escapeHtml(r.work_date)}</td>
        <td>${escapeHtml(labelFor(r.project_id))}</td>
        <td class="small">${escapeHtml(p ? p.full_name : "—")}</td>
        <td><span class="tag">${escapeHtml(KIND_LABEL[r.task_kind] || r.task_kind)}</span></td>
        <td class="num">${hrs(r.minutes)}</td>
        <td class="small">${r.notes ? escapeHtml(r.notes)
          : `<span class="muted">no note — nothing to put on an invoice line</span>`}</td>
        <td class="num small">${rate}</td>
      </tr>`;
  }).join("");
}

function renderVisitWorksheet() {
  if (me.role !== "admin") return;
  const rows = personVisits();
  $("hrs-visits-empty").classList.toggle("hidden", rows.length > 0);
  $("hrs-visits-table").classList.toggle("hidden", rows.length === 0);

  $("hrs-visits-body").innerHTML = rows.map((v) => {
    const b = hoursBilling[v.id] || {};
    const rate = b.rate != null
      ? `<strong>$${b.rate}</strong>`
      : `<span class="muted">—</span>`;
    return `
      <tr>
        <td class="small">${escapeHtml(v.visit_date)}</td>
        <td>${escapeHtml(labelFor(v.project_id))}</td>
        <td class="small">${escapeHtml(v.visit_type)}</td>
        <td class="small">${escapeHtml(v.attendee_name || "")}</td>
        <td class="num">${rate}</td>
        <td class="small muted">${escapeHtml(b.rate_basis || "")}</td>
        <td><select data-disp="${v.id}" style="padding:3px 6px;font-size:13px">
          ${Object.entries(DISPOSITION).map(([k, l]) =>
            `<option value="${k}"${k === (b.disposition || "") ? " selected" : ""}>${l}</option>`).join("")}
        </select></td>
      </tr>`;
  }).join("");

  $("hrs-visits-body").querySelectorAll("[data-disp]").forEach((s) =>
    s.addEventListener("change", () => saveDisposition(s.dataset.disp, s.value)));
}

async function saveDisposition(visitId, value) {
  const { data, error } = await sb.from("site_visit_billing")
    .update({ disposition: value || null })
    .eq("visit_id", visitId)
    .select("visit_id");
  if (error) return fail("Saving that decision", error);
  if (!data || !data.length) return toast("That did not save — no billing row for this visit.", "warn");
  hoursBilling[visitId] = { ...(hoursBilling[visitId] || {}), disposition: value || null };
  toast("Saved.");
}

function renderMargin() {
  if (me.role !== "admin") return;
  // Margin is a whole-project question: one person's share of the hours against
  // the whole fee is not a margin, it is a misleading fraction. So this panel
  // goes away entirely while a person filter is on rather than quietly
  // answering a different question.
  if (whoFilter()) { $("margin-card").classList.add("hidden"); return; }
  $("margin-card").classList.remove("hidden");

  const byProject = {};
  for (const r of hoursRows) {
    const c = contractOf[r.project_id];
    if (!c || !c.design_fee) continue;
    const b = (byProject[r.project_id] ||= { engineer: 0, drafter: 0, contract: c });
    b[rateClassOf(r.employee_id)] += r.minutes;
  }
  const entries = Object.entries(byProject);
  $("hrs-margin-empty").classList.toggle("hidden", entries.length > 0);
  $("hrs-margin-table").classList.toggle("hidden", entries.length === 0);

  $("hrs-margin-body").innerHTML = entries.map(([pid, b]) => {
    const eh = b.engineer / 60;
    const dh = b.drafter / 60;
    const bare = eh * RATE.engineer.bill + dh * RATE.drafter.bill;
    const trueCost = eh * RATE.engineer.cost + dh * RATE.drafter.cost;
    const fee = Number(b.contract.design_fee);
    const margin = fee ? ((fee - bare) / fee) * 100 : null;
    const money = (n) => `$${Math.round(n).toLocaleString()}`;
    return `
      <tr>
        <td>${escapeHtml(labelFor(pid))}</td>
        <td><span class="mono small">${escapeHtml(b.contract.number)}</span></td>
        <td class="num">${money(fee)}</td>
        <td class="num">${eh.toFixed(1)}</td>
        <td class="num">${dh.toFixed(1)}</td>
        <td class="num">${money(bare)}</td>
        <td class="num muted">${money(trueCost)}</td>
        <td class="num ${margin != null && margin <= 0 ? "" : ""}">${
          margin == null ? "—"
            : `<span style="color:var(--${margin <= 0 ? "err" : "ink"})">${margin.toFixed(0)}%</span>`}</td>
      </tr>`;
  }).join("");
}

function initHoursControls() {
  $("h-kind").innerHTML = `<option value="">All work</option>` +
    Object.entries(KIND_LABEL).map(([k, l]) => `<option value="${k}">${l}</option>`).join("");

  if (me.role === "admin") {
    $("h-who-field").classList.remove("hidden");
    // people is loaded in boot() for admins, before this runs.
    $("h-who").innerHTML = `<option value="">Everyone</option>` +
      people.filter((p) => p.active)
            .map((p) => `<option value="${p.id}">${escapeHtml(p.full_name)}</option>`).join("");
    // Re-render rather than re-fetch: the rows for the range are already here,
    // and a round trip per click would make the filter feel broken.
    $("h-who").addEventListener("change", renderHours);
  }

  setQuickRange("mtd");
  $("h-range").addEventListener("change", () => { setQuickRange($("h-range").value); loadHours(); });
  for (const id of ["h-from", "h-to"]) {
    $(id).addEventListener("change", loadHours);
  }
  $("h-kind").addEventListener("change", renderHoursByProject);
  $("person-target").addEventListener("input", () => renderPersonDays(
    coverage(personRows(), hoursRange().from, hoursRange().to)));
}

// ----------------------------------------------------------- proposals

let proposals = [];

async function loadProposals() {
  if (me.role !== "admin") return;      // RLS denies it anyway; don't even ask
  const { data, error } = await sb
    .from("proposals")
    .select(`id, number, title, client_name, status, design_fee, visit_rate,
             project_id, link_confidence, link_note`)
    .order("number", { ascending: false });
  if (error) return fail("Loading proposals", error);
  proposals = data || [];
  await ensureLabels(proposals.map((p) => p.project_id).filter(Boolean));
  renderProposalStats();
  renderProposals();
}

function visibleProposals() {
  const st = $("prop-filter-status").value;
  const q = $("prop-search").value.trim().toLowerCase();
  return proposals.filter((p) =>
    (!st || p.status === st) &&
    (!q || `${p.number} ${p.title} ${p.client_name || ""}`.toLowerCase().includes(q)));
}

function renderProposalStats() {
  const all = proposals;
  const n = (s) => all.filter((p) => p.status === s).length;
  const money = all.filter((p) => p.status === "signed" && p.design_fee)
                   .reduce((a, p) => a + Number(p.design_fee), 0);
  $("prop-scope").textContent = `· ${all.length} on record`;
  $("prop-stats").innerHTML = `
    <div class="stat"><div class="n">${n("for_review")}</div><div class="k">For review</div></div>
    <div class="stat"><div class="n">${n("sent")}</div><div class="k">Sent</div></div>
    <div class="stat pass"><div class="n">${n("signed")}</div><div class="k">Signed</div></div>
    <div class="stat"><div class="n">${n("archive")}</div><div class="k">Archive</div></div>
    <div class="stat"><div class="n">${all.filter((p) => p.project_id).length}</div>
      <div class="k">Linked to a job</div></div>
    <div class="stat"><div class="n">$${(money / 1000).toFixed(0)}k</div>
      <div class="k">Signed design fees</div></div>`;
}

function renderProposals() {
  const rows = visibleProposals();
  const body = $("prop-body");
  body.innerHTML = "";
  $("prop-empty").classList.toggle("hidden", rows.length > 0);
  $("prop-table").classList.toggle("hidden", rows.length === 0);

  for (const p of rows.slice(0, 400)) {
    const link = p.project_id
      // A merely address-matched link is marked, because billing off an
      // unverified link is how a fee lands on the wrong job.
      ? `${escapeHtml(labelFor(p.project_id))}${
          p.link_confidence === "suggested"
            ? ` <span class="tag nb" title="${escapeHtml(p.link_note || "")}">unconfirmed</span>`
            : ""}`
      : `<span class="muted">—</span>`;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono small">${escapeHtml(p.number)}</td>
      <td>${escapeHtml(p.title || "")}</td>
      <td class="small">${escapeHtml(p.client_name || "")}</td>
      <td><span class="tag ${p.status === "signed" ? "ok" : p.status === "for_review" ? "nb" : ""}"
            >${escapeHtml(p.status)}</span></td>
      <td class="num">${p.design_fee ? "$" + Number(p.design_fee).toLocaleString() : ""}</td>
      <td class="num">${p.visit_rate ? "$" + p.visit_rate : ""}</td>
      <td class="small">${link}</td>`;
    body.appendChild(tr);
  }
}

$("prop-filter-status").addEventListener("change", renderProposals);
$("prop-search").addEventListener("input", renderProposals);

// --------------------------------------------------------- site visits

let visits = [];

// Stored values stay pending/passed/failed/na (a CHECK constraint), but the
// wording does not: "Passed" and "Failed" imply a certification an
// observation visit does not carry.
const OUTCOME_LABEL = {
  pending: "Not yet reported", passed: "No corrections noted",
  failed: "Corrections required", na: "Informational / n/a",
};
// HD observes; it does not inspect. This list is the vocabulary that ends up in
// a visit record and, from there, one copy-paste from an invoice description.
const COMMON_TYPES = [
  "Pre-pour observation", "Pre-pour observation (piers)", "Pre-pour observation (pool)",
  "Framing observation", "Sheathing observation", "Pier observation", "Excavation observation",
  "Wall removal assessment", "House assessment", "Joist assessment", "Ledger observation",
  "Deck framing observation", "Project walkthrough", "Site visit",
];

let visitBilling = {};        // visit_id -> {rate, basis}. Admin only.

async function loadVisits() {
  const { data, error } = await sb
    .from("site_visits")
    .select(`id, project_id, visit_date, start_time, end_time, attendee_id, attendee_name,
             visit_type, outcome, notes, distance_mi, duration_min, depart_time,
             calendar_event_id, source`)
    .order("visit_date", { ascending: false })
    .order("id", { ascending: false });

  if (error) return fail("Loading site visits", error);
  visits = data || [];

  // Fees live in a separate admin-only table, so an employee never even asks
  // for them. Distance and drive time stay on the visit — they are logistics.
  visitBilling = {};
  if (me.role === "admin") {
    const { data: bill } = await sb
      .from("site_visit_billing")
      .select("visit_id, rate, rate_basis");
    for (const b of bill || []) visitBilling[b.visit_id] = b;
    await loadLetters();
  }
  document.querySelectorAll(".admin-only-col").forEach((n) =>
    n.classList.toggle("hidden", me.role !== "admin"));

  await ensureLabels(visits.map((v) => v.project_id));
  renderVisitFilters();
  renderVisitStats();
  renderVisits();
  // Refresh only the composer's status/chat — never its inputs, which may be
  // holding a half-typed instruction.
  renderLetterStatus();
}

function visibleVisits() {
  const proj = $("v-filter-proj").value;
  const mine = $("v-filter-mine").checked;
  return visits.filter((v) =>
    (!proj || String(v.project_id) === proj) &&
    (!mine || v.attendee_id === me.id ||
      (v.attendee_name || "").toLowerCase() === (me.full_name || "").toLowerCase()));
}

function renderVisitFilters() {
  const sel = $("v-filter-proj");
  const keep = sel.value;
  const ids = [...new Set(visits.map((v) => String(v.project_id)))]
    .sort((a, b) => labelFor(a).localeCompare(labelFor(b)));
  sel.innerHTML = `<option value="">All projects</option>` +
    ids.map((id) => `<option value="${id}">${escapeHtml(labelFor(id))}</option>`).join("");
  if (keep) sel.value = keep;
}

function renderVisitStats() {
  const rows = visibleVisits();
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const thisMonth = rows.filter((v) => v.visit_date.startsWith(monthKey)).length;
  const passed = rows.filter((v) => v.outcome === "passed").length;
  const failed = rows.filter((v) => v.outcome === "failed").length;
  const upcoming = rows.filter((v) => v.visit_date >= ymd(now)).length;
  const unbooked = rows.filter((v) => !v.calendar_event_id && v.visit_date >= ymd(now)).length;
  const projectCount = new Set(rows.map((v) => v.project_id)).size;

  $("visit-scope").textContent = rows.length === visits.length
    ? `· ${visits.length} on record`
    : `· ${rows.length} of ${visits.length}`;

  $("visit-stats").innerHTML = `
    <div class="stat"><div class="n">${rows.length}</div><div class="k">Total visits</div></div>
    <div class="stat"><div class="n">${projectCount}</div><div class="k">Projects</div></div>
    <div class="stat"><div class="n">${thisMonth}</div><div class="k">This month</div></div>
    <div class="stat"><div class="n">${upcoming}</div><div class="k">Today or later</div></div>
    <div class="stat pass"><div class="n">${passed}</div><div class="k">Passed</div></div>
    <div class="stat fail"><div class="n">${failed}</div><div class="k">Failed</div></div>
    ${unbooked ? `<div class="stat"><div class="n">${unbooked}</div>
        <div class="k">Not on calendar</div></div>` : ""}`;
}

function renderVisits() {
  const rows = visibleVisits();
  const body = $("visits-body");
  body.innerHTML = "";
  $("visits-empty").classList.toggle("hidden", rows.length > 0);
  $("visits-table").classList.toggle("hidden", rows.length === 0);

  for (const v of rows) {
    const when = parseYmd(v.visit_date).toLocaleDateString(undefined,
      { weekday: "short", month: "short", day: "numeric" });
    const time = v.start_time ? v.start_time.slice(0, 5) : "all day";
    const travel = v.distance_mi != null
      ? `${v.distance_mi} mi · ${v.duration_min ?? "?"} min`
      : `<span class="muted">—</span>`;
    const b = visitBilling[v.id];
    const rate = b && b.rate != null
      ? `<span title="${escapeHtml(b.rate_basis || "")}">$${b.rate}</span>`
      : `<span class="muted" title="${escapeHtml((b && b.rate_basis) || "no contracted rate")}">—</span>`;
    const cal = v.calendar_event_id
      ? `<span class="tag" style="color:var(--ok);border-color:var(--ok)">booked</span>`
      : v.source === "import"
        ? `<span class="tag">historical</span>`
        : `<span class="tag nb">not booked</span>`;

    // Letter status for this visit — the entry point Ben asked for: pick the
    // visit in the log, then compose below.
    const lt = lettersByVisit[v.id];
    const ltColor = lt && lt.status === "error" ? "var(--err)"
      : lt && (lt.status === "draft" || lt.status === "issued") ? "var(--ok)" : "";
    const letterCell = me.role === "admin"
      ? `<button class="btn ghost sm" data-vletter="${v.id}"${
          ltColor ? ` style="color:${ltColor};border-color:${ltColor}"` : ""}>${
          lt ? escapeHtml(LETTER_STATUS_LABEL[lt.status] || lt.status) : "Letter…"}</button>`
      : "";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${when}<div class="small muted">${escapeHtml(time)}</div></td>
      <td>${escapeHtml(labelFor(v.project_id))}</td>
      <td>${escapeHtml(v.visit_type)}${
        v.notes ? `<div class="small muted">${escapeHtml(v.notes)}</div>` : ""}</td>
      <td class="small">${escapeHtml(v.attendee_name)}</td>
      <td><select data-outcome="${v.id}" style="padding:3px 6px;font-size:13px">
            ${Object.entries(OUTCOME_LABEL).map(([k, l]) =>
              `<option value="${k}"${k === v.outcome ? " selected" : ""}>${l}</option>`).join("")}
          </select></td>
      <td class="num small">${travel}</td>
      <td class="num small admin-only-col${me.role === "admin" ? "" : " hidden"}">${rate}</td>
      <td class="admin-only-col${me.role === "admin" ? "" : " hidden"}">${letterCell}</td>
      <td>${cal}</td>
      <td class="right"><button class="btn ghost sm" data-vdel="${v.id}">Delete</button></td>`;
    body.appendChild(tr);
  }

  body.querySelectorAll("[data-outcome]").forEach((s) =>
    s.addEventListener("change", () => saveVisit(s.dataset.outcome, { outcome: s.value })));
  body.querySelectorAll("[data-vdel]").forEach((b) =>
    b.addEventListener("click", () => deleteVisit(b.dataset.vdel)));
  body.querySelectorAll("[data-vletter]").forEach((b) =>
    b.addEventListener("click", () => openLetterComposer(Number(b.dataset.vletter))));
}

async function saveVisit(id, patch) {
  const { data, error } = await sb.from("site_visits").update(patch).eq("id", id).select("id");
  if (error) fail("Saving that visit", error);
  else if (!data || !data.length) toast("That change did not save — the visit is not yours to edit.", "warn");
  else toast("Saved.");
  await loadVisits();
}

async function deleteVisit(id) {
  const v = visits.find((x) => String(x.id) === String(id));
  const what = v ? `the ${v.visit_type} on ${v.visit_date} (${labelFor(v.project_id)})` : "this visit";
  let msg = `Delete ${what}? This cannot be undone.`;
  if (v && v.calendar_event_id) {
    msg += `\n\nThe Outlook event is NOT removed by this — delete it there too, ` +
           `or run sync-visits.mjs which will report it as orphaned.`;
  }
  if (!confirm(msg)) return;
  const { data, error } = await sb.from("site_visits").delete().eq("id", id).select("id");
  if (error) return fail("Deleting the visit", error);
  await loadVisits();
  if (!data || !data.length) return toast("Nothing was deleted — that visit is not yours.", "warn");
  toast("Visit deleted.");
}

$("v-add").addEventListener("click", async () => {
  if (!$("v-proj").value) return toast("Pick a project first.", "err");
  if (!$("v-date").value) return toast("Pick a date first.", "err");
  const type = $("v-type").value.trim();
  if (!type) return toast("Say what kind of visit it is.", "err");

  const whoId = $("v-who").value;
  const who = people.find((p) => p.id === whoId);

  $("v-add").disabled = true;
  try {
    const { error } = await sb.from("site_visits").insert({
      project_id: Number($("v-proj").value),
      visit_date: $("v-date").value,
      start_time: $("v-start").value || null,
      end_time: $("v-end").value || null,
      attendee_id: whoId || me.id,
      attendee_name: who ? who.full_name : me.full_name,
      visit_type: type,
      outcome: $("v-outcome").value,
      notes: $("v-notes").value.trim() || null,
      site_address: labelFor($("v-proj").value).replace(/^\S+\s+—\s+/, ""),
      created_by: me.id,
      source: "app",
    });
    if (error) return fail("Adding the visit", error);
    $("v-notes").value = "";
    $("v-type").value = "";
    await loadVisits();
    toast("Visit added — run sync-visits.mjs to book it and price the travel.");
  } finally {
    $("v-add").disabled = false;
  }
});

$("v-filter-proj").addEventListener("change", () => { renderVisitStats(); renderVisits(); });
$("v-filter-mine").addEventListener("change", () => { renderVisitStats(); renderVisits(); });

function initVisitForm() {
  $("v-date").value = ymd(new Date());
  $("visit-types").innerHTML = COMMON_TYPES.map((t) => `<option value="${t}">`).join("");
  fillProjectCombo($("v-proj"), projects);
  // Only admins can see the whole roster, so everyone else can only book themselves.
  const who = $("v-who");
  who.innerHTML = (people.length ? people : [me])
    .filter((p) => p.active !== false)
    .map((p) => `<option value="${p.id}"${p.id === me.id ? " selected" : ""}>${
      escapeHtml(p.full_name)}</option>`).join("");
}

// -------------------------------------------------------------- letters
// The app only QUEUES a letter; tools/generate-letters.mjs on the office
// machine builds the spec from the 009_letters template for the chosen type,
// renders it through the firmprint kit, drops the PDF in
// 009_letters\1 - For Review, and writes status/paths back onto the row.
// Admin-only end to end (RLS): a letter goes out over Ben's seal.

// Keys are the runner's template registry. Labels are what Ben picks from.
const LETTER_TYPES = {
  foundation: "Foundation observation",
  framing: "Framing observation",
  pool: "Pool observation",
  trenching: "Trenching / pier observation",
  general: "General letter",
};

const LETTER_STATUS_LABEL = {
  queued: "queued", working: "rendering…", draft: "draft ready",
  error: "error", issued: "issued",
};

// A prefill from the visit's own wording, never a decision — Ben can change it.
function guessLetterType(v) {
  const t = `${v.visit_type || ""} ${v.notes || ""}`.toLowerCase();
  if (/trench|excavat|pier|grade beam/.test(t)) return "trenching";
  if (/pool|gunite|shotcrete/.test(t)) return "pool";
  if (/framing|sheathing|joist|ledger|deck/.test(t)) return "framing";
  if (/pour|foundation|slab|rebar|steel/.test(t)) return "foundation";
  return "general";
}

let letters = [];          // admin only; RLS returns nothing for anyone else
let lettersByVisit = {};   // visit_id -> latest letter for that visit
let letterVisitId = null;  // visit the composer is open on, or null

async function loadLetters() {
  if (me.role !== "admin") return; // RLS denies it anyway; don't even ask
  const { data, error } = await sb
    .from("letters")
    .select(`id, project_id, site_visit_id, letter_type, status, messages,
             spec_path, output_path, pages, error, created_at, updated_at`)
    .order("id", { ascending: true });
  if (error) return fail("Loading letters", error);
  letters = data || [];
  lettersByVisit = {};
  for (const l of letters)
    if (l.site_visit_id != null) lettersByVisit[l.site_visit_id] = l;
}

function letterStatusHtml(lt) {
  if (!lt) return `<span class="muted">not started</span>`;
  const label = LETTER_STATUS_LABEL[lt.status] || lt.status;
  const color = lt.status === "error" ? "var(--err)"
    : (lt.status === "draft" || lt.status === "issued") ? "var(--ok)" : "";
  return `<span class="tag"${color ? ` style="color:${color};border-color:${color}"` : ""}>${
    escapeHtml(label)}</span>`;
}

function fmtWhen(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString(undefined,
    { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function openLetterComposer(visitId) {
  // Switching visits clears the edits box: half-typed instructions for one
  // letter must never ride along and get appended to a different one. Same
  // visit keeps the draft text (background refreshes never touch it).
  if (letterVisitId !== visitId) $("lt-msg").value = "";
  letterVisitId = visitId;
  renderLetterComposer();
  $("letter-card").scrollIntoView({ behavior: "smooth", block: "start" });
}

function syncLetterTypeOptions(lt, v) {
  const sel = $("lt-type");
  const want = lt ? lt.letter_type : guessLetterType(v);
  // A row written with a type this build doesn't know must still display
  // honestly rather than silently snapping to the first option.
  if (![...sel.options].some((o) => o.value === want)) {
    const o = document.createElement("option");
    o.value = want; o.textContent = want;
    sel.appendChild(o);
  }
  sel.value = want;
}

// Full render: only on open and after Go. It touches the type select, so it
// must never run from a background data refresh — that is how half-typed
// input gets eaten (see the week-grid postmortem in the README).
function renderLetterComposer() {
  const v = letterVisitId != null
    ? visits.find((x) => x.id === letterVisitId) : null;
  if (!v) letterVisitId = null;
  const open = letterVisitId != null;
  $("lt-closed").classList.toggle("hidden", open);
  $("lt-open").classList.toggle("hidden", !open);
  $("lt-scope").textContent = "";
  if (!open) return;

  const lt = lettersByVisit[v.id] || null;
  $("lt-visit").innerHTML =
    `<b>${escapeHtml(labelFor(v.project_id))}</b><br>` +
    `${escapeHtml(v.visit_type)} · ${escapeHtml(v.visit_date)}` +
    (v.attendee_name ? ` · ${escapeHtml(v.attendee_name)}` : "");
  syncLetterTypeOptions(lt, v);
  renderLetterStatus();
}

// Partial refresh: status line, chat and the issued button only. Safe to call
// after any data reload — it never touches the textarea or the type select.
function renderLetterStatus() {
  if (letterVisitId == null) return;
  const lt = lettersByVisit[letterVisitId] || null;

  $("lt-status").innerHTML = letterStatusHtml(lt) +
    (lt ? `<div class="small muted">${escapeHtml(fmtWhen(lt.updated_at))}</div>` : "");
  $("lt-issued").classList.toggle("hidden", !(lt && lt.status === "draft"));

  let h = "";
  for (const m of (lt && Array.isArray(lt.messages) ? lt.messages : [])) {
    h += `<div class="lt-bubble"><div class="small muted">${
      escapeHtml(fmtWhen(m.at))}</div>${escapeHtml(m.text || "")}</div>`;
  }
  if (!lt) {
    h += `<div class="lt-sys">Nothing queued yet — Go queues the standard letter
      for this visit; the edits box is optional.</div>`;
  } else {
    if (lt.status === "queued")
      h += `<div class="lt-sys">Queued — waiting for generate-letters.mjs on the office machine.</div>`;
    if (lt.status === "working")
      h += `<div class="lt-sys">The office machine is rendering this letter…</div>`;
    if (lt.error)
      h += `<div class="lt-sys err">${escapeHtml(lt.error)}</div>`;
    if (lt.output_path)
      h += `<div class="lt-sys">PDF: ${escapeHtml(lt.output_path)}${
        lt.pages ? ` · ${lt.pages} page${lt.pages === 1 ? "" : "s"}` : ""}</div>`;
  }
  $("lt-chat").innerHTML = h;
}

$("lt-go").addEventListener("click", async () => {
  if (me.role !== "admin" || letterVisitId == null) return;
  const v = visits.find((x) => x.id === letterVisitId);
  if (!v) return toast("That visit is gone — pick another from the log.", "err");
  const type = $("lt-type").value;
  if (!type) return toast("Pick a letter type first.", "err");
  const text = $("lt-msg").value.trim();
  const lt = lettersByVisit[v.id] || null;

  $("lt-go").disabled = true;
  try {
    let toastMsg = "Letter queued — run generate-letters.mjs on the office machine.";
    if (!lt || lt.status === "issued") {
      // First letter for the visit — or a revision of an issued one. Issued
      // is terminal (the record that a sealed letter went out must survive),
      // so a revision is a NEW row, and it needs words to exist.
      if (lt && !text)
        return toast("That letter is issued. Type what the revision should change, then Go.", "err");
      const messages = text ? [{ at: new Date().toISOString(), text }] : [];
      const { error } = await sb.from("letters").insert({
        project_id: v.project_id,
        site_visit_id: v.id,
        letter_type: type,
        status: "queued",
        messages,
        requested_by: me.id,
      });
      if (error) return fail("Queuing the letter", error);
      if (lt) toastMsg = "Revision queued as a new letter — the issued record stays.";
    } else {
      // Re-queue through the server-side queue_letter(): the append happens
      // atomically in the database, so a stale tab can never erase messages
      // added from another device — and if the runner is mid-render, its
      // writebacks are fenced on its claim, so this re-queue wins.
      const { data, error } = await sb.rpc("queue_letter", {
        p_letter_id: lt.id, p_text: text || null, p_letter_type: type,
      });
      if (error) return fail("Re-queuing the letter", error);
      if (!data || !data.length)
        return toast("That change did not save — the letter row is not editable.", "warn");
    }
    $("lt-msg").value = "";
    await loadLetters();
    renderVisits();
    renderLetterStatus();
    toast(toastMsg);
  } finally {
    $("lt-go").disabled = false;
  }
});

$("lt-issued").addEventListener("click", async () => {
  if (letterVisitId == null) return;
  const lt = lettersByVisit[letterVisitId];
  if (!lt || lt.status !== "draft") return;
  const { data, error } = await sb.from("letters")
    .update({ status: "issued" }).eq("id", lt.id).eq("status", "draft").select("id");
  if (error) return fail("Marking the letter issued", error);
  if (!data || !data.length) return toast("That change did not save.", "warn");
  await loadLetters();
  renderVisits();
  renderLetterStatus();
  toast("Marked issued.");
});

// The type list is static HTML, so this attaches once, like the filter selects.
$("lt-type").innerHTML = Object.entries(LETTER_TYPES)
  .map(([k, l]) => `<option value="${k}">${escapeHtml(l)}</option>`).join("");

// ---------------------------------------------------------------- admin

let people = [];
let assignFor = null;

async function loadPeople() {
  const { data, error } = await sb
    .from("employees")
    .select("id, email, full_name, role, active, rate_class")
    .order("full_name");
  if (error) return fail("Loading people", error);
  people = data || [];

  const { data: counts } = await sb.from("project_assignments").select("employee_id");
  const tally = {};
  for (const r of counts || []) tally[r.employee_id] = (tally[r.employee_id] || 0) + 1;

  const admins = people.filter((p) => p.role === "admin" && p.active).length;
  const body = $("people-body");
  body.innerHTML = "";
  for (const p of people) {
    const isMe = p.id === me.id;
    const lastAdmin = p.role === "admin" && p.active && admins <= 1;
    const lock = isMe || lastAdmin;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(p.full_name)}<div class="small muted">${escapeHtml(p.email)}</div></td>
      <td><select data-role="${p.id}" ${lock ? "disabled" : ""}>
            ${["admin", "employee", "contractor"].map((r) =>
              `<option value="${r}"${r === p.role ? " selected" : ""}>${r}</option>`).join("")}
          </select></td>
      <!-- Not the same thing as role. Role is a permission; this is which §5.2
           rate their hours cost at, and it is nobody's default to guess. -->
      <td><select data-rateclass="${p.id}">
            <option value=""${!p.rate_class ? " selected" : ""}>— not set</option>
            <option value="engineer"${p.rate_class === "engineer" ? " selected" : ""}>engineer</option>
            <option value="drafter"${p.rate_class === "drafter" ? " selected" : ""}>drafter</option>
          </select></td>
      <td><input type="checkbox" data-active="${p.id}" ${p.active ? "checked" : ""}
                 ${lock ? "disabled" : ""}></td>
      <td class="num">${
        // Staff see every project by role, so an assignment count here would
        // read as "0 projects" for someone who can actually see all of them.
        p.role === "contractor"
          ? (tally[p.id] || 0)
          : `<span title="Staff see every project by role">all</span>`
      }</td>
      <td class="right">${
        p.role === "contractor"
          ? `<button class="btn ghost sm" data-assign="${p.id}">Projects</button>`
          : `<span class="small muted">—</span>`
      }</td>`;
    body.appendChild(tr);
  }

  // Your own row, and the last remaining admin, are locked so the firm cannot
  // be left with nobody able to administer it.
  body.querySelectorAll("[data-role]").forEach((s) =>
    s.addEventListener("change", () => savePerson(s.dataset.role, { role: s.value })));
  body.querySelectorAll("[data-rateclass]").forEach((s) =>
    s.addEventListener("change", () =>
      savePerson(s.dataset.rateclass, { rate_class: s.value || null })));
  body.querySelectorAll("[data-active]").forEach((c) =>
    c.addEventListener("change", () => savePerson(c.dataset.active, { active: c.checked })));
  body.querySelectorAll("[data-assign]").forEach((b) =>
    b.addEventListener("click", () => openAssign(b.dataset.assign)));
}

async function savePerson(id, patch) {
  const { data, error } = await sb.from("employees").update(patch).eq("id", id).select("id");
  // Reload either way: on failure the control must snap back to the truth
  // rather than sit there showing a change that never landed.
  if (error) fail("Saving that person", error);
  else if (!data || !data.length) toast("That change did not save — you cannot edit this person.", "warn");
  else toast("Saved.");
  await loadPeople();
}

async function openAssign(employeeId) {
  assignFor = people.find((p) => p.id === employeeId);
  if (!assignFor) return;
  $("assign-box").classList.remove("hidden");
  $("assign-who").textContent = assignFor.full_name;
  $("assign-list").innerHTML = `<span class="muted small">Loading…</span>`;

  // All statuses here too: assigning someone to a closed job is exactly how you
  // let them log a warranty visit or a late correction against it.
  const { data: all, error } = await sb
    .from("projects")
    .select("id, number, name, is_overhead, status")
    .order("is_overhead")
    .order("number", { ascending: false });
  if (error) return fail("Loading projects", error);

  fillProjectCombo($("assign-proj"), all || []);

  await renderAssignments(employeeId);
}

// employeeId is closed over, not read from the mutable global, so clicking
// through people quickly cannot remove a project from the wrong person.
async function renderAssignments(employeeId) {
  const { data, error } = await sb
    .from("project_assignments")
    .select("project_id")
    .eq("employee_id", employeeId);
  if (error) return fail("Loading assignments", error);
  if (!assignFor || assignFor.id !== employeeId) return;   // moved on already

  const ids = (data || []).map((r) => r.project_id);
  await ensureLabels(ids);

  const box = $("assign-list");
  box.innerHTML = ids.length
    ? ids.map((id) => `<span class="chip">${escapeHtml(labelFor(id))}
        <button data-unassign="${id}" title="Remove">&times;</button></span>`).join("")
    : `<span class="muted small">No projects assigned — they can log nothing.</span>`;

  box.querySelectorAll("[data-unassign]").forEach((b) =>
    b.addEventListener("click", async () => {
      const { error: e2 } = await sb.from("project_assignments").delete()
        .eq("employee_id", employeeId).eq("project_id", b.dataset.unassign);
      if (e2) return fail("Removing that project", e2);
      await renderAssignments(employeeId);
      await loadPeople();
    }));
}

$("assign-add").addEventListener("click", async () => {
  if (!assignFor) return;
  const target = assignFor.id;
  const { error } = await sb.from("project_assignments").insert({
    employee_id: target, project_id: Number($("assign-proj").value),
  });
  if (error && !String(error.message).toLowerCase().includes("duplicate")) {
    return fail("Assigning that project", error);
  }
  await renderAssignments(target);
  await loadPeople();
  toast("Assigned.");
});

$("assign-close").addEventListener("click", () => {
  $("assign-box").classList.add("hidden");
  assignFor = null;
});

// ----------------------------------------------------------------- start
// onAuthStateChange fires with the restored session on load, so it is the only
// entry point — a second bootstrap here would double-boot.
(async () => {
  const { data } = await sb.auth.getSession();
  if (!data.session) showLogin();
})();
