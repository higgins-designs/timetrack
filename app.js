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
let dayDate = ymd(new Date());   // the day the entry panel is showing
let dayEntries = [];
let weekStart = startOfWeek(new Date());
let weekEntries = [];     // FINISHED entries for the week
let weekRunning = [];     // LIVE timers in the week - must be visible to the grid
let tick = null;
const savingCells = new Set();

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
    .select("id, email, full_name, role, active")
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
  await Promise.all([loadRunning(), loadDay(), loadWeek()]);
  if (me.role === "admin") {
    $("admin-card").classList.remove("hidden");
    $("tab-people-btn").classList.remove("hidden");
    await loadPeople();
  }
  initVisitForm();   // needs projects, and people if this is an admin
}

// Every project you have access to, including closed ones — a warranty visit or
// a late correction lands on a job that closed months ago, and it still has to
// be loggable. Grouped so the live work stays at the top of a long list.
function fillProjectSelect(sel, list) {
  if (!sel) return;
  const keep = sel.value;
  sel.innerHTML = "";
  const groups = [
    ["Active", list.filter((p) => !p.is_overhead && p.status === "active")],
    ["On hold", list.filter((p) => !p.is_overhead && p.status === "on_hold")],
    ["Overhead", list.filter((p) => p.is_overhead)],
    ["Closed", list.filter((p) => !p.is_overhead && p.status === "closed")],
  ];
  for (const [label, items] of groups) {
    if (!items.length) continue;
    const g = document.createElement("optgroup");
    g.label = `${label} (${items.length})`;
    for (const p of items) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = projLabel(p);
      g.appendChild(o);
    }
    sel.appendChild(g);
  }
  if (keep) sel.value = keep;
}

async function loadProjects() {
  const { data, error } = await sb
    .from("projects")
    .select("id, number, name, is_overhead, status")
    .order("is_overhead", { ascending: true })
    .order("number", { ascending: false });

  if (error) return fail("Loading projects", error);
  projects = data || [];
  for (const p of projects) labelCache[p.id] = projLabel(p);

  if (!projects.length) toast("No projects are assigned to you yet.", "warn");

  fillProjectSelect($("proj"), projects);
  fillProjectSelect($("m-proj"), projects);
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

async function loadRunning() {
  const { data, error } = await sb
    .from("time_entries")
    .select("id, project_id, task_kind, notes, started_at, work_date")
    .eq("employee_id", me.id)
    .is("ended_at", null)
    .not("started_at", "is", null)
    .maybeSingle();

  if (error) return fail("Checking the running timer", error);
  running = data || null;
  renderTimer();
}

function renderTimer() {
  const box = $("timer");
  clearInterval(tick);

  if (!running) {
    box.classList.add("idle");
    $("stop-btn").classList.add("hidden");
    $("elapsed").textContent = "0:00:00";
    $("timer-what").innerHTML =
      `<div class="proj">Nothing running</div>
       <div class="sub">Pick a project below and start the clock.</div>`;
    return;
  }

  box.classList.remove("idle");
  $("stop-btn").classList.remove("hidden");
  $("timer-what").innerHTML =
    `<div class="proj">${escapeHtml(labelFor(running.project_id))}</div>
     <div class="sub">${escapeHtml(KIND_LABEL[running.task_kind] || running.task_kind)}${
       running.notes ? " · " + escapeHtml(running.notes) : ""
     }</div>`;

  const started = new Date(running.started_at);
  const paint = () => ($("elapsed").textContent = hhmmss(Date.now() - started.getTime()));
  paint();
  tick = setInterval(paint, 1000);
}

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
  if (!running) {
    // Never report success for a stop that wrote nothing.
    toast("There was no running timer to stop.", "warn");
    return false;
  }
  const ended = new Date();
  const started = new Date(running.started_at);
  // Round up, so a 40-second call is a minute rather than nothing.
  const minutes = Math.max(1, Math.ceil((ended - started) / 60000));

  // `.is("ended_at", null)` is what stops a stale tab from rewriting an entry
  // that was already closed elsewhere and inflating its minutes.
  const { data, error } = await sb
    .from("time_entries")
    .update({ ended_at: ended.toISOString(), minutes })
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
      <td class="right"><button class="btn ghost" data-del="${e.id}"
            style="padding:3px 9px;font-size:12px">Delete</button></td>`;
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
  const { error } = await sb.from("time_entries").delete().eq("id", id);
  if (error) return fail("Deleting the entry", error);
  await Promise.all([loadDay(), loadWeek()]);
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
  if ($("proj").value) ids.add(String($("proj").value));
  // Built from the entries, NOT from the picker, so hours on a project that has
  // since been closed or unassigned still appear and still count.
  return [...ids].map((id) => ({ id, label: labelFor(id) }))
                 .sort((a, b) => a.label.localeCompare(b.label));
}

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
      const val = totalMin ? (totalMin / 60).toFixed(2).replace(/\.?0+$/, "") : "";
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
    // Clicking a day opens that day in the entry panel above, which is the only
    // way to correct or delete a timer entry on a past day.
    inp.addEventListener("focus", async () => {
      if (inp.dataset.date !== dayDate) { dayDate = inp.dataset.date; await loadDay(); }
    });
  });
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
  for (const p of ["time", "visits", "people"]) {
    $(`panel-${p}`).classList.toggle("hidden", p !== name);
  }
  if (name === "visits") loadVisits();
}

// --------------------------------------------------------- site visits

let visits = [];

const OUTCOME_LABEL = { pending: "Pending", passed: "Passed", failed: "Failed", na: "n/a" };
const COMMON_TYPES = [
  "Pre-pour inspection", "Pre-pour inspection (piers)", "Pre-pour inspection (pool)",
  "Framing inspection", "Sheathing inspection", "Pier inspection", "Excavation inspection",
  "Wall removal assessment", "House assessment", "Joist assessment", "Ledger inspection",
  "Deck framing inspection", "Project walkthrough", "Site visit",
];

async function loadVisits() {
  const { data, error } = await sb
    .from("site_visits")
    .select(`id, project_id, visit_date, start_time, end_time, attendee_id, attendee_name,
             visit_type, outcome, notes, distance_mi, duration_min, depart_time,
             suggested_rate, rate, rate_ambiguous, calendar_event_id, source`)
    .order("visit_date", { ascending: false })
    .order("id", { ascending: false });

  if (error) return fail("Loading site visits", error);
  visits = data || [];
  await ensureLabels(visits.map((v) => v.project_id));
  renderVisitFilters();
  renderVisitStats();
  renderVisits();
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
    // A suggested rate is shown as a suggestion, never as a decided fee.
    const rate = v.rate != null
      ? `$${v.rate}`
      : v.suggested_rate
        ? `<span class="muted" title="Suggested from distance — not confirmed">~$${v.suggested_rate}${
            v.rate_ambiguous ? " ?" : ""}</span>`
        : `<span class="muted">—</span>`;
    const cal = v.calendar_event_id
      ? `<span class="tag" style="color:var(--ok);border-color:var(--ok)">booked</span>`
      : v.source === "import"
        ? `<span class="tag">historical</span>`
        : `<span class="tag nb">not booked</span>`;

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
      <td class="num small">${rate}</td>
      <td>${cal}</td>
      <td class="right"><button class="btn ghost" data-vdel="${v.id}"
            style="padding:3px 9px;font-size:12px">Delete</button></td>`;
    body.appendChild(tr);
  }

  body.querySelectorAll("[data-outcome]").forEach((s) =>
    s.addEventListener("change", () => saveVisit(s.dataset.outcome, { outcome: s.value })));
  body.querySelectorAll("[data-vdel]").forEach((b) =>
    b.addEventListener("click", () => deleteVisit(b.dataset.vdel)));
}

async function saveVisit(id, patch) {
  const { error } = await sb.from("site_visits").update(patch).eq("id", id);
  if (error) fail("Saving that visit", error);
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
  const { error } = await sb.from("site_visits").delete().eq("id", id);
  if (error) return fail("Deleting the visit", error);
  await loadVisits();
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
  fillProjectSelect($("v-proj"), projects);
  // Only admins can see the whole roster, so everyone else can only book themselves.
  const who = $("v-who");
  who.innerHTML = (people.length ? people : [me])
    .filter((p) => p.active !== false)
    .map((p) => `<option value="${p.id}"${p.id === me.id ? " selected" : ""}>${
      escapeHtml(p.full_name)}</option>`).join("");
}

// ---------------------------------------------------------------- admin

let people = [];
let assignFor = null;

async function loadPeople() {
  const { data, error } = await sb
    .from("employees")
    .select("id, email, full_name, role, active")
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
      <td><input type="checkbox" data-active="${p.id}" ${p.active ? "checked" : ""}
                 ${lock ? "disabled" : ""}></td>
      <td class="num">${tally[p.id] || 0}</td>
      <td class="right"><button class="btn ghost" data-assign="${p.id}"
            style="padding:3px 9px;font-size:12px">Projects</button></td>`;
    body.appendChild(tr);
  }

  // Your own row, and the last remaining admin, are locked so the firm cannot
  // be left with nobody able to administer it.
  body.querySelectorAll("[data-role]").forEach((s) =>
    s.addEventListener("change", () => savePerson(s.dataset.role, { role: s.value })));
  body.querySelectorAll("[data-active]").forEach((c) =>
    c.addEventListener("change", () => savePerson(c.dataset.active, { active: c.checked })));
  body.querySelectorAll("[data-assign]").forEach((b) =>
    b.addEventListener("click", () => openAssign(b.dataset.assign)));
}

async function savePerson(id, patch) {
  const { error } = await sb.from("employees").update(patch).eq("id", id);
  // Reload either way: on failure the control must snap back to the truth
  // rather than sit there showing a change that never landed.
  if (error) fail("Saving that person", error);
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

  fillProjectSelect($("assign-proj"), all || []);

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
