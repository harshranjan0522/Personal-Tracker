/* ============================================================
   Daily Tracker — local-first tasks, money & bill splitting
   No backend. Everything lives in localStorage on this device.
   ============================================================ */
'use strict';

/* ---------------- Tiny DOM helpers ---------------- */
const $  = (q, root = document) => root.querySelector(q);
const $$ = (q, root = document) => Array.from(root.querySelectorAll(q));
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const icon = (id, cls = 'ico') => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;

function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

/* ---------------- Date helpers (LOCAL time, not UTC) ----------------
   The original app used new Date().toISOString().slice(0,10), which is a
   UTC date. In IST (UTC+5:30) that rolls over at 05:30 local, so "today"
   was wrong for a big chunk of every day. Everything below stays local. */
const pad2      = n => String(n).padStart(2, '0');
const toISO     = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const todayISO  = () => toISO(new Date());
const parseISO  = s => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); };
const addDays   = (iso, n) => { const d = parseISO(iso); d.setDate(d.getDate() + n); return toISO(d); };
const monthKey  = iso => String(iso).slice(0, 7);
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();

const DOW   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTH = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function humanDate(iso){
  if (!iso) return '—';
  const t = todayISO();
  if (iso === t)             return 'Today';
  if (iso === addDays(t, -1)) return 'Yesterday';
  if (iso === addDays(t,  1)) return 'Tomorrow';
  const d = parseISO(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${DOW[d.getDay()]}, ${d.getDate()} ${MONTH[d.getMonth()]}${sameYear ? '' : ' ' + d.getFullYear()}`;
}
function humanDateTime(s){
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d)) return '—';
  return `${humanDate(toISO(d))} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function humanTime(t){
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  const ap = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad2(m)}${ap}`;
}

/* ---------------- Money (integer minor units — no float drift) ---------------- */
const toMinor   = n => Math.round((Number(n) || 0) * 100);
const fromMinor = m => m / 100;

const CURRENCIES = [
  ['INR','₹ Indian Rupee'], ['USD','$ US Dollar'],   ['EUR','€ Euro'],
  ['GBP','£ Pound'],        ['AED','د.إ Dirham'],    ['SGD','S$ Singapore Dollar'],
  ['AUD','A$ Australian Dollar'], ['CAD','C$ Canadian Dollar'], ['JPY','¥ Yen'],
];

function money(v, opts = {}){
  const n = Number(v) || 0;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency: state.settings.currency,
      minimumFractionDigits: opts.compact ? 0 : 2,
      maximumFractionDigits: opts.compact ? 0 : 2,
    }).format(n);
  } catch { return n.toFixed(2); }
}
const moneyAbs = v => money(Math.abs(Number(v) || 0));

/* ---------------- Reference data ---------------- */
const PRIORITY_ORDER = { High: 3, Medium: 2, Low: 1 };
const REPEAT_LABEL = { none:'', daily:'Daily', weekdays:'Weekdays', weekly:'Weekly', monthly:'Monthly' };

const CATEGORIES = {
  Debit:  ['Food & drink','Groceries','Transport','Rent','Bills & utilities','Shopping','Health','Entertainment','Travel','Education','Subscriptions','Gifts','Other'],
  Credit: ['Salary','Freelance','Business','Investment','Refund','Gift','Other'],
};

const PERSON_COLORS = ['#1c5c3b','#2c5578','#96690d','#a8371a','#5c4a7d','#2f6f6b','#8a5a2b','#4a6b2a','#7d3f5c','#3a4a7a'];

/* ---------------- Store ---------------- */
const STORAGE_KEY = 'dt_state_v2';
const LEGACY = { tasks: 'dt_tasks_v1', expenses: 'dt_expenses_v1', lastSeen: 'dt_last_seen' };

const uid = () => (crypto.randomUUID ? crypto.randomUUID()
                 : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

function defaultState(){
  return {
    version: 2,
    settings: {
      currency: 'INR',
      theme: 'dark',
      budget: 0,
      showOverdue: true,
      myShareOnly: true,
      confirmDelete: true,
    },
    people: [{ id: 'me', name: 'You', color: PERSON_COLORS[0], isMe: true, archived: false }],
    tasks: [],
    expenses: [],
    settlements: [],
  };
}

let state = defaultState();
let storageWritable = true;

function save(){
  if (!storageWritable) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    storageWritable = false;
    toast('Could not save — browser storage is full or blocked.', 'err', 8000);
    console.error('[tracker] save failed', err);
  }
}

function load(){
  let raw = null;
  try { raw = localStorage.getItem(STORAGE_KEY); }
  catch { storageWritable = false; toast('Storage is blocked — changes will not persist.', 'err', 8000); }

  if (raw){
    try { state = reconcile(JSON.parse(raw)); return; }
    catch (err){ console.error('[tracker] corrupt state, starting fresh', err); }
  }
  state = migrateLegacy() ?? defaultState();
  save();
}

/* Pull forward data from the original v1 single-file app so nothing is lost. */
function migrateLegacy(){
  let oldTasks = [], oldExp = [];
  try { oldTasks = JSON.parse(localStorage.getItem(LEGACY.tasks) || '[]'); } catch {}
  try { oldExp   = JSON.parse(localStorage.getItem(LEGACY.expenses) || '[]'); } catch {}
  if (!oldTasks.length && !oldExp.length) return null;

  const s = defaultState();
  s.tasks = oldTasks.map(t => ({
    id: t.id || uid(),
    title: t.title || 'Untitled',
    notes: t.notes || '',
    date: t.date || todayISO(),
    time: t.time || '',
    deadline: t.deadline || '',
    priority: PRIORITY_ORDER[t.priority] ? t.priority : 'Medium',
    tags: [],
    completed: !!t.completed,
    completedAt: t.completed ? Date.now() : null,
    repeat: 'none', seriesId: null,
    createdAt: Date.now(), updatedAt: Date.now(),
  }));
  s.expenses = oldExp.map(e => ({
    id: e.id || uid(),
    date: e.date || todayISO(),
    type: e.type === 'Credit' ? 'Credit' : 'Debit',
    amount: Number(e.amount) || 0,
    desc: e.desc || '',
    category: e.type === 'Credit' ? 'Other' : 'Other',
    method: 'Other',
    shared: false, paidBy: null, split: null,
    createdAt: Date.now(), updatedAt: Date.now(),
  }));
  setTimeout(() => toast(`Imported ${s.tasks.length} tasks and ${s.expenses.length} entries from the old version.`, 'ok', 6000), 600);
  return s;
}

/* Defensive normalisation — tolerate hand-edited or older backups. */
function reconcile(raw){
  const s = defaultState();
  if (!raw || typeof raw !== 'object') return s;

  Object.assign(s.settings, raw.settings || {});
  s.settings.currency = CURRENCIES.some(c => c[0] === s.settings.currency) ? s.settings.currency : 'INR';
  s.settings.budget   = Math.max(0, Number(s.settings.budget) || 0);

  const people = Array.isArray(raw.people) ? raw.people : [];
  s.people = people
    .filter(p => p && p.id && typeof p.name === 'string')
    .map((p, i) => ({
      id: p.id, name: p.name.slice(0, 40) || 'Unnamed',
      color: p.color || PERSON_COLORS[i % PERSON_COLORS.length],
      isMe: !!p.isMe, archived: !!p.archived,
    }));
  if (!s.people.some(p => p.isMe)) s.people.unshift({ id: 'me', name: 'You', color: PERSON_COLORS[0], isMe: true, archived: false });

  s.tasks = (Array.isArray(raw.tasks) ? raw.tasks : [])
    .filter(t => t && t.id)
    .map(t => ({
      id: t.id,
      title: String(t.title || 'Untitled').slice(0, 200),
      notes: String(t.notes || '').slice(0, 2000),
      date: /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : todayISO(),
      time: t.time || '', deadline: t.deadline || '',
      priority: PRIORITY_ORDER[t.priority] ? t.priority : 'Medium',
      tags: Array.isArray(t.tags) ? t.tags.slice(0, 10).map(x => String(x).slice(0, 24)) : [],
      completed: !!t.completed,
      completedAt: t.completedAt ?? (t.completed ? Date.now() : null),
      repeat: REPEAT_LABEL[t.repeat] !== undefined ? t.repeat : 'none',
      seriesId: t.seriesId || null,
      createdAt: t.createdAt || Date.now(), updatedAt: t.updatedAt || Date.now(),
    }));

  const validIds = new Set(s.people.map(p => p.id));
  s.expenses = (Array.isArray(raw.expenses) ? raw.expenses : [])
    .filter(e => e && e.id)
    .map(e => {
      const type = e.type === 'Credit' ? 'Credit' : 'Debit';
      const out = {
        id: e.id,
        date: /^\d{4}-\d{2}-\d{2}$/.test(e.date) ? e.date : todayISO(),
        type, amount: Math.max(0, Number(e.amount) || 0),
        desc: String(e.desc || '').slice(0, 200),
        category: CATEGORIES[type].includes(e.category) ? e.category : 'Other',
        method: e.method || 'Other',
        shared: false, paidBy: null, split: null,
        createdAt: e.createdAt || Date.now(), updatedAt: e.updatedAt || Date.now(),
      };
      // A split is only kept if every person it references still exists.
      if (e.shared && e.paidBy && validIds.has(e.paidBy) && e.split && Array.isArray(e.split.parts)){
        const parts = e.split.parts.filter(p => p && validIds.has(p.id));
        if (parts.length){
          out.shared = true; out.paidBy = e.paidBy;
          out.split = { mode: ['equal','exact','shares','percent'].includes(e.split.mode) ? e.split.mode : 'equal',
                        parts: parts.map(p => ({ id: p.id, value: Number(p.value) || 0 })) };
        }
      }
      return out;
    });

  s.settlements = (Array.isArray(raw.settlements) ? raw.settlements : [])
    .filter(x => x && x.id && validIds.has(x.from) && validIds.has(x.to) && x.from !== x.to)
    .map(x => ({
      id: x.id, from: x.from, to: x.to,
      amount: Math.max(0, Number(x.amount) || 0),
      date: /^\d{4}-\d{2}-\d{2}$/.test(x.date) ? x.date : todayISO(),
      note: String(x.note || '').slice(0, 120),
      createdAt: x.createdAt || Date.now(),
    }));

  return s;
}

/* ---------------- People helpers ---------------- */
const personById   = id => state.people.find(p => p.id === id) || null;
const personName   = id => personById(id)?.name ?? 'Unknown';
const me           = () => state.people.find(p => p.isMe) || state.people[0];
const activePeople = () => state.people.filter(p => !p.archived);
const initials     = name => String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';

function avatar(id, size = ''){
  const p = personById(id);
  const nm = p?.name || '?';
  return `<span class="avatar ${size}" style="background:${p?.color || '#888'}" title="${escapeHtml(nm)}">${escapeHtml(initials(nm))}</span>`;
}

/* ---------------- Split maths ----------------
   Everything is computed in integer minor units (paise/cents) and the
   rounding remainder is distributed with the largest-remainder method, so
   the shares always add up to the total exactly. */
function computeShares(amount, split){
  const total = toMinor(amount);
  const parts = (split?.parts || []).filter(p => personById(p.id));
  const n = parts.length;
  const out = new Map();
  if (!n || total <= 0){ parts.forEach(p => out.set(p.id, 0)); return out; }

  const mode = split.mode || 'equal';

  if (mode === 'exact'){
    parts.forEach(p => out.set(p.id, toMinor(p.value)));
    return out;
  }

  // equal / shares / percent all reduce to weighted distribution
  const weights = parts.map(p => mode === 'equal' ? 1 : Math.max(0, Number(p.value) || 0));
  const W = weights.reduce((a, b) => a + b, 0);
  if (W <= 0){ parts.forEach(p => out.set(p.id, 0)); return out; }

  const exact = weights.map(w => total * w / W);
  const floors = exact.map(Math.floor);
  let remainder = total - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < remainder; k++) floors[order[k % n].i]++;

  parts.forEach((p, i) => out.set(p.id, floors[i]));
  return out;
}

/* Net position per person, in minor units. Positive = they are owed money. */
function computeLedger(){
  const led = new Map(state.people.map(p => [p.id, 0]));
  const bump = (id, v) => led.has(id) && led.set(id, led.get(id) + v);

  for (const e of state.expenses){
    if (!e.shared || !e.paidBy) continue;
    const shares = computeShares(e.amount, e.split);
    // Debit: the payer fronted the cash, participants owe their share.
    // Credit: the receiver holds cash that belongs to the participants.
    const sign = e.type === 'Credit' ? -1 : 1;
    bump(e.paidBy, sign * toMinor(e.amount));
    for (const [pid, sh] of shares) bump(pid, -sign * sh);
  }
  for (const s of state.settlements){
    bump(s.from, toMinor(s.amount));   // paying down what you owe
    bump(s.to,  -toMinor(s.amount));
  }
  return led;
}

/* Fewest transfers that clear every balance (greedy largest-debtor/creditor). */
function simplifyDebts(ledger){
  const creditors = [], debtors = [];
  for (const [id, v] of ledger){
    if (v > 0)      creditors.push({ id, v });
    else if (v < 0) debtors.push({ id, v: -v });
  }
  creditors.sort((a, b) => b.v - a.v);
  debtors.sort((a, b) => b.v - a.v);

  const out = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length){
    const amt = Math.min(debtors[i].v, creditors[j].v);
    if (amt > 0) out.push({ from: debtors[i].id, to: creditors[j].id, amount: fromMinor(amt) });
    debtors[i].v -= amt; creditors[j].v -= amt;
    if (debtors[i].v === 0) i++;
    if (creditors[j].v === 0) j++;
  }
  return out;
}

/* What a given entry actually cost *me*.
   Share view  → my slice of a split. Cash view → what left my pocket. */
function myAmount(e){
  const myId = me().id;
  if (!e.shared) return e.amount;
  if (state.settings.myShareOnly){
    const shares = computeShares(e.amount, e.split);
    return fromMinor(shares.get(myId) || 0);
  }
  return e.paidBy === myId ? e.amount : 0;
}

/* ---------------- Toasts (with undo) ---------------- */
const toastsEl = () => $('#toasts');

function toast(msg, kind = 'ok', ms = 3200, action){
  const host = toastsEl();
  if (!host) return;
  const t = el('div', `toast ${kind}`);
  t.innerHTML = `${icon(kind === 'err' ? 'i-alert' : 'i-check')}<span class="msg">${escapeHtml(msg)}</span>`;
  if (action){
    const b = el('button', 'btn small secondary', escapeHtml(action.label));
    b.addEventListener('click', () => { action.run(); dismiss(); });
    t.appendChild(b);
  }
  host.appendChild(t);
  const timer = setTimeout(dismiss, ms);
  function dismiss(){
    clearTimeout(timer);
    if (!t.isConnected) return;
    t.classList.add('out');
    setTimeout(() => t.remove(), 180);
  }
}

/* Delete anything with a one-tap undo instead of a scary dialog. */
function removeWithUndo(listName, predicate, label){
  const removed = state[listName].filter(predicate);
  if (!removed.length) return;
  state[listName] = state[listName].filter(x => !predicate(x));
  save(); renderAll();
  toast(`${label} deleted.`, 'ok', 6000, {
    label: 'Undo',
    run(){ state[listName].push(...removed); save(); renderAll(); toast('Restored.', 'ok', 1800); },
  });
}

/* ---------------- Confirm dialog (replaces window.confirm) ---------------- */
function confirmAction({ title, body, okLabel = 'Delete', danger = true }){
  return new Promise(resolve => {
    const dlg = $('#confirmModal');
    $('#confirmTitle').textContent = title;
    $('#confirmBody').textContent = body || '';
    const ok = $('#confirmOk');
    ok.textContent = okLabel;
    ok.className = `btn ${danger ? 'danger' : ''}`;
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.showModal();
  });
}

async function guardedDelete(opts, run){
  if (state.settings.confirmDelete){
    if (!(await confirmAction(opts))) return;
  }
  run();
}

/* ---------------- Router ---------------- */
let currentView = 'dashboard';

function setView(name, { focus = false } = {}){
  const btn = $(`.nav-btn[data-view="${name}"]`);
  if (!btn) return;
  currentView = name;
  $$('.nav-btn').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === name)));
  $$('.view').forEach(v => { v.hidden = v.id !== `view-${name}`; });
  try { localStorage.setItem('dt_view', name); } catch {}
  if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`);
  renderView(name);
  if (focus) $(`#view-${name}`)?.focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* Charts must only be built while their canvas is actually visible —
   Chart.js measures the container, and a display:none parent is 0×0. */
function renderView(name){
  if (name === 'dashboard') renderDashboard();
  if (name === 'tasks')     renderTasks();
  if (name === 'expenses')  renderExpenses();
  if (name === 'split')     renderSplit();
  if (name === 'insights')  renderInsights();
  if (name === 'settings')  renderSettings();
}

function renderAll(){
  renderView(currentView);
  updateBrandSub();
}

function updateBrandSub(){
  const t = todayISO();
  const today = state.tasks.filter(x => x.date === t);
  const done = today.filter(x => x.completed).length;
  $('#brandSub').textContent = today.length
    ? `${done}/${today.length} done today · ${humanDate(t)}`
    : humanDate(t);
}

/* ============================================================
   TASKS
   ============================================================ */
const taskUI = { day: todayISO(), filter: 'all', search: '', sort: 'priority', tag: null };

/* Materialise repeating tasks forward to today (idempotent, capped). */
function materialiseRepeats(){
  const today = todayISO();
  const bySeries = new Map();
  for (const t of state.tasks){
    const sid = t.seriesId || (t.repeat !== 'none' ? t.id : null);
    if (!sid) continue;
    const cur = bySeries.get(sid);
    if (!cur || t.date > cur.date) bySeries.set(sid, t);
  }

  let added = 0;
  for (const [sid, last] of bySeries){
    if (last.repeat === 'none') continue;
    const existing = new Set(state.tasks.filter(t => (t.seriesId || t.id) === sid).map(t => t.date));
    let cursor = last.date, guard = 0;
    while (cursor < today && guard++ < 400){
      cursor = nextRepeatDate(cursor, last.repeat);
      if (!cursor || cursor > today) break;
      if (existing.has(cursor)) continue;
      state.tasks.push({
        ...last, id: uid(), seriesId: sid, date: cursor,
        completed: false, completedAt: null,
        deadline: '', createdAt: Date.now(), updatedAt: Date.now(),
      });
      existing.add(cursor); added++;
    }
  }
  if (added) save();
}

function nextRepeatDate(iso, repeat){
  const d = parseISO(iso);
  if (repeat === 'daily')   d.setDate(d.getDate() + 1);
  else if (repeat === 'weekly')  d.setDate(d.getDate() + 7);
  else if (repeat === 'monthly'){
    const day = d.getDate();
    d.setDate(1); d.setMonth(d.getMonth() + 1);
    d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())));
  }
  else if (repeat === 'weekdays'){
    do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
  } else return null;
  return toISO(d);
}

function taskIsOverdue(t){
  if (t.completed) return false;
  if (t.deadline){ const d = new Date(t.deadline); if (!isNaN(d) && d < new Date()) return true; }
  return t.date < todayISO();
}

function sortTasks(list){
  const s = taskUI.sort;
  const byTime = (a, b) => (a.time || '99:99').localeCompare(b.time || '99:99');
  if (s === 'time')    return list.sort((a, b) => byTime(a, b) || a.title.localeCompare(b.title));
  if (s === 'created') return list.sort((a, b) => b.createdAt - a.createdAt);
  if (s === 'title')   return list.sort((a, b) => a.title.localeCompare(b.title));
  return list.sort((a, b) => (PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority]) || byTime(a, b));
}

function matchesTaskSearch(t){
  const q = taskUI.search.trim().toLowerCase();
  if (taskUI.tag && !t.tags.includes(taskUI.tag)) return false;
  if (!q) return true;
  return t.title.toLowerCase().includes(q)
      || t.notes.toLowerCase().includes(q)
      || t.tags.some(x => x.toLowerCase().includes(q));
}

function renderTasks(){
  const day = taskUI.day;
  $('#taskDayLabel').textContent = humanDate(day);
  $('#taskFormSub').textContent = $('#taskId').value
    ? 'Editing an existing task.'
    : `New task lands on ${humanDate(day)}.`;

  // tag filter bar
  const tagBar = $('#taskTagBar');
  const allTags = [...new Set(state.tasks.flatMap(t => t.tags))].sort();
  tagBar.innerHTML = allTags.length
    ? allTags.map(tg => `<button class="tag" data-act="task-tag" data-tag="${escapeHtml(tg)}" data-on="${taskUI.tag === tg ? 1 : 0}">#${escapeHtml(tg)}</button>`).join('')
    : '';
  tagBar.hidden = !allTags.length;

  const dayTasks = state.tasks.filter(t => t.date === day && matchesTaskSearch(t));
  const active = sortTasks(dayTasks.filter(t => !t.completed));
  const done   = sortTasks(dayTasks.filter(t =>  t.completed));

  // stats line
  const total = dayTasks.length;
  $('#taskStatsBar').innerHTML = total
    ? `<b style="color:var(--text)">${done.length}/${total}</b> complete · ${active.length} remaining`
    : '';

  // overdue rollover (only shown while looking at today)
  const showOverdue = state.settings.showOverdue && day === todayISO();
  const overdue = showOverdue
    ? sortTasks(state.tasks.filter(t => !t.completed && t.date < day && matchesTaskSearch(t)))
    : [];
  $('#taskOverdueWrap').hidden = !overdue.length;
  if (overdue.length) $('#taskOverdue').innerHTML = overdue.map(t => taskItem(t, true)).join('');

  const f = taskUI.filter;
  const wrap = $('#taskListWrap');
  const blocks = [];
  if (f !== 'done'){
    blocks.push(`<div class="group-head"><span>Active · ${active.length}</span></div>`);
    blocks.push(`<div class="list">${active.length ? active.map(t => taskItem(t)).join('') : emptyState('Nothing outstanding.')}</div>`);
  }
  if (f !== 'active'){
    blocks.push(`<div class="group-head"><span>Done · ${done.length}</span>${done.length ? `<button class="btn small ghost" data-act="clear-done">Clear done</button>` : ''}</div>`);
    blocks.push(`<div class="list">${done.length ? done.map(t => taskItem(t)).join('') : emptyState('No completed tasks yet.')}</div>`);
  }
  wrap.innerHTML = blocks.join('');
  updateBrandSub();
}

function taskItem(t, showDate = false){
  const over = taskIsOverdue(t);
  const bits = [];
  if (showDate) bits.push(`<span>${escapeHtml(humanDate(t.date))}</span>`);
  if (t.time) bits.push(`<span>${escapeHtml(humanTime(t.time))}</span>`);
  if (t.deadline) bits.push(`<span>Due <b>${escapeHtml(humanDateTime(t.deadline))}</b></span>`);
  if (t.repeat !== 'none') bits.push(`<span>${icon('i-repeat','ico')} ${REPEAT_LABEL[t.repeat]}</span>`);

  return `
    <div class="item ${t.completed ? 'done' : ''} ${over && !t.completed ? 'overdue' : ''}" data-id="${t.id}">
      <div style="display:flex; gap:11px; align-items:flex-start; min-width:0">
        <button class="check" data-act="task-toggle" data-id="${t.id}" data-on="${t.completed ? 1 : 0}"
                aria-label="${t.completed ? 'Mark as not done' : 'Mark as done'}">${icon('i-check')}</button>
        <div style="min-width:0; flex:1">
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap">
            <span class="title">${escapeHtml(t.title)}</span>
            <span class="pill ${t.priority.toLowerCase()}">${t.priority}</span>
            ${over && !t.completed ? `<span class="pill high">Overdue</span>` : ''}
          </div>
          ${bits.length ? `<div class="meta">${bits.join('')}</div>` : ''}
          ${t.tags.length ? `<div class="row tight" style="margin-top:5px">${t.tags.map(tg => `<span class="tag">#${escapeHtml(tg)}</span>`).join('')}</div>` : ''}
          ${t.notes ? `<div class="subtle" style="margin-top:5px; white-space:pre-wrap">${escapeHtml(t.notes)}</div>` : ''}
        </div>
      </div>
      <div class="actions">
        ${showDate ? `<button class="btn small ghost" data-act="task-move-today" data-id="${t.id}">To today</button>` : ''}
        <button class="btn icon ghost" data-act="task-edit"   data-id="${t.id}" aria-label="Edit task">${icon('i-pencil')}</button>
        <button class="btn icon ghost" data-act="task-delete" data-id="${t.id}" aria-label="Delete task">${icon('i-trash')}</button>
      </div>
    </div>`;
}

function emptyState(text, ico = 'i-inbox'){
  return `<div class="empty">${icon(ico)}<span>${escapeHtml(text)}</span></div>`;
}

function resetTaskForm(){
  $('#taskId').value = '';
  $('#taskTitle').value = '';
  $('#taskDate').value = taskUI.day;
  $('#taskTime').value = '';
  $('#taskDeadline').value = '';
  $('#taskPriority').value = 'Medium';
  $('#taskRepeat').value = 'none';
  $('#taskTags').value = '';
  $('#taskNotes').value = '';
  $('#taskFormTitle').textContent = 'Add task';
  $('#taskSubmitBtn').querySelector('span').textContent = 'Add task';
  $('#taskCancelBtn').hidden = true;
}

function editTask(id){
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  if (currentView !== 'tasks'){ taskUI.day = t.date; setView('tasks'); }
  $('#taskId').value = t.id;
  $('#taskTitle').value = t.title;
  $('#taskDate').value = t.date;
  $('#taskTime').value = t.time || '';
  $('#taskDeadline').value = t.deadline || '';
  $('#taskPriority').value = t.priority;
  $('#taskRepeat').value = t.repeat || 'none';
  $('#taskTags').value = t.tags.join(', ');
  $('#taskNotes').value = t.notes || '';
  $('#taskFormTitle').textContent = 'Edit task';
  $('#taskSubmitBtn').querySelector('span').textContent = 'Save changes';
  $('#taskCancelBtn').hidden = false;
  $('#taskTitle').focus();
  if (window.innerWidth < 900) $('#taskForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function parseTags(raw){
  return [...new Set(String(raw || '').split(',').map(s => s.trim().replace(/^#/, '')).filter(Boolean))]
    .slice(0, 10).map(s => s.slice(0, 24));
}

function submitTask(ev){
  ev.preventDefault();
  const title = $('#taskTitle').value.trim();
  if (!title){ toast('Give the task a title.', 'err'); $('#taskTitle').focus(); return; }

  const id = $('#taskId').value;
  const payload = {
    title,
    date: $('#taskDate').value || todayISO(),
    time: $('#taskTime').value,
    deadline: $('#taskDeadline').value,
    priority: $('#taskPriority').value,
    repeat: $('#taskRepeat').value,
    tags: parseTags($('#taskTags').value),
    notes: $('#taskNotes').value.trim(),
    updatedAt: Date.now(),
  };

  if (id){
    const i = state.tasks.findIndex(t => t.id === id);
    if (i > -1) state.tasks[i] = { ...state.tasks[i], ...payload };
    toast('Task updated.');
  } else {
    state.tasks.push({
      id: uid(), ...payload,
      completed: false, completedAt: null,
      seriesId: null, createdAt: Date.now(),
    });
    toast('Task added.');
  }
  save();
  taskUI.day = payload.date;
  resetTaskForm();
  materialiseRepeats();
  renderTasks();
}

function toggleTask(id){
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  t.completed = !t.completed;
  t.completedAt = t.completed ? Date.now() : null;
  t.updatedAt = Date.now();
  save();
  renderView(currentView);
  updateBrandSub();
}

/* ============================================================
   MONEY (expenses + split editor)
   ============================================================ */
const expUI = { type: 'Debit', filter: 'all', range: 'thisMonth', category: 'all', search: '' };
/* Draft split state lives here while the form is open. */
let draft = { shared: false, paidBy: null, mode: 'equal', parts: new Map() };

function rangeBounds(key){
  const now = new Date(), y = now.getFullYear(), m = now.getMonth();
  if (key === 'thisMonth') return [toISO(new Date(y, m, 1)), toISO(new Date(y, m + 1, 0))];
  if (key === 'lastMonth') return [toISO(new Date(y, m - 1, 1)), toISO(new Date(y, m, 0))];
  if (key === 'last30')    return [addDays(todayISO(), -29), todayISO()];
  if (key === 'thisYear')  return [`${y}-01-01`, `${y}-12-31`];
  return ['0000-01-01', '9999-12-31'];
}

function filteredExpenses(){
  const [from, to] = rangeBounds(expUI.range);
  const q = expUI.search.trim().toLowerCase();
  return state.expenses.filter(e => {
    if (e.date < from || e.date > to) return false;
    if (expUI.filter === 'shared'){ if (!e.shared) return false; }
    else if (expUI.filter !== 'all' && e.type !== expUI.filter) return false;
    if (expUI.category !== 'all' && e.category !== expUI.category) return false;
    if (q && !(e.desc.toLowerCase().includes(q) || e.category.toLowerCase().includes(q))) return false;
    return true;
  }).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
}

function renderExpenses(){
  syncCategoryOptions();
  $('#expRangeSub').textContent = {
    thisMonth: 'This month', lastMonth: 'Last month', last30: 'Last 30 days',
    thisYear: 'This year', all: 'All time',
  }[expUI.range];

  const list = filteredExpenses();

  // summary
  let inSum = 0, outSum = 0;
  for (const e of list){
    const v = myAmount(e);
    if (e.type === 'Credit') inSum += v; else outSum += v;
  }
  const net = inSum - outSum;
  $('#expSummary').innerHTML = `
    <div class="stat pos"><div class="k">Received</div><div class="v">${money(inSum)}</div><div class="s">${list.filter(e => e.type === 'Credit').length} entries</div></div>
    <div class="stat neg"><div class="k">Spent</div><div class="v">${money(outSum)}</div><div class="s">${list.filter(e => e.type === 'Debit').length} entries</div></div>
    <div class="stat ${net >= 0 ? 'pos' : 'neg'}"><div class="k">Net</div><div class="v">${money(net)}</div><div class="s">${state.settings.myShareOnly ? 'your share only' : 'cash out of pocket'}</div></div>`;

  // grouped by date
  const host = $('#expenseList');
  if (!list.length){ host.innerHTML = emptyState('No entries match these filters.'); return; }
  const groups = new Map();
  for (const e of list){ if (!groups.has(e.date)) groups.set(e.date, []); groups.get(e.date).push(e); }

  host.innerHTML = [...groups].map(([date, items]) => {
    const dayNet = items.reduce((a, e) => a + (e.type === 'Credit' ? myAmount(e) : -myAmount(e)), 0);
    return `<div class="group-head"><span>${escapeHtml(humanDate(date))}</span><span class="${dayNet >= 0 ? 'amt pos' : 'amt neg'}">${money(dayNet)}</span></div>
            <div class="list">${items.map(expenseItem).join('')}</div>`;
  }).join('');
}

function expenseItem(e){
  const isCredit = e.type === 'Credit';
  const bits = [`<span>${escapeHtml(e.category)}</span>`, `<span>${escapeHtml(e.method)}</span>`];

  let splitLine = '';
  if (e.shared){
    const shares = computeShares(e.amount, e.split);
    const mine = fromMinor(shares.get(me().id) || 0);
    const who = e.paidBy === me().id ? 'You' : personName(e.paidBy);
    const verb = isCredit ? 'received' : 'paid';
    splitLine = `
      <div class="row tight" style="margin-top:6px; align-items:center">
        <span class="avatar-stack">${[...shares.keys()].slice(0, 5).map(id => avatar(id, 'sm')).join('')}</span>
        <span class="subtle">${escapeHtml(who)} ${verb} · your share ${money(mine)}${shares.size > 5 ? ` · +${shares.size - 5} more` : ''}</span>
      </div>`;
  }

  return `
    <div class="item" data-id="${e.id}">
      <div style="min-width:0">
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap">
          <span class="title">${escapeHtml(e.desc || e.category)}</span>
          <span class="pill ${isCredit ? 'credit' : 'debit'}">${isCredit ? 'Received' : 'Spent'}</span>
          ${e.shared ? `<span class="pill info">${icon('i-split')} Split ${computeShares(e.amount, e.split).size}</span>` : ''}
        </div>
        <div class="meta">${bits.join('')}</div>
        ${splitLine}
      </div>
      <div class="actions" style="gap:10px">
        <span class="amt ${isCredit ? 'pos' : 'neg'}">${isCredit ? '+' : '−'}${moneyAbs(e.amount)}</span>
        <button class="btn icon ghost" data-act="exp-edit"   data-id="${e.id}" aria-label="Edit entry">${icon('i-pencil')}</button>
        <button class="btn icon ghost" data-act="exp-delete" data-id="${e.id}" aria-label="Delete entry">${icon('i-trash')}</button>
      </div>
    </div>`;
}

function syncCategoryOptions(){
  const sel = $('#expenseCategory');
  const want = CATEGORIES[expUI.type];
  const keep = sel.value;
  sel.innerHTML = want.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  sel.value = want.includes(keep) ? keep : want[0];

  const f = $('#expCategoryFilter');
  const used = [...new Set(state.expenses.map(e => e.category))].sort();
  const keepF = f.value;
  f.innerHTML = `<option value="all">All categories</option>` + used.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  f.value = (keepF === 'all' || used.includes(keepF)) ? keepF : 'all';
  expUI.category = f.value;
}

/* ---------------- Split editor ---------------- */
function setExpenseType(type){
  expUI.type = type;
  $$('[data-act="exp-type"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.type === type)));
  syncCategoryOptions();
  $('#splitPanel').querySelector('label.field > span').textContent = type === 'Credit' ? 'Received by' : 'Paid by';
  renderSplitEditor();
}

function renderSplitEditor(){
  const panel = $('#splitPanel');
  panel.hidden = !draft.shared;
  $('#expenseShared').checked = draft.shared;
  if (!draft.shared) return;

  const people = activePeople();
  if (people.length < 2){
    $('#splitLines').innerHTML = emptyState('Add a friend on the Split tab first.', 'i-users');
    $('#splitSummary').textContent = '';
    return;
  }

  // paid-by select
  const paidSel = $('#expensePaidBy');
  draft.paidBy = people.some(p => p.id === draft.paidBy) ? draft.paidBy : me().id;
  paidSel.innerHTML = people.map(p => `<option value="${p.id}">${escapeHtml(p.isMe ? `${p.name} (me)` : p.name)}</option>`).join('');
  paidSel.value = draft.paidBy;
  $('#splitMode').value = draft.mode;

  const amount = Number($('#expenseAmount').value) || 0;
  const parts = [...draft.parts.entries()].map(([id, value]) => ({ id, value }));
  const shares = computeShares(amount, { mode: draft.mode, parts });

  $('#splitLines').innerHTML = people.map(p => {
    const on = draft.parts.has(p.id);
    const owed = fromMinor(shares.get(p.id) || 0);
    const showInput = on && draft.mode !== 'equal';
    const unit = draft.mode === 'percent' ? '%' : draft.mode === 'shares' ? '×' : '';
    return `
      <div class="split-line ${on ? '' : 'off'}">
        <button type="button" class="check" data-act="split-toggle" data-id="${p.id}" data-on="${on ? 1 : 0}"
                aria-label="Include ${escapeHtml(p.name)}">${icon('i-check')}</button>
        <span class="sname">${avatar(p.id, 'sm')}<span>${escapeHtml(p.isMe ? `${p.name} (me)` : p.name)}</span></span>
        ${showInput
          ? `<input type="number" step="0.01" min="0" inputmode="decimal" data-act="split-value" data-id="${p.id}"
                    value="${draft.parts.get(p.id) || ''}" placeholder="0" aria-label="${escapeHtml(p.name)} ${unit || 'amount'}" />`
          : `<span></span>`}
        <span class="owed">${on ? money(owed) : '—'}</span>
      </div>`;
  }).join('');

  // validation summary
  const totalShares = [...shares.values()].reduce((a, b) => a + b, 0);
  const target = toMinor(amount);
  const n = draft.parts.size;
  let msg, bad = false;

  if (!n){ msg = 'Pick at least one person to split between.'; bad = true; }
  else if (draft.mode === 'exact' && totalShares !== target){
    const diff = fromMinor(target - totalShares);
    msg = `Exact amounts are off by ${moneyAbs(diff)} — ${diff > 0 ? 'add' : 'remove'} that much.`;
    bad = true;
  }
  else if (draft.mode === 'percent'){
    const sum = [...draft.parts.values()].reduce((a, b) => a + (Number(b) || 0), 0);
    if (Math.abs(sum - 100) > 0.01){ msg = `Percentages add up to ${sum.toFixed(2)}%, not 100%.`; bad = true; }
    else msg = `Split ${n} ways · ${money(amount / n)} average.`;
  }
  else if (draft.mode === 'shares' && [...draft.parts.values()].every(v => !Number(v))){
    msg = 'Give at least one person a share weight.'; bad = true;
  }
  else msg = `Split ${n} ways · totals ${money(fromMinor(totalShares))}.`;

  const sum = $('#splitSummary');
  sum.textContent = msg;
  sum.style.color = bad ? 'var(--danger)' : 'var(--muted)';
  draft.valid = !bad;
}

function seedDraftEqual(){
  draft.parts = new Map(activePeople().map(p => [p.id, 0]));
}

function resetExpenseForm(){
  $('#expenseId').value = '';
  $('#expenseAmount').value = '';
  $('#expenseDate').value = todayISO();
  $('#expenseDesc').value = '';
  $('#expenseMethod').value = 'UPI';
  $('#expFormTitle').textContent = 'Add entry';
  $('#expenseSubmitBtn').querySelector('span').textContent = 'Add entry';
  $('#expenseCancelBtn').hidden = true;
  draft = { shared: false, paidBy: me().id, mode: 'equal', parts: new Map(), valid: true };
  setExpenseType('Debit');
  renderSplitEditor();
}

function editExpense(id){
  const e = state.expenses.find(x => x.id === id);
  if (!e) return;
  $('#expenseId').value = e.id;
  $('#expenseAmount').value = e.amount;
  $('#expenseDate').value = e.date;
  $('#expenseDesc').value = e.desc;
  $('#expenseMethod').value = e.method;
  setExpenseType(e.type);
  $('#expenseCategory').value = e.category;

  draft = {
    shared: !!e.shared,
    paidBy: e.paidBy || me().id,
    mode: e.split?.mode || 'equal',
    parts: new Map((e.split?.parts || []).map(p => [p.id, p.value])),
    valid: true,
  };
  $('#expFormTitle').textContent = 'Edit entry';
  $('#expenseSubmitBtn').querySelector('span').textContent = 'Save changes';
  $('#expenseCancelBtn').hidden = false;
  renderSplitEditor();
  $('#expenseAmount').focus();
  if (window.innerWidth < 900) $('#expenseForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function submitExpense(ev){
  ev.preventDefault();
  const amount = Number($('#expenseAmount').value);
  if (!(amount > 0)){ toast('Enter an amount greater than zero.', 'err'); $('#expenseAmount').focus(); return; }

  if (draft.shared){
    renderSplitEditor();
    if (!draft.valid){ toast('Fix the split before saving.', 'err'); return; }
  }

  const payload = {
    date: $('#expenseDate').value || todayISO(),
    type: expUI.type,
    amount,
    desc: $('#expenseDesc').value.trim(),
    category: $('#expenseCategory').value,
    method: $('#expenseMethod').value,
    shared: draft.shared,
    paidBy: draft.shared ? draft.paidBy : null,
    split: draft.shared
      ? { mode: draft.mode, parts: [...draft.parts.entries()].map(([id, value]) => ({ id, value: Number(value) || 0 })) }
      : null,
    updatedAt: Date.now(),
  };

  const id = $('#expenseId').value;
  if (id){
    const i = state.expenses.findIndex(x => x.id === id);
    if (i > -1) state.expenses[i] = { ...state.expenses[i], ...payload };
    toast('Entry updated.');
  } else {
    state.expenses.push({ id: uid(), ...payload, createdAt: Date.now() });
    toast(draft.shared ? 'Split entry added.' : 'Entry added.');
  }
  save();
  resetExpenseForm();
  renderExpenses();
}

/* ============================================================
   SPLIT VIEW
   ============================================================ */
function renderSplit(){
  const ledger = computeLedger();
  const myId = me().id;
  const mine = ledger.get(myId) || 0;

  // What I care about is my own position, split into who owes me and who I owe.
  const pairs = simplifyDebts(ledger);
  const toMe   = pairs.filter(p => p.to === myId).reduce((a, p) => a + p.amount, 0);
  const fromMe = pairs.filter(p => p.from === myId).reduce((a, p) => a + p.amount, 0);

  const sharedCount = state.expenses.filter(e => e.shared).length;
  $('#splitStats').innerHTML = `
    <div class="stat pos"><div class="k">You are owed</div><div class="v">${money(toMe)}</div></div>
    <div class="stat neg"><div class="k">You owe</div><div class="v">${money(fromMe)}</div></div>
    <div class="stat ${mine >= 0 ? 'pos' : 'neg'}"><div class="k">Net position</div><div class="v">${money(fromMinor(mine))}</div><div class="s">${mine >= 0 ? 'in your favour' : 'you are behind'}</div></div>
    <div class="stat"><div class="k">Split entries</div><div class="v">${sharedCount}</div><div class="s">${activePeople().length} people</div></div>`;

  // balances
  const rows = state.people
    .filter(p => !p.archived || (ledger.get(p.id) || 0) !== 0)
    .map(p => ({ p, v: fromMinor(ledger.get(p.id) || 0) }))
    .sort((a, b) => b.v - a.v);
  $('#balanceList').innerHTML = rows.length && sharedCount + state.settlements.length
    ? rows.map(({ p, v }) => `
        <div class="person-row">
          ${avatar(p.id)}
          <div class="grow"><div class="name">${escapeHtml(p.isMe ? `${p.name} (me)` : p.name)}${p.archived ? ' <span class="pill">archived</span>' : ''}</div>
            <div class="subtle">${Math.abs(v) < 0.005 ? 'all settled' : v > 0 ? 'is owed' : 'owes'}</div></div>
          <div class="amt ${Math.abs(v) < 0.005 ? 'zero' : v > 0 ? 'pos' : 'neg'}">${Math.abs(v) < 0.005 ? '—' : moneyAbs(v)}</div>
        </div>`).join('')
    : emptyState('No split expenses yet. Add one from the Money tab.', 'i-split');

  // settle-up suggestions
  $('#settleList').innerHTML = pairs.length
    ? pairs.map(p => `
        <div class="settle-row">
          ${avatar(p.from)}<span class="name" style="font-weight:650">${escapeHtml(personName(p.from))}</span>
          <span class="arrow">${icon('i-arrow-right')}</span>
          ${avatar(p.to)}<span class="name" style="font-weight:650">${escapeHtml(personName(p.to))}</span>
          <span class="spacer"></span>
          <span class="amt">${money(p.amount)}</span>
          <button class="btn small" data-act="settle-now" data-from="${p.from}" data-to="${p.to}" data-amount="${p.amount}">Settle up</button>
        </div>`).join('')
    : emptyState('Everyone is square.', 'i-check');

  // people
  $('#peopleList').innerHTML = state.people.map(p => {
    const bal = fromMinor(ledger.get(p.id) || 0);
    const used = state.expenses.some(e => e.shared && (e.paidBy === p.id || e.split?.parts.some(x => x.id === p.id)))
              || state.settlements.some(s => s.from === p.id || s.to === p.id);
    return `
      <div class="person-row">
        ${avatar(p.id)}
        <div class="grow" style="min-width:0">
          <input class="person-name" data-rename="${p.id}" value="${escapeHtml(p.name)}" maxlength="40" aria-label="Name"
                 style="border-color:transparent; background:transparent; padding:2px 4px; font-weight:650" />
          <div class="subtle" style="padding-left:5px">${p.isMe ? 'you · ' : ''}${p.archived ? 'archived · ' : ''}${Math.abs(bal) < 0.005 ? 'settled up' : bal > 0 ? `owed ${moneyAbs(bal)}` : `owes ${moneyAbs(bal)}`}</div>
        </div>
        ${p.isMe ? '' : `<button class="btn icon ghost" data-act="person-remove" data-id="${p.id}" data-used="${used ? 1 : 0}" aria-label="Remove">${icon('i-trash')}</button>`}
      </div>`;
  }).join('');

  // settlement form + history
  const opts = activePeople().map(p => `<option value="${p.id}">${escapeHtml(p.isMe ? `${p.name} (me)` : p.name)}</option>`).join('');
  const from = $('#settleFrom'), to = $('#settleTo');
  const keepFrom = from.value, keepTo = to.value;
  from.innerHTML = opts; to.innerHTML = opts;
  const live = activePeople().map(p => p.id);
  from.value = live.includes(keepFrom) ? keepFrom : myId;
  to.value = (live.includes(keepTo) && keepTo !== from.value)
    ? keepTo : (live.find(p => p !== from.value) ?? myId);
  if (!$('#settleDate').value) $('#settleDate').value = todayISO();

  const hist = [...state.settlements].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
  $('#settlementList').innerHTML = hist.length
    ? hist.map(s => `
        <div class="item">
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; min-width:0">
            ${avatar(s.from, 'sm')}<span class="title">${escapeHtml(personName(s.from))}</span>
            <span class="arrow subtle">${icon('i-arrow-right')}</span>
            ${avatar(s.to, 'sm')}<span class="title">${escapeHtml(personName(s.to))}</span>
            <div class="meta" style="width:100%">${escapeHtml(humanDate(s.date))}</div>
          </div>
          <div class="actions" style="gap:10px">
            <span class="amt">${money(s.amount)}</span>
            <button class="btn icon ghost" data-act="settle-delete" data-id="${s.id}" aria-label="Delete settlement">${icon('i-trash')}</button>
          </div>
        </div>`).join('')
    : emptyState('No payments recorded yet.');
}

/* ============================================================
   DASHBOARD
   ============================================================ */
function completionStreak(){
  const done = new Set(state.tasks.filter(t => t.completed && t.completedAt)
    .map(t => toISO(new Date(t.completedAt))));
  let streak = 0, cursor = todayISO();
  if (!done.has(cursor)) cursor = addDays(cursor, -1);   // today may still be in progress
  while (done.has(cursor)){ streak++; cursor = addDays(cursor, -1); }
  return streak;
}

function monthTotals(mKey = monthKey(todayISO())){
  let inSum = 0, outSum = 0;
  for (const e of state.expenses){
    if (monthKey(e.date) !== mKey) continue;
    const v = myAmount(e);
    if (e.type === 'Credit') inSum += v; else outSum += v;
  }
  return { inSum, outSum, net: inSum - outSum };
}

function renderDashboard(){
  const t = todayISO();
  const today = state.tasks.filter(x => x.date === t);
  const doneCount = today.filter(x => x.completed).length;
  const pct = today.length ? Math.round(doneCount / today.length * 100) : 0;
  const overdue = state.tasks.filter(x => !x.completed && x.date < t).length;
  const { inSum, outSum, net } = monthTotals();
  const ledger = computeLedger();
  const pairs = simplifyDebts(ledger);
  const myId = me().id;
  const toMe   = pairs.filter(p => p.to === myId).reduce((a, p) => a + p.amount, 0);
  const fromMe = pairs.filter(p => p.from === myId).reduce((a, p) => a + p.amount, 0);

  $('#dashStats').innerHTML = `
    <div class="stat"><div class="k">Today's tasks</div><div class="v">${doneCount}/${today.length}</div><div class="s">${overdue ? `${overdue} overdue` : 'nothing overdue'}</div></div>
    <div class="stat"><div class="k">Streak</div><div class="v">${completionStreak()}d</div><div class="s">consecutive days</div></div>
    <div class="stat neg"><div class="k">Spent this month</div><div class="v">${money(outSum, { compact: true })}</div><div class="s">${money(inSum, { compact: true })} received</div></div>
    <div class="stat ${toMe - fromMe >= 0 ? 'pos' : 'neg'}"><div class="k">Split balance</div><div class="v">${money(toMe - fromMe, { compact: true })}</div><div class="s">${
      !toMe && !fromMe ? 'all settled'
      : toMe && fromMe ? `${money(toMe, { compact: true })} in, ${money(fromMe, { compact: true })} out`
      : toMe ? `${money(toMe, { compact: true })} owed to you`
      : `you owe ${money(fromMe, { compact: true })}`}</div></div>`;

  $('#dashTodaySub').textContent = humanDate(t);
  const ring = $('#dashRing');
  ring.style.setProperty('--p', pct);
  ring.querySelector('span').textContent = `${pct}%`;
  $('#dashRingMeta').innerHTML = today.length
    ? `<div style="font-weight:700; font-size:15px">${doneCount === today.length ? 'All done. ' : ''}${today.length - doneCount} task${today.length - doneCount === 1 ? '' : 's'} left</div>
       <div class="subtle">${overdue ? `${overdue} unfinished from earlier days` : 'Nothing carried over.'}</div>`
    : `<div style="font-weight:700; font-size:15px">No tasks today</div><div class="subtle">Add one to get going.</div>`;

  const upNext = state.tasks.filter(x => x.date === t && !x.completed)
    .sort((a, b) => (PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority]) || (a.time || '99:99').localeCompare(b.time || '99:99'))
    .slice(0, 4);
  $('#dashUpNext').innerHTML = upNext.length ? upNext.map(x => taskItem(x)).join('') : emptyState('Nothing on the books today.', 'i-check');

  // budget
  const budget = state.settings.budget;
  const bpct = budget > 0 ? Math.min(100, Math.round(outSum / budget * 100)) : 0;
  const cls = !budget ? '' : outSum > budget ? 'over' : outSum > budget * 0.8 ? 'warn' : '';
  $('#dashMonthSub').textContent = `${MONTH[new Date().getMonth()]} ${new Date().getFullYear()} · daily spending`;
  $('#dashBudget').innerHTML = budget > 0
    ? `<div class="row" style="justify-content:space-between"><span class="subtle">Budget</span>
         <span><b>${money(outSum)}</b> <span class="subtle">of ${money(budget)}</span></span></div>
       <div class="bar ${cls}"><i style="width:${bpct}%"></i></div>
       <div class="subtle" style="margin-top:6px">${outSum > budget ? `Over by ${money(outSum - budget)}.` : `${money(budget - outSum)} left this month.`}</div>`
    : `<div class="row" style="justify-content:space-between"><span class="subtle">Net this month</span><span class="amt ${net >= 0 ? 'pos' : 'neg'}">${money(net)}</span></div>
       <div class="subtle" style="margin-top:6px">Set a monthly budget in Settings to track it here.</div>`;

  $('#dashBalances').innerHTML = pairs.length
    ? pairs.slice(0, 5).map(p => `
        <div class="person-row">${avatar(p.from)}
          <div class="grow"><div class="name">${escapeHtml(personName(p.from))} → ${escapeHtml(personName(p.to))}</div>
            <div class="subtle">${p.from === myId ? 'you owe' : p.to === myId ? 'owes you' : 'between friends'}</div></div>
          <div class="amt ${p.to === myId ? 'pos' : p.from === myId ? 'neg' : ''}">${money(p.amount)}</div>
        </div>`).join('')
    : emptyState('Nothing outstanding.', 'i-check');

  const recent = [...state.expenses].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt).slice(0, 5);
  $('#dashRecent').innerHTML = recent.length
    ? recent.map(e => `
        <div class="person-row">
          <div class="grow" style="min-width:0"><div class="name">${escapeHtml(e.desc || e.category)}</div>
            <div class="subtle">${escapeHtml(humanDate(e.date))} · ${escapeHtml(e.category)}${e.shared ? ' · split' : ''}</div></div>
          <div class="amt ${e.type === 'Credit' ? 'pos' : 'neg'}">${e.type === 'Credit' ? '+' : '−'}${moneyAbs(e.amount)}</div>
        </div>`).join('')
    : emptyState('No money entries yet.', 'i-wallet');

  drawDashChart();
}

/* ============================================================
   CHARTS
   ============================================================ */
const charts = {};
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function chartTheme(){
  if (typeof Chart === 'undefined') return null;
  const grid = cssVar('--border');
  const text = cssVar('--muted');
  Chart.defaults.color = text;
  Chart.defaults.font.family = "'JetBrains Mono', ui-monospace, monospace";
  Chart.defaults.font.size = 10;
  return {
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: text, boxWidth: 10, boxHeight: 10, usePointStyle: true, padding: 14 } },
      tooltip: {
        backgroundColor: cssVar('--surface-2'), borderColor: cssVar('--border-2'), borderWidth: 1,
        titleColor: cssVar('--text'), bodyColor: cssVar('--text-2'), padding: 10, cornerRadius: 8,
        callbacks: { label: c => ` ${c.dataset.label || c.label}: ${money(c.parsed.y ?? c.parsed)}` },
      },
    },
    scales: {
      x: { grid: { color: grid, drawBorder: false }, ticks: { color: text, maxRotation: 0, autoSkipPadding: 12 } },
      y: { grid: { color: grid, drawBorder: false }, ticks: { color: text, callback: v => money(v, { compact: true }) }, beginAtZero: true },
    },
  };
}

function mount(key, canvasId, config){
  if (typeof Chart === 'undefined') return;
  const cv = document.getElementById(canvasId);
  if (!cv || !cv.offsetParent) return;          // skip hidden canvases (0×0)
  charts[key]?.destroy();
  charts[key] = new Chart(cv, config);
}

const CREDIT_C = () => cssVar('--credit');
const DEBIT_C  = () => cssVar('--debit');
const CAT_COLORS = ['#a8371a','#2c5578','#96690d','#1c5c3b','#5c4a7d','#2f6f6b','#8a5a2b','#4a6b2a','#7d3f5c','#3a4a7a','#b5763f','#55705c','#93516b'];

function dailySeries(y, m){
  const n = daysInMonth(y, m);
  const credit = Array(n).fill(0), debit = Array(n).fill(0);
  for (const e of state.expenses){
    const [ey, em, ed] = e.date.split('-').map(Number);
    if (ey !== y || em - 1 !== m) continue;
    const v = myAmount(e);
    if (e.type === 'Credit') credit[ed - 1] += v; else debit[ed - 1] += v;
  }
  return { labels: Array.from({ length: n }, (_, i) => String(i + 1)), credit, debit };
}

function drawDashChart(){
  const now = new Date();
  const { labels, debit } = dailySeries(now.getFullYear(), now.getMonth());
  const opts = chartTheme();
  if (!opts) return;
  // Spending only — one salary credit would otherwise flatten every debit bar.
  mount('dash', 'dashChart', {
    type: 'bar',
    data: { labels, datasets: [
      { label: 'Spent', data: debit, backgroundColor: DEBIT_C() + 'cc', borderRadius: 0, borderSkipped: false },
    ]},
    options: { ...opts, plugins: { ...opts.plugins, legend: { display: false } } },
  });
}

function renderInsights(){
  const years = [...new Set(state.expenses.map(e => e.date.slice(0, 4)))].sort().reverse();
  const now = new Date();
  const cy = String(now.getFullYear());
  if (!years.includes(cy)) years.unshift(cy);
  const sel = $('#insightsYear');
  const keep = sel.value;
  sel.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
  sel.value = years.includes(keep) ? keep : cy;
  const year = Number(sel.value);
  $('#chartYearLabel').textContent = year;
  $('#insightsSub').textContent = state.settings.myShareOnly
    ? 'Amounts show your share of split expenses.'
    : 'Amounts show cash that left your pocket.';

  // ---- headline stats for the year
  let inSum = 0, outSum = 0;
  const byCat = new Map();
  for (const e of state.expenses){
    if (Number(e.date.slice(0, 4)) !== year) continue;
    const v = myAmount(e);
    if (e.type === 'Credit') inSum += v;
    else { outSum += v; byCat.set(e.category, (byCat.get(e.category) || 0) + v); }
  }
  const topCat = [...byCat].sort((a, b) => b[1] - a[1])[0];
  const monthsWithData = new Set(state.expenses.filter(e => Number(e.date.slice(0, 4)) === year && e.type === 'Debit').map(e => e.date.slice(5, 7))).size;
  $('#insightStats').innerHTML = `
    <div class="stat pos"><div class="k">Received ${year}</div><div class="v">${money(inSum, { compact: true })}</div></div>
    <div class="stat neg"><div class="k">Spent ${year}</div><div class="v">${money(outSum, { compact: true })}</div></div>
    <div class="stat ${inSum - outSum >= 0 ? 'pos' : 'neg'}"><div class="k">Net ${year}</div><div class="v">${money(inSum - outSum, { compact: true })}</div></div>
    <div class="stat"><div class="k">Avg / month</div><div class="v">${money(monthsWithData ? outSum / monthsWithData : 0, { compact: true })}</div><div class="s">${topCat ? `top: ${topCat[0]}` : 'no spending yet'}</div></div>`;

  const opts = chartTheme();
  if (!opts) return;

  // ---- daily flow, current month
  const d = dailySeries(now.getFullYear(), now.getMonth());
  mount('day', 'dayChart', {
    type: 'bar',
    data: { labels: d.labels, datasets: [
      { label: 'Received', data: d.credit, backgroundColor: CREDIT_C() + 'cc', borderRadius: 0, borderSkipped: false },
      { label: 'Spent',    data: d.debit,  backgroundColor: DEBIT_C()  + 'cc', borderRadius: 0, borderSkipped: false },
    ]},
    options: opts,
  });

  // ---- monthly flow, selected year
  const mCredit = Array(12).fill(0), mDebit = Array(12).fill(0);
  for (const e of state.expenses){
    const [ey, em] = e.date.split('-').map(Number);
    if (ey !== year) continue;
    const v = myAmount(e);
    if (e.type === 'Credit') mCredit[em - 1] += v; else mDebit[em - 1] += v;
  }
  mount('month', 'monthChart', {
    type: 'line',
    data: { labels: MONTH, datasets: [
      { label: 'Received', data: mCredit, borderColor: CREDIT_C(), backgroundColor: CREDIT_C() + '22', fill: true, tension: .35, pointRadius: 3 },
      { label: 'Spent',    data: mDebit,  borderColor: DEBIT_C(),  backgroundColor: DEBIT_C()  + '22', fill: true, tension: .35, pointRadius: 3 },
    ]},
    options: opts,
  });

  // ---- category doughnut
  const cats = [...byCat].sort((a, b) => b[1] - a[1]);
  mount('cat', 'catChart', {
    type: 'doughnut',
    data: { labels: cats.map(c => c[0]), datasets: [{
      data: cats.map(c => c[1]),
      backgroundColor: cats.map((_, i) => CAT_COLORS[i % CAT_COLORS.length]),
      borderColor: cssVar('--surface-2'), borderWidth: 2,
    }]},
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '58%',
      plugins: {
        legend: { position: 'right', labels: { color: cssVar('--muted'), boxWidth: 10, usePointStyle: true, padding: 10 } },
        tooltip: { ...opts.plugins.tooltip, callbacks: {
          label: c => { const tot = cats.reduce((a, b) => a + b[1], 0);
            return ` ${c.label}: ${money(c.parsed)} (${tot ? Math.round(c.parsed / tot * 100) : 0}%)`; } } },
      },
    },
  });

  // ---- running balance this month
  const run = []; let acc = 0;
  for (let i = 0; i < d.credit.length; i++){ acc += d.credit[i] - d.debit[i]; run.push(acc); }
  mount('cum', 'cumChart', {
    type: 'line',
    data: { labels: d.labels, datasets: [{
      label: 'Running net', data: run, borderColor: cssVar('--credit'),
      backgroundColor: cssVar('--credit') + '20', fill: true, tension: .3, pointRadius: 0, borderWidth: 2,
    }]},
    options: { ...opts, plugins: { ...opts.plugins, legend: { display: false } }, scales: { ...opts.scales, y: { ...opts.scales.y, beginAtZero: false } } },
  });

  // ---- tasks completed, last 30 days
  const days = Array.from({ length: 30 }, (_, i) => addDays(todayISO(), i - 29));
  const counts = days.map(day => state.tasks.filter(t => t.completed && t.completedAt && toISO(new Date(t.completedAt)) === day).length);
  mount('task', 'taskChart', {
    type: 'bar',
    data: { labels: days.map(x => `${parseISO(x).getDate()} ${MONTH[parseISO(x).getMonth()]}`), datasets: [{
      label: 'Completed', data: counts, backgroundColor: cssVar('--credit') + 'cc', borderRadius: 0, borderSkipped: false,
    }]},
    options: { ...opts,
      plugins: { ...opts.plugins, legend: { display: false }, tooltip: { ...opts.plugins.tooltip, callbacks: { label: c => ` ${c.parsed.y} task${c.parsed.y === 1 ? '' : 's'}` } } },
      scales: { ...opts.scales, y: { ...opts.scales.y, ticks: { color: cssVar('--muted'), precision: 0, callback: v => v } } } },
  });
}

/* ============================================================
   SETTINGS & DATA
   ============================================================ */
const SHORTCUTS = [
  ['1 – 6', 'Jump between sections'],
  ['N', 'New task (from Tasks)'],
  ['E', 'New money entry'],
  ['/', 'Focus search'],
  ['T', 'Jump to today'],
  ['← / →', 'Previous / next day'],
  ['Esc', 'Cancel editing'],
  ['?', 'Show this list'],
];

function applyTheme(){
  const pref = state.settings.theme;
  const dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#100e0b' : '#efeae0');
}

function renderSettings(){
  const s = state.settings;
  $('#setMyName').value = me().name;
  $('#setCurrency').innerHTML = CURRENCIES.map(([c, l]) => `<option value="${c}">${escapeHtml(l)}</option>`).join('');
  $('#setCurrency').value = s.currency;
  $('#setTheme').value = s.theme;
  $('#setBudget').value = s.budget || '';
  $('#setShowOverdue').checked = s.showOverdue;
  $('#setMyShareOnly').checked = s.myShareOnly;
  $('#setConfirmDelete').checked = s.confirmDelete;

  const bytes = new Blob([JSON.stringify(state)]).size;
  $('#dataSummary').textContent =
    `${state.tasks.length} tasks · ${state.expenses.length} entries · ${state.people.length} people · ${(bytes / 1024).toFixed(1)} KB`;

  $('#shortcutList').innerHTML = SHORTCUTS
    .map(([k, d]) => `<div class="row" style="justify-content:space-between"><span class="subtle">${escapeHtml(d)}</span><span class="kbd">${escapeHtml(k)}</span></div>`)
    .join('');
}

function download(name, text, mime = 'application/json'){
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = el('a'); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const csvCell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

function exportCSV(what){
  let rows;
  if (what === 'tasks'){
    rows = [['Date','Title','Priority','Time','Deadline','Repeat','Tags','Completed','Notes']];
    for (const t of [...state.tasks].sort((a, b) => a.date.localeCompare(b.date)))
      rows.push([t.date, t.title, t.priority, t.time, t.deadline, t.repeat, t.tags.join(' '), t.completed ? 'yes' : 'no', t.notes]);
  } else {
    rows = [['Date','Type','Amount','My share','Description','Category','Method','Shared','Paid by','Split between']];
    for (const e of [...state.expenses].sort((a, b) => a.date.localeCompare(b.date))){
      const shares = e.shared ? computeShares(e.amount, e.split) : null;
      rows.push([e.date, e.type, e.amount.toFixed(2), myAmount(e).toFixed(2), e.desc, e.category, e.method,
                 e.shared ? 'yes' : 'no', e.shared ? personName(e.paidBy) : '',
                 shares ? [...shares.keys()].map(id => `${personName(id)}:${fromMinor(shares.get(id)).toFixed(2)}`).join(' | ') : '']);
    }
  }
  download(`daily-tracker-${what}-${todayISO()}.csv`, rows.map(r => r.map(csvCell).join(',')).join('\n'), 'text/csv');
  toast(`${what[0].toUpperCase()}${what.slice(1)} exported.`);
}

function importJSON(file){
  const reader = new FileReader();
  reader.onload = async () => {
    let parsed;
    try { parsed = JSON.parse(reader.result); }
    catch { toast('That file is not valid JSON.', 'err'); return; }
    const next = reconcile(parsed);
    const ok = await confirmAction({
      title: 'Replace all local data?',
      body: `This backup has ${next.tasks.length} tasks, ${next.expenses.length} money entries and ${next.people.length} people. Your current data will be replaced.`,
      okLabel: 'Replace', danger: true,
    });
    if (!ok) return;
    state = next;
    save(); applyTheme(); materialiseRepeats(); renderAll();
    toast('Backup restored.');
  };
  reader.readAsText(file);
}

/* A demo month so every screen has something to show on a fresh install. */
function sampleData(){
  const s = defaultState();
  const T = todayISO();
  s.settings = { ...s.settings, currency: 'INR', budget: 40000 };
  s.people = [
    { id: 'me', name: 'You',  color: PERSON_COLORS[0], isMe: true,  archived: false },
    { id: 'p1', name: 'Asha', color: PERSON_COLORS[1], isMe: false, archived: false },
    { id: 'p2', name: 'Bala', color: PERSON_COLORS[2], isMe: false, archived: false },
    { id: 'p3', name: 'Dev',  color: PERSON_COLORS[3], isMe: false, archived: false },
  ];

  const exp = (back, type, amount, desc, category, split) => ({
    id: uid(), date: addDays(T, -back), type, amount, desc, category, method: 'UPI',
    shared: !!split, paidBy: split ? split.by : null,
    split: split ? { mode: split.mode || 'equal', parts: split.who.map((id, i) => ({ id, value: split.values ? split.values[i] : 0 })) } : null,
    createdAt: Date.now() - back * 864e5, updatedAt: Date.now(),
  });
  s.expenses = [
    exp(26, 'Credit', 185000, 'Monthly salary',    'Salary'),
    exp(24, 'Debit',   32000, 'Flat rent',         'Rent'),
    exp(20, 'Debit',    4870, 'Big Basket run',    'Groceries'),
    exp(18, 'Debit',    3600, 'Goa trip cab',      'Travel',       { by: 'p1', who: ['me','p1','p2','p3'] }),
    exp(15, 'Debit',    8400, 'Airbnb — Goa',      'Travel',       { by: 'me', who: ['me','p1','p2','p3'] }),
    exp(12, 'Debit',    2250, 'Dinner at Toit',    'Food & drink', { by: 'me', who: ['me','p1','p2'] }),
    exp( 9, 'Debit',    1499, 'Spotify + Netflix', 'Subscriptions'),
    exp( 7, 'Debit',    6200, 'Cricket kit',       'Shopping',     { by: 'p2', who: ['me','p2'], mode: 'shares', values: [3, 1] }),
    exp( 5, 'Credit',   12000, 'Freelance invoice','Freelance'),
    exp( 3, 'Debit',    1180, 'Uber to airport',   'Transport'),
    exp( 2, 'Debit',    5400, 'Team lunch',        'Food & drink', { by: 'p3', who: ['me','p1','p2','p3'], mode: 'percent', values: [40,20,20,20] }),
    exp( 1, 'Debit',     890, 'Pharmacy',          'Health'),
    exp( 0, 'Debit',    2100, 'Groceries',         'Groceries'),
  ];
  s.settlements = [{ id: uid(), from: 'p1', to: 'me', amount: 1500, date: addDays(T, -4), note: '', createdAt: Date.now() }];

  const task = (back, title, o = {}) => ({
    id: uid(), title, notes: o.notes || '', date: addDays(T, -back),
    time: o.time || '', deadline: o.deadline || '', priority: o.priority || 'Medium',
    tags: o.tags || [], completed: !!o.done, completedAt: o.done ? parseISO(addDays(T, -back)).getTime() + 5e7 : null,
    repeat: o.repeat || 'none', seriesId: null, createdAt: Date.now() - back * 864e5, updatedAt: Date.now(),
  });
  s.tasks = [
    task(0, 'Ship the tracker redesign', { time: '10:00', priority: 'High',   tags: ['work'],    notes: 'Split view + charts' }),
    task(0, 'Morning run — 5k',          { time: '06:30', priority: 'Medium', tags: ['health'],  repeat: 'daily', done: true }),
    task(0, 'Pay electricity bill',      { priority: 'High', tags: ['home'],  repeat: 'monthly', deadline: addDays(T, -1) + 'T18:00' }),
    task(0, 'Call Asha about Goa split', { time: '19:00', priority: 'Low',    tags: ['friends'] }),
    task(1, 'Review PR #42',             { time: '15:00', priority: 'High',   tags: ['work'],    notes: 'Left over from yesterday' }),
    task(3, 'Book dentist',              { priority: 'Medium', tags: ['health'] }),
  ];
  for (let i = 1; i <= 20; i++) s.tasks.push(task(i, ['Journal','Read 20 pages','Inbox zero','Stretch'][i % 4], { done: true, tags: ['health'], priority: 'Low' }));
  return s;
}

/* ============================================================
   EVENTS
   ============================================================ */
function onAction(ev){
  const btn = ev.target.closest('[data-act]');
  if (!btn) return;
  const { act, id } = btn.dataset;

  switch (act){
    /* nav */
    case 'goto': setView(btn.dataset.view); break;

    /* tasks */
    case 'task-day':   taskUI.day = addDays(taskUI.day, Number(btn.dataset.delta)); resetTaskForm(); renderTasks(); break;
    case 'task-today': taskUI.day = todayISO(); resetTaskForm(); renderTasks(); break;
    case 'task-filter':
      taskUI.filter = btn.dataset.filter;
      $$('[data-act="task-filter"]').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
      renderTasks(); break;
    case 'task-tag':
      taskUI.tag = taskUI.tag === btn.dataset.tag ? null : btn.dataset.tag;
      renderTasks(); break;
    case 'task-toggle': toggleTask(id); break;
    case 'task-edit':   editTask(id); break;
    case 'task-delete': {
      const t = state.tasks.find(x => x.id === id);
      if (!t) break;
      const series = t.seriesId || (t.repeat !== 'none' ? t.id : null);
      guardedDelete({ title: 'Delete task?', body: `“${t.title}”${series ? ' — only this occurrence is removed.' : ''}` },
        () => removeWithUndo('tasks', x => x.id === id, 'Task'));
      break;
    }
    case 'task-move-today': {
      const t = state.tasks.find(x => x.id === id);
      if (t){ t.date = todayISO(); t.updatedAt = Date.now(); save(); renderTasks(); toast('Moved to today.'); }
      break;
    }
    case 'move-overdue': {
      const t = todayISO();
      const moved = state.tasks.filter(x => !x.completed && x.date < t);
      if (!moved.length) break;
      const before = moved.map(x => ({ id: x.id, date: x.date }));
      moved.forEach(x => { x.date = t; x.updatedAt = Date.now(); });
      save(); renderTasks();
      toast(`${moved.length} task${moved.length === 1 ? '' : 's'} moved to today.`, 'ok', 6000, {
        label: 'Undo',
        run(){ before.forEach(b => { const x = state.tasks.find(y => y.id === b.id); if (x) x.date = b.date; }); save(); renderTasks(); },
      });
      break;
    }
    case 'clear-done':
      guardedDelete({ title: 'Clear completed tasks?', body: `Removes the finished tasks on ${humanDate(taskUI.day)}.` },
        () => removeWithUndo('tasks', x => x.completed && x.date === taskUI.day, 'Completed tasks'));
      break;

    /* money */
    case 'exp-type': setExpenseType(btn.dataset.type); break;
    case 'exp-filter':
      expUI.filter = btn.dataset.filter;
      $$('[data-act="exp-filter"]').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
      renderExpenses(); break;
    case 'exp-edit': editExpense(id); break;
    case 'exp-delete': {
      const e = state.expenses.find(x => x.id === id);
      if (!e) break;
      guardedDelete({ title: 'Delete entry?', body: `${e.desc || e.category} — ${money(e.amount)}${e.shared ? '. This also removes it from everyone’s balance.' : ''}` },
        () => removeWithUndo('expenses', x => x.id === id, 'Entry'));
      break;
    }

    /* split editor */
    case 'split-toggle':
      if (draft.parts.has(id)) draft.parts.delete(id); else draft.parts.set(id, 0);
      renderSplitEditor(); break;
    case 'split-all':  seedDraftEqual(); renderSplitEditor(); break;
    case 'split-none': draft.parts.clear(); renderSplitEditor(); break;

    /* people */
    case 'person-remove': {
      const p = personById(id);
      if (!p) break;
      if (btn.dataset.used === '1'){
        guardedDelete({
          title: `Archive ${p.name}?`,
          body: 'They appear in existing splits, so their history is kept. Archiving just hides them from new entries.',
          okLabel: 'Archive', danger: false,
        }, () => { p.archived = !p.archived; save(); renderSplit(); toast(p.archived ? 'Archived.' : 'Unarchived.'); });
      } else {
        guardedDelete({ title: `Remove ${p.name}?`, body: 'They are not in any split yet, so nothing is lost.' },
          () => removeWithUndo('people', x => x.id === id, p.name));
      }
      break;
    }

    /* settlements */
    case 'settle-now': {
      state.settlements.push({
        id: uid(), from: btn.dataset.from, to: btn.dataset.to,
        amount: Number(btn.dataset.amount), date: todayISO(), note: '', createdAt: Date.now(),
      });
      save(); renderSplit(); toast('Payment recorded.');
      break;
    }
    case 'settle-delete':
      guardedDelete({ title: 'Delete settlement?', body: 'Balances will go back to what they were.' },
        () => removeWithUndo('settlements', x => x.id === id, 'Settlement'));
      break;

    /* data */
    case 'export-json':
      download(`daily-tracker-backup-${todayISO()}.json`, JSON.stringify(state, null, 2));
      toast('Backup downloaded.'); break;
    case 'import-json': $('#importFile').click(); break;
    case 'export-csv':  exportCSV(btn.dataset.what); break;
    case 'load-sample':
      confirmAction({ title: 'Load sample data?', body: 'Your current tasks, entries and people will be replaced with a demo month.', okLabel: 'Load sample', danger: false })
        .then(ok => { if (!ok) return; state = sampleData(); save(); applyTheme(); materialiseRepeats(); setView('dashboard'); toast('Sample data loaded.'); });
      break;
    case 'wipe': {
      const what = btn.dataset.what;
      const label = what === 'all' ? 'everything' : what === 'tasks' ? 'all tasks' : 'all money entries';
      confirmAction({ title: `Delete ${label}?`, body: 'This cannot be undone. Export a backup first if you might want it back.', okLabel: 'Delete forever' })
        .then(ok => {
          if (!ok) return;
          if (what === 'tasks') state.tasks = [];
          else if (what === 'expenses'){ state.expenses = []; state.settlements = []; }
          else { const theme = state.settings.theme; state = defaultState(); state.settings.theme = theme; }
          save(); applyTheme(); renderAll(); toast(`Deleted ${label}.`);
        });
      break;
    }
  }
}

function bind(){
  document.addEventListener('click', onAction);

  $$('.nav-btn').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  // roving arrow-key nav across tabs
  $('.nav').addEventListener('keydown', ev => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(ev.key)) return;
    const btns = $$('.nav-btn');
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    ev.preventDefault();
    const next = ev.key === 'Home' ? 0 : ev.key === 'End' ? btns.length - 1
               : (i + (ev.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length;
    btns[next].focus(); setView(btns[next].dataset.view);
  });

  /* tasks */
  $('#taskForm').addEventListener('submit', submitTask);
  $('#taskCancelBtn').addEventListener('click', () => { resetTaskForm(); renderTasks(); });
  $('#taskSearch').addEventListener('input', ev => { taskUI.search = ev.target.value; renderTasks(); });
  $('#taskSort').addEventListener('change', ev => { taskUI.sort = ev.target.value; renderTasks(); });
  $('#taskDate').addEventListener('change', ev => {
    if (!$('#taskId').value && ev.target.value){ taskUI.day = ev.target.value; renderTasks(); }
  });

  /* money */
  $('#expenseForm').addEventListener('submit', submitExpense);
  $('#expenseCancelBtn').addEventListener('click', () => { resetExpenseForm(); renderExpenses(); });
  $('#expenseAmount').addEventListener('input', () => { if (draft.shared) renderSplitEditor(); });
  $('#expenseShared').addEventListener('change', ev => {
    draft.shared = ev.target.checked;
    if (draft.shared && !draft.parts.size) seedDraftEqual();
    renderSplitEditor();
  });
  $('#expensePaidBy').addEventListener('change', ev => { draft.paidBy = ev.target.value; renderSplitEditor(); });
  $('#splitMode').addEventListener('change', ev => {
    draft.mode = ev.target.value;
    if (draft.mode === 'shares') for (const k of draft.parts.keys()) draft.parts.set(k, 1);
    else if (draft.mode === 'percent'){
      const n = draft.parts.size || 1;
      for (const k of draft.parts.keys()) draft.parts.set(k, Math.round(100 / n * 100) / 100);
    } else if (draft.mode === 'exact'){
      const shares = computeShares(Number($('#expenseAmount').value) || 0, { mode: 'equal', parts: [...draft.parts.keys()].map(id => ({ id, value: 1 })) });
      for (const k of draft.parts.keys()) draft.parts.set(k, fromMinor(shares.get(k) || 0));
    }
    renderSplitEditor();
  });
  $('#splitLines').addEventListener('input', ev => {
    const t = ev.target.closest('[data-act="split-value"]');
    if (!t) return;
    draft.parts.set(t.dataset.id, Number(t.value) || 0);
    // update only the derived numbers so the field keeps focus + caret
    const parts = [...draft.parts.entries()].map(([id, value]) => ({ id, value }));
    const shares = computeShares(Number($('#expenseAmount').value) || 0, { mode: draft.mode, parts });
    $$('#splitLines .split-line').forEach(line => {
      const pid = line.querySelector('[data-act="split-toggle"]')?.dataset.id;
      const owed = line.querySelector('.owed');
      if (pid && owed) owed.textContent = draft.parts.has(pid) ? money(fromMinor(shares.get(pid) || 0)) : '—';
    });
    const total = [...shares.values()].reduce((a, b) => a + b, 0);
    const target = toMinor(Number($('#expenseAmount').value) || 0);
    const bad = draft.mode === 'exact' && total !== target;
    draft.valid = !bad;
    const sum = $('#splitSummary');
    sum.textContent = bad ? `Exact amounts are off by ${moneyAbs(fromMinor(target - total))}.` : `Split ${draft.parts.size} ways · totals ${money(fromMinor(total))}.`;
    sum.style.color = bad ? 'var(--danger)' : 'var(--muted)';
  });
  $('#insightsYear').addEventListener('change', renderInsights);
  $('#peopleList').addEventListener('change', ev => {
    const t = ev.target.closest('[data-rename]');
    if (!t) return;
    const p = personById(t.dataset.rename);
    const v = t.value.trim().slice(0, 40);
    if (!p) return;
    if (!v || state.people.some(x => x.id !== p.id && x.name.toLowerCase() === v.toLowerCase())){
      toast(v ? 'Someone already has that name.' : 'Name cannot be empty.', 'err');
      t.value = p.name; return;
    }
    p.name = v; save(); renderAll(); toast('Renamed.');
  });
  $('#expRange').addEventListener('change', ev => { expUI.range = ev.target.value; renderExpenses(); });
  $('#expCategoryFilter').addEventListener('change', ev => { expUI.category = ev.target.value; renderExpenses(); });
  $('#expSearch').addEventListener('input', ev => { expUI.search = ev.target.value; renderExpenses(); });

  /* split */
  $('#personForm').addEventListener('submit', ev => {
    ev.preventDefault();
    const name = $('#personName').value.trim();
    if (!name) return;
    if (state.people.some(p => p.name.toLowerCase() === name.toLowerCase())){ toast('Someone already has that name.', 'err'); return; }
    state.people.push({ id: uid(), name: name.slice(0, 40), color: PERSON_COLORS[state.people.length % PERSON_COLORS.length], isMe: false, archived: false });
    $('#personName').value = '';
    save(); renderSplit(); toast(`${name} added.`);
  });
  $('#settleForm').addEventListener('submit', ev => {
    ev.preventDefault();
    const from = $('#settleFrom').value, to = $('#settleTo').value;
    const amount = Number($('#settleAmount').value);
    if (from === to){ toast('Pick two different people.', 'err'); return; }
    if (!(amount > 0)){ toast('Enter an amount.', 'err'); return; }
    state.settlements.push({ id: uid(), from, to, amount, date: $('#settleDate').value || todayISO(), note: '', createdAt: Date.now() });
    $('#settleAmount').value = '';
    save(); renderSplit(); toast('Payment recorded.');
  });

  /* settings */
  $('#setMyName').addEventListener('change', ev => {
    const v = ev.target.value.trim();
    if (v){ me().name = v.slice(0, 40); save(); renderAll(); }
  });
  $('#setCurrency').addEventListener('change', ev => { state.settings.currency = ev.target.value; save(); renderAll(); });
  $('#setTheme').addEventListener('change', ev => {
    state.settings.theme = ev.target.value; save(); applyTheme();
    Object.values(charts).forEach(c => c?.destroy());
    renderView(currentView);
  });
  $('#setBudget').addEventListener('change', ev => { state.settings.budget = Math.max(0, Number(ev.target.value) || 0); save(); renderSettings(); });
  $('#setShowOverdue').addEventListener('change', ev => { state.settings.showOverdue = ev.target.checked; save(); });
  $('#setMyShareOnly').addEventListener('change', ev => { state.settings.myShareOnly = ev.target.checked; save(); });
  $('#setConfirmDelete').addEventListener('change', ev => { state.settings.confirmDelete = ev.target.checked; save(); });
  $('#importFile').addEventListener('change', ev => { const f = ev.target.files[0]; if (f) importJSON(f); ev.target.value = ''; });

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (state.settings.theme === 'system') applyTheme(); });

  /* browser back / forward between sections */
  window.addEventListener('hashchange', () => {
    const v = location.hash.slice(1);
    if (VIEWS.includes(v) && v !== currentView) setView(v);
  });

  /* keyboard */
  document.addEventListener('keydown', onKey);

  /* redraw charts when the window resizes past a breakpoint */
  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => renderView(currentView), 250); });

  /* roll the day over if the tab is left open past midnight */
  setInterval(() => {
    const t = todayISO();
    if (t !== bind._today){ bind._today = t; materialiseRepeats(); renderAll(); }
  }, 60_000);
  bind._today = todayISO();
}

const VIEWS = ['dashboard','tasks','expenses','split','insights','settings'];

function onKey(ev){
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName) || ev.target.isContentEditable;

  if (ev.key === 'Escape'){
    if ($('#taskId').value){ resetTaskForm(); renderTasks(); }
    if ($('#expenseId').value){ resetExpenseForm(); renderExpenses(); }
    if (typing) ev.target.blur();
    return;
  }
  if (typing || ev.metaKey || ev.ctrlKey || ev.altKey) return;

  if (ev.key >= '1' && ev.key <= '6'){ ev.preventDefault(); setView(VIEWS[Number(ev.key) - 1]); return; }

  switch (ev.key.toLowerCase()){
    case 'n': ev.preventDefault(); setView('tasks');    $('#taskTitle').focus(); break;
    case 'e': ev.preventDefault(); setView('expenses'); $('#expenseAmount').focus(); break;
    case '/': ev.preventDefault();
      (currentView === 'expenses' ? $('#expSearch') : (setView('tasks'), $('#taskSearch'))).focus(); break;
    case 't': if (currentView === 'tasks'){ taskUI.day = todayISO(); resetTaskForm(); renderTasks(); } break;
    case 'arrowleft':  if (currentView === 'tasks'){ taskUI.day = addDays(taskUI.day, -1); resetTaskForm(); renderTasks(); } break;
    case 'arrowright': if (currentView === 'tasks'){ taskUI.day = addDays(taskUI.day,  1); resetTaskForm(); renderTasks(); } break;
    case '?': setView('settings'); $('#shortcutList').scrollIntoView({ behavior: 'smooth', block: 'center' }); break;
  }
}

/* ============================================================
   INIT
   ============================================================ */
function init(){
  load();
  applyTheme();
  materialiseRepeats();

  resetTaskForm();
  resetExpenseForm();
  bind();

  const fromHash = location.hash.slice(1);
  let start = 'dashboard';
  try { start = VIEWS.includes(fromHash) ? fromHash : (localStorage.getItem('dt_view') || 'dashboard'); } catch {}
  setView(VIEWS.includes(start) ? start : 'dashboard');
  updateBrandSub();
}

init();
