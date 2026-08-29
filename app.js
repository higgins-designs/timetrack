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

// Designer capability: Letters and Drawing aids without admin (Ben, 2026-08-27 —
// "letters, drawing aids are for designers", "proposals are for admins or select
// office staff"). Admin implies it, so an admin is never locked out of a surface
// a designer can reach.
//
// ⚠️ This is the VIEW half only. The gate is RLS —
// timetrack_private.can_design() and the `*_designer_*` policies in migration
// 0021. Two things it deliberately does NOT unlock, enforced in the database
// rather than by hiding a button: marking a letter sent (that releases Ben's
// P.E. seal and is terminal), and approving a design-manifest fact (the
// manifest records what the ENGINEER decided). Nothing financial is touched:
// proposals and site_visit_billing stay admin-only tables, because RLS cannot
// hide a column.
const canDesign = () => Boolean(me && (me.role === "admin" || me.can_design));
const isAdmin = () => Boolean(me && me.role === "admin");
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
// A project label that is also the way into it: one delegated listener (see
// "project drawer") opens the drawer on any of these, so a table that renders
// its project through this needs no re-wiring after a render.
//
// The attribute is data-projlink and NOT data-proj: the week grid's hour cells
// already carry data-proj, and a delegated listener on that name would open a
// drawer every time someone clicked a cell to type into it.
function projLink(projectId, text) {
  if (projectId == null || projectId === "") return "";
  const label = text == null ? labelFor(projectId) : text;
  return `<a class="plink" role="button" tabindex="0" title="Open this project"` +
    ` data-projlink="${escapeHtml(String(projectId))}">${escapeHtml(label)}</a>`;
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
    .select("id, email, full_name, role, active, rate_class, can_design")
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
  // The phone masthead shows initials instead (CSS). Same fact, a tenth of the
  // width, and it keeps the firm name from being an ellipsis.
  $("who-short").textContent = me.full_name.trim().split(/\s+/)
    .map((w) => w[0]).join("").slice(0, 3).toUpperCase() +
    (me.role === "admin" ? " ·" : "");
  $("who-short").title = $("who").textContent;
  $("m-date").value = ymd(new Date());
  dayDate = ymd(new Date());

  await loadProjects();
  await Promise.all([loadRunning(), loadDay(), loadWeek(), loadDrafts()]);
  // Designers get the two production surfaces; Proposals and People stay with
  // admin. Splitting these two blocks is the whole point of migration 0021 —
  // the letter generator used to cost an admin badge, and an admin badge is
  // every contracted fee.
  if (canDesign()) {
    $("tab-letters-btn").classList.remove("hidden");
    $("tab-drawing-btn").classList.remove("hidden");
    initDrawingTab();   // fills the three composer comboboxes; needs projects
  }
  if (me.role === "admin") {
    $("admin-card").classList.remove("hidden");
    $("tab-people-btn").classList.remove("hidden");
    $("tab-proposals-btn").classList.remove("hidden");
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
  for (const p of ["overview", "todo", "time", "visits", "letters", "hours", "proposals", "drawing", "people"]) {
    $(`panel-${p}`).classList.toggle("hidden", p !== name);
  }
  if (name === "overview") loadOverview();
  if (name === "todo") loadTasks();
  // `time` was the one panel showTab never reloaded — and it is the tab an
  // employee lives in, so the one gesture that refreshes everything else did
  // nothing there.
  if (name === "time") reloadTimePanel();
  if (name === "visits") loadVisits();
  if (name === "letters") loadLettersTab();
  else stopLetterPoll(); // leaving the board: no reason to keep polling
  if (name === "hours") loadHours();
  if (name === "proposals") loadProposals();
  // AFTER the proposals line and NEVER between the letters if/else above —
  // inserting there would rebind that else and silently break letter polling.
  if (name === "drawing") loadDrawingTab();
  else stopDrawingPoll(); // leaving the board: no reason to keep polling
}

// ------------------------------------------------- refresh on coming back
//
// NOTHING refreshed an employee's view. boot() fetches once at sign-in, both
// pollers return early on `me.role !== "admin"`, and showTab reloaded every
// panel except `time` — the tab an employee works in. A tab left open therefore
// showed the world as it was at sign-in. It looked fine to an admin because an
// admin is the one writing, and his own client re-renders after its own writes.
//
// Refresh when the tab comes back to the foreground rather than on an interval:
// the data only matters while someone is looking, and a background timer on a
// phone spends battery to repaint a hidden page.
//
// ⚠️ Do NOT re-boot here. onAuthStateChange already fires on refocus, and
// re-booting there "used to reset the manual-entry date and wipe whatever was
// being typed into the week grid" — see that handler. This reloads the VISIBLE
// panel only, sends the week grid through loadWeekPreservingFocus, and bails
// out entirely if the user is typing.
const REFRESH_AFTER_HIDDEN_MS = 30_000;
let hiddenSince = null;
let refreshInFlight = false;

async function reloadTimePanel() {
  await Promise.all([loadProjects(), loadRunning(), loadDay(), loadDrafts()]);
  await loadWeekPreservingFocus();
}

function isTyping() {
  const a = document.activeElement;
  if (!a || !a.matches) return false;
  // The week grid is safe — loadWeekPreservingFocus restores the cell and its
  // half-typed value. Any OTHER field would simply lose what is in it.
  if (a.matches("#week-body input[data-proj]")) return false;
  return a.matches("input, textarea, select") && !a.matches("input[type=checkbox], input[type=radio]");
}

async function refreshVisiblePanel() {
  if (!me || refreshInFlight || isTyping()) return;
  // Letters and Drawing aids are admin boards that already poll while work is
  // in flight, and both own a composer that a background reload would disturb.
  const panels = ["overview", "todo", "time", "visits", "hours", "proposals", "people"];
  const visible = panels.find((p) => !$(`panel-${p}`).classList.contains("hidden"));
  if (!visible) return;
  refreshInFlight = true;
  try {
    if (visible === "time") await reloadTimePanel();
    else showTab(visible);
  } catch {
    // A failed refresh must leave the page exactly as it was. The user still
    // has the data they had; throwing here would take the panel down with it.
  } finally {
    refreshInFlight = false;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) { hiddenSince = Date.now(); return; }
  const away = hiddenSince ? Date.now() - hiddenSince : 0;
  hiddenSince = null;
  if (away >= REFRESH_AFTER_HIDDEN_MS) refreshVisiblePanel();
});

// ------------------------------------------------------- project drawer
// The modules were only ever joined by the project number, and there was no
// project view: you could read "26016 — 3811 Grayson Ln" on five tabs and not
// reach the job behind it. This is that view — a slide-over, not a tab, so
// showTab's panel array and every existing test address the same panels.
//
// Everything below is a plain query, so RLS is the gate: an employee gets only
// their own time entries, and the two ADMIN-ONLY TABLES (letters, proposals)
// are not queried at all for anyone else — their sections are omitted rather
// than rendered empty, because an empty "Letters" heading claims this job has
// no letters when the truth is that you cannot see letters.

const PD_ROWS = 8;          // rows per section before the "N more" line
// The hours figure is summed from the rows read here rather than from a
// server-side aggregate. A project past this many confirmed entries would
// under-report, so the total is marked with a + instead of quietly lying.
const PD_TIME_CAP = 500;

let pdToken = 0;            // a later open (or a close) makes an earlier load stale
let pdReturnFocus = null;

// Local dates only — parseYmd, never new Date("2026-08-24") which is UTC.
function pdShortDate(s) {
  if (!s) return "";
  const d = parseYmd(s);
  const opts = d.getFullYear() === new Date().getFullYear()
    ? { month: "short", day: "numeric" }
    : { year: "2-digit", month: "short", day: "numeric" };
  return d.toLocaleDateString(undefined, opts);
}
function pdStampDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
// `people` is loaded for admins only, so for anyone else this reads "—" rather
// than inventing a name for a person they cannot look up.
function pdWho(id) {
  if (!id) return "—";
  const person = people.find((x) => x.id === id) || (id === me.id ? me : null);
  return person ? person.full_name.split(" ")[0] : "—";
}

async function openProjectDrawer(projectId) {
  const id = String(projectId == null ? "" : projectId).trim();
  if (!id || !me) return;
  const token = ++pdToken;
  const drawer = $("proj-drawer");
  // Only remember where focus came from on a genuine open; clicking a project
  // inside the drawer must not make the drawer's own link the return target.
  if (drawer.classList.contains("hidden")) pdReturnFocus = document.activeElement;
  $("pd-scrim").classList.remove("hidden");
  drawer.classList.remove("hidden");
  $("pd-title").textContent = labelFor(id);
  $("pd-sub").innerHTML = "";
  $("pd-facts").innerHTML = "";
  $("pd-actions").innerHTML = "";      // no stale actions over a different job
  pdProposals = [];
  $("pd-sections").innerHTML = `<div class="pd-none">Loading…</div>`;
  $("pd-body").scrollTop = 0;
  $("pd-close").focus();

  const data = await pdLoad(id);
  if (token !== pdToken) return;     // closed, or another project was opened
  pdRender(data);
}

async function pdLoad(id) {
  const admin = me.role === "admin";
  const design = canDesign();   // letters + drawing jobs; proposals stay admin
  const jobs = [
    sb.from("projects")
      .select("id, number, name, folder, client, status, phase, next_action, is_overhead")
      .eq("id", id).maybeSingle(),
    sb.from("tasks")
      .select("id, title, due_date, status, priority, assignee_id, notes")
      .eq("project_id", id)
      .order("due_date", { ascending: true, nullsFirst: false })
      .order("id", { ascending: true }),
    // confirmed only, and never a running timer — a reconstructed guess is not
    // an hour. Same filter the Hours tab uses.
    sb.from("time_entries")
      .select("id, employee_id, work_date, minutes, task_kind, notes")
      .eq("project_id", id).eq("confirmed", true).not("minutes", "is", null)
      .order("work_date", { ascending: false }).order("id", { ascending: false })
      .limit(PD_TIME_CAP),
    sb.from("site_visits")
      .select("id, visit_date, visit_type, attendee_name, outcome")
      .eq("project_id", id).order("visit_date", { ascending: false }).limit(200),
    design ? sb.from("letters")
      .select("id, status, scopes, performed_by, pages, updated_at")
      .eq("project_id", id).order("updated_at", { ascending: false }) : null,
    admin ? sb.from("proposals")
      .select(`id, number, title, status, design_fee, visit_rate, hourly_rate,
               link_confidence, link_note`)
      .eq("project_id", id).order("number", { ascending: false }) : null,
    design ? sb.from("drawing_jobs")
      // review_status included because the drawer renders drawingStatusHtml —
      // without it every done job would read "Unreviewed" regardless of truth.
      .select("id, kind, status, review_status, updated_at")
      .eq("project_id", id).order("updated_at", { ascending: false }).limit(50) : null,
  ];
  const [proj, tks, tme, vis, lts, pps, djs] = await Promise.all(
    jobs.map((j) => j || Promise.resolve({ data: null, error: null })));

  return {
    id, admin, design,
    project: proj.data || null, projectError: proj.error || null,
    tasks: tks.data || [], tasksError: tks.error || null,
    time: tme.data || [], timeError: tme.error || null,
    visits: vis.data || [], visitsError: vis.error || null,
    letters: lts.data || [], lettersError: lts.error || null,
    proposals: pps.data || [], proposalsError: pps.error || null,
    drawing: djs.data || [], drawingError: djs.error || null,
  };
}

// Where each section's heading count leads. The key is the section's own
// data-pdsec value, so the two can never drift apart.
//
// "Time" goes to Hours & Fees, not the Time tab: the Time tab is one person's
// timesheet for today and this week, and Hours & Fees is the module that reports
// a JOB's hours. Every one of these is a real filter that survives the target
// tab's next render — see the keep-the-current-value handling in each of
// renderTodoProjectFilter / renderVisitFilters / renderLetterProjectFilter /
// renderProposalProjectFilter / renderHoursProjectFilter.
const PD_GO = {
  tasks: "Open the To do tab, filtered to this project",
  time: "Open Hours & Fees, filtered to this project",
  "site visits": "Open the Site visits log, filtered to this project",
  letters: "Open the Letters board, filtered to this project",
  proposal: "Open the Proposals register, filtered to this project",
  "drawing aids": "Open the Drawing aids board, filtered to this project",
};

function pdSection(label, total, rows, empty, error, note) {
  const shown = rows.slice(0, PD_ROWS);
  const key = label.toLowerCase();
  // A count of zero is not a way in — an empty filtered module is a dead end,
  // and an affordance that leads nowhere is worse than none.
  const goable = Boolean(PD_GO[key]) && total > 0;
  const count = goable
    ? `<button class="cnt" type="button" data-pdgo="${escapeHtml(key)}"
         title="${escapeHtml(PD_GO[key])}">${total}</button>`
    : `<span>${total}</span>`;
  return `<div class="pd-sec" data-pdsec="${escapeHtml(key)}">
    <div class="gh">${escapeHtml(label)} ${count}</div>
    ${error
      ? `<div class="pd-none" style="color:var(--err)">Could not load this — ${
          escapeHtml(error.message || String(error))}</div>`
      : shown.length
        ? `<table><tbody>${shown.join("")}</tbody></table>`
        : `<div class="pd-none">${escapeHtml(empty)}</div>`}
    ${total > shown.length ? `<div class="pd-more">${total - shown.length} more not shown.${
      goable ? ` <button class="cnt" type="button" data-pdgo="${escapeHtml(key)}"
        title="${escapeHtml(PD_GO[key])}">View all ${total} &rarr;</button>` : ""}</div>` : ""}
    ${note ? `<div class="pd-more">${escapeHtml(note)}</div>` : ""}
  </div>`;
}

// Clip a long free-text field for a single-line slot. The drawer IS the
// project's own view, so unlike the search results this one keeps the full text
// in a title — but it still must not wrap the fixed header to four lines.
function pdClip(s, n) {
  const v = String(s == null ? "" : s).trim();
  return v.length > n ? v.slice(0, n - 1).trimEnd() + "…" : v;
}

function pdRender(d) {
  const p = d.project;
  pdProposals = d.proposals;          // what the resolve buttons act on
  $("pd-title").textContent = p ? projLabel(p) : labelFor(d.id);
  if (p) gsRemember(d.id);

  // ONE restrained identity line: client · phase · status. There is deliberately
  // no project-manager field here — `timetrack.projects` has id, number, name,
  // folder, client, status, is_overhead, created_at, updated_at, phase,
  // phase_index, next_action and nothing else. Inventing a PM would mean
  // choosing a person the database never named.
  const ident = [];
  if (p && p.client) {
    ident.push(`<span title="${escapeHtml(p.client)}">${escapeHtml(pdClip(p.client, 60))}</span>`);
  }
  if (p && p.phase) ident.push(escapeHtml(p.phase));
  if (p && p.status) ident.push(escapeHtml(String(p.status).replace(/_/g, " ")));
  $("pd-sub").innerHTML = ident.length
    ? ident.join(`<span class="sep"> · </span>`)
    : `<span class="muted">No client, phase or status recorded.</span>`;

  const openTasks = d.tasks.filter((t) => t.status === "open");
  const minutes = d.time.reduce((a, r) => a + (r.minutes || 0), 0);
  const capped = d.time.length >= PD_TIME_CAP;
  const today = ymd(new Date());
  const past = d.visits.filter((v) => v.visit_date <= today);      // already newest first
  const ahead = d.visits.filter((v) => v.visit_date > today);
  const last = past[0];
  const next = ahead[ahead.length - 1];
  const prop = d.proposals[0];

  // CERTAINTY LANGUAGE. The tile used to read "0 hours logged" while the section
  // under it read "No confirmed hours" — two different claims about the same
  // number. Only confirmed entries are summed (a reconstructed draft is not an
  // hour), so the tile says confirmed too. Same rule anywhere a figure is
  // inferred rather than directly linked: the proposal below is joined by
  // link_confidence, so an unconfirmed link is marked ON THE TILE, not only down
  // in the section where you would have to scroll to find it.
  const facts = [
    ["Open tasks", String(openTasks.length), ""],
    // An employee's RLS view is their own entries, so the label has to say so
    // rather than let a partial number read as the whole job's effort.
    [d.admin ? "Confirmed h" : "Your confirmed h",
      (hrs(minutes) || "0") + (capped ? "+" : ""),
      "Confirmed time entries only — reconstructed drafts and running timers are not counted"],
    ["Last visit", last ? pdShortDate(last.visit_date) : "—", ""],
    ["Next visit", next ? pdShortDate(next.visit_date) : "—", ""],
  ];
  if (d.design) facts.push(["Letters", String(d.letters.length), ""]);
  if (d.admin && prop) {
    const unsure = prop.link_confidence === "suggested";
    facts.push([
      `Proposal · ${PROPOSAL_STATUS_LABEL[prop.status] || prop.status}${unsure ? " ·" : ""}`,
      prop.number,
      unsure ? "This proposal is matched to this job by address only — not confirmed" : "",
      unsure ? "unconfirmed" : "",
    ]);
  }
  $("pd-facts").innerHTML = facts.map(([k, n, tip, flag]) =>
    `<div class="pd-fact"${tip ? ` title="${escapeHtml(tip)}"` : ""}>
      <div class="n">${escapeHtml(n)}</div>
      <div class="k">${escapeHtml(k)}${
        flag ? ` <span class="tag nb">${escapeHtml(flag)}</span>` : ""}</div></div>`).join("");

  pdRenderActions(d);

  const out = [];
  if (d.projectError) {
    out.push(`<div class="pd-none" style="color:var(--err)">Could not read the project — ${
      escapeHtml(d.projectError.message)}</div>`);
  }
  if (p && p.next_action) {
    out.push(`<div class="pd-next"><b>Next:</b> ${escapeHtml(p.next_action)}</div>`);
  }

  const taskRows = openTasks.map((t) => `
    <tr>
      <td class="when${t.due_date && t.due_date < today ? " late" : ""}">${
        t.due_date ? escapeHtml(pdShortDate(t.due_date)) : "—"}</td>
      <td>${escapeHtml(t.title)}${
        t.priority === "high" ? ` <span class="tag nb">high</span>` : ""}${
        t.notes ? `<div class="muted small">${escapeHtml(t.notes)}</div>` : ""}</td>
      <td class="small muted">${escapeHtml(pdWho(t.assignee_id))}</td>
    </tr>`);
  out.push(pdSection("Tasks", openTasks.length, taskRows,
    d.tasks.length ? "Nothing open — the rest are finished or dropped." : "No tasks on this job.",
    d.tasksError));

  const timeRows = d.time.map((r) => `
    <tr>
      <td class="when">${escapeHtml(pdShortDate(r.work_date))}</td>
      <td>${escapeHtml(KIND_LABEL[r.task_kind] || r.task_kind)}${
        r.notes ? `<div class="muted small">${escapeHtml(r.notes)}</div>` : ""}</td>
      <td class="small muted">${escapeHtml(pdWho(r.employee_id))}</td>
      <td class="num">${escapeHtml(hrs(r.minutes) || "0")}</td>
    </tr>`);
  out.push(pdSection("Time", d.time.length, timeRows,
    d.admin ? "No confirmed hours on this job." : "You have no hours on this job.",
    d.timeError, capped ? `Only the most recent ${PD_TIME_CAP} entries were read.` : ""));

  const visitRows = d.visits.map((v) => `
    <tr>
      <td class="when">${escapeHtml(pdShortDate(v.visit_date))}</td>
      <td>${escapeHtml(v.visit_type)}${
        v.attendee_name ? `<div class="muted small">${escapeHtml(v.attendee_name)}</div>` : ""}</td>
      <td class="small">${escapeHtml(OUTCOME_LABEL[v.outcome] || v.outcome)}</td>
    </tr>`);
  out.push(pdSection("Site visits", d.visits.length, visitRows,
    "No visits recorded.", d.visitsError));

  // Not queried for the people who may not see them, and not rendered either —
  // an empty "Letters" heading claims a job has none when the truth is that you
  // cannot see letters. Letters and Drawing aids follow the DESIGNER
  // capability; Proposal is money and stays admin.
  if (d.design) {
    const letterRows = d.letters.map((lt) => `
      <tr>
        <td class="when">${escapeHtml(pdStampDate(lt.updated_at))}</td>
        <td>${escapeHtml(letterScopeLabel(lt))}${
          lt.performed_by ? `<div class="muted small">${escapeHtml(lt.performed_by)}</div>` : ""}</td>
        <td class="small">${letterStatusHtml(lt)}</td>
      </tr>`);
    out.push(pdSection("Letters", d.letters.length, letterRows,
      "No letters for this job.", d.lettersError));

    const drawingRows = d.drawing.map((j) => `
      <tr>
        <td class="when">${escapeHtml(pdStampDate(j.updated_at))}</td>
        <td>${escapeHtml(DRAWING_KIND_LABEL[j.kind] || j.kind)}</td>
        <td class="small">${drawingStatusHtml(j)}</td>
      </tr>`);
    out.push(pdSection("Drawing aids", d.drawing.length, drawingRows,
      "No drawing jobs on this project.", d.drawingError));
  }

  if (d.admin) {
    const propRows = d.proposals.map((pr) => `
      <tr>
        <td class="when">${escapeHtml(pr.number)}</td>
        <td>${escapeHtml(pr.title || "")}
          <div class="muted small">${escapeHtml(PROPOSAL_STATUS_LABEL[pr.status] || pr.status)}${
            pr.link_confidence === "suggested"
              ? ` · <span class="tag nb" title="${escapeHtml(pr.link_note || "")}">unconfirmed link</span>`
              : ""}</div>${pdLinkResolveHtml(pr)}</td>
        <td class="num small">${pr.design_fee ? "$" + Number(pr.design_fee).toLocaleString() : ""}${
          pr.visit_rate ? `<div class="muted">$${escapeHtml(String(pr.visit_rate))}/visit</div>` : ""}</td>
      </tr>`);
    out.push(pdSection("Proposal", d.proposals.length, propRows,
      "No proposal is linked to this job.", d.proposalsError));
  }

  out.push(`<div class="pd-foot">
    <a class="plink" data-pdtodo="${escapeHtml(String(d.id))}">Open project tasks &rarr;</a>
    ${p && p.folder
      ? `<div style="margin-top:8px">Folder <span class="path">${escapeHtml(p.folder)}</span></div>`
      : ""}
  </div>`);

  $("pd-sections").innerHTML = out.join("");
  const todoLink = $("pd-sections").querySelector("[data-pdtodo]");
  if (todoLink) {
    todoLink.addEventListener("click", () => {
      const id = todoLink.dataset.pdtodo;
      closeProjectDrawer();
      goToProject(id);
    });
  }
  // Controls inside innerHTML are re-wired on every render, without exception.
  $("pd-sections").querySelectorAll("[data-pdgo]").forEach((b) =>
    b.addEventListener("click", () => pdGo(b.dataset.pdgo, d.id)));
  $("pd-sections").querySelectorAll("[data-pdconfirm]").forEach((b) =>
    b.addEventListener("click", () => pdConfirmLink(Number(b.dataset.pdconfirm), d.id)));
  $("pd-sections").querySelectorAll("[data-pddrop]").forEach((b) =>
    b.addEventListener("click", () => pdDropLink(Number(b.dataset.pddrop), d.id)));
}

// ------------------------------------------------- resolving a proposal link
// An address-matched link is a GUESS, and it is a consequential one: once
// link_confidence is 'confirmed' on a SIGNED proposal that states a per-visit
// fee, timetrack_private.contracted_visit_rate() starts returning that rate and
// the seed_visit_billing trigger stamps it onto every visit inserted afterwards.
// So the button says what it arms, and there is a second, explicit confirm step
// before anything is written.
function pdLinkResolveHtml(pr) {
  if (pr.link_confidence !== "suggested") return "";
  const arms = pr.status === "signed" && pr.visit_rate;
  const label = arms
    ? `Confirm link — arms $${escapeHtml(String(pr.visit_rate))}/visit on future visits`
    : `Confirm link — this proposal is this job`;
  const tip = arms
    ? `Sets link_confidence to confirmed. ${pr.number} is signed at $${pr.visit_rate} per visit, ` +
      `so confirming makes that the contracted rate stamped onto every site visit logged from now on.`
    : `Sets link_confidence to confirmed: this proposal really does belong to this project. ` +
      `${pr.number} is ${PROPOSAL_STATUS_LABEL[pr.status] || pr.status} with no per-visit fee, ` +
      `so no rate is armed by it today.`;
  return `<div class="pd-resolve">
    <button class="arm" type="button" data-pdconfirm="${pr.id}"
      title="${escapeHtml(tip)}">${label}</button>
    <button class="drop" type="button" data-pddrop="${pr.id}"
      title="${escapeHtml(`Clears the suggested match: ${pr.number} stops being attached to this ` +
        `project. The proposal itself is not deleted.`)}">Not this job</button>
  </div>`;
}

async function pdConfirmLink(proposalId, projectId) {
  const pr = pdProposalById(proposalId);
  if (!pr) return;
  const arms = pr.status === "signed" && pr.visit_rate;
  const msg = `Confirm that proposal ${pr.number} is this project?\n\n` +
    (arms
      ? `${pr.number} is SIGNED at $${pr.visit_rate} per visit.\n\n` +
        `Confirming this link arms the contracted visit rate: every site visit ` +
        `logged on this project from now on will be stamped $${pr.visit_rate}. ` +
        `Visits already on record are not changed.`
      : `No per-visit rate is armed by this — ${pr.number} is ` +
        `${(PROPOSAL_STATUS_LABEL[pr.status] || pr.status).toLowerCase()}` +
        `${pr.visit_rate ? "" : " with no per-visit fee"}. It records that the ` +
        `address match was checked and is right.`);
  if (!confirm(msg)) return;

  const { data, error } = await sb.from("proposals")
    .update({ link_confidence: "confirmed" }).eq("id", proposalId).select("id");
  if (error) return fail("Confirming the proposal link", error);
  if (!data || !data.length) {
    return toast("Nothing changed — that proposal is not yours to edit.", "warn");
  }
  toast(arms ? `Linked. $${pr.visit_rate}/visit is now the contracted rate.` : "Link confirmed.");
  await pdAfterLinkChange(projectId);
}

async function pdDropLink(proposalId, projectId) {
  const pr = pdProposalById(proposalId);
  if (!pr) return;
  if (!confirm(`Detach proposal ${pr.number} from this project?\n\n` +
      `The suggested match was made on address alone. Detaching leaves ${pr.number} ` +
      `on the register with no project, so nothing bills from it. The proposal ` +
      `itself is not deleted.`)) return;

  const { data, error } = await sb.from("proposals")
    .update({ project_id: null, link_confidence: null }).eq("id", proposalId).select("id");
  if (error) return fail("Detaching the proposal", error);
  if (!data || !data.length) {
    return toast("Nothing changed — that proposal is not yours to edit.", "warn");
  }
  toast(`${pr.number} is no longer linked to this job.`);
  await pdAfterLinkChange(projectId);
}

// The drawer holds the only copy of what it loaded, so re-read rather than
// patch it in place — and refresh the Proposals register if it is already
// loaded, or its table would still show the old confidence.
let pdProposals = [];
function pdProposalById(id) {
  return pdProposals.find((x) => x.id === id) ||
    proposals.find((x) => x.id === id) || null;
}
async function pdAfterLinkChange(projectId) {
  if (proposals.length) await loadProposals();
  await openProjectDrawer(projectId);
}

// Where a section heading count leads. Each target sets a filter the module
// itself keeps across renders, so it survives the tab's own reload.
function pdGo(key, projectId) {
  const id = String(projectId);
  closeProjectDrawer();
  if (key === "tasks") return goToProject(id);
  if (key === "time") {
    setHoursProjectFilter(id);
    showTab("hours");
    return;
  }
  if (key === "site visits") {
    setVisitProjectFilter(id);
    showTab("visits");
    return;
  }
  if (key === "letters") {
    setLetterProjectFilter(id);
    showTab("letters");
    return;
  }
  if (key === "proposal") {
    setProposalProjectFilter(id);
    showTab("proposals");
    return;
  }
  if (key === "drawing aids") {
    setDrawingProjectFilter(id);
    showTab("drawing");
  }
}

// ------------------------------------------------------------ quick actions
// Each one lands on a flow that is genuinely preselected. "Draft letter" is the
// exception and says so: a letter is composed FROM A SITE VISIT, not from a
// project, so it opens the visits log for this job — where the Letter button
// lives on each row — rather than pretending the composer can be opened on a
// project. It is admin-only, and simply not emitted for anyone else.
function pdRenderActions(d) {
  const p = d.project;
  const id = String(d.id);
  const acts = [
    ["task", "Add task", "Add a task on this project", false],
    ["time", "Log time", "Open the timer with this project already picked", false],
    ["visit", "Schedule visit", "Open the visit form with this project already picked", false],
  ];
  if (d.design) {
    acts.push(["letter", "Draft letter",
      d.visits.length
        ? "A letter is written from a site visit — opens this project's visits log, where each row has a Letter button"
        : "No site visit on this project yet. A letter is always written from a visit.",
      d.visits.length === 0]);
  }
  acts.push(["folder", "Open folder",
    p && p.folder
      ? `Copy the folder path — a browser cannot open Explorer:\n${p.folder}`
      : "No folder path on record for this project.",
    !(p && p.folder)]);

  $("pd-actions").innerHTML = acts.map(([k, label, title, off]) =>
    `<button type="button" data-pdact="${escapeHtml(k)}" title="${escapeHtml(title)}"${
      off ? " disabled" : ""}>${escapeHtml(label)}</button>`).join("");

  $("pd-actions").querySelectorAll("[data-pdact]").forEach((b) =>
    b.addEventListener("click", () => pdAct(b.dataset.pdact, id, p)));
}

function pdAct(what, id, p) {
  if (what === "folder") {
    if (!p || !p.folder) return;
    // A page served over http cannot navigate to file:// — the browser blocks
    // it silently. Handing over the path is the honest version.
    navigator.clipboard?.writeText(p.folder).then(
      () => toast("Folder path copied — paste it into Explorer."),
      () => toast(p.folder, "warn"));
    return;
  }
  closeProjectDrawer();
  if (what === "task") {
    setTodoProjectFilter(id);
    showTab("todo");
    setCombo("td-proj", id);
    renderTodo();
    $("td-title").focus();
    return;
  }
  if (what === "time") {
    showTab("time");
    setCombo("proj", id);
    $("notes").focus();
    return;
  }
  if (what === "visit") {
    setVisitProjectFilter(id);
    showTab("visits");
    setCombo("v-proj", id);
    $("v-date").focus();
    return;
  }
  if (what === "letter") {
    // The visits log, filtered to this project. See pdRenderActions.
    setVisitProjectFilter(id);
    showTab("visits");
  }
}

function closeProjectDrawer() {
  const drawer = $("proj-drawer");
  if (drawer.classList.contains("hidden")) return;
  pdToken++;                          // any load still in flight is now stale
  drawer.classList.add("hidden");
  $("pd-scrim").classList.add("hidden");
  const back = pdReturnFocus;
  pdReturnFocus = null;
  if (back && document.contains(back) && typeof back.focus === "function") {
    back.focus();
    // Coming back from a project opened out of the header search, focusing the
    // box re-fires its focus handler and the empty result list springs open
    // over the page. Put the caret back without the menu.
    if (back.id === "gs-q") gsClose();
  }
}

$("pd-close").addEventListener("click", closeProjectDrawer);
$("pd-scrim").addEventListener("click", closeProjectDrawer);
// Escape closes it. Harmless when it is shut — closeProjectDrawer returns
// immediately — so this cannot interfere with the form comboboxes, which are
// behind the scrim whenever the drawer is up.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeProjectDrawer();
});

// One listener for every project label in the app, present and future.
document.addEventListener("click", (e) => {
  const el = e.target.closest && e.target.closest("[data-projlink]");
  if (!el) return;
  e.preventDefault();
  openProjectDrawer(el.dataset.projlink);
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const el = e.target.closest && e.target.closest("[data-projlink]");
  if (!el) return;
  e.preventDefault();
  openProjectDrawer(el.dataset.projlink);
});

// ---------------------------------------------------- global project search
// The header's way in: a number, an address or a client, then the drawer. Same
// keyboard rules as the form comboboxes — arrows, Enter, Escape — but it is not
// a field: picking opens the drawer and clears the box. Nothing focuses it at
// boot, so it can never steal the caret on load.

const GS_MAX = 8;
const gs = { rows: [], hi: -1, open: false, needle: "", recent: false };

// "Recently opened", and it means exactly that — projects THIS BROWSER opened in
// the drawer, newest first. Not "recently worked on", which nothing records, and
// not "recently updated", which would need a query on every focus. Kept in
// localStorage beside the theme so it survives a reload.
const GS_RECENT_KEY = "hd-gs-recent";
const GS_RECENT_MAX = 5;
function gsRecentIds() {
  try {
    const v = JSON.parse(localStorage.getItem(GS_RECENT_KEY) || "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch { return []; }
}
function gsRemember(id) {
  const ids = [String(id), ...gsRecentIds().filter((x) => x !== String(id))]
    .slice(0, GS_RECENT_MAX);
  try { localStorage.setItem(GS_RECENT_KEY, JSON.stringify(ids)); } catch { /* private mode */ }
}
function gsRecentRows() {
  return gsRecentIds()
    .map((id) => projects.find((p) => String(p.id) === id))
    .filter(Boolean);
}

function gsMatches(q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const rank = { active: 0, on_hold: 1, closed: 3 };
  // Matching stays on the WIDE text — number, address and the whole client
  // field. Only the display is trimmed (see gsRender): a client string is
  // sometimes a paragraph of internal notes, and being able to find a job by a
  // name buried in it is worth keeping.
  return projects
    .filter((p) => `${p.number || ""} ${p.name} ${p.client || ""}`.toLowerCase().includes(needle))
    .sort((a, b) => ((rank[a.status] ?? 2) - (rank[b.status] ?? 2)) ||
      String(b.number || "").localeCompare(String(a.number || "")))
    .slice(0, GS_MAX);
}

// First occurrence only, escaped on both sides of the <mark>.
function gsMark(text, needle) {
  const s = String(text == null ? "" : text);
  if (!needle) return escapeHtml(s);
  const i = s.toLowerCase().indexOf(needle);
  if (i < 0) return escapeHtml(s);
  return escapeHtml(s.slice(0, i)) +
    `<mark>${escapeHtml(s.slice(i, i + needle.length))}</mark>` +
    escapeHtml(s.slice(i + needle.length));
}

// How much of a free-text field a result line may carry. Long enough to
// identify a client, far short of a paragraph.
const GS_CLIP = 48;

// A bounded window of a long field. If the match falls outside the opening
// window the window moves to it, so searching by a name buried in a note still
// shows you why the row came back — without carrying the note.
function gsSnippet(text, needle) {
  const s = String(text == null ? "" : text).trim();
  if (s.length <= GS_CLIP) return s;
  const i = needle ? s.toLowerCase().indexOf(needle) : -1;
  if (i < 0 || i + needle.length <= GS_CLIP - 1) {
    return s.slice(0, GS_CLIP - 1).trimEnd() + "…";
  }
  const start = Math.max(0, i - 12);
  return "…" + s.slice(start, start + GS_CLIP - 2).trimEnd() + "…";
}

// TWO LINES, and no more. A result is a picker entry: its job is to identify a
// project, not to narrate it. `projects.client` carries internal commercial
// notes on some jobs ("…this is his own house, and the fee is relationship
// pricing. Referred by…") and rendering that made one row four times the height
// of its neighbours and leaked the note into a picker. Line 1 is identity, line
// 2 is client + phase/status. The long field is cut HERE, not merely hidden by
// CSS overflow — text that is only visually clipped is still in the page, still
// selectable and still copied. CSS ellipsis stays on top of it for narrow
// widths. No title attribute either: a tooltip is still displaying it.
function gsRowHtml(p, i) {
  const n = gs.needle;
  const line1 = p.is_overhead
    ? gsMark(p.name, n)
    : `<span class="n">${gsMark(p.number || "", n)}</span>` +
      `<span class="sep"> — </span>${gsMark(p.name, n)}`;

  const bits = [];
  if (p.client) bits.push(`<span class="cl">${gsMark(gsSnippet(p.client, n), n)}</span>`);
  if (p.phase) bits.push(`<span class="cl">${escapeHtml(p.phase)}</span>`);
  if (p.status && p.status !== "active") {
    bits.push(`<span class="cl">${escapeHtml(String(p.status).replace(/_/g, " "))}</span>`);
  }
  const line2 = bits.join(`<span class="sep"> · </span>`);

  return `<div class="opt${i === gs.hi ? " on" : ""}" data-i="${i}" role="option"
       aria-selected="${i === gs.hi}"><div class="ln1">${line1}</div>${
    line2 ? `<div class="ln2">${line2}</div>` : ""}</div>`;
}

function gsRender() {
  const box = $("gs-list");
  if (!gs.rows.length) {
    box.innerHTML = `<div class="none">${$("gs-q").value.trim()
      ? "No project matches that." : "Type a number, an address or a client."}</div>`;
    return;
  }
  box.innerHTML = (gs.recent ? `<div class="grp">Recently opened</div>` : "") +
    gs.rows.map(gsRowHtml).join("");
  const on = box.querySelector(".opt.on");
  if (on) on.scrollIntoView({ block: "nearest" });
}

function gsOpen() {
  const q = $("gs-q").value;
  gs.needle = q.trim().toLowerCase();
  gs.rows = gs.needle ? gsMatches(q) : gsRecentRows();
  gs.recent = !gs.needle && gs.rows.length > 0;
  gsRender();
  $("gs-list").classList.remove("hidden");
  $("gs-q").setAttribute("aria-expanded", "true");
  gs.open = true;
}
function gsClose() {
  $("gs-list").classList.add("hidden");
  $("gs-q").setAttribute("aria-expanded", "false");
  gs.open = false;
  gs.hi = -1;
}
function gsChoose(i) {
  const p = gs.rows[i];
  if (!p) return;
  $("gs-q").value = "";
  gsClose();
  gsSheetClose();
  openProjectDrawer(p.id);
}

// ---- the phone sheet -------------------------------------------------------
// At phone width the field is replaced by an icon and the icon opens the SAME
// input, restyled by CSS into a full-screen sheet. The element never moves, so
// no listener below has to be re-attached and none can go out of step.
const gsPhone = () => window.matchMedia("(max-width: 620px)").matches;
const gsSheetIsOpen = () => document.documentElement.classList.contains("gs-sheet");

function gsSheetOpen() {
  document.documentElement.classList.add("gs-sheet");
  $("gs-toggle").setAttribute("aria-expanded", "true");
  $("gs-q").focus();
  gsOpen();
}
function gsSheetClose() {
  if (!gsSheetIsOpen()) return;
  document.documentElement.classList.remove("gs-sheet");
  $("gs-toggle").setAttribute("aria-expanded", "false");
  gsClose();
  if (document.activeElement === $("gs-q")) $("gs-q").blur();
}
// Focus the search from a keyboard shortcut, opening the sheet first if that is
// the shape it is currently in.
function gsFocus() {
  if (gsPhone() && !gsSheetIsOpen()) return gsSheetOpen();
  $("gs-q").focus();
  $("gs-q").select();
  gsOpen();
}

$("gs-toggle").addEventListener("click", () => {
  if (gsSheetIsOpen()) gsSheetClose(); else gsSheetOpen();
});
$("gs-sheet-close").addEventListener("click", gsSheetClose);
// Rotating a phone to a tablet width would leave the sheet class on an element
// the media query no longer restyles — a search box pinned invisibly over the
// page. Drop it as soon as the breakpoint stops applying.
window.addEventListener("resize", () => { if (!gsPhone()) gsSheetClose(); });

$("gs-q").addEventListener("input", () => {
  const q = $("gs-q").value;
  gs.needle = q.trim().toLowerCase();
  gs.rows = gs.needle ? gsMatches(q) : gsRecentRows();
  gs.recent = !gs.needle && gs.rows.length > 0;
  // Never pre-highlight the recents list: Enter on a box you have just emptied
  // must not open whatever you happened to look at last.
  gs.hi = gs.needle && gs.rows.length ? 0 : -1;
  if (!gs.open) gsOpen(); else gsRender();
});
$("gs-q").addEventListener("focus", gsOpen);
// Clicking a box that ALREADY has the caret fires no focus event, so without
// this the list stays shut — which is exactly what happens coming back from a
// drawer that was opened out of the search and handed focus back.
$("gs-q").addEventListener("click", gsOpen);
$("gs-q").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!gs.open) return gsOpen();
    gs.hi = Math.max(0, Math.min(gs.rows.length - 1, gs.hi + (e.key === "ArrowDown" ? 1 : -1)));
    gsRender();
  } else if (e.key === "Enter") {
    if (gs.open && gs.hi >= 0) { e.preventDefault(); gsChoose(gs.hi); }
  } else if (e.key === "Escape") {
    // The ladder: the results close first, then the sheet (on a phone), then
    // the drawer. Each Escape does exactly one of them — consuming the event is
    // what stops the document-level handler closing the drawer at the same time.
    if (gs.open) { e.preventDefault(); e.stopPropagation(); gsClose(); }
    else if (gsSheetIsOpen()) { e.preventDefault(); e.stopPropagation(); gsSheetClose(); }
  }
});
$("gs-q").addEventListener("blur", () => setTimeout(() => {
  // In sheet mode the list IS the sheet's content; hiding it on blur would
  // leave a full-screen blank.
  if (!gsSheetIsOpen()) gsClose();
}, 120));
$("gs-list").addEventListener("mousedown", (e) => {
  const opt = e.target.closest(".opt");
  if (!opt) return;
  e.preventDefault();                 // keep focus so blur cannot undo the pick
  gsChoose(Number(opt.dataset.i));
});

// Ctrl/Cmd+K anywhere, and "/" when you are not typing into something. The
// second guard is the whole point: "/" is a legitimate character in a task
// title, a note, a visit type and an address, so it must only be a shortcut
// when no field has the caret.
document.addEventListener("keydown", (e) => {
  if ($("app").classList.contains("hidden")) return;      // still on the login screen
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    return gsFocus();
  }
  if (e.key === "/" && !mod && !e.altKey) {
    const el = document.activeElement;
    const tag = el && el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
        (el && el.isContentEditable)) return;
    e.preventDefault();
    gsFocus();
  }
});

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
  if (t.project_id) bits.push(projLink(t.project_id));
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
  // The project name needs no wiring: projLink() rides the app-wide delegated
  // listener, so it survives every re-render of this list.
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

// Point a project filter <select> at a project, adding the option if the module
// has no rows for it yet. Shared by every "open this module, filtered to this
// job" path so they cannot drift apart.
function pickProjectOption(sel, projectId) {
  const id = String(projectId);
  if (![...sel.options].some((o) => o.value === id)) {
    sel.insertAdjacentHTML("beforeend",
      `<option value="${escapeHtml(id)}">${escapeHtml(labelFor(id))}</option>`);
  }
  sel.value = id;
}
function setTodoProjectFilter(id) {
  pickProjectOption($("td-filter-proj"), id);
  todoBucketFilter = "";
}

// Filter the to-do list to a project and show it. Called from anywhere a
// project name appears, so a name on screen is a way in rather than a label.
function goToProject(projectId) {
  setTodoProjectFilter(projectId);
  showTab("todo");
  renderTodo();
}

function renderTodoProjectFilter() {
  const sel = $("td-filter-proj");
  const keep = sel.value;
  const ids = [...new Set(tasks.map((t) => t.project_id).filter(Boolean))].map(String);
  // A filter set from the project drawer has to survive this rebuild even when
  // the job has no tasks — otherwise "filtered to that project" silently becomes
  // "all projects" the moment the tab reloads.
  if (keep && !ids.includes(keep)) ids.push(keep);
  ids.sort((a, b) => labelFor(a).localeCompare(labelFor(b)));
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

// Capped, with the rest a click away. Uncapped this ran about thirty rows and
// several thousand pixels, which pushed everything else on the page below the
// fold. The list itself — what is in it and the order it is in — is unchanged.
//
// The cap is responsive because the fold is: ten rows is a third of a desktop
// screen and three phone screens. Breakpoints match the CSS (620 phone, 900 is
// where .two-col collapses).
function ovAttentionMax() {
  const w = window.innerWidth;
  if (w <= 620) return 3;
  if (w <= 900) return 5;
  return 10;
}

// The last list rendered, so a resize can redraw at the new cap without going
// back to the database. Nothing here is an input, so redrawing it cannot eat
// anything half-typed.
let ovLastOpen = [];
let ovResizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(ovResizeTimer);
  ovResizeTimer = setTimeout(() => {
    if ($("panel-overview").classList.contains("hidden")) return;
    if (!ovLastOpen.length) return;
    renderOvAttention(ovLastOpen);
  }, 150);
});

function renderOvAttention(open) {
  ovLastOpen = open;
  const OV_ATTENTION_MAX = ovAttentionMax();
  const rank = { overdue: 0, today: 1, this_week: 2 };
  const all = open.filter((t) => bucketOf(t) in rank)
    .sort((a, b) => (rank[bucketOf(a)] - rank[bucketOf(b)]) ||
                    ((daysLeft(a) ?? 0) - (daysLeft(b) ?? 0)));
  const rows = all.slice(0, OV_ATTENTION_MAX);
  $("ov-att-count").textContent = all.length ? `— ${all.length}` : "";
  $("ov-attention-empty").classList.toggle("hidden", all.length > 0);
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
    </tr>`).join("") +
    (all.length > rows.length ? `
    <tr><td></td>
      <td class="right"><a data-ovall style="color:var(--teal-lt);cursor:pointer"
        >View all ${all.length} &rarr;</a></td></tr>` : "");

  $("ov-attention").querySelectorAll("[data-ovdone]").forEach((c) =>
    c.addEventListener("change", () => saveTask(c.dataset.ovdone,
      { status: "done", completed_at: new Date().toISOString() })));
  $("ov-attention").querySelectorAll("[data-goproj]").forEach((a) =>
    a.addEventListener("click", () => goToProject(a.dataset.goproj)));
  // The rest of the list lives on the To do tab, unfiltered — the same place
  // the tiles lead to.
  const more = $("ov-attention").querySelector("[data-ovall]");
  if (more) {
    more.addEventListener("click", () => {
      todoBucketFilter = "";
      $("td-filter-proj").value = "";
      showTab("todo");
      renderTodo();
    });
  }
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
// Read by personRows AND personVisits, so every panel on the tab — the stats,
// the per-person card, Effort by project, additional services, the visit
// worksheet and the margin table — agrees about which job is on screen.
function hoursProjFilter() {
  const sel = $("h-proj");
  return sel ? sel.value : "";
}
function personRows() {
  const who = whoFilter();
  const proj = hoursProjFilter();
  return hoursRows.filter((r) =>
    (!who || r.employee_id === who) &&
    (!proj || String(r.project_id) === proj));
}
function personVisits() {
  const who = whoFilter();
  const proj = hoursProjFilter();
  const p = who ? personById(who) : null;
  const name = (p && p.full_name || "").toLowerCase();
  // attendee_id is null on the imported history, which is most of it, so fall
  // back to the name the log recorded.
  return hoursVisits.filter((v) =>
    (!proj || String(v.project_id) === proj) &&
    (!who || v.attendee_id === who || (v.attendee_name || "").toLowerCase() === name));
}

function setHoursProjectFilter(id) { pickProjectOption($("h-proj"), id); }

function renderHoursProjectFilter() {
  const sel = $("h-proj");
  const keep = sel.value;
  const ids = [...new Set([
    ...hoursRows.map((r) => r.project_id),
    ...hoursVisits.map((v) => v.project_id),
  ].filter(Boolean).map(String))];
  if (keep && !ids.includes(keep)) ids.push(keep);   // see renderTodoProjectFilter
  ids.sort((a, b) => labelFor(a).localeCompare(labelFor(b)));
  sel.innerHTML = `<option value="">All projects</option>` +
    ids.map((id) => `<option value="${id}">${escapeHtml(labelFor(id))}</option>`).join("");
  if (keep) sel.value = keep;
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
  renderHoursProjectFilter();
  const proj = hoursProjFilter();
  $("hrs-scope").textContent = (me.role === "admin" ? "· firm-wide" : "· your hours only") +
    (proj ? ` · ${labelFor(proj)} only` : "");
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
      <td>${projLink(pid)}</td>
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

  // A PROJECT filter is not the person trap above: fee against effort stays a
  // whole-project question, and narrowing to one project still asks it.
  const onlyProj = hoursProjFilter();
  const byProject = {};
  for (const r of hoursRows) {
    if (onlyProj && String(r.project_id) !== onlyProj) continue;
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
  // Re-render, not re-fetch: the range's rows are already loaded.
  $("h-proj").addEventListener("change", renderHours);
  $("person-target").addEventListener("input", () => renderPersonDays(
    coverage(personRows(), hoursRange().from, hoursRange().to)));
}

// ----------------------------------------------------------- proposals

// Registry enums are storage values; the page shows English.
const PROPOSAL_STATUS_LABEL = {
  for_review: "For review", sent: "Sent", signed: "Signed", archive: "Archive",
};

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

function setProposalProjectFilter(id) { pickProjectOption($("prop-filter-proj"), id); }

function renderProposalProjectFilter() {
  const sel = $("prop-filter-proj");
  const keep = sel.value;
  const ids = [...new Set(proposals.map((p) => p.project_id).filter(Boolean).map(String))];
  if (keep && !ids.includes(keep)) ids.push(keep);   // see renderTodoProjectFilter
  ids.sort((a, b) => labelFor(a).localeCompare(labelFor(b)));
  sel.innerHTML = `<option value="">Any project</option>` +
    ids.map((id) => `<option value="${id}">${escapeHtml(labelFor(id))}</option>`).join("");
  if (keep) sel.value = keep;
}

function visibleProposals() {
  const st = $("prop-filter-status").value;
  const q = $("prop-search").value.trim().toLowerCase();
  const proj = $("prop-filter-proj").value;
  return proposals.filter((p) =>
    (!st || p.status === st) &&
    (!proj || String(p.project_id) === proj) &&
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
  renderProposalProjectFilter();
  const rows = visibleProposals();
  const body = $("prop-body");
  body.innerHTML = "";
  $("prop-empty").classList.toggle("hidden", rows.length > 0);
  $("prop-table").classList.toggle("hidden", rows.length === 0);

  for (const p of rows.slice(0, 400)) {
    const link = p.project_id
      // A merely address-matched link is marked, because billing off an
      // unverified link is how a fee lands on the wrong job.
      ? `${projLink(p.project_id)}${
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
            >${escapeHtml(PROPOSAL_STATUS_LABEL[p.status] || p.status)}</span></td>
      <td class="num">${p.design_fee ? "$" + Number(p.design_fee).toLocaleString() : ""}</td>
      <td class="num">${p.visit_rate ? "$" + p.visit_rate : ""}</td>
      <td class="small">${link}</td>`;
    body.appendChild(tr);
  }
}

$("prop-filter-status").addEventListener("change", renderProposals);
$("prop-filter-proj").addEventListener("change", renderProposals);
$("prop-search").addEventListener("input", renderProposals);

// --------------------------------------------------------- site visits

let visits = [];

// Stored values stay pending/passed/failed/na (a CHECK constraint), but the
// wording does not: "Passed" and "Failed" imply a certification an
// observation visit does not carry. This applies to the STAT TILES too —
// they said Passed/Failed for a month under this very comment.
const OUTCOME_LABEL = {
  pending: "Not yet reported", passed: "No corrections noted",
  failed: "Corrections required", na: "Informational / n/a",
};
// The same four outcomes, short enough for the inline <select> in the history
// table — which is about 130px wide and was rendering "No correctior…". The
// STORED values are untouched (a CHECK constraint owns them), and every place a
// visit outcome reaches a person outside this table — the project hub, the stat
// tiles, the add-visit form, anything that ends up in correspondence — keeps the
// full OUTCOME_LABEL wording.
const OUTCOME_SHORT = {
  pending: "Not reported", passed: "No corrections",
  failed: "Corrections", na: "Informational",
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
  }
  // Letters are a designer surface, not a billing one. They were loaded inside
  // the admin block only because admin used to be the only way to reach them,
  // which left a designer's visits log with no Letter button.
  if (canDesign()) await loadLetters();
  // Two classes, two audiences. The Letter column used to share `admin-only-col`
  // with the RATE column, so a designer's visits log had no Letter button — the
  // one place a letter is composed from. Rate is money and stays admin.
  document.querySelectorAll(".admin-only-col").forEach((n) =>
    n.classList.toggle("hidden", !isAdmin()));
  document.querySelectorAll(".designer-only-col").forEach((n) =>
    n.classList.toggle("hidden", !canDesign()));

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

function setVisitProjectFilter(id) { pickProjectOption($("v-filter-proj"), id); }

function renderVisitFilters() {
  const sel = $("v-filter-proj");
  const keep = sel.value;
  const ids = [...new Set(visits.map((v) => String(v.project_id)))];
  if (keep && !ids.includes(keep)) ids.push(keep);   // see renderTodoProjectFilter
  ids.sort((a, b) => labelFor(a).localeCompare(labelFor(b)));
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
    <div class="stat pass"><div class="n">${passed}</div><div class="k">No corrections</div></div>
    <div class="stat fail"><div class="n">${failed}</div><div class="k">Corrections noted</div></div>
    ${unbooked ? `<div class="stat"><div class="n">${unbooked}</div>
        <div class="k">Not on calendar</div></div>` : ""}`;
}

function renderVisits() {
  const rows = visibleVisits();
  const body = $("visits-body");
  body.innerHTML = "";
  // Same honesty rule as the letters board: with a filter on, "none recorded"
  // is a claim about the firm that the filtered view cannot support.
  const onlyProj = $("v-filter-proj").value;
  $("visits-empty").textContent = onlyProj
    ? `No site visits recorded on ${labelFor(onlyProj)}.`
    : "No site visits recorded.";
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
    // canDesign(), not admin: showing the COLUMN without the BUTTON in it gives
    // a designer a visible, permanently empty cell — worse than hiding it,
    // because it looks like the job has no letter rather than like they cannot
    // start one.
    const letterCell = canDesign()
      // Labelled with the status once a letter exists, which reads as a badge
      // rather than a control — the title says out loud that it opens.
      ? `<button class="btn ghost sm" data-vletter="${v.id}"${
          ltColor ? ` style="color:${ltColor};border-color:${ltColor}"` : ""} title="${
          lt ? "Open this letter in the composer to review or change it."
             : "Compose a letter from this visit."}">${
          lt ? escapeHtml(LETTER_STATUS_LABEL[lt.status] || lt.status) : "Letter…"}</button>`
      : "";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${when}<div class="small muted">${escapeHtml(time)}</div></td>
      <td>${projLink(v.project_id)}</td>
      <td>${escapeHtml(v.visit_type)}${
        v.notes ? `<div class="small muted">${escapeHtml(v.notes)}</div>` : ""}</td>
      <td class="small">${escapeHtml(v.attendee_name)}</td>
      <td><select data-outcome="${v.id}" style="padding:3px 6px;font-size:13px"
                  title="${escapeHtml(OUTCOME_LABEL[v.outcome] || v.outcome)}">
            ${Object.entries(OUTCOME_SHORT).map(([k, l]) =>
              `<option value="${k}"${k === v.outcome ? " selected" : ""} title="${
                escapeHtml(OUTCOME_LABEL[k])}">${escapeHtml(l)}</option>`).join("")}
          </select></td>
      <td class="num small">${travel}</td>
      <td class="num small admin-only-col${me.role === "admin" ? "" : " hidden"}">${rate}</td>
      <td class="designer-only-col${canDesign() ? "" : " hidden"}">${letterCell}</td>
      <td>${cal}</td>
      <td class="right"><button class="btn ghost sm" data-vdel="${v.id}">Delete</button></td>`;
    body.appendChild(tr);
  }

  body.querySelectorAll("[data-outcome]").forEach((s) =>
    s.addEventListener("change", () => saveVisit(s.dataset.outcome, { outcome: s.value })));
  body.querySelectorAll("[data-vdel]").forEach((b) =>
    b.addEventListener("click", () => deleteVisit(b.dataset.vdel)));
  body.querySelectorAll("[data-vletter]").forEach((b) =>
    b.addEventListener("click", () => {
      // The composer lives in the Letters tab now; the button here is the
      // entry point Ben asked to keep under observations.
      showTab("letters");
      openLetterComposer(Number(b.dataset.vletter));
    }));
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
// machine (kept alive by the HD Letter Watcher task) builds the spec for the
// checked observation scopes, renders it through the firmprint kit WITH Ben's
// stamp and signature, drops it in 009_letters\1 - For Review, and writes
// status/paths back onto the row. Admin-only end to end (RLS).

// The composer's checkboxes — mirror tools/letter-templates.mjs SCOPES.
// Piers is deliberately separate from trenching/excavations, and the framing
// family carries all three variations of the old letter menu (Ben, 8/24).
// Each scope's items are the sub-checkboxes whose checked subset the letter's
// sentence enumerates.
// `core` is pre-checked when a category is selected; the rest of the library
// sits unchecked — a letter must never silently attest to something nobody
// looked at (welds, vapor retarder, ...). Mirror of tools/letter-templates.mjs.
const LETTER_SCOPES = {
  foundation: { label: "Foundation pre-pour",
    core: ["rebar mat placement", "reinforcing bar size and spacing",
      "beam widths and depths", "slab thickness", "reinforcing steel location and cover"],
    items: ["rebar mat placement", "reinforcing bar size and spacing",
      "beam widths and depths", "slab thickness", "beam reinforcement",
      "slab reinforcement", "reinforcing steel location and cover",
      "laps and development", "anchor bolts and embeds", "void boxes",
      "vapor retarder", "plumbing penetrations and blockouts"] },
  trenching: { label: "Trenching / excavations",
    core: ["grade beam widths", "grade beam depths", "bearing conditions"],
    items: ["grade beam widths", "grade beam depths", "bearing conditions"] },
  piers: { label: "Piers",
    core: ["pier depths", "pier diameters", "pier reinforcement"],
    items: ["pier depths", "pier diameters", "pier reinforcement",
      "pier locations", "bearing conditions", "reinforcing cage placement",
      "pier cap reinforcement", "embedment into bearing material"] },
  pool: { label: "Pool shell",
    core: ["rebar mat placement", "reinforcing bar size and spacing",
      "shell thickness", "beam width and depth", "rebar cover"],
    items: ["rebar mat placement", "reinforcing bar size and spacing",
      "shell thickness", "beam width and depth", "wall reinforcement",
      "floor reinforcement", "bond beam reinforcement", "double-mat spacing",
      "steps and benches", "reinforcing around penetrations",
      "skimmer box reinforcement", "rebar cover", "pier depth and reinforcement"] },
  framing: { label: "Wood framing",
    core: ["wall framing", "floor joists and floor framing",
      "roof rafters and roof framing", "headers and beams", "blocking"],
    items: ["wall framing", "floor joists and floor framing",
      "roof rafters and roof framing", "ceiling framing", "headers and beams",
      "posts and columns", "bearing conditions", "blocking",
      "joist and beam hangers", "straps and ties", "holdowns", "anchor bolts",
      "framing around openings", "field modifications, notches and holes"] },
  steel: { label: "Steel framing",
    core: ["structural steel members", "member sizes and locations",
      "bolted connections", "base plates", "anchor rods"],
    items: ["structural steel members", "member sizes and locations",
      "welded connections", "bolted connections", "base plates", "anchor rods",
      "beam bearing", "steel-to-wood connections", "steel-to-concrete connections",
      "bracing", "metal deck", "deck attachment", "field modifications"] },
  sheathing: { label: "Sheathing / lateral framing",
    core: ["wall sheathing", "roof sheathing", "nailing size and spacing"],
    items: ["wall sheathing", "roof sheathing", "floor sheathing",
      "nailing size and spacing", "panel edge blocking", "shear wall nailing",
      "diaphragm nailing", "holdowns", "straps and collectors",
      "lateral load-path connections"] },
  masonry: { label: "Masonry",
    core: ["wall reinforcement", "grout placement", "bond beams", "lintels"],
    items: ["wall reinforcement", "grout placement", "bond beams", "lintels",
      "foundation dowels", "wall anchors", "wall-to-roof connections"] },
  retaining: { label: "Retaining walls",
    core: ["footing dimensions", "footing reinforcement", "stem reinforcement",
      "wall thickness"],
    items: ["footing dimensions", "footing reinforcement", "stem reinforcement",
      "wall thickness", "dowels", "drainage provisions", "waterproofing", "backfill"] },
  repairs: { label: "Post-installed anchors / repairs",
    core: ["epoxy anchors", "mechanical anchors", "dowels"],
    items: ["epoxy anchors", "mechanical anchors", "dowels", "added framing",
      "sistered members", "repair plates", "field welds", "corrective work"] },
  existing: { label: "Existing conditions",
    core: ["existing framing", "existing foundation", "cracking", "movement"],
    items: ["existing framing", "existing foundation", "cracking", "movement",
      "deterioration", "field measurements", "concealed conditions",
      "previous modifications"] },
};

// DB status 'issued' displays as "sent" — Ben's word for it. The Sent button
// sets it, and the office machine then moves the file to 2 - Sent itself.
const LETTER_STATUS_LABEL = {
  queued: "queued", working: "rendering…", draft: "draft ready",
  error: "error", issued: "sent",
};

// Prepopulation from the visit's own wording — a prefill, never a decision.
// The specific pre-pour scopes (piers/pool/trenching) win over the generic
// foundation guess, so "Pre-pour observation (piers)" checks only Piers.
function guessScopes(v) {
  const t = `${v.visit_type || ""} ${v.notes || ""}`.toLowerCase();
  const s = new Set();
  if (/trench|excavat|grade beam/.test(t)) s.add("trenching");
  if (/pier/.test(t)) s.add("piers");
  if (/pool|gunite|shotcrete/.test(t)) s.add("pool");
  if (/sheathing|nailing|shear wall/.test(t)) s.add("sheathing");
  if (/steel/.test(t)) s.add("steel");
  else if (/framing|joist|ledger|deck/.test(t)) s.add("framing");
  if (/masonry|cmu|block wall/.test(t)) s.add("masonry");
  if (/retaining/.test(t)) s.add("retaining");
  if (/repair|epoxy|anchor|sister/.test(t)) s.add("repairs");
  if (/existing|assessment|evaluation|walkthrough/.test(t)) s.add("existing");
  if (!s.size && /pour|foundation|slab|rebar/.test(t)) s.add("foundation");
  return [...s];
}

let letters = [];          // admin only; RLS returns nothing for anyone else
let lettersByVisit = {};   // visit_id -> latest letter for that visit
let letterVisitId = null;  // visit the composer is open on, or null

async function loadLetters() {
  if (!canDesign()) return; // RLS denies it anyway; don't even ask
  const { data, error } = await sb
    .from("letters")
    .select(`id, project_id, site_visit_id, letter_type, scopes, scope_items,
             performed_by, status, messages, spec_path, output_path, pages,
             error, created_at, updated_at`)
    .order("id", { ascending: true });
  if (error) return fail("Loading letters", error);
  letters = data || [];
  lettersByVisit = {};
  for (const l of letters)
    if (l.site_visit_id != null) lettersByVisit[l.site_visit_id] = l;
}

// What a letter covers, for the board and the composer.
function letterScopeLabel(lt) {
  const s = Array.isArray(lt.scopes) ? lt.scopes : [];
  if (!s.length) return "General letter";
  return s.map((k) => LETTER_SCOPES[k]?.label || k).join(" + ");
}

function loadLettersTab() {
  if (!canDesign()) return;
  // The composer resolves its visit out of `visits`, which was only ever
  // filled by the Site visits tab. Landing here first and opening a letter
  // therefore found an empty array, closed the composer and made the button
  // look dead. loadVisits() also loads letters for an admin, so one call
  // covers this board and the composer both.
  loadVisits().then(() => {
    renderLetterBoard(); renderLetterStatus(); syncLetterPoll();
    applyLetterComposerMin(); // restore the saved collapsed state on arrival
  });
}

// The board is fetch-on-open: nothing here subscribes, so a letter queued
// while this tab is open reads "queued" forever even after the runner has
// rendered and stamped it. Poll only while something is actually in flight,
// and stop the moment nothing is — an idle tab must not talk to the network.
let letterPollTimer = null;
const LETTER_POLL_MS = 4000;

function lettersInFlight() {
  return letters.some((l) => l.status === "queued" || l.status === "working");
}

function stopLetterPoll() {
  if (letterPollTimer) { clearInterval(letterPollTimer); letterPollTimer = null; }
}

function syncLetterPoll() {
  const onTab = !$("panel-letters").classList.contains("hidden");
  if (!onTab || !canDesign() || !lettersInFlight()) return stopLetterPoll();
  if (letterPollTimer) return; // already running
  letterPollTimer = setInterval(async () => {
    // Re-check the tab each tick: showTab stops the poll, but a stray timer
    // must never repaint a hidden panel.
    if ($("panel-letters").classList.contains("hidden")) return stopLetterPoll();
    await loadLetters();
    renderLetterBoard();
    // renderLetterStatus ONLY — it is the documented safe partial refresh.
    // Never call renderLetterComposer/openLetterComposer from here: they
    // rebuild the scope checkboxes and scroll the card into view, so on a
    // timer they would eat half-made selections every tick (see the week-grid
    // postmortem in the README).
    renderLetterStatus();
    if (!lettersInFlight()) stopLetterPoll();
  }, LETTER_POLL_MS);
}

// Static control: attached once, never inside a render.
$("lt-filter-proj").addEventListener("change", renderLetterBoard);

function setLetterProjectFilter(id) { pickProjectOption($("lt-filter-proj"), id); }

function renderLetterProjectFilter() {
  const sel = $("lt-filter-proj");
  const keep = sel.value;
  const ids = [...new Set(letters.map((l) => String(l.project_id)).filter((x) => x && x !== "null"))];
  if (keep && !ids.includes(keep)) ids.push(keep);   // see renderTodoProjectFilter
  ids.sort((a, b) => labelFor(a).localeCompare(labelFor(b)));
  sel.innerHTML = `<option value="">All projects</option>` +
    ids.map((id) => `<option value="${id}">${escapeHtml(labelFor(id))}</option>`).join("");
  if (keep) sel.value = keep;
}

// The only ways into the composer used to be the scope text on this board and
// a button on the visits log labelled with the letter's STATUS — both read as
// labels, not actions, so "change this letter" had no visible door. This is
// that door. Issued is terminal, so there it opens the composer to start a
// NEW revision rather than to edit the sealed record.
function reviseButtonHtml(lt) {
  if (lt.site_visit_id == null) {
    return `<button class="btn ghost sm" disabled
      title="This letter is not attached to a site visit, so the composer cannot open on it.">Revise</button> `;
  }
  const issued = lt.status === "issued";
  return `<button class="btn ghost sm" data-ltopen="${lt.site_visit_id}" title="${
    issued
      ? "This letter was issued. Opens the composer to queue a NEW revision — the sealed record stays."
      : "Open the composer to change this letter and regenerate the PDF."
  }">${issued ? "New revision" : "Revise"}</button> `;
}

function renderLetterBoard() {
  const body = $("letters-body");
  renderLetterProjectFilter();
  const only = $("lt-filter-proj").value;
  const all = [...letters].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  const rows = only ? all.filter((l) => String(l.project_id) === only) : all;
  $("lt-count").textContent = all.length
    ? (rows.length === all.length ? `· ${all.length} on record` : `· ${rows.length} of ${all.length}`)
    : "";
  // "No letters yet" is a different claim from "none on this job" — and with a
  // filter on, the first one is false.
  $("letters-empty").textContent = only
    ? `No letters on ${labelFor(only)}.`
    : "No letters yet — use the Letter column in the Site visits log.";
  $("letters-empty").classList.toggle("hidden", rows.length > 0);
  $("letters-table").classList.toggle("hidden", rows.length === 0);
  body.innerHTML = "";
  for (const lt of rows) {
    const file = lt.output_path
      ? `<span class="small" title="${escapeHtml(lt.output_path)}">${
          escapeHtml(lt.output_path.split("\\").pop())}</span>`
      : `<span class="muted">—</span>`;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="small">${escapeHtml(fmtWhen(lt.updated_at))}</td>
      <td>${projLink(lt.project_id)}</td>
      <td><button class="btn ghost sm" data-ltopen="${lt.site_visit_id ?? ""}">${
        escapeHtml(letterScopeLabel(lt))}</button></td>
      <td class="small">${escapeHtml(lt.performed_by || "")}</td>
      <td>${letterStatusHtml(lt)}</td>
      <td class="num small">${lt.pages ?? ""}</td>
      <td>${file}</td>
      <td class="right">${
        lt.status === "draft" && isAdmin()
          ? `<button class="btn ghost sm" data-ltsent="${lt.id}"
               title="Mark this letter sent. Only after it has actually gone to the client — the file moves to 2 - Sent and this is final.">Sent</button> `
          : ""
      }${reviseButtonHtml(lt)}<button class="btn ghost sm" data-ltdel="${
        lt.id}">Delete</button></td>`;
    body.appendChild(tr);
  }
  body.querySelectorAll("[data-ltopen]").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.dataset.ltopen) openLetterComposer(Number(b.dataset.ltopen));
    }));
  body.querySelectorAll("[data-ltsent]").forEach((b) =>
    b.addEventListener("click", () => markLetterIssued(Number(b.dataset.ltsent), { confirmFirst: true })));
  body.querySelectorAll("[data-ltdel]").forEach((b) =>
    b.addEventListener("click", () => deleteLetter(Number(b.dataset.ltdel))));
}

// Deleting removes the RECORD. Files already rendered on the office machine
// stay on disk — the app cannot and must not delete inside the Dropbox tree.
async function deleteLetter(id) {
  const lt = letters.find((x) => x.id === id);
  if (!lt) return;
  let msg = `Delete this ${letterScopeLabel(lt).toLowerCase()} letter record (${
    labelFor(lt.project_id)})? This cannot be undone.`;
  if (lt.status === "working") {
    msg += `\n\nIt is rendering RIGHT NOW — the render will finish but nothing will record it.`;
  }
  if (lt.status === "issued") {
    msg += `\n\nIt is marked ISSUED — deleting erases the record that it was sent.`;
  }
  if (lt.output_path) {
    msg += `\n\nThe rendered file stays on disk:\n${lt.output_path}`;
  }
  if (!confirm(msg)) return;
  const { data, error } = await sb.from("letters").delete().eq("id", id).select("id");
  if (error) return fail("Deleting the letter", error);
  if (!data || !data.length) return toast("Nothing was deleted.", "warn");
  await loadLetters();
  renderLetterBoard();
  renderVisits();
  // Close the composer only if it was showing the deleted letter's visit —
  // a full re-render on an unrelated delete would eat half-made selections.
  if (letterVisitId === lt.site_visit_id) {
    letterVisitId = null;
    renderLetterComposer();
  }
  toast("Letter deleted.");
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

// The composer is tall and sits under the board, so it pushes the letter list
// off screen once you are only reading. Minimizing collapses the body and
// keeps the header, and the choice survives a reload.
const LT_MIN_KEY = "hd-letters-composer-min";
let letterComposerMin = (() => {
  try { return localStorage.getItem(LT_MIN_KEY) === "1"; } catch { return false; }
})();

function applyLetterComposerMin() {
  $("lt-body").classList.toggle("hidden", letterComposerMin);
  $("lt-min").textContent = letterComposerMin ? "Show" : "Minimize";
  // Minimized, the header is the only thing left, so say what is behind it —
  // otherwise a queued letter is collapsed out of sight with no trace.
  if (letterComposerMin && letterVisitId != null) {
    const v = visits.find((x) => x.id === letterVisitId);
    const lt = lettersByVisit[letterVisitId] || null;
    $("lt-scope").textContent = v
      ? `— ${labelFor(v.project_id)}${lt ? ` · ${LETTER_STATUS_LABEL[lt.status] || lt.status}` : ""}`
      : "";
  } else if (letterComposerMin) {
    $("lt-scope").textContent = "";
  }
}

function setLetterComposerMin(min) {
  letterComposerMin = min;
  try { localStorage.setItem(LT_MIN_KEY, min ? "1" : "0"); } catch { /* private mode */ }
  applyLetterComposerMin();
}

$("lt-min").addEventListener("click", () => setLetterComposerMin(!letterComposerMin));

async function openLetterComposer(visitId) {
  // Never fail silently. renderLetterComposer resolves the visit out of
  // `visits` and closes itself when it cannot find one, so a click on a
  // letter whose visit is not loaded looked like a dead button. Fetch and
  // retry once; if it still is not there, say so rather than do nothing.
  if (!visits.some((x) => x.id === visitId)) {
    await loadVisits();
    if (!visits.some((x) => x.id === visitId)) {
      return toast("That letter's site visit could not be loaded, so the composer cannot open on it.", "err");
    }
  }
  // Opening a letter always expands. A collapsed composer would swallow the
  // click exactly like the unloaded-visits bug did — the row would highlight
  // and nothing would appear.
  if (letterComposerMin) setLetterComposerMin(false);
  // Switching visits clears the edits box: half-typed instructions for one
  // letter must never ride along and get appended to a different one. Same
  // visit keeps the draft text (background refreshes never touch it).
  if (letterVisitId !== visitId) $("lt-msg").value = "";
  letterVisitId = visitId;
  renderLetterComposer();
  $("letter-card").scrollIntoView({ behavior: "smooth", block: "start" });
}

// Fill the checkboxes and the Performed-by dropdown. Only the full composer
// render calls this — background refreshes must never reset a half-made
// selection.
function syncComposerInputs(lt, v) {
  const want = new Set(lt && Array.isArray(lt.scopes) && lt.scopes.length
    ? lt.scopes : guessScopes(v));
  // A stored scope this build doesn't know must still display honestly.
  const keys = [...new Set([...Object.keys(LETTER_SCOPES), ...want])];
  const stored = (lt && lt.scope_items && typeof lt.scope_items === "object") ? lt.scope_items : {};
  $("lt-scopes").innerHTML = keys.map((k) => {
    const cfg = LETTER_SCOPES[k] || { label: k, items: [], core: [] };
    const on = want.has(k);
    // Core items default checked; extended library items must be chosen on
    // purpose. A stored subset restores exactly.
    const picked = new Set(Array.isArray(stored[k]) && stored[k].length ? stored[k] : cfg.core);
    return `
    <div>
      <label><input type="checkbox" data-ltscope="${escapeHtml(k)}"${
        on ? " checked" : ""}> <b>${escapeHtml(cfg.label)}</b></label>
      ${cfg.items.length ? `<div class="lt-items${on ? "" : " hidden"}" data-ltitems="${escapeHtml(k)}">
        ${cfg.items.map((i) => `<label><input type="checkbox" data-ltitem="${escapeHtml(k)}"
          value="${escapeHtml(i)}"${picked.has(i) ? " checked" : ""}> ${escapeHtml(i)}</label>`).join("")}
      </div>` : ""}
    </div>`;
  }).join("");
  // Checking a scope reveals its items; unchecking hides them (state kept).
  document.querySelectorAll("#lt-scopes [data-ltscope]").forEach((c) =>
    c.addEventListener("change", () => {
      const items = document.querySelector(`#lt-scopes [data-ltitems="${c.dataset.ltscope}"]`);
      if (items) items.classList.toggle("hidden", !c.checked);
    }));

  // Performed by: the roster, plus whatever name the visit or the letter
  // already carries (historical imports have attendees who are not users).
  const names = [...new Set([
    ...people.filter((p) => p.active !== false).map((p) => p.full_name),
    ...(v.attendee_name ? [v.attendee_name] : []),
    ...(lt && lt.performed_by ? [lt.performed_by] : []),
  ])];
  const value = (lt && lt.performed_by) || v.attendee_name || me.full_name;
  $("lt-by").innerHTML = names.map((n) =>
    `<option value="${escapeHtml(n)}"${n === value ? " selected" : ""}>${escapeHtml(n)}</option>`).join("");
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
  syncComposerInputs(lt, v);
  renderLetterStatus();
  // Last: this render blanks #lt-scope, which is where the minimized summary
  // lives, so re-apply after rather than before.
  applyLetterComposerMin();
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
    h += `<div class="lt-sys">Nothing queued yet — Queue Letter builds the letter from
      the checked standard content; the notes box is optional.</div>`;
  } else {
    if (lt.status === "queued")
      h += `<div class="lt-sys">Queued — waiting for generate-letters.mjs on the office machine.</div>`;
    if (lt.status === "working")
      h += `<div class="lt-sys">The office machine is rendering this letter…</div>`;
    // A finished draft is revisable, but nothing said so: the composer showed
    // a PDF path and a Sent button and left the only way to change the letter
    // undiscoverable. queue_letter() re-queues anything that is not issued.
    if (lt.status === "draft")
      h += `<div class="lt-sys"><b>Draft ready — read the PDF before sending.</b><br>
        <b>To change it:</b> describe what should differ in the notes box below and press
        <b>Queue changes</b>. It regenerates and replaces this PDF, and your note is kept
        on the letter.<br>
        <b>Sent</b> is final — press it only once the letter has actually gone out. After
        that a revision becomes a new letter rather than a change to this one.</div>`;
    if (lt.error)
      h += `<div class="lt-sys err">${escapeHtml(lt.error)}</div>`;
    if (lt.output_path)
      h += `<div class="lt-sys">PDF: ${escapeHtml(lt.output_path)}${
        lt.pages ? ` · ${lt.pages} page${lt.pages === 1 ? "" : "s"}` : ""}</div>`;
  }
  $("lt-chat").innerHTML = h;

  // "Queue Letter" on a finished draft reads like it would make a SECOND
  // letter, which is why revising one looked impossible. Say what it does.
  // Safe here: this touches a button label, never a text input or a select.
  $("lt-go").textContent =
    lt && lt.status !== "issued" && lt.status !== "queued" && lt.status !== "working"
      ? "Queue changes"
      : "Queue Letter";
}

$("lt-go").addEventListener("click", async () => {
  if (!canDesign() || letterVisitId == null) return;
  const v = visits.find((x) => x.id === letterVisitId);
  if (!v) return toast("That visit is gone — pick another from the log.", "err");
  const scopes = [...document.querySelectorAll("#lt-scopes [data-ltscope]:checked")]
    .map((c) => c.dataset.ltscope);
  const performedBy = $("lt-by").value;
  const text = $("lt-msg").value.trim();
  if (!scopes.length && !text) {
    return toast("Check what was observed, or describe it in the edits box.", "err");
  }
  // Item subsets: only stored when Ben unchecked something; a checked scope
  // with NOTHING under it is a mistake, not a letter.
  const scopeItems = {};
  for (const k of scopes) {
    const cfg = LETTER_SCOPES[k];
    if (!cfg || !cfg.items.length) continue;
    const picked = [...document.querySelectorAll(`#lt-scopes [data-ltitem="${k}"]:checked`)]
      .map((c) => c.value);
    if (!picked.length) {
      return toast(`Check at least one item under ${cfg.label}, or uncheck it.`, "err");
    }
    scopeItems[k] = picked; // always explicit — the letter says exactly this
  }
  // The board shows this; the runner works from scopes.
  const type = scopes.length === 0 ? "general" : scopes.length === 1 ? scopes[0] : "multi";
  const lt = lettersByVisit[v.id] || null;

  $("lt-go").disabled = true;
  try {
    let toastMsg = "Letter queued — the office machine renders it within a minute or two.";
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
        scopes,
        scope_items: scopeItems,
        performed_by: performedBy || null,
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
        p_scopes: scopes, p_performed_by: performedBy || null,
        p_scope_items: scopeItems,
      });
      if (error) return fail("Re-queuing the letter", error);
      if (!data || !data.length)
        return toast("That change did not save — the letter row is not editable.", "warn");
    }
    $("lt-msg").value = "";
    await loadLetters();
    renderLetterBoard();
    renderVisits();
    renderLetterStatus();
    // Queueing is the moment something goes in flight — start watching now so
    // the board flips to draft on its own instead of sitting on "queued".
    syncLetterPoll();
    toast(toastMsg);
  } finally {
    $("lt-go").disabled = false;
  }
});

// Marking a letter sent is reachable from the board as well as the composer,
// so the update lives here once. The status guard stays in the WHERE clause,
// not just the caller: two tabs can disagree about what is still a draft.
// confirmFirst is on for the board button and off for the composer. On the
// board you are looking at a list and the wrong row is one pixel away; in the
// composer you are looking at the letter itself, with its PDF path on screen.
async function markLetterIssued(id, { confirmFirst = false } = {}) {
  const lt = letters.find((l) => l.id === id);
  if (!lt || lt.status !== "draft") return;
  if (confirmFirst && !confirm(
    "Mark this letter sent?\n\nOnly do this once it has actually gone to the client. " +
    "The file moves to \"2 - Sent\", and after this a revision becomes a NEW letter " +
    "rather than a change to this one."
  )) return;
  const { data, error } = await sb.from("letters")
    .update({ status: "issued" }).eq("id", id).eq("status", "draft").select("id");
  if (error) return fail("Marking the letter sent", error);
  if (!data || !data.length) return toast("That change did not save — it is no longer a draft.", "warn");
  await loadLetters();
  renderLetterBoard();
  renderVisits();
  renderLetterStatus();
  toast("Marked sent — the office machine moves the file to 2 - Sent.");
}

$("lt-issued").addEventListener("click", () => {
  if (letterVisitId == null) return;
  const lt = lettersByVisit[letterVisitId];
  if (lt) markLetterIssued(lt.id);
});

// --------------------------------------------------------- drawing aids
// Admin-only, and the letters architecture end to end: the browser only QUEUES
// jobs into timetrack.drawing_jobs; tools/generate-drawing-aids.mjs on the
// office machine does the file work in the Dropbox tree and the AI calls, then
// writes status/results back. Every shape here mirrors
// tools/drawing-aids-contracts.md — change one, change both.

// Storage-value → English, like the letters board.
const DRAWING_STATUS_LABEL = { queued: "Queued", working: "Working", done: "Done", error: "Error" };
// `setup` stays for HISTORY — pre-0024 rows keep rendering; the composer no
// longer offers it and the runner refuses a queued one with the way forward.
const DRAWING_KIND_LABEL = {
  setup: "Project setup", analyze: "Analyze sources", generate: "Generate set",
  table: "Table", check: "Check", compare: "Compare",
};

// Findings vocabulary is FIXED (contracts): evidence classes, never the word
// "confirmed". The badge TEXT carries the distinction — colour stays out of it.
const EVIDENCE_BADGE = {
  deterministic: "DET", "single-model": "1-MODEL", "two-model": "2-MODEL",
};
const EVIDENCE_TIP = {
  deterministic: "Deterministic text check — no AI involved",
  "single-model": "Flagged by one model",
  "two-model": "Two-model agreement — both engines flagged this independently",
};

// "Done" is a machine fact, not an engineering state (migration 0022). These
// two vocabularies mirror the CHECK constraints on drawing_jobs.review_status
// and finding_dispositions.disposition — registry-drift.mjs holds them to the
// schema snapshot, so a renamed value fails a test instead of a live click.
const DA_REVIEW_STATES = {
  unreviewed: "Unreviewed",
  in_review: "In review",
  accepted: "Accepted",
  revisions: "Revisions needed",
  superseded: "Superseded",
};
const DA_DISPOSITIONS = {
  open: "Open",
  fixed: "Fixed",
  accepted_as_shown: "Accepted as shown",
  false_positive: "False positive",
  deferred: "Deferred",
  superseded: "Superseded",
};
// What a DESIGNER may write — the workflow reports. The engineering judgments
// (accepted_as_shown, false_positive, superseded) and the 'accepted' sign-off
// are the engineer's alone; RLS is the guard, this list only keeps the UI from
// offering what the database will refuse. Mirrors the 0022 policies.
const DA_DESIGNER_DISPOSITIONS = ["open", "fixed", "deferred"];

// The manifest keys prefill actually writes onto sheets — mirrors the
// runner's PREFILL_FACT_KEYS (registry-drift.mjs holds them together). The
// readiness line counts THESE, because "4 approved facts" of which zero are
// prefillable is a promise the generate cannot keep.
const DA_PREFILL_KEYS = ["design_pi", "soil_bearing", "note_a_natural", "note_a_limestone", "remove_replace_depth"];

// Sheet registry — mirrors tools\drawing-templates.mjs in the runner.
// [key, title, core]; core pre-checked, extended opt-in (the letters-scopes
// philosophy: a checkbox is a content selector someone chose on purpose).
const DRAWING_KITS = {
  residential: { label: "Residential (IRC)", sheets: [
    ["S0.0", "General Notes", true],
    ["S1.0", "Foundation Plan", true],
    ["S1.1", "Framing Plan", true],
    ["S1.2", "Roof Framing Plan", true],
    ["S1.3", "Wind Bracing Plan", true],
    ["S2.0", "Foundation Details", true],
    ["S3.0", "Framing Details", false],
    ["S3.1", "Typ. Steel Framing Details", false],
    ["S4.0", "Typ. Wind Bracing Details", true],
    ["S4.1", "Typ. Wood Framing Details", true],
  ] },
  ibc: { label: "Commercial (IBC)", sheets: [
    ["S0.0", "General Notes", true],
    ["S0.1", "General Notes (cont.)", true],
    ["S1.0", "Foundation Plan", true],
    ["S1.1", "Framing Plan", true],
    ["S1.2", "Roof Framing Plan", true],
    ["S1.3", "Wind Bracing Plan", true],
    ["S4.0", "Typ. Wind Bracing Details", true],
    ["S4.1", "Typ. Wood Framing Details", true],
  ] },
  pool22: { label: "Pool 22x34", sheets: [
    ["S0.0", "Pool General Notes", true],
    ["S1.0", "Pool Foundation Plan", true],
  ] },
  pool24: { label: "Pool 24x36", sheets: [
    ["S0.0", "Pool General Notes", true],
    ["S1.0", "Pool Foundation Plan", true],
  ] },
};

// Fact-key registry — mirrors the runner's copy (contracts §fact keys). AI may
// propose verbatim + selection keys only; decision keys are UI-entry only, so
// the add-fact form below is the ONLY door for them.
const FACT_KEYS = [
  { key: "geotech_firm", label: "Geotech firm", fact_class: "verbatim", units: "" },
  { key: "geotech_report_no", label: "Geotech report no.", fact_class: "verbatim", units: "" },
  { key: "geotech_date", label: "Geotech report date", fact_class: "verbatim", units: "" },
  { key: "soil_class", label: "Soil classification", fact_class: "verbatim", units: "" },
  { key: "pvr", label: "PVR", fact_class: "verbatim", units: "in" },
  { key: "pier_min_dia", label: "Min. pier diameter", fact_class: "verbatim", units: "in" },
  { key: "limestone_depth", label: "Depth to limestone", fact_class: "verbatim", units: "" },
  { key: "skin_friction", label: "Allowable skin friction", fact_class: "verbatim", units: "psf/ft" },
  { key: "groundwater", label: "Groundwater observation", fact_class: "verbatim", units: "" },
  { key: "stories", label: "Stories", fact_class: "verbatim", units: "" },
  { key: "roof_material", label: "Roof material", fact_class: "verbatim", units: "" },
  { key: "design_pi", label: "Design PI", fact_class: "selection", units: "" },
  { key: "soil_bearing", label: "Soil bearing capacity", fact_class: "selection", units: "" },
  { key: "pier_embed", label: "Pier embedment", fact_class: "selection", units: "" },
  { key: "foundation_type", label: "Foundation type", fact_class: "selection", units: "" },
  { key: "lateral_pressure", label: "Lateral earth pressure", fact_class: "selection", units: "pcf" },
  { key: "remove_replace_depth", label: "Remove & replace depth", fact_class: "selection", units: "in" },
  { key: "wind_speed", label: "Wind speed (Vult)", fact_class: "selection", units: "mph" },
  { key: "wind_exposure", label: "Wind exposure", fact_class: "selection", units: "" },
  { key: "code_edition", label: "Governing code edition", fact_class: "selection", units: "" },
  { key: "note_a_natural", label: 'Note "A" — natural soils embedment', fact_class: "decision", units: "in" },
  { key: "note_a_limestone", label: 'Note "A" — limestone embedment', fact_class: "decision", units: "in" },
  { key: "fc_foundation", label: "f'c — foundation", fact_class: "decision", units: "PSI" },
  { key: "slab_thickness", label: "Slab thickness", fact_class: "decision", units: "in" },
  { key: "slab_reinf", label: "Slab reinforcement", fact_class: "decision", units: "" },
  { key: "surcharge", label: "Design surcharge", fact_class: "decision", units: "psf" },
  { key: "design_groundwater", label: "Design groundwater elev.", fact_class: "decision", units: "" },
];

// Table inventory — columns fixed from the house drawing templates (contracts).
// Seeded rows are STARTING POINTS for engineer-entered data, never content the
// app decides: header schedule ships its H6–H12 labels, grade beam its two
// standard rows; everything else starts blank.
const TABLE_TYPES = {
  foundation_summary: { label: "Foundation Design Summary", title: "FOUNDATION DESIGN SUMMARY",
    columns: ["Design Parameter", "Value"], rows: [] },
  // Row LABELS and the template's own standard reinforcement are seeds; the
  // dimensions are not. Pre-filling 12"x30" would put a member size the
  // engineer never entered onto a drawing that says he did — the template
  // itself ships these cells as "-" for that reason.
  grade_beam: { label: "Grade Beam Schedule", title: "GRADE BEAM SCHEDULE",
    columns: ["Label", "Width", "Depth", "Pen.", "Reinforcement"],
    rows: [
      ["Perimeter Beams", "", "", 'Note "A"', '(2) #5 T&B w/ #3 ties @ 12" O.C.'],
      ["Interior Beams", "", "", "", '(2) #5 T&B w/ #3 ties @ 12" O.C.'],
    ] },
  column: { label: "Column Schedule", title: "COLUMN SCHEDULE",
    columns: ["Label", "Size", "Remarks"], rows: [] },
  joist: { label: "Joist Schedule", title: "JOIST SCHEDULE",
    columns: ["Label", "Size", "Max. Spacing", "Remarks"], rows: [] },
  embed_plate: { label: "Embed Plate Schedule", title: "EMBED PLATE SCHEDULE",
    columns: ["Label", "W", "D", "Headed Studs", "Thk.", "Condition"], rows: [] },
  header: { label: "Header Schedule", title: "HEADER SCHEDULE",
    columns: ["Label", "Size", "Jamb Studs"],
    rows: [["H6", "2-2x6", "1 jack, 1 king"], ["H8", "2-2x8", "1 jack, 2 king"],
           ["H10", "2-2x10", "2 jack, 2 king"], ["H12", "2-2x12", "2 jack, 2 king"]] },
  wind_bracing: { label: "Wind Bracing Legend", title: "WIND BRACING LEGEND",
    columns: ["Label", "Description", "Edge Nailing", "Sill Plate Nailing", "Detail Ref."], rows: [] },
  custom: { label: "Custom", title: "", columns: null, rows: [] },
};

let drawingJobs = [];        // admin only; RLS returns nothing for anyone else
let projectFacts = [];       // facts for the tab's selected project
const daExpanded = new Set(); // job ids whose details row is open — survives the poll's re-render

// Engineer verdicts on individual findings, keyed job fingerprint.
// Loaded together with the jobs; absence of an entry means "open".
let daDispositions = new Map();
const daFpCache = new Map();  // finding identity JSON -> sha256 hex

const dispKey = (jobId, fp) => `${jobId} ${fp}`;

// The ONE implementation of the finding fingerprint (the 0022 contract):
// sha256 over the finding's content identity. Content-keyed so a re-run
// re-attaches verdicts only to findings that came back byte-identical —
// anything new or re-phrased starts at open, which errs in the safe
// direction (a re-run can re-surface work, never silently resolve it).
// ⚠️ Changing this orphans every stored disposition — the rows keep the
// record, but the board would show all findings open again.
async function findingFingerprint(f) {
  const ident = JSON.stringify([f.sheet ?? "", f.page ?? 0, f.category ?? "", f.finding ?? ""]);
  let fp = daFpCache.get(ident);
  if (!fp) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ident));
    fp = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    daFpCache.set(ident, fp);
  }
  return fp;
}

// Stamp `_fp` onto every checker finding so the render stays synchronous.
async function annotateFindingFps(jobs) {
  for (const j of jobs) {
    if (j.kind !== "check" && j.kind !== "compare") continue;
    const fs = j.results && Array.isArray(j.results.findings) ? j.results.findings : [];
    for (const f of fs) f._fp = await findingFingerprint(f);
  }
}

function findingDisposition(jobId, f) {
  const row = f && f._fp ? daDispositions.get(dispKey(jobId, f._fp)) : null;
  return row ? row.disposition : "open";
}

// ONE active project for the whole module. Four independent pickers (manifest
// filter, setup, table builder, checker) made it possible to read project A's
// manifest while queuing work on B — the facts-panel race token only papered
// over the symptom. The per-tool hidden inputs stay in the DOM and are synced
// from here, so the queue handlers (and the test harness) keep one shape.
let daActiveProject = null;

function daSetActive(id) {
  daActiveProject = id ? String(id) : null;
  // The OLD project's facts must not render under the new heading for even a
  // frame — the readiness line's counts would be a claim about the wrong job.
  // loadDrawingFacts below repopulates; until it lands the honest count is
  // "nothing loaded yet", not the previous project's numbers.
  projectFacts = [];
  for (const k of ["da-proj", "da-tproj", "da-cproj"]) $(k).value = daActiveProject || "";
  $("da-active-pick").classList.toggle("hidden", Boolean(daActiveProject));
  $("da-active-lock").classList.toggle("hidden", !daActiveProject);
  if (daActiveProject) {
    $("da-active").value = daActiveProject;
    $("da-active-label").textContent = labelFor(daActiveProject);
  } else {
    $("da-active").value = "";
    $("da-active-q").value = "";
  }
  daRenderActiveStats();
  loadDrawingFacts();
}

function daRenderActiveStats() {
  if (!daActiveProject) {
    $("da-active-stats").textContent = "";
    daRenderGenReady();   // clears the generate card's readiness line too
    return;
  }
  const approved = projectFacts.filter((f) => f.status === "approved").length;
  const proposed = projectFacts.filter((f) => f.status === "proposed").length;
  const mine = drawingJobs.filter((j) => String(j.project_id) === daActiveProject);
  // Open findings across this project's completed checks. null = no completed
  // check yet, which is a different claim than "0 open" and must not print as
  // one; superseded reviews are out — their findings are moot by declaration.
  let open = null;
  for (const j of mine) {
    if ((j.kind !== "check" && j.kind !== "compare") || j.status !== "done") continue;
    if (j.review_status === "superseded") continue;
    const fs = j.results && Array.isArray(j.results.findings) ? j.results.findings : [];
    if (open === null) open = 0;
    for (const f of fs) if (findingDisposition(j.id, f) === "open") open++;
  }
  $("da-active-stats").textContent =
    `— manifest ${approved} approved · ${proposed} proposed · ${mine.length} job${mine.length === 1 ? "" : "s"} on record` +
    (open === null ? "" : ` · ${open} open finding${open === 1 ? "" : "s"}`);
  daRenderGenReady();
}

// The generate card's readiness line: what prefill will ACTUALLY write, which
// is the prefill-key subset of the manifest, not the whole manifest — a line
// claiming "4 approved facts" of which zero are prefillable promises a filled
// sheet the generate cannot produce. This line is the 0024 split's whole
// pitch: generate when the manifest is ready, not before.
function daRenderGenReady() {
  const el = $("da-gen-ready");
  if (!el) return;
  if (!daActiveProject) { el.textContent = ""; return; }
  if (!$("da-opt-prefill").checked) {
    el.innerHTML = `<span class="muted">Prefill is unticked — the set assembles with the template's
      own placeholders; no manifest values are written.</span>`;
    return;
  }
  const approved = projectFacts.filter((f) =>
    f.status === "approved" && DA_PREFILL_KEYS.includes(f.key)).length;
  const proposed = projectFacts.filter((f) =>
    f.status === "proposed" && DA_PREFILL_KEYS.includes(f.key)).length;
  el.innerHTML = `Prefill will write <b>${approved}</b> of the ${DA_PREFILL_KEYS.length} prefillable
    value${DA_PREFILL_KEYS.length === 1 ? "" : "s"} (Design PI, soil bearing, Note "A" embedments, R&amp;R depth).` +
    (proposed
      ? ` <span style="color:var(--warn)">${proposed} prefillable value${proposed === 1 ? " is" : "s are"}
          still only PROPOSED — approve ${proposed === 1 ? "it" : "them"} on the manifest above or
          ${proposed === 1 ? "it" : "they"} will not appear on the set.</span>`
      : "");
}

function initDrawingTab() {
  fillProjectCombo($("da-active"), projects);
  fillProjectCombo($("da-proj"), projects);
  fillProjectCombo($("da-tproj"), projects);
  fillProjectCombo($("da-cproj"), projects);
  $("da-active").addEventListener("change", () => daSetActive($("da-active").value));
  $("da-active-change").addEventListener("click", () => daSetActive(null));
  $("da-active-hub").addEventListener("click", () => {
    if (daActiveProject) openProjectDrawer(daActiveProject);
  });
}

async function loadDrawingTab() {
  if (!canDesign()) return;
  await Promise.all([loadDrawingJobs(), loadDrawingFacts()]);
  syncDrawingPoll();
}

// PostgREST silently caps an unranged select at max-rows (1000) with a 200 —
// and dispositions accumulate by design (they survive job deletion and
// re-runs), so an unpaged fetch would one day quietly render judged findings
// as Open again. Page until a short page says the table is exhausted.
async function fetchAllDispositions() {
  const PAGE = 1000;
  const all = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from("finding_dispositions")
      .select("job_id, finding_key, disposition, note, decided_at")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return { error };
    all.push(...(data || []));
    if (!data || data.length < PAGE) return { data: all };
  }
}

// The reload race guard, same shape as daFactsToken: an in-flight poll fetch
// that resolves AFTER a verdict was recorded must not repaint the board from
// its pre-verdict snapshot — with the poll stopped on that tick, the stale
// paint would stand until the next manual reload.
let daJobsToken = 0;

async function loadDrawingJobs() {
  if (!canDesign()) return;
  const token = ++daJobsToken;
  // Jobs and dispositions land together: rendering findings against a stale
  // verdict map would briefly show closed findings as open (or worse, the
  // other way around), so neither renders without the other.
  const [jobsRes, dispRes] = await Promise.all([
    sb.from("drawing_jobs")
      .select(`id, project_id, kind, payload, messages, status, review_status, outputs, results,
               warnings, manifest, error, upload_paths, requested_by, created_at, updated_at`)
      .order("updated_at", { ascending: false }),
    fetchAllDispositions(),
  ]);
  if (token !== daJobsToken) return;   // a newer load owns the board now
  if (jobsRes.error) return fail("Loading drawing jobs", jobsRes.error);
  if (dispRes.error) return fail("Loading finding dispositions", dispRes.error);
  drawingJobs = jobsRes.data || [];
  daDispositions = new Map((dispRes.data || []).map((d) => [dispKey(d.job_id, d.finding_key), d]));
  await annotateFindingFps(drawingJobs);
  if (token !== daJobsToken) return;
  await ensureLabels(drawingJobs.map((j) => j.project_id));
  if (token !== daJobsToken) return;
  renderDrawingBoard();
  daRenderActiveStats();
}

// The project these facts belong to, captured when the load started. The
// heading and the Approve buttons are rendered from THIS, never from a fresh
// read of the select — otherwise a slow response for project A lands after the
// filter has moved to B and paints A's rows under B's name, with live Approve
// buttons. Approving there supersedes an approved value on a project Ben never
// opened, silently, and prefill then consumes it as blessed. The project drawer
// guards its loads the same way (pdToken).
let daFactsToken = 0;
let daFactsFor = null;

async function loadDrawingFacts() {
  if (!canDesign()) return;
  // A designer reads the manifest; only the engineer writes it. Hiding the form
  // is courtesy — RLS is the guard.
  $("da-fact-form").classList.toggle("hidden", !isAdmin());
  const proj = daActiveProject;
  const token = ++daFactsToken;
  if (!proj) { projectFacts = []; daFactsFor = null; renderDrawingFacts(); return; }
  const { data, error } = await sb
    .from("project_facts")
    .select(`id, project_id, key, label, value, units, fact_class, status,
             source, source_ref, extracted_by, notes, updated_at`)
    .eq("project_id", proj)
    .in("status", ["approved", "proposed"])
    .order("key", { ascending: true });
  if (token !== daFactsToken) return;   // a newer load owns the panel now
  if (error) return fail("Loading the design manifest", error);
  projectFacts = data || [];
  daFactsFor = proj;
  renderDrawingFacts();
  daRenderActiveStats();
}

// ---- polling: clone of the letters poll -----------------------------------
// Fetch-on-open otherwise; poll only while a job is actually in flight, and
// refresh ONLY the board + facts renders — NEVER the composer inputs (the
// full-render vs partial-refresh house rule; see renderLetterComposer).
let drawingPollTimer = null;
const DRAWING_POLL_MS = 4000;

function drawingJobsInFlight() {
  return drawingJobs.some((j) => j.status === "queued" || j.status === "working");
}

function stopDrawingPoll() {
  if (drawingPollTimer) { clearInterval(drawingPollTimer); drawingPollTimer = null; }
}

function syncDrawingPoll() {
  const onTab = !$("panel-drawing").classList.contains("hidden");
  if (!onTab || !canDesign() || !drawingJobsInFlight()) return stopDrawingPoll();
  if (drawingPollTimer) return; // already running
  drawingPollTimer = setInterval(async () => {
    // Re-check each tick: showTab stops the poll, but a stray timer must never
    // repaint a hidden panel.
    if ($("panel-drawing").classList.contains("hidden")) return stopDrawingPoll();
    // Never repaint the board out from under an open control. While a queued
    // job keeps the poll alive, an engineer can be mid-verdict on an older
    // done job — a tick that rebuilds innerHTML closes the dropdown and drops
    // the pick (the loadWeekPreservingFocus rule). Skip the tick; the next one
    // lands after the click resolves and focus moves on.
    if ($("da-jobs-body").contains(document.activeElement)) return;
    await loadDrawingJobs();       // renders the board only
    await loadDrawingFacts();      // a finished setup proposes facts; show them
    if (!drawingJobsInFlight()) stopDrawingPoll();
  }, DRAWING_POLL_MS);
}

// ---- project filter (the letters lt-filter-proj pattern) ------------------

// Static control: attached once, never inside a render.
// History filter only. It used to also scope the Design manifest, which made
// one control do two conceptually different jobs — filtering job history and
// selecting whose design data is live below.
$("da-filter-proj").addEventListener("change", renderDrawingBoard);

function setDrawingProjectFilter(id) {
  pickProjectOption($("da-filter-proj"), id);   // narrow the history too
  daSetActive(id);                              // and lock the module onto the job
}

function renderDrawingProjectFilter() {
  const sel = $("da-filter-proj");
  const keep = sel.value;
  // EVERY project, not just those with jobs. This select also scopes the
  // Design manifest, and decision-class facts (Note "A" embedments, f'c, slab
  // thickness) are UI-entry only — so listing only projects that already have a
  // drawing job made it impossible to enter the values a human must supply
  // before the first job, and left the card inert on a fresh install.
  const withJobs = new Set(drawingJobs.map((j) => String(j.project_id)).filter((x) => x && x !== "null"));
  const ids = [...new Set([...withJobs, ...projects.map((p) => String(p.id))])];
  if (keep && !ids.includes(keep)) ids.push(keep);   // see renderTodoProjectFilter
  ids.sort((a, b) => labelFor(a).localeCompare(labelFor(b)));
  sel.innerHTML = `<option value="">All projects</option>` +
    ids.map((id) => `<option value="${id}"${withJobs.has(id) ? "" : ' data-nojobs="1"'}>${
      escapeHtml(labelFor(id))}</option>`).join("");
  if (keep) sel.value = keep;
}

// ---- jobs board -----------------------------------------------------------

function drawingStatusHtml(j) {
  const label = DRAWING_STATUS_LABEL[j.status] || j.status;
  const color = j.status === "error" ? "var(--err)" : j.status === "done" ? "var(--ok)" : "";
  let html = `<span class="tag"${color ? ` style="color:${color};border-color:${color}"` : ""}>${
    escapeHtml(label)}</span>`;
  // The engineering state rides beside the machine state, done jobs only —
  // "Done" says the run finished, this says whether an engineer has looked.
  if (j.status === "done") {
    const rs = j.review_status || "unreviewed";
    const rc = rs === "accepted" ? " ok" : rs === "revisions" ? " nb" : "";
    html += ` <span class="tag${rc}">${escapeHtml(DA_REVIEW_STATES[rs] || rs)}</span>`;
  }
  return html;
}

function daManifestLine(m) {
  if (!m) return "";
  const bits = [];
  if (m.runner_version) bits.push(`runner ${m.runner_version}`);
  if (m.checklist_version) bits.push(`checklist ${m.checklist_version}`);
  if (m.prompt_version) bits.push(`prompt ${m.prompt_version}`);
  for (const [k, v] of Object.entries(m.models || {})) if (v) bits.push(`${k}: ${v}`);
  return bits.join(" · ");
}

// The expanded details row for one job. Everything here is runner-written data
// rendered read-only; findings keep the fixed evidence vocabulary.
function renderDrawingDetails(j) {
  const out = [];
  if (j.status === "queued") out.push(`<div class="lt-sys">Queued — waiting for the office machine.</div>`);
  if (j.status === "working") out.push(`<div class="lt-sys">The office machine is working on this…</div>`);
  if (j.error) out.push(`<div class="lt-sys err">${escapeHtml(j.error)}</div>`);
  for (const m of (Array.isArray(j.messages) ? j.messages : [])) {
    out.push(`<div class="lt-bubble"><div class="small muted">${
      escapeHtml(fmtWhen(m.at))}</div>${escapeHtml(m.text || "")}</div>`);
  }
  const r = j.results || {};
  // One branch for the whole setup family: analyze writes address_check +
  // facts_proposed, generate writes facts_used/prefilled/background, and the
  // retired setup rows carry any mix — every line below renders only when its
  // result is present.
  if (j.kind === "setup" || j.kind === "analyze" || j.kind === "generate") {
    const ac = r.address_check;
    if (ac) {
      const verdict = { match: "Match", mismatch: "MISMATCH — extraction and prefill refused",
        unreadable: "Unreadable", not_applicable: "Not applicable — no geotech attached" }[ac.verdict]
        || ac.verdict;
      const color = ac.verdict === "mismatch" ? "var(--err)" :
        ac.verdict === "unreadable" ? "var(--warn)" : "";
      // The says-clause only makes sense when a geotech was actually read —
      // an arch-only analyze rendering 'geotech says "?"' implies a check
      // that never happened.
      const says = ac.verdict === "not_applicable" ? "" :
        `<span class="muted">— geotech says &quot;${escapeHtml(ac.geotech_address || "?")}&quot;,
        project is &quot;${escapeHtml(ac.project_address || "?")}&quot;</span>`;
      out.push(`<div class="small" style="margin-top:6px"><b>Geotech address check:</b>
        <span${color ? ` style="color:${color};font-weight:700"` : ""}>${escapeHtml(verdict)}</span>
        ${says}</div>`);
    }
    if (Array.isArray(r.facts_used) && r.facts_used.length) {
      out.push(`<div class="small" style="margin-top:6px"><b>Approved facts used:</b> ${
        r.facts_used.map((f) => escapeHtml(`${f.key} = ${f.value}`)).join(" · ")}</div>`);
    }
    if (r.facts_proposed) {
      out.push(`<div class="small" style="margin-top:6px">${
        escapeHtml(String(r.facts_proposed))} fact(s) proposed — review them in the Design manifest below.</div>`);
    }
    if (Array.isArray(r.prefilled) && r.prefilled.length) {
      out.push(`<div class="small" style="margin-top:6px"><b>Prefilled:</b> ${
        r.prefilled.map((p) => escapeHtml(`${p.sheet} · ${p.field} = ${p.value}`)).join(" · ")}</div>`);
    }
    if (r.background) {
      out.push(`<div class="small" style="margin-top:6px"><b>Drafting background:</b> ${
        escapeHtml(r.background.status || "")}${
        r.background.detail ? ` <span class="muted">— ${escapeHtml(r.background.detail)}</span>` : ""}</div>`);
    }
  }
  if (j.kind === "check" || j.kind === "compare") {
    // Always show COVERAGE, on every status. This line is what answers "did
    // both engines review this set?", and it used to say a bare "ok" whenever
    // the engine survived even one page — 11 failures out of 12 read as a clean
    // pass, with the failures buried in the warnings below. A detail was only
    // ever appended when the status was not "ok", so a partial run looked total.
    const engBits = Object.entries(r.engines || {}).map(([k, e]) => {
      const cover = Number.isFinite(e.pages_total) && e.pages_total
        ? ` ${e.pages_reviewed}/${e.pages_total} sheets` : "";
      return `${k}: ${e.status || "?"}${cover}${e.model ? ` (${e.model})` : ""}${
        e.detail ? ` — ${e.detail}` : ""}`;
    });
    if (engBits.length) {
      out.push(`<div class="small" style="margin-top:6px"><b>Engines:</b> ${
        escapeHtml(engBits.join(" · "))}</div>`);
    }
    const findings = Array.isArray(r.findings) ? r.findings : [];
    if (findings.length) {
      // The verdict tally first: "37 findings" and "37 findings, 2 open" are
      // different situations and the count line is what says which one this is.
      const tally = {};
      for (const f of findings) {
        const d = findingDisposition(j.id, f);
        tally[d] = (tally[d] || 0) + 1;
      }
      const parts = Object.keys(DA_DISPOSITIONS)
        .filter((d) => tally[d])
        .map((d) => `${tally[d]} ${DA_DISPOSITIONS[d].toLowerCase()}`);
      out.push(`<div class="small" style="margin-top:8px"><b>Findings:</b> ${
        findings.length} · ${escapeHtml(parts.join(" · "))}</div>`);

      const bySheet = {};
      for (const f of findings) (bySheet[f.sheet || "(no sheet)"] ||= []).push(f);
      const sevRank = { high: 0, medium: 1, low: 2, info: 3 };
      for (const sheet of Object.keys(bySheet).sort()) {
        const list = bySheet[sheet]
          .sort((a, b) => (sevRank[a.severity] ?? 9) - (sevRank[b.severity] ?? 9));
        out.push(`<div style="margin-top:8px"><b class="small">${escapeHtml(sheet)}</b>${
          list.map((f) => {
            const d = findingDisposition(j.id, f);
            const row = f._fp ? daDispositions.get(dispKey(j.id, f._fp)) : null;
            // A judged finding stays legible but recedes; only 'open' and the
            // deliberate parking of 'deferred' keep full weight.
            const closed = d !== "open" && d !== "deferred";
            // Designers get the workflow states only, and a row already
            // carrying an engineering judgment is read-only for them — the
            // select would be an offer the database refuses (0022 RLS).
            const writable = isAdmin() || DA_DESIGNER_DISPOSITIONS.includes(d);
            const options = (isAdmin()
              ? Object.keys(DA_DISPOSITIONS) : DA_DESIGNER_DISPOSITIONS)
              .map((v) => `<option value="${v}"${v === d ? " selected" : ""}>${
                escapeHtml(DA_DISPOSITIONS[v])}</option>`).join("");
            const control = !f._fp ? "" : writable
              ? `<select class="da-disp" data-dadisp="${j.id}" data-fp="${f._fp}"
                   title="The engineer's verdict on this finding — the runner's record above it never changes.">${options}</select>`
              : `<span class="tag">${escapeHtml(DA_DISPOSITIONS[d] || d)}</span>`;
            return `
            <div class="da-finding small${closed ? " da-closed" : ""}">
              <span class="tag da-evi" title="${escapeHtml((EVIDENCE_TIP[f.evidence] || f.evidence || "") +
                (f.engine ? ` · ${f.engine}` : ""))}">${
                escapeHtml(EVIDENCE_BADGE[f.evidence] || f.evidence || "?")}</span>
              <span class="tag${f.severity === "high" ? " nb" : ""}">${escapeHtml(f.severity || "")}</span>
              <span class="muted">${escapeHtml(f.category || "")}</span>
              <span class="da-ftext">${escapeHtml(f.finding || "")}${
                f.location ? ` <span class="muted">— ${escapeHtml(f.location)}</span>` : ""}${
                f.page ? ` <span class="muted">· p.${escapeHtml(String(f.page))}</span>` : ""}</span>
              ${control}${
                row && row.note ? `<span class="muted"> — ${escapeHtml(row.note)}</span>` : ""}
            </div>`;
          }).join("")}</div>`);
      }
    } else if (j.status === "done") {
      out.push(`<div class="small muted" style="margin-top:6px">No findings —
        an advisory review, not a certification that the set is right.</div>`);
    }
  }
  // The engineering review of the whole job, any kind. "Done" above is the
  // machine's fact; this line records the engineer's read of it. Manual on
  // purpose — nothing here ever auto-accepts or auto-supersedes.
  if (j.status === "done") {
    const rs = j.review_status || "unreviewed";
    // An accepted job is settled: a designer can neither sign one off nor
    // reopen one (0022 — the letters 'issued' rail), so they see a tag.
    if (!isAdmin() && rs === "accepted") {
      out.push(`<div class="small" style="margin-top:10px"><b>Engineering review:</b>
        <span class="tag ok">Accepted</span></div>`);
    } else {
      const options = Object.entries(DA_REVIEW_STATES)
        .filter(([v]) => isAdmin() || v !== "accepted")
        .map(([v, label]) => `<option value="${v}"${v === rs ? " selected" : ""}>${
          escapeHtml(label)}</option>`).join("");
      out.push(`<div class="small" style="margin-top:10px"><b>Engineering review:</b>
        <select data-darev="${j.id}" style="width:auto;padding:4px 8px">${options}</select></div>`);
    }
  }
  for (const w of (Array.isArray(j.warnings) ? j.warnings : [])) {
    out.push(`<div class="lt-sys" style="color:var(--warn)">${
      escapeHtml(typeof w === "string" ? w : JSON.stringify(w))}</div>`);
  }
  const mline = daManifestLine(j.manifest);
  if (mline) out.push(`<div class="da-prov" style="margin-top:6px">${escapeHtml(mline)}</div>`);
  if (Array.isArray(j.upload_paths) && j.upload_paths.length) {
    out.push(`<div class="da-prov">Inputs: ${escapeHtml(j.upload_paths.map((u) =>
      `${u.slot}: ${u.name || u.object}${u.sha256 ? ` (${u.sha256.slice(0, 8)}…)` : ""}`).join(" · "))}</div>`);
  }
  return out.join("") || `<div class="small muted">Nothing to show yet.</div>`;
}

function renderDrawingBoard() {
  renderDrawingProjectFilter();
  const only = $("da-filter-proj").value;
  const all = drawingJobs;                       // query is already newest-first
  const rows = only ? all.filter((j) => String(j.project_id) === only) : all;
  $("da-count").textContent = all.length
    ? (rows.length === all.length ? `· ${all.length} on record` : `· ${rows.length} of ${all.length}`)
    : "";
  // Same honesty rule as the letters board: with a filter on, "none yet" is a
  // claim the filtered view cannot support.
  $("da-jobs-empty").textContent = only
    ? `No drawing jobs on ${labelFor(only)}.`
    : "No drawing jobs yet — queue an analyze, a generate, a table or a check below.";
  $("da-jobs-empty").classList.toggle("hidden", rows.length > 0);
  $("da-jobs-table").classList.toggle("hidden", rows.length === 0);

  $("da-jobs-body").innerHTML = rows.map((j) => {
    const outputs = Array.isArray(j.outputs) && j.outputs.length
      ? j.outputs.map((o) => `<button class="btn ghost sm" data-dacopy="${escapeHtml(o.path || "")}"
            title="Copy the file path — the browser cannot open files on the office machine:
${escapeHtml(o.path || "")}">${escapeHtml(o.label || (o.path || "").split("\\").pop() || "file")}</button>`)
        .join(" ")
      : `<span class="muted">—</span>`;
    const open = daExpanded.has(j.id);
    return `
      <tr>
        <td class="small">${escapeHtml(fmtWhen(j.updated_at))}</td>
        <td>${projLink(j.project_id)}</td>
        <td class="small">${escapeHtml(DRAWING_KIND_LABEL[j.kind] || j.kind)}</td>
        <td>${drawingStatusHtml(j)}</td>
        <td>${outputs}</td>
        <td class="right" style="white-space:nowrap">
          <button class="btn ghost sm" data-daview="${j.id}">${open ? "Hide" : "View"}</button>
          <button class="btn ghost sm" data-dareq="${j.id}"
            title="Send this job back to the queue — it re-runs with the facts approved as of now.">Re-queue</button>
          <button class="btn ghost sm" data-dadel="${j.id}">Delete</button>
        </td>
      </tr>` + (open
        ? `<tr class="da-detail"><td colspan="6">${renderDrawingDetails(j)}</td></tr>`
        : "");
  }).join("");

  // innerHTML-created controls: re-wired after every render, no exception.
  $("da-jobs-body").querySelectorAll("[data-daview]").forEach((b) =>
    b.addEventListener("click", () => {
      const id = Number(b.dataset.daview);
      if (daExpanded.has(id)) daExpanded.delete(id); else daExpanded.add(id);
      renderDrawingBoard();
    }));
  $("da-jobs-body").querySelectorAll("[data-dareq]").forEach((b) =>
    b.addEventListener("click", () => requeueDrawingJob(Number(b.dataset.dareq))));
  $("da-jobs-body").querySelectorAll("[data-dadel]").forEach((b) =>
    b.addEventListener("click", () => deleteDrawingJob(Number(b.dataset.dadel))));
  $("da-jobs-body").querySelectorAll("[data-dacopy]").forEach((b) =>
    b.addEventListener("click", () => daCopyPath(b.dataset.dacopy)));
  $("da-jobs-body").querySelectorAll("[data-dadisp]").forEach((s) =>
    s.addEventListener("change", () =>
      setFindingDisposition(Number(s.dataset.dadisp), s.dataset.fp, s.value)));
  $("da-jobs-body").querySelectorAll("[data-darev]").forEach((s) =>
    s.addEventListener("change", () =>
      setDrawingReviewStatus(Number(s.dataset.darev), s.value)));
}

// Record the engineer's verdict on one finding, through the atomic upsert RPC
// (0022). The finding SNAPSHOT rides along so the disposition row stays
// self-describing after the job — or a re-run's results — are gone.
async function setFindingDisposition(jobId, fp, value) {
  const j = drawingJobs.find((x) => x.id === jobId);
  const f = j && j.results && Array.isArray(j.results.findings)
    ? j.results.findings.find((x) => x._fp === fp) : null;
  if (!j || !f) return renderDrawingBoard();
  let note = null;
  if (value === "false_positive" || value === "accepted_as_shown") {
    // These two are the record that the ENGINEER disagrees with (or overrides)
    // the checker — a sentence of why is what makes a false positive a
    // checker-corpus regression case later. Cancel aborts the verdict.
    note = prompt(`${DA_DISPOSITIONS[value]} — optional note for the record` +
      (value === "false_positive" ? " (why is the checker wrong here?)" : "") + ":");
    if (note === null) return renderDrawingBoard();   // cancelled — revert the select
  }
  const snapshot = { ...f };
  delete snapshot._fp;
  const { data, error } = await sb.rpc("set_finding_disposition", {
    p_job_id: jobId, p_finding_key: fp, p_disposition: value,
    p_note: note, p_finding: snapshot,
  });
  if (error) { renderDrawingBoard(); return fail("Recording the disposition", error); }
  if (!Array.isArray(data) || !data.length) {
    renderDrawingBoard();
    return toast("That disposition was refused — nothing was written.", "warn");
  }
  // Invalidate any in-flight board load: it was queried before this commit,
  // and letting it land would repaint the verdict away (see daJobsToken).
  daJobsToken++;
  daDispositions.set(dispKey(jobId, fp), data[0]);
  renderDrawingBoard();
  daRenderActiveStats();
}

// Move the job's engineering review state. Proven from the returned row, not
// assumed from the request — an RLS refusal comes back as zero rows, and the
// board must snap back to the truth rather than keep the optimistic select.
async function setDrawingReviewStatus(jobId, value) {
  const { data, error } = await sb.from("drawing_jobs")
    .update({ review_status: value })
    .eq("id", jobId)
    .select("id, review_status");
  if (error) { await loadDrawingJobs(); return fail("Setting the review status", error); }
  if (!Array.isArray(data) || !data.length) {
    await loadDrawingJobs();
    return toast("That review change was refused — nothing was written.", "warn");
  }
  daJobsToken++;   // an in-flight pre-commit load must not repaint this away
  const j = drawingJobs.find((x) => x.id === jobId);
  if (j) j.review_status = data[0].review_status;
  renderDrawingBoard();
  daRenderActiveStats();
}

// A page served over http cannot navigate to file:// — hand the path over
// instead (the "Open folder" precedent in the project drawer).
function daCopyPath(path) {
  if (!path) return;
  if (!navigator.clipboard) return toast(path, "warn");
  navigator.clipboard.writeText(path).then(
    () => toast("Path copied — paste it into Explorer."),
    () => toast(path, "warn"));
}

// Prompt-free re-queue through the server-side RPC: the message append and the
// status flip happen atomically in the database, and the runner's claim fence
// handles a job it was mid-way through.
async function requeueDrawingJob(id) {
  const { data, error } = await sb.rpc("queue_drawing_job", {
    p_job_id: id, p_text: null, p_payload: null,
  });
  if (error) return fail("Re-queuing the job", error);
  if (data == null || (Array.isArray(data) && !data.length)) {
    return toast("That job could not be re-queued — nothing was written.", "warn");
  }
  toast("Re-queued — it runs with the facts approved as of now.");
  await loadDrawingJobs();
  syncDrawingPoll();
}

// Deleting removes the RECORD. Files already uploaded, rendered or filed on
// the office machine stay on disk — the app cannot and must not delete inside
// the Dropbox tree.
async function deleteDrawingJob(id) {
  const j = drawingJobs.find((x) => x.id === id);
  if (!j) return;
  let msg = `Delete this ${(DRAWING_KIND_LABEL[j.kind] || j.kind).toLowerCase()} job record (${
    labelFor(j.project_id)})? This cannot be undone.\n\nOnly the record here is removed — ` +
    `anything already uploaded, rendered or filed on the office machine stays on disk.`;
  if (j.status === "working") {
    msg += `\n\nIt is running RIGHT NOW — the run will finish but nothing will record it.`;
  }
  if (Array.isArray(j.outputs) && j.outputs.length) {
    msg += `\n\nOutputs that stay on disk:\n${j.outputs.map((o) => o.path).join("\n")}`;
  }
  if (!confirm(msg)) return;
  const { data, error } = await sb.from("drawing_jobs").delete().eq("id", id).select("id");
  if (error) return fail("Deleting the job", error);
  if (!data || !data.length) return toast("Nothing was deleted.", "warn");
  daExpanded.delete(id);
  await loadDrawingJobs();
  toast("Job record deleted — files stay on disk.");
}

// ---- design manifest (facts) ----------------------------------------------

function daProvenance(f) {
  const val = `${f.value ?? ""}${f.units ? ` ${f.units}` : ""}`.trim();
  const src = `${f.source || "no source"}${f.source_ref ? ` ${f.source_ref}` : ""}`;
  return `${val || "—"} — ${src} — ${f.extracted_by ? "extracted" : "engineer"}`;
}

function renderDrawingFacts() {
  // The project whose rows are actually in `projectFacts` — not whatever the
  // filter says right now. These must never disagree.
  const proj = daFactsFor;
  $("da-facts-scope").textContent = proj
    ? `— ${labelFor(proj)}` : "— pick the active project above";
  const box = $("da-facts-list");
  if (!proj) {
    box.innerHTML = `<div class="empty">Pick the active project at the top of this tab —
      the manifest, setup, tables and checker all work on that one job.</div>`;
    return;
  }
  const approved = projectFacts.filter((f) => f.status === "approved");
  const proposed = projectFacts.filter((f) => f.status === "proposed");
  if (!approved.length && !proposed.length) {
    box.innerHTML = `<div class="empty">No facts yet on ${escapeHtml(labelFor(proj))} — queue a
      project setup with a geotech report to extract some, or add one below.</div>`;
    return;
  }
  const row = (f) => `
    <tr>
      <td>${escapeHtml(f.label || f.key)}<div class="small muted mono">${escapeHtml(f.key)}</div></td>
      <td>${escapeHtml(f.value ?? "")}${
        f.units ? ` <span class="muted small">${escapeHtml(f.units)}</span>` : ""}</td>
      <td><span class="tag">${escapeHtml(f.fact_class)}</span></td>
      <td><div class="da-prov">${escapeHtml(daProvenance(f))}</div>${
        f.notes ? `<div class="small muted">${escapeHtml(f.notes)}</div>` : ""}</td>
      <td class="right" style="white-space:nowrap">${
        f.status === "proposed" && isAdmin()
          ? `<button class="btn sm" data-dafapp="${f.id}"
               title="Approve — prefill, table seeding and the checker consume approved facts only. Approving supersedes any earlier approved value for this key.">Approve</button>
             <button class="btn ghost sm" data-dafrej="${f.id}">Reject</button>`
          : ""}</td>
    </tr>`;
  const group = (label, list) => list.length ? `
    <div class="tgroup">
      <div class="gh">${label} <span>${list.length}</span></div>
      <div class="grid-wrap"><table><tbody>${list.map(row).join("")}</tbody></table></div>
    </div>` : "";
  box.innerHTML =
    group("Approved", approved) +
    group("Proposed — awaiting review", proposed);

  // innerHTML-created controls: re-wired after every render.
  box.querySelectorAll("[data-dafapp]").forEach((b) =>
    b.addEventListener("click", () => approveDrawingFact(Number(b.dataset.dafapp))));
  box.querySelectorAll("[data-dafrej]").forEach((b) =>
    b.addEventListener("click", () => rejectDrawingFact(Number(b.dataset.dafrej))));
}

async function approveDrawingFact(id) {
  // approve_fact() supersedes any prior approved row for the same
  // (project, key) atomically — the partial unique index owns that rule.
  const { data, error } = await sb.rpc("approve_fact", { p_fact_id: id });
  if (error) return fail("Approving the fact", error);
  if (data == null || (Array.isArray(data) && !data.length)) {
    return toast("Nothing was approved — that fact may already be decided.", "warn");
  }
  toast("Approved — jobs queued from now on use it.");
  await loadDrawingFacts();
}

async function rejectDrawingFact(id) {
  // Status guard in the WHERE clause: a fact approved from another tab must
  // not be quietly flipped to rejected by a stale button.
  const { data, error } = await sb.from("project_facts")
    .update({ status: "rejected" }).eq("id", id).eq("status", "proposed").select("id");
  if (error) return fail("Rejecting the fact", error);
  if (!data || !data.length) return toast("Nothing changed — that fact is no longer proposed.", "warn");
  toast("Rejected.");
  await loadDrawingFacts();
}

// The add-fact form — the only door for decision-class values. Filled from the
// static registry, so it can populate at module scope like the kind selects.
$("da-fact-key").innerHTML = ["verbatim", "selection", "decision"].map((cls) =>
  `<optgroup label="${
    cls === "verbatim" ? "Verbatim — the report states it outright"
    : cls === "selection" ? "Selection — the report offers alternatives"
    : "Decision — what the engineer chose"}">` +
  FACT_KEYS.filter((k) => k.fact_class === cls).map((k) =>
    `<option value="${escapeHtml(k.key)}">${escapeHtml(k.label)}</option>`).join("") +
  `</optgroup>`).join("");

function daSyncFactUnits() {
  const reg = FACT_KEYS.find((k) => k.key === $("da-fact-key").value);
  $("da-fact-units").placeholder = (reg && reg.units) || "—";
}
$("da-fact-key").addEventListener("change", daSyncFactUnits);
daSyncFactUnits();

$("da-fact-add").addEventListener("click", async () => {
  // ADMIN, not canDesign(): the design manifest records what the ENGINEER
  // decided, and decision-class values are his alone. RLS agrees —
  // project_facts is SELECT-only for a designer (migration 0021).
  if (!isAdmin()) return;
  // The project the panel is SHOWING, so a fact can never be written to a job
  // other than the one whose manifest is on screen.
  const proj = daFactsFor;
  if (!proj) return toast("Pick a project in the filter above first.", "err");
  const key = $("da-fact-key").value;
  const reg = FACT_KEYS.find((k) => k.key === key);
  if (!reg) return toast("Pick a fact.", "err");
  const value = $("da-fact-value").value.trim();
  if (!value) return toast("Enter the value.", "err");
  // Blank units fall back to the registry's usual unit — the placeholder reads
  // that way, and a bare bearing capacity would be wrong on a sheet.
  const units = $("da-fact-units").value.trim() || reg.units || "";
  $("da-fact-add").disabled = true;
  try {
    const { data, error } = await sb.rpc("set_fact", {
      p_project_id: Number(proj), p_key: key, p_label: reg.label,
      p_value: value, p_units: units, p_fact_class: reg.fact_class,
      p_notes: $("da-fact-notes").value.trim() || null,
    });
    if (error) return fail("Saving the fact", error);
    if (data == null || (Array.isArray(data) && !data.length)) {
      return toast("That fact did not save — nothing was written.", "warn");
    }
    $("da-fact-value").value = "";
    $("da-fact-units").value = "";
    $("da-fact-notes").value = "";
    toast("Saved — jobs queued from now on use it.");
    await loadDrawingFacts();
  } finally {
    $("da-fact-add").disabled = false;
  }
});

// ---- uploads (storage bucket drawing-intake) ------------------------------
// Upload FIRST, insert the row only once every object landed: a row that
// references an object that never arrived is a job the runner can only fail.
// Hash and upload the SAME bytes — the runner re-hashes after download and
// refuses a mismatch, which is what catches a truncated upload.
async function daUploadFiles(files) {
  const jobFolder = `job-${crypto.randomUUID()}`;
  const uploads = [];
  for (const { slot, file } of files) {
    const buf = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const object = `${jobFolder}/${slot}.pdf`;
    const { error } = await sb.storage.from("drawing-intake")
      .upload(object, buf, { contentType: "application/pdf" });
    if (error) throw new Error(`${slot}: ${error.message}`);
    uploads.push({ slot, object, name: file.name, sha256, size: file.size });
  }
  return uploads;
}

// Best-effort cleanup when the row insert fails after a successful upload.
// The bucket is a transient inbox either way; the runner ignores objects no
// row references.
async function daRemoveUploads(uploads) {
  if (!uploads || !uploads.length) return;
  try { await sb.storage.from("drawing-intake").remove(uploads.map((u) => u.object)); }
  catch { /* transient bucket; nothing depends on this succeeding */ }
}

// ---- project setup composer -----------------------------------------------

function renderDrawingSheets() {
  const kit = DRAWING_KITS[$("da-kit").value] || DRAWING_KITS.residential;
  $("da-sheets").innerHTML = kit.sheets.map(([key, title, core]) => `
    <label><input type="checkbox" data-dasheet="${escapeHtml(key)}"${core ? " checked" : ""}>
      <span class="mono small">${escapeHtml(key)}</span> ${escapeHtml(title)}${
      core ? "" : ` <span class="muted small">(extended)</span>`}</label>`).join("");
}
$("da-kit").addEventListener("change", renderDrawingSheets);
renderDrawingSheets();

$("da-opt-rr").addEventListener("change", () =>
  $("da-rr-depth-wrap").classList.toggle("hidden", !$("da-opt-rr").checked));
// The readiness line describes what PREFILL will do, so it follows the box.
$("da-opt-prefill").addEventListener("change", daRenderGenReady);

// Analyze: files + verification + proposals, no sheets. At least one document
// is required — an analyze with nothing attached has nothing to do, and the
// runner would refuse it anyway; refuse it here with the reason.
$("da-analyze-go").addEventListener("click", async () => {
  if (!canDesign()) return;
  const projectId = $("da-proj").value;
  if (!projectId) return toast("Pick the active project at the top of the tab first.", "err");
  const arch = $("da-file-arch").files[0] || null;
  const geotech = $("da-file-geotech").files[0] || null;
  if (!arch && !geotech) {
    return toast("Attach the architectural set and/or the geotech report — analyze files and reads them.", "err");
  }
  const note = $("da-analyze-notes").value.trim();
  $("da-analyze-go").disabled = true;
  try {
    let uploads;
    try {
      uploads = await daUploadFiles([
        ...(arch ? [{ slot: "arch", file: arch }] : []),
        ...(geotech ? [{ slot: "geotech", file: geotech }] : []),
      ]);
    } catch (e) { return fail("Uploading the PDFs (nothing was queued)", e); }
    const { data, error } = await sb.from("drawing_jobs").insert({
      project_id: Number(projectId), kind: "analyze", payload: {},
      upload_paths: uploads, status: "queued",
      messages: note ? [{ at: new Date().toISOString(), text: note }] : [],
      requested_by: me.id,
    }).select("id");
    if (error) { await daRemoveUploads(uploads); return fail("Queuing the analyze", error); }
    if (!data || !data.length) {
      await daRemoveUploads(uploads);
      return toast("That did not queue — nothing was written.", "warn");
    }
    $("da-file-arch").value = "";
    $("da-file-geotech").value = "";
    $("da-analyze-notes").value = "";
    toast("Analyze queued — the office machine files, verifies and proposes facts.");
    await Promise.all([loadDrawingJobs(), loadDrawingFacts()]);
    syncDrawingPoll();
  } finally {
    $("da-analyze-go").disabled = false;
  }
});

// Does any job on this project carry a FILED architectural set? Advisory for
// the composer only — the runner re-derives it (latestFiledArch) and degrades
// the background honestly if the file is gone by the time the job runs.
function daHasFiledArch(projectId) {
  return drawingJobs.some((j) => String(j.project_id) === String(projectId)
    && (Array.isArray(j.upload_paths) ? j.upload_paths : [])
      .some((u) => u?.slot === "arch" && u.filed));
}

// …and is one still IN FLIGHT? An analyze that just queued has an arch upload
// but no filed path yet — telling its author to "run Analyze first" when they
// just did names a wrong cause and invites a duplicate upload.
function daHasPendingArch(projectId) {
  return drawingJobs.some((j) => String(j.project_id) === String(projectId)
    && (j.status === "queued" || j.status === "working")
    && (Array.isArray(j.upload_paths) ? j.upload_paths : [])
      .some((u) => u?.slot === "arch" && !u.filed));
}

// Generate: assemble + prefill from APPROVED facts. No uploads — the manifest
// is the input, which is exactly what makes the first generated set complete.
$("da-generate-go").addEventListener("click", async () => {
  if (!canDesign()) return;
  const projectId = $("da-proj").value;
  if (!projectId) return toast("Pick the active project at the top of the tab first.", "err");
  const sheets = [...document.querySelectorAll("#da-sheets [data-dasheet]:checked")]
    .map((c) => c.dataset.dasheet);
  if (!sheets.length) return toast("Check at least one sheet.", "err");
  if ($("da-opt-background").checked && !daHasFiledArch(projectId)) {
    return toast(daHasPendingArch(projectId)
      ? "Your analyze with the arch PDF is still running — wait for it to finish filing, then queue this generate."
      : "The drafting background reads the architectural set a previous Analyze filed — " +
        "run Analyze with the arch PDF first, or untick the option.", "err");
  }
  const sub = (v) => Boolean(document.querySelector(`#panel-drawing [data-dasub][value="${v}"]`)?.checked);
  const obs = (v) => Boolean(document.querySelector(`#panel-drawing [data-daobs][value="${v}"]`)?.checked);
  const rr = $("da-opt-rr").checked;
  const payload = {
    kit: $("da-kit").value,
    sheets,
    options: {
      prefill: $("da-opt-prefill").checked,
      background: $("da-opt-background").checked,
      callouts: [...document.querySelectorAll("#panel-drawing [data-dacallout]:checked")]
        .map((c) => c.value),
      submittals: {
        truss_shops: sub("truss_shops"), steel_shops: sub("steel_shops"),
        mix_designs: sub("mix_designs"), pad_compaction: sub("pad_compaction"),
        swell_tests: sub("swell_tests"),
      },
      observations: {
        foundation_excavation: obs("foundation_excavation"),
        concrete_placement: obs("concrete_placement"),
        framing: obs("framing"), sheathing_nailing: obs("sheathing_nailing"),
      },
      remove_replace: { required: rr, depth: rr ? $("da-rr-depth").value.trim() : "" },
    },
  };
  const note = $("da-generate-notes").value.trim();
  $("da-generate-go").disabled = true;
  try {
    const { data, error } = await sb.from("drawing_jobs").insert({
      project_id: Number(projectId), kind: "generate", payload,
      upload_paths: [], status: "queued",
      messages: note ? [{ at: new Date().toISOString(), text: note }] : [],
      requested_by: me.id,
    }).select("id");
    if (error) return fail("Queuing the generate", error);
    if (!data || !data.length) return toast("That did not queue — nothing was written.", "warn");
    $("da-generate-notes").value = "";
    toast("Generate queued — the office machine assembles and prefills from approved facts.");
    await loadDrawingJobs();
    syncDrawingPoll();
  } finally {
    $("da-generate-go").disabled = false;
  }
});

// ---- table builder composer -----------------------------------------------

$("da-ttype").innerHTML = Object.entries(TABLE_TYPES).map(([k, t]) =>
  `<option value="${k}">${escapeHtml(t.label)}</option>`).join("");

let daOutTouched = false;    // stop auto-fill from clobbering a hand-set out name

function daTitleCase(s) {
  return String(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).trim();
}
function daTableType() { return $("da-ttype").value; }
function daCurrentCols() {
  if (daTableType() === "custom") {
    return $("da-tcols").value.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return TABLE_TYPES[daTableType()].columns.slice();
}
// Raw harvest, blanks kept: a re-render (add row, column change) must not eat
// a row someone left empty on purpose. Queue-time is where blanks are dropped.
function daHarvestRows() {
  return [...$("da-trows-body").querySelectorAll("tr")].map((tr) =>
    [...tr.querySelectorAll("input[data-dacell]")].map((i) => i.value));
}
function renderTableGrid(rows) {
  const cols = daCurrentCols();
  if (!cols.length) {
    $("da-trows-head").innerHTML = `<th class="muted">Define columns above</th>`;
    $("da-trows-body").innerHTML = "";
    return;
  }
  $("da-trows-head").innerHTML = cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
  if (!rows.length) rows = [Array(cols.length).fill("")];
  $("da-trows-body").innerHTML = rows.map((r) =>
    `<tr>${cols.map((_, i) =>
      `<td><input type="text" data-dacell value="${escapeHtml(r[i] ?? "")}"></td>`).join("")}</tr>`).join("");
}

$("da-ttype").addEventListener("change", () => {
  const t = TABLE_TYPES[daTableType()];
  $("da-tcols-wrap").classList.toggle("hidden", daTableType() !== "custom");
  $("da-ttitle").value = t.title;
  daOutTouched = false;
  $("da-tout").value = daTitleCase(t.title);
  renderTableGrid(t.rows.map((r) => r.slice()));
});
$("da-tcols").addEventListener("change", () => renderTableGrid(daHarvestRows()));
$("da-trow-add").addEventListener("click", () => {
  const rows = daHarvestRows();
  rows.push([]);
  renderTableGrid(rows);
});
$("da-trow-del").addEventListener("click", () => {
  const rows = daHarvestRows();
  rows.pop();
  renderTableGrid(rows);
});
$("da-ttitle").addEventListener("input", () => {
  if (!daOutTouched) $("da-tout").value = daTitleCase($("da-ttitle").value);
});
$("da-tout").addEventListener("input", () => { daOutTouched = true; });

// Seed the grid for the initially selected type.
(function daInitTableComposer() {
  const t = TABLE_TYPES[daTableType()];
  $("da-ttitle").value = t.title;
  $("da-tout").value = daTitleCase(t.title);
  renderTableGrid(t.rows.map((r) => r.slice()));
})();

$("da-table-go").addEventListener("click", async () => {
  if (!canDesign()) return;
  const projectId = $("da-tproj").value;
  if (!projectId) return toast("Pick the active project at the top of the tab first.", "err");
  const cols = daCurrentCols();
  if (!cols.length) return toast("Define at least one column.", "err");
  const rows = daHarvestRows()
    .map((r) => cols.map((_, i) => (r[i] ?? "").trim()))
    .filter((r) => r.some((c) => c !== ""));
  if (!rows.length) return toast("Fill in at least one row.", "err");
  const title = $("da-ttitle").value.trim();
  if (!title) return toast("Give the table a title.", "err");
  // Same bounds the runner's validateTableSpec enforces — (1, 34] and
  // (0.5, 22] — so an out-of-range size is refused here with a sentence Ben
  // can act on, instead of queueing a job that comes back `error` minutes later.
  const width = parseFloat($("da-twidth").value);
  const height = parseFloat($("da-theight").value);
  if (!(width > 1 && width <= 34)) {
    return toast("Width must be more than 1 in and at most 34 in (the sheet's long side).", "err");
  }
  if (!(height > 0.5 && height <= 22)) {
    return toast("Height must be more than 0.5 in and at most 22 in (the sheet's short side).", "err");
  }
  const payload = {
    table_type: daTableType(),
    title,
    columns: cols,
    rows,
    footnote: $("da-tfoot").value.trim(),
    width_in: width,
    height_in: height,
    out_name: $("da-tout").value.trim() || daTitleCase(title),
  };
  $("da-table-go").disabled = true;
  try {
    const { data, error } = await sb.from("drawing_jobs").insert({
      project_id: Number(projectId), kind: "table", payload,
      upload_paths: [], messages: [], status: "queued", requested_by: me.id,
    }).select("id");
    if (error) return fail("Queuing the table", error);
    if (!data || !data.length) return toast("That did not queue — nothing was written.", "warn");
    toast("Table queued — it renders into working cad\\tables.");
    await loadDrawingJobs();
    syncDrawingPoll();
  } finally {
    $("da-table-go").disabled = false;
  }
});

// ---- checker composer -----------------------------------------------------

function daSyncCheckerMode() {
  const compare = $("da-cmode-compare").checked;
  $("da-subject-wrap").classList.toggle("hidden", compare);
  $("da-compare-wrap").classList.toggle("hidden", !compare);
  $("da-cscope-wrap").classList.toggle("hidden", compare);
  $("da-check-go").textContent = compare ? "Queue compare" : "Queue check";
}
document.querySelectorAll('input[name="da-cmode"]').forEach((r) =>
  r.addEventListener("change", daSyncCheckerMode));
daSyncCheckerMode();

$("da-check-go").addEventListener("click", async () => {
  if (!canDesign()) return;
  const projectId = $("da-cproj").value;
  if (!projectId) return toast("Pick the active project at the top of the tab first.", "err");
  const compare = $("da-cmode-compare").checked;
  const engines = [
    ...($("da-eng-claude").checked ? ["claude"] : []),
    ...($("da-eng-codex").checked ? ["codex"] : []),
  ];
  if (!engines.length) return toast("Pick at least one engine.", "err");
  const notes = $("da-check-notes").value.trim();
  const slots = [];
  if (compare) {
    const oldF = $("da-file-old").files[0];
    const newF = $("da-file-new").files[0];
    if (!oldF || !newF) return toast("A compare needs both revisions.", "err");
    slots.push({ slot: "old", file: oldF }, { slot: "new", file: newF });
  } else {
    const subject = $("da-file-subject").files[0];
    if (!subject) return toast("Attach the drawing set to check.", "err");
    slots.push({ slot: "subject", file: subject });
  }
  const payload = compare
    ? { engines, notes }
    : { engines, scope: $("da-cscope").value, notes };
  $("da-check-go").disabled = true;
  try {
    let uploads;
    try { uploads = await daUploadFiles(slots); }
    catch (e) { return fail("Uploading the PDFs (nothing was queued)", e); }
    const { data, error } = await sb.from("drawing_jobs").insert({
      project_id: Number(projectId), kind: compare ? "compare" : "check",
      payload, upload_paths: uploads, status: "queued", messages: [],
      requested_by: me.id,
    }).select("id");
    if (error) { await daRemoveUploads(uploads); return fail("Queuing the check", error); }
    if (!data || !data.length) {
      await daRemoveUploads(uploads);
      return toast("That did not queue — nothing was written.", "warn");
    }
    $("da-file-subject").value = "";
    $("da-file-old").value = "";
    $("da-file-new").value = "";
    $("da-check-notes").value = "";
    toast(compare
      ? "Compare queued — per-sheet pairing, then the diff and the engines."
      : "Check queued — deterministic pass first, then the engines.");
    await loadDrawingJobs();
    syncDrawingPoll();
  } finally {
    $("da-check-go").disabled = false;
  }
});

// ---------------------------------------------------------------- admin

let people = [];
let assignFor = null;

async function loadPeople() {
  const { data, error } = await sb
    .from("employees")
    .select("id, email, full_name, role, active, rate_class, can_design")
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
