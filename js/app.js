/* ============================================================
   app.js — screens, state and interaction.
   ============================================================ */

const APP_VERSION = '2.7.0';

const S = {
  view: 'today',
  date: Calc.today(),
  settings: null,
  ings: new Map(),
  recipes: [],
  entries: [],
  weights: [],
  libTab: 'ing',
  addSlot: 'morning',
  addMode: 'log',
  draft: null,       // ingredient being reviewed/edited
  draftPhotos: {},   // {labelPhoto, frontPhoto} pending blobs
  photoTarget: null,
  portion: null,     // {kind, ref, g, entryId}
  recipeDraft: null,
  nameResults: [],
  draftNut: {},
  lookupForExisting: false,
  stopScanner: null,
  thumbs: new Map()
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/* ============================================================
   boot
   ============================================================ */

async function boot() {
  $('about-ver').textContent = APP_VERSION;
  /* The cache name is the thing that actually decides what code is running,
     so show it too — a mismatch after a deploy explains itself. */
  if (window.caches) {
    caches.keys().then((names) => {
      const el2 = $('about-cache');
      if (el2) el2.textContent = names.length ? names.join(', ') : 'none';
    }).catch(() => {});
  }
  S.settings = await DB.settings();
  applyTheme(S.settings.theme);
  if (!S.settings.seeded) await seedLibrary();
  await reload();
  bindNav();
  bindToday();
  bindLibrary();
  bindAdd();
  bindReview();
  bindPortion();
  bindRecipe();
  bindWeight();
  bindSettings();
  bindWelcome();
  bindNameSearch();
  bindFull();
  renderAll();
  if (!S.settings.welcomed) $('welcome').hidden = false;
  armSplash();
  registerSW();
  /* 250 KB of food data, fetched once the screen is up rather than before it. */
  if (typeof Swiss !== 'undefined') setTimeout(() => Swiss.preload(), 400);
}

/* The opening screen waits for a tap rather than walking itself into the
   day's log. Enter is armed only once the data is loaded, so it can never
   land on a half-drawn screen. */
function armSplash() {
  const btn = $('veil-enter');
  const veil = $('boot-veil');

  /* Since the screen now costs a tap, make it worth one: the date and where
     the day stands, so a glance answers the question without entering. */
  const total = Calc.sum(S.entries);
  const t = S.settings.targets;
  const lines = [Calc.prettyDate(S.date)];
  if (S.entries.length) {
    lines.push('<b>' + Calc.fmt(total.kcal, 0) + '</b> of ' + Calc.fmt(t.kcal, 0) + ' kcal' +
      ' · <b>' + Calc.fmt(total.pro, 0) + '</b> of ' + Calc.fmt(t.pro, 0) + ' g protein');
  } else {
    lines.push('nothing logged yet');
  }
  $('veil-meta').innerHTML = lines.join('<br>');

  btn.disabled = false;
  btn.textContent = 'Enter';
  btn.onclick = () => {
    btn.disabled = true;
    veil.classList.add('out');
    /* Leave the node in place for the fade, then take it out of the layout
       so it can never swallow a tap. */
    setTimeout(() => { veil.hidden = true; }, 450);
  };
}

function bindWelcome() {
  $('welcome-go').addEventListener('click', async () => {
    S.settings = await DB.saveSettings({ welcomed: true });
    $('welcome').hidden = true;
  });
  $('welcome-empty').addEventListener('click', async () => {
    if (!confirm('Start with nothing in the library? Your plan’s 18 ingredients and 2 saved meals are removed. Settings › Your data › Erase everything puts them back.')) return;
    await Promise.all([DB.clear('ingredients'), DB.clear('recipes')]);
    S.thumbs.clear();
    S.settings = await DB.saveSettings({ welcomed: true });
    await reload();
    renderAll();
    $('welcome').hidden = true;
    toast('Empty library — tap + to add your first item', 3600);
  });
}

async function reload() {
  const [ings, recipes, weights] = await Promise.all([
    DB.all('ingredients'), DB.all('recipes'), DB.all('weights')
  ]);
  S.ings = new Map(ings.map((i) => [i.id, i]));
  S.recipes = recipes.sort((a, b) => a.name.localeCompare(b.name));
  S.weights = weights.sort((a, b) => a.date.localeCompare(b.date));
  S.entries = await DB.entriesForDate(S.date);
  S.entries.sort((a, b) => (a.created || 0) - (b.created || 0));
}

async function seedLibrary() {
  const byName = new Map();
  for (const row of SEED_INGREDIENTS) {
    const [name, brand, basis, unit, kcal, pro, car, fat, fib, portion, slot] = row;
    const ing = {
      id: DB.uid(),
      name, brand, barcode: '',
      basis, unit, kcal, pro, car, fat, fib,
      defaultG: portion,
      defaultSlot: slot,
      source: SEED_VERIFY.indexOf(name) >= 0 ? 'verify' : 'seed',
      updated: Date.now()
    };
    await DB.put('ingredients', ing);
    byName.set(name, ing);
  }
  for (const r of SEED_RECIPES) {
    const items = r.pick
      .map((n) => byName.get(n))
      .filter(Boolean)
      .map((i) => ({ ingId: i.id, g: i.defaultG }));
    await DB.put('recipes', { id: DB.uid(), name: r.name, items, updated: Date.now() });
  }
  S.settings = await DB.saveSettings({ seeded: true });
}

const THEME_BAR = { pink: '#D9827C', light: '#F6F3EC', dark: '#14170F' };

function applyTheme(name) {
  const t = THEME_BAR[name] ? name : 'pink';
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('bibis-theme', t); } catch (e) { /* private mode */ }
  const meta = $('meta-theme');
  if (meta) meta.setAttribute('content', THEME_BAR[t]);
}

/* ---------- update detection ----------
   Offline caching means a deployed change does not reach the phone until
   the cached shell is replaced, and none of that is visible from inside
   the app. So it watches for a waiting worker and says so, instead of
   leaving you to guess whether you are on the current version. */
function registerSW() {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.register('sw.js').then((reg) => {
    /* left waiting by an earlier visit */
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);

    reg.addEventListener('updatefound', () => {
      const incoming = reg.installing;
      if (!incoming) return;
      incoming.addEventListener('statechange', () => {
        /* An existing controller means this is an update rather than a
           first install — only then is there anything worth saying. */
        if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
          offerUpdate(incoming);
        }
      });
    });

    reg.update().catch(() => {});   // ask the server once per launch
  }).catch(() => { /* no offline support; the app still works */ });

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}

function offerUpdate(worker) {
  const bar = $('update-bar');
  if (!bar || !bar.hidden) return;
  bar.hidden = false;
  $('update-go').onclick = () => {
    $('update-go').textContent = 'Updating…';
    worker.postMessage({ type: 'SKIP_WAITING' });
  };
  $('update-later').onclick = () => { bar.hidden = true; };
}

/* ============================================================
   chrome: nav, toast, busy, sheets
   ============================================================ */

function bindNav() {
  $('tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    show(btn.dataset.view);
  });
}

function show(view) {
  S.view = view;
  ['today', 'library', 'trends', 'settings'].forEach((v) => {
    $('view-' + v).hidden = v !== view;
  });
  Array.from($('tabs').children).forEach((b) => {
    b.classList.toggle('is-on', b.dataset.view === view);
  });
  if (view === 'library') renderLibrary();
  if (view === 'trends') renderTrends();
  if (view === 'settings') renderSettings();
}

let toastTimer = null;
function toast(msg, ms) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms || 2600);
}

function busy(on, text) {
  $('busy-text').textContent = text || 'Working…';
  $('busy').hidden = !on;
}

const SHEETS = ['add', 'scan', 'name', 'review', 'portion', 'recipe', 'weight', 'full'];
function openSheet(name) {
  $('sheet-host').hidden = false;
  SHEETS.forEach((s) => { $('sheet-' + s).hidden = s !== name; });
}
function closeSheets() {
  $('sheet-host').hidden = true;
  SHEETS.forEach((s) => { $('sheet-' + s).hidden = true; });
  if (S.stopScanner) { S.stopScanner(); S.stopScanner = null; }
}
$('sheet-backdrop').addEventListener('click', closeSheets);
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeSheets();
});

/* ============================================================
   TODAY
   ============================================================ */

function bindToday() {
  $('day-prev').addEventListener('click', () => changeDay(-1));
  $('day-next').addEventListener('click', () => changeDay(1));
  $('fab-add').addEventListener('click', () => openAdd(defaultSlot()));
  $('weight-add').addEventListener('click', openWeight);

  $('slots').addEventListener('click', async (e) => {
    const add = e.target.closest('.slot-add');
    if (add) { openAdd(add.dataset.slot); return; }
    const del = e.target.closest('.entry-del');
    if (del) {
      await DB.del('entries', del.dataset.id);
      await reload();
      renderToday();
      toast('Removed');
      return;
    }
    const row = e.target.closest('.entry');
    if (row) editEntry(row.dataset.id);
  });
}

function defaultSlot() {
  const h = new Date().getHours();
  if (h < 11) return 'morning';
  if (h < 15) return 'lunch';
  if (h < 19) return 'afternoon';
  return 'evening';
}

async function changeDay(delta) {
  S.date = Calc.shiftDate(S.date, delta);
  S.entries = await DB.entriesForDate(S.date);
  S.entries.sort((a, b) => (a.created || 0) - (b.created || 0));
  renderToday();
}

function renderAll() { renderToday(); }

function renderToday() {
  $('day-label').textContent = Calc.dayName(S.date);
  $('day-date').textContent = Calc.prettyDate(S.date).toUpperCase();

  const total = Calc.sum(S.entries);
  const t = S.settings.targets;

  const rings = $('rings');
  rings.textContent = '';
  rings.appendChild(ringEl('kcal', 'Energy', total.kcal, t.kcal, 'kcal', 0, true));
  rings.appendChild(ringEl('pro', 'Protein', total.pro, t.pro, 'g', 1));
  rings.appendChild(ringEl('car', 'Carbs', total.car, t.car, 'g', 1));
  rings.appendChild(ringEl('fat', 'Fat', total.fat, t.fat, 'g', 1));
  rings.appendChild(ringEl('fib', 'Fiber', total.fib, t.fib, 'g', 1));

  const host = $('slots');
  host.textContent = '';
  SLOTS.forEach((slot) => {
    const mine = S.entries.filter((e) => e.slot === slot.id);
    const sum = Calc.sum(mine);

    const wrap = el('div', 'slot');
    const head = el('div', 'slot-head');
    head.appendChild(el('h2', null, slot.name));
    head.appendChild(el('span', 'slot-kcal', mine.length ? Calc.fmt(sum.kcal, 0) + ' kcal · ' + Calc.fmt(sum.pro, 0) + ' g P' : ''));
    const addBtn = el('button', 'slot-add', '+ add');
    addBtn.dataset.slot = slot.id;
    head.appendChild(addBtn);
    wrap.appendChild(head);

    const list = el('div', 'entries');
    if (!mine.length) {
      list.appendChild(el('div', 'empty', 'Nothing logged'));
    } else {
      mine.forEach((e) => list.appendChild(entryEl(e)));
    }
    wrap.appendChild(list);
    host.appendChild(wrap);
  });

  renderWeightLine();
}

function ringEl(key, label, value, target, unit, dp, span) {
  const wrap = el('div', 'ring ' + key + (span ? ' span2' : ''));
  const top = el('div', 'ring-top');
  top.appendChild(el('span', 'ring-label', label));
  const of = el('span', 'ring-of');
  const diff = value - Calc.num(target);
  const met = target && Math.abs(diff) <= target * 0.04;
  if (met) of.classList.add('met');
  of.textContent = target
    ? (met ? 'on target'
      : (diff < 0 ? Calc.fmt(-diff, dp) + ' to go' : Calc.fmt(diff, dp) + ' over'))
    : '';
  top.appendChild(of);
  wrap.appendChild(top);

  const v = el('div', 'ring-val');
  v.textContent = Calc.fmt(value, dp);
  const u = el('small', null, unit);
  v.appendChild(u);
  wrap.appendChild(v);

  const meter = el('div', 'meter');
  const bar = el('i');
  const pct = target ? Math.min(100, value / target * 100) : 0;
  bar.style.width = pct + '%';
  if (target && value > target * 1.04) bar.classList.add('over');
  meter.appendChild(bar);
  wrap.appendChild(meter);

  if (target) {
    const foot = el('div', 'ring-of');
    foot.textContent = 'target ' + Calc.fmt(target, 0) + ' ' + unit;
    wrap.appendChild(foot);
  }
  return wrap;
}

function entryEl(e) {
  const row = el('div', 'entry');
  row.dataset.id = e.id;

  const ing = e.refKind === 'ing' ? S.ings.get(e.refId) : null;
  const url = ing ? thumbUrl(ing) : null;
  if (url) {
    const img = el('img', 'entry-thumb');
    img.src = url;
    img.alt = '';
    row.appendChild(img);
  } else {
    row.appendChild(el('div', 'entry-thumb', (e.name || '?').charAt(0).toUpperCase()));
  }

  const main = el('div', 'entry-main');
  main.appendChild(el('div', 'entry-name', e.name));
  main.appendChild(el('div', 'entry-sub',
    (e.refKind === 'rec' ? Calc.fmt(e.mult * 100, 0) + '% portion' : Calc.fmt(e.g, e.g % 1 ? 1 : 0) + ' ' + (e.unit || 'g')) +
    ' · ' + Calc.fmt(e.pro, 1) + ' P · ' + Calc.fmt(e.car, 1) + ' C · ' + Calc.fmt(e.fat, 1) + ' F'
  ));
  row.appendChild(main);

  row.appendChild(el('div', 'entry-kcal', Calc.fmt(e.kcal, 0)));
  const del = el('button', 'entry-del', '✕');
  del.dataset.id = e.id;
  del.setAttribute('aria-label', 'Remove ' + e.name);
  row.appendChild(del);
  return row;
}

function thumbUrl(ing) {
  const blob = ing.frontPhoto || ing.labelPhoto;
  if (!blob) return null;
  if (S.thumbs.has(ing.id)) return S.thumbs.get(ing.id);
  const url = URL.createObjectURL(blob);
  S.thumbs.set(ing.id, url);
  return url;
}

function renderWeightLine() {
  const host = $('weight-line');
  host.textContent = '';
  if (!S.weights.length) {
    host.appendChild(el('span', null, 'No weight logged yet.'));
    return;
  }
  const last = S.weights[S.weights.length - 1];
  const b = el('b', null, Calc.fmt(last.kg, 1) + ' kg');
  host.appendChild(b);
  host.appendChild(el('span', null, '  ' + Calc.prettyDate(last.date)));
  if (S.weights.length > 1) {
    const first = S.weights[0];
    const d = last.kg - first.kg;
    host.appendChild(el('span', null,
      '   ' + (d >= 0 ? '+' : '−') + Calc.fmt(Math.abs(d), 1) + ' kg since ' + Calc.prettyDate(first.date)));
  }
}

/* ============================================================
   ADD flow
   ============================================================ */

function bindAdd() {
  $('add-search').addEventListener('input', renderAddResults);
  $('m-barcode').addEventListener('click', openScanner);
  $('m-photo').addEventListener('click', () => {
    S.photoTarget = 'read';
    $('photo-input').value = '';
    $('photo-input').click();
  });
  $('m-album').addEventListener('click', () => {
    S.photoTarget = 'read';
    $('album-input').value = '';
    $('album-input').click();
  });
  $('m-manual').addEventListener('click', () => {
    openReview({
      name: '', brand: '', barcode: '', basis: 100, unit: 'g',
      kcal: 0, pro: 0, car: 0, fat: 0, fib: 0, source: 'manual'
    }, { isNew: true });
  });
  $('photo-input').addEventListener('change', onPhotoRead);
  $('album-input').addEventListener('change', onPhotoRead);

  $('add-results').addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    if (row.dataset.kind === 'ing') openPortion('ing', S.ings.get(row.dataset.id));
    else openPortion('rec', S.recipes.find((r) => r.id === row.dataset.id));
  });
}

/* Two intents, one sheet. From Today you are logging something you ate, so
   saving an ingredient continues to the portion step. From Library you are
   cataloguing a product for later, so saving stops there. */
function openAdd(slot) {
  S.addMode = 'log';
  S.addSlot = slot;
  const name = (SLOTS.find((s) => s.id === slot) || { name: 'the day' }).name.toLowerCase();
  $('add-title').textContent = 'Add to ' + name;
  $('add-existing').hidden = false;
  $('add-search').value = '';
  renderAddResults();
  openSheet('add');
}

function openAddToLibrary() {
  S.addMode = 'library';
  $('add-title').textContent = 'New ingredient';
  /* No point searching the library for something you are adding to it. */
  $('add-existing').hidden = true;
  openSheet('add');
}

function renderAddResults() {
  const q = ($('add-search').value || '').trim().toLowerCase();
  const host = $('add-results');
  host.textContent = '';

  let recs = S.recipes;
  let ings = Array.from(S.ings.values());
  if (q) {
    const m = (s) => (s || '').toLowerCase().indexOf(q) >= 0;
    recs = recs.filter((r) => m(r.name));
    ings = ings.filter((i) => m(i.name) || m(i.brand) || m(i.barcode));
  } else {
    ings = ings.sort((a, b) => (b.updated || 0) - (a.updated || 0)).slice(0, 6);
  }

  recs.forEach((r) => host.appendChild(recipeRow(r)));
  ings.sort((a, b) => a.name.localeCompare(b.name)).forEach((i) => host.appendChild(ingRow(i)));

  if (!host.children.length) {
    host.appendChild(el('div', 'empty', q ? 'Nothing in your library matches — scan, photograph or type it in below.' : 'Your library is empty.'));
  }
}

function ingRow(i, editable) {
  const row = el('button', 'row');
  row.dataset.kind = 'ing';
  row.dataset.id = i.id;
  const url = thumbUrl(i);
  if (url) { const img = el('img', 'row-thumb'); img.src = url; img.alt = ''; row.appendChild(img); }
  else row.appendChild(el('div', 'row-thumb', i.name.charAt(0).toUpperCase()));

  const main = el('div', 'row-main');
  main.appendChild(el('div', 'row-name', i.name || 'Unnamed'));
  const sub = el('div', 'row-sub');
  sub.textContent = Calc.fmt(i.kcal, 0) + ' kcal · ' + Calc.fmt(i.pro, 1) + ' P · ' +
    Calc.fmt(i.car, 1) + ' C · ' + Calc.fmt(i.fat, 1) + ' F';
  main.appendChild(sub);
  row.appendChild(main);

  const right = el('div', 'row-right');
  right.appendChild(srcTag(i.source));
  right.appendChild(el('span', 'row-basis', 'per ' + Calc.basisOf(i) + ' ' + (i.unit || 'g')));
  row.appendChild(right);

  /* In Library the row opens the editor, so say so. Without this the row
     looks like a read-only list entry and the editor stays undiscovered. */
  if (editable) row.appendChild(el('span', 'row-edit', '✎'));
  return row;
}

function recipeRow(r) {
  const row = el('button', 'row');
  row.dataset.kind = 'rec';
  row.dataset.id = r.id;
  row.appendChild(el('div', 'row-thumb', r.name.charAt(0).toUpperCase()));
  const { macros, grams } = Calc.scaleRecipe(r, S.ings);
  const main = el('div', 'row-main');
  main.appendChild(el('div', 'row-name', r.name));
  main.appendChild(el('div', 'row-sub',
    (r.items || []).length + ' items · ' + Calc.fmt(grams, 0) + ' g · ' +
    Calc.fmt(macros.kcal, 0) + ' kcal · ' + Calc.fmt(macros.pro, 1) + ' P'));
  row.appendChild(main);
  const right = el('div', 'row-right', 'meal');
  row.appendChild(right);
  return row;
}

function srcTag(source) {
  const map = {
    off: ['src-off', 'OFF'],
    ai: ['src-ai', 'PHOTO'],
    usda: ['src-usda', 'USDA'],
    swiss: ['src-swiss', 'SWISS'],
    lookup: ['src-ai', 'LOOKED UP'],
    manual: ['src-manual', 'TYPED'],
    seed: ['src-seed', 'PLAN'],
    verify: ['src-ai', 'CHECK']
  };
  const [cls, text] = map[source] || map.manual;
  return el('span', 'src-tag ' + cls, text);
}

/* ---------- barcode ---------- */

async function openScanner() {
  openSheet('scan');
  $('scan-manual').value = '';
  const status = (m) => { $('scan-status').textContent = m; };
  status(Vision.barcodeSupported()
    ? 'Point the camera at the barcode.'
    : 'This browser cannot decode barcodes — type the number instead.');
  try {
    S.stopScanner = await Vision.startScanner($('cam'), (code) => {
      S.stopScanner = null;
      doLookup(code);
    }, status);
  } catch (e) {
    status(e.message + ' Type the number under the bars instead.');
  }
}

$('scan-lookup').addEventListener('click', () => {
  const code = ($('scan-manual').value || '').trim();
  if (!code) { toast('Type the barcode number first'); return; }
  if (S.stopScanner) { S.stopScanner(); S.stopScanner = null; }
  doLookup(code);
});

async function doLookup(code) {
  busy(true, 'Looking up ' + code + '…');
  try {
    const existing = await DB.byIndex('ingredients', 'barcode', String(code).replace(/\D/g, ''));
    if (existing && existing.length) {
      busy(false);
      if (S.addMode === 'library') {
        toast('Already in your library — opening it');
        openReview(existing[0], { isNew: false });
      } else {
        toast('Already in your library');
        openPortion('ing', existing[0]);
      }
      return;
    }
    const draft = await Vision.lookupBarcode(code);
    busy(false);
    openReview(draft, { isNew: true });
  } catch (e) {
    busy(false);
    if (e.notFound) {
      openReview({
        name: '', brand: '', barcode: String(code).replace(/\D/g, ''),
        basis: 100, unit: 'g', kcal: 0, pro: 0, car: 0, fat: 0, fib: 0,
        source: 'manual',
        note: 'Not in Open Food Facts. Photograph the label below, or type the values in.'
      }, { isNew: true });
    } else {
      toast(e.message, 4200);
    }
  }
}

/* ---------- label photo ---------- */

async function onPhotoRead(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  busy(true, 'Reading the label…');
  try {
    const blob = await Vision.prepareImage(file);
    if (S.settings.aiProvider === 'none' || !S.settings.aiKey) {
      busy(false);
      S.draftPhotos.labelPhoto = blob;
      openReview({
        name: '', brand: '', barcode: '', basis: 100, unit: 'g',
        kcal: 0, pro: 0, car: 0, fat: 0, fib: 0, source: 'manual',
        note: 'Photo attached. Label reading is off, so type the values from the picture.'
      }, { isNew: true, keepPhotos: true });
      return;
    }
    const draft = await Vision.readLabel(blob, S.settings);
    S.draftPhotos.labelPhoto = blob;
    busy(false);
    openReview(draft, { isNew: true, keepPhotos: true });
  } catch (e) {
    busy(false);
    toast(e.message, 5000);
  }
}

/* ============================================================
   FULL NUTRITION PANEL
   ============================================================ */

function bindFull() {
  $('open-full').addEventListener('click', openFullForDay);
}

function openFullForDay() {
  const nutrients = S.entries.map((e) => (e.n && typeof e.n === 'object') ? e.n : Nut.of(e));
  const kcals = S.entries.map((e) => Calc.num(e.kcal));
  const { sum, coverage } = Nut.total(nutrients, kcals);

  $('full-title').textContent = 'Full nutrition · ' + Calc.dayName(S.date);

  const withData = nutrients.filter((n) => Object.keys(n).some((k) => CORE.indexOf(k) < 0)).length;
  const note = $('full-note');
  if (!S.entries.length) {
    note.textContent = 'Nothing logged for this day yet.';
  } else if (withData === S.entries.length) {
    note.textContent = 'All ' + S.entries.length + ' items carry vitamin and mineral data. Percentages are of the EU reference intake for adults (Regulation 1169/2011).';
  } else {
    note.textContent = withData + ' of ' + S.entries.length + ' items carry vitamin and mineral data. Where an item has no value for a nutrient it is left out of that total rather than counted as zero — so each figure says how much of the day it actually covers.';
  }

  renderNutPanel($('full-panel'), sum, coverage, true);
  openSheet('full');
}

function renderNutPanel(host, sum, coverage, showCoverage) {
  host.textContent = '';
  NUTRIENT_GROUPS.forEach((group) => {
    const keys = Nut.keysInGroup(group.id);
    if (!keys.some((k) => sum[k] !== undefined)) return;

    const wrap = el('div', 'nut-group');
    wrap.appendChild(el('h3', null, group.name));
    const rows = el('div', 'nut-rows');

    keys.forEach((key) => {
      const meta = NUT[key];
      const value = sum[key];
      const known = value !== undefined;
      const row = el('div', 'nut-row' + (known ? '' : ' none'));

      row.appendChild(el('div', 'nut-name', meta.label));
      const val = el('div', 'nut-val');
      val.textContent = known ? Nut.fmt(key, value) : 'no data';
      if (known) val.appendChild(el('small', null, meta.unit));
      row.appendChild(val);

      if (known && meta.nrv) {
        const pct = Nut.pct(key, value);
        const meter = el('div', 'nut-meter');
        const bar = el('div', 'ri-track');
        const fill = el('i');
        fill.style.width = Math.min(100, pct) + '%';
        if (pct > 150) fill.classList.add('high');
        bar.appendChild(fill);
        meter.appendChild(bar);
        meter.appendChild(el('span', 'pct', Math.round(pct) + '% RI'));
        row.appendChild(meter);
      }

      if (known && showCoverage && coverage[key] && coverage[key].energyShare < 0.995) {
        const c = coverage[key];
        row.appendChild(el('div', 'nut-cover',
          'covers ' + Math.round(c.energyShare * 100) + '% of the day’s energy · ' +
          c.items + ' of ' + c.ofItems + ' items'));
      }
      rows.appendChild(row);
    });

    wrap.appendChild(rows);
    host.appendChild(wrap);
  });

  if (!host.children.length) host.appendChild(el('div', 'empty', 'No nutrient data yet.'));
}

/* ---------- the editable panel inside the review sheet ---------- */

function renderMoreNutrients() {
  const host = $('r-more-fields');
  host.textContent = '';
  const current = S.draftNut || {};
  $('r-more-basis').textContent = (parseFloat($('r-basis').value) || 100) + ' ' + $('r-unit').value;

  const countLabel = () => {
    const n = Object.keys(S.draftNut).filter((k) => CORE.indexOf(k) < 0).length;
    $('r-more-count').textContent = n ? n + ' with values' : 'none set';
  };
  countLabel();

  NUTRIENT_GROUPS.forEach((group) => {
    const keys = Nut.keysInGroup(group.id).filter((k) => CORE.indexOf(k) < 0);
    if (!keys.length) return;
    host.appendChild(el('div', 'more-sub', group.name));
    const grid = el('div', 'more-grid');
    keys.forEach((key) => {
      const meta = NUT[key];
      const label = el('label');
      label.appendChild(el('span', null, meta.label + ' (' + meta.unit + ')'));
      const inp = el('input');
      inp.type = 'number';
      inp.step = 'any';
      inp.min = '0';
      inp.inputMode = 'decimal';
      inp.placeholder = 'no data';
      inp.value = current[key] !== undefined ? current[key] : '';
      inp.addEventListener('input', () => {
        const raw = inp.value.trim();
        if (raw === '') delete S.draftNut[key];
        else {
          const v = parseFloat(raw);
          if (isFinite(v)) S.draftNut[key] = v;
        }
        countLabel();
      });
      label.appendChild(inp);
      grid.appendChild(label);
    });
    host.appendChild(grid);
  });
}

/* ============================================================
   NAME SEARCH — food with no barcode and no label
   ============================================================ */

function bindNameSearch() {
  $('m-name').addEventListener('click', () => openNameSearch(''));
  $('nm-go').addEventListener('click', runNameSearch);
  $('nm-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') runNameSearch(); });

  $('nm-results').addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    const draft = S.nameResults[Number(row.dataset.i)];
    if (!draft) return;

    /* Opened from an existing ingredient's form, so fill that record in
       place. Creating a second "Carrots, raw" would leave the day log
       pointing at whichever one happened to be picked first. */
    if (S.lookupForExisting) {
      fillReviewFrom(draft);
      openSheet('review');
      toast('Values filled in — check them, then Save');
      return;
    }
    openReview(draft, { isNew: true });
  });

  /* the same lookup, reachable from a half-filled ingredient form */
  $('r-lookup').addEventListener('click', () => {
    const q = ($('r-name').value || '').trim();
    if (!q) { toast('Type a name first, then look it up'); return; }
    openNameSearch(q, true, true);
  });
}

/* Overwrite the open review form's values from a search result, keeping the
   name the user already typed and keeping the record's identity. */
function fillReviewFrom(draft) {
  const keepName = ($('r-name').value || '').trim();
  $('r-basis').value = Calc.basisOf(draft);
  $('r-unit').value = draft.unit === 'ml' ? 'ml' : 'g';
  MACROS.forEach((k) => { $('r-' + k).value = Calc.num(draft[k]); });
  if (!keepName) $('r-name').value = draft.name || '';
  if (draft.brand && !($('r-brand').value || '').trim()) $('r-brand').value = draft.brand;

  S.draftNut = Nut.of(draft);
  if (S.draft) S.draft.source = draft.source;
  renderMoreNutrients();
  $('r-more').open = true;

  const prov = $('review-prov');
  prov.textContent = (draft.note || '') +
    ' — values replaced from this lookup, and the basis is now ' +
    Calc.basisOf(draft) + ' ' + (draft.unit || 'g') + '.';
  prov.hidden = false;
  prov.classList.toggle('off', draft.source === 'off');
}

function openNameSearch(q, autorun, forExisting) {
  $('nm-q').value = q || '';
  $('nm-results').textContent = '';
  S.nameResults = [];
  S.lookupForExisting = !!forExisting;
  $('nm-status').textContent = sourceLine();
  openSheet('name');
  if (autorun && q) runNameSearch();
}

function sourceLine() {
  const swiss = (typeof Swiss !== 'undefined')
    ? 'Searching the Swiss database' + (Swiss.ready() ? ' (' + Swiss.count() + ' foods, offline)' : '') + ', then '
    : '';
  if ((S.settings.usdaKey || '').trim()) return swiss + 'USDA FoodData Central.';
  if (S.settings.aiProvider !== 'none' && (S.settings.aiKey || '').trim()) {
    return swiss + 'the model, which answers from reference tables.';
  }
  return swiss + 'Open Food Facts. Add a USDA key under Settings for the reference tables.';
}

async function runNameSearch() {
  const q = ($('nm-q').value || '').trim();
  if (q.length < 2) { toast('Type at least two letters'); return; }
  const host = $('nm-results');
  host.textContent = '';
  $('nm-status').textContent = 'Searching for "' + q + '"…';
  busy(true, 'Searching…');
  try {
    const results = await Vision.searchByName(q, S.settings);
    S.nameResults = results;
    busy(false);
    const base = results.length === 1
      ? 'One match. Tap it to check the values.'
      : results.length + ' matches. Tap the closest one — you can still edit every value.';
    $('nm-status').textContent = results._warn ? base + ' ⚠ ' + results._warn : base;
    results.forEach((r, i) => {
      const row = el('button', 'row');
      row.dataset.i = i;
      row.appendChild(el('div', 'row-thumb', (r._label || r.name || '?').charAt(0).toUpperCase()));
      const main = el('div', 'row-main');
      main.appendChild(el('div', 'row-name', r._label || r.name));
      main.appendChild(el('div', 'row-sub', r._sub ||
        (Calc.fmt(r.kcal, 0) + ' kcal · ' + Calc.fmt(r.pro, 1) + ' P · ' +
         Calc.fmt(r.car, 1) + ' C · ' + Calc.fmt(r.fat, 1) + ' F')));
      row.appendChild(main);
      const right = el('div', 'row-right');
      right.appendChild(srcTag(r.source));
      right.appendChild(el('span', 'row-basis', 'per 100 ' + (r.unit || 'g')));
      row.appendChild(right);
      host.appendChild(row);
    });
  } catch (e) {
    busy(false);
    $('nm-status').textContent = e.message;
  }
}

/* ============================================================
   REVIEW (create / edit an ingredient)
   ============================================================ */

function bindReview() {
  $('r-save').addEventListener('click', saveReview);
  $('r-delete').addEventListener('click', deleteIngredient);
  $('r-add-label').addEventListener('click', () => { S.photoTarget = 'labelPhoto'; $('r-photo-file').value = ''; $('r-photo-file').click(); });
  $('r-add-front').addEventListener('click', () => { S.photoTarget = 'frontPhoto'; $('r-photo-file').value = ''; $('r-photo-file').click(); });
  $('r-photo-file').addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    try {
      if (S.photoTarget !== 'labelPhoto' && S.photoTarget !== 'frontPhoto') S.photoTarget = 'labelPhoto';
      S.draftPhotos[S.photoTarget] = await Vision.prepareImage(file);
      renderReviewPhotos();
      toast('Photo attached');
    } catch (e) { toast(e.message); }
  });
}

function openReview(draft, opts) {
  const o = opts || {};
  S.draft = Object.assign({}, draft);
  if (!o.keepPhotos) S.draftPhotos = {};
  if (o.isNew) { S.draft.id = null; }

  $('review-title').textContent = o.isNew ? 'Check the values' : 'Edit ingredient';
  const prov = $('review-prov');
  if (draft.note) { prov.textContent = draft.note; prov.hidden = false; prov.classList.toggle('off', draft.source === 'off'); }
  else prov.hidden = true;

  $('r-name').value = draft.name || '';
  $('r-brand').value = draft.brand || '';
  $('r-barcode').value = draft.barcode || '';
  $('r-basis').value = Calc.basisOf(draft);
  $('r-unit').value = draft.unit === 'ml' ? 'ml' : 'g';
  MACROS.forEach((k) => { $('r-' + k).value = Calc.num(draft[k]); });
  $('r-delete').hidden = !draft.id;

  /* Everything beyond the five macros lives here while the sheet is open. */
  S.draftNut = Nut.of(draft);
  $('r-more').open = false;
  renderMoreNutrients();

  renderReviewPhotos();
  openSheet('review');
}

function renderReviewPhotos() {
  const host = $('review-photos');
  host.textContent = '';
  [['labelPhoto', 'Nutrition label'], ['frontPhoto', 'Product']].forEach(([key, cap]) => {
    const pending = S.draftPhotos[key];
    if (pending === 'remove') return;                    // struck out, awaiting Save
    const blob = pending || (S.draft && S.draft[key]);
    if (!blob) return;

    const fig = el('figure');
    const img = el('img');
    img.src = URL.createObjectURL(blob);
    img.alt = cap;
    fig.appendChild(img);
    fig.appendChild(el('figcaption', null, cap + (pending ? ' · new' : '')));

    const acts = el('div', 'photo-row-acts');
    const swap = el('button', 'mini-btn', 'Replace');
    swap.type = 'button';
    swap.onclick = () => { S.photoTarget = key; $('r-photo-file').value = ''; $('r-photo-file').click(); };
    const drop = el('button', 'mini-btn danger', 'Remove');
    drop.type = 'button';
    drop.onclick = () => {
      /* 'remove' rather than deleting the key: an absent key means "leave
         whatever is already saved alone", which is the opposite intent. */
      S.draftPhotos[key] = 'remove';
      renderReviewPhotos();
      toast('Photo will be removed when you save');
    };
    acts.appendChild(swap);
    acts.appendChild(drop);
    fig.appendChild(acts);
    host.appendChild(fig);
  });
}

/* three states: a new blob, an explicit removal, or leave as it was */
function resolvePhoto(key, prev) {
  const pending = S.draftPhotos[key];
  if (pending === 'remove') return null;
  if (pending) return pending;
  return (prev && prev[key]) || null;
}

async function saveReview() {
  const name = ($('r-name').value || '').trim();
  if (!name) { toast('Give it a name first'); return; }
  const basis = parseFloat($('r-basis').value);
  if (!(basis > 0)) { toast('The label basis must be a number above zero'); return; }

  const prev = S.draft.id ? S.ings.get(S.draft.id) : null;
  const ing = {
    id: S.draft.id || DB.uid(),
    name,
    brand: ($('r-brand').value || '').trim(),
    barcode: ($('r-barcode').value || '').replace(/\D/g, ''),
    basis,
    unit: $('r-unit').value === 'ml' ? 'ml' : 'g',
    defaultG: (prev && prev.defaultG) || Math.round(basis),
    defaultSlot: (prev && prev.defaultSlot) || S.addSlot,
    source: S.draft.source === 'verify' ? 'manual' : (S.draft.source || 'manual'),
    labelPhoto: resolvePhoto('labelPhoto', prev),
    frontPhoto: resolvePhoto('frontPhoto', prev),
    updated: Date.now()
  };
  MACROS.forEach((k) => { ing[k] = Calc.num($('r-' + k).value); });

  /* The five macros are authoritative from their own fields; the extended
     panel keeps whatever it holds. Salt and sodium are kept consistent. */
  const nut = Object.assign({}, S.draftNut);
  MACROS.forEach((k) => { nut[k] = ing[k]; });
  Nut.deriveSalt(nut);
  ing.n = nut;

  await DB.put('ingredients', ing);
  S.thumbs.delete(ing.id);
  await reload();

  const wasNew = !S.draft.id;
  S.draft = null;
  S.draftPhotos = {};

  if (wasNew && S.addMode !== 'library') {
    openPortion('ing', S.ings.get(ing.id));
  } else {
    closeSheets();
    renderToday();
    renderLibrary();
    toast(wasNew ? 'Added to your library' : 'Saved');
  }
}

async function deleteIngredient() {
  if (!S.draft || !S.draft.id) return;
  const used = S.recipes.some((r) => (r.items || []).some((it) => it.ingId === S.draft.id));
  if (used && !confirm('This ingredient is used in a saved meal. Delete it anyway?')) return;
  await DB.del('ingredients', S.draft.id);
  S.thumbs.delete(S.draft.id);
  await reload();
  closeSheets();
  renderLibrary();
  toast('Deleted');
}

/* ============================================================
   PORTION (log it)
   ============================================================ */

function bindPortion() {
  $('portion-g').addEventListener('input', renderPortionPreview);
  $('portion-save').addEventListener('click', savePortion);
  $('portion-edit').addEventListener('click', () => {
    if (!S.portion) return;
    if (S.portion.kind === 'ing') openReview(S.portion.ref, { isNew: false });
    else openRecipe(S.portion.ref);
  });
  $('portion-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    $('portion-g').value = chip.dataset.v;
    renderPortionPreview();
  });
}

function openPortion(kind, ref, entry) {
  if (!ref) { toast('That item is missing from your library'); return; }
  S.portion = { kind, ref, entryId: entry ? entry.id : null };
  $('portion-title').textContent = ref.name;

  if (kind === 'ing') {
    $('portion-unit').textContent = ref.unit || 'g';
    $('portion-g').value = entry ? entry.g : (ref.defaultG || Calc.basisOf(ref));
    const base = Calc.num(ref.defaultG) || Calc.basisOf(ref);
    const chips = [base * 0.5, base, base * 1.5, base * 2, Calc.basisOf(ref)]
      .map((v) => Math.round(v * 10) / 10)
      .filter((v, i, a) => v > 0 && a.indexOf(v) === i)
      .sort((a, b) => a - b);
    fillChips(chips, (v) => v + ' ' + (ref.unit || 'g'));
  } else {
    $('portion-unit').textContent = '% of the meal';
    $('portion-g').value = entry ? Math.round(entry.mult * 100) : 100;
    fillChips([50, 75, 100, 125, 150], (v) => v + '%');
  }
  renderPortionPreview();
  openSheet('portion');
}

function fillChips(values, label) {
  const host = $('portion-chips');
  host.textContent = '';
  values.forEach((v) => {
    const c = el('button', 'chip', label(v));
    c.dataset.v = v;
    host.appendChild(c);
  });
}

function portionMacros() {
  const p = S.portion;
  const v = Calc.num($('portion-g').value);

  if (p.kind === 'ing') {
    return {
      macros: Calc.scale(p.ref, v),
      nut: Nut.scale(Nut.of(p.ref), v, Calc.basisOf(p.ref)),
      g: v, mult: 1
    };
  }

  const { macros, grams } = Calc.scaleRecipe(p.ref, S.ings);
  const mult = v / 100;
  const out = {};
  MACROS.forEach((k) => { out[k] = macros[k] * mult; });

  /* A recipe's nutrient total is only as complete as its ingredients. Sum
     what is known per nutrient; a nutrient no ingredient knows stays absent. */
  const nut = {};
  (p.ref.items || []).forEach((it) => {
    const ing = S.ings.get(it.ingId);
    if (!ing) return;
    const scaled = Nut.scale(Nut.of(ing), Calc.num(it.g) * mult, Calc.basisOf(ing));
    Object.keys(scaled).forEach((k) => { nut[k] = (nut[k] || 0) + scaled[k]; });
  });

  return { macros: out, nut, g: grams * mult, mult };
}

function renderPortionPreview() {
  const { macros } = portionMacros();
  const host = $('portion-preview');
  host.textContent = '';
  [['kcal', 'kcal', 0], ['pro', 'protein', 1], ['car', 'carbs', 1], ['fat', 'fat', 1], ['fib', 'fiber', 1]]
    .forEach(([k, label, dp]) => {
      const cell = el('div', 'pp ' + k);
      cell.appendChild(el('div', 'pp-l', label));
      cell.appendChild(el('div', 'pp-v', Calc.fmt(macros[k], dp)));
      host.appendChild(cell);
    });
}

async function savePortion() {
  const p = S.portion;
  const { macros, nut, g, mult } = portionMacros();
  if (!(g > 0)) { toast('Enter an amount above zero'); return; }

  const entry = {
    id: p.entryId || DB.uid(),
    date: S.date,
    slot: S.addSlot,
    refKind: p.kind,
    refId: p.ref.id,
    name: p.ref.name,
    unit: p.kind === 'ing' ? (p.ref.unit || 'g') : 'g',
    g: Math.round(g * 10) / 10,
    mult,
    created: Date.now()
  };
  MACROS.forEach((k) => { entry[k] = Math.round(macros[k] * 100) / 100; });

  /* Snapshot the full panel too, for the same reason as the macros: what you
     ate today must not change when you correct an ingredient tomorrow. */
  const snap = {};
  Object.keys(nut || {}).forEach((k) => { snap[k] = Math.round(nut[k] * 1000) / 1000; });
  MACROS.forEach((k) => { snap[k] = entry[k]; });
  entry.n = snap;

  if (p.entryId) {
    const old = S.entries.find((e) => e.id === p.entryId);
    if (old) { entry.slot = old.slot; entry.date = old.date; entry.created = old.created; }
  }

  if (p.kind === 'ing') {
    const ing = Object.assign({}, p.ref, { defaultG: entry.g, updated: Date.now() });
    await DB.put('ingredients', ing);
  }

  await DB.put('entries', entry);
  await reload();
  closeSheets();
  renderToday();
  toast(p.entryId ? 'Updated' : 'Added to ' + (SLOTS.find((s) => s.id === entry.slot) || {}).name);
}

function editEntry(id) {
  const e = S.entries.find((x) => x.id === id);
  if (!e) return;
  S.addSlot = e.slot;
  const ref = e.refKind === 'ing' ? S.ings.get(e.refId) : S.recipes.find((r) => r.id === e.refId);
  if (!ref) { toast('That item is no longer in your library'); return; }
  openPortion(e.refKind, ref, e);
}

/* ============================================================
   LIBRARY
   ============================================================ */

function bindLibrary() {
  $('lib-search').addEventListener('input', renderLibrary);
  $('lib-seg').addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    S.libTab = b.dataset.tab;
    Array.from($('lib-seg').children).forEach((x) => x.classList.toggle('is-on', x === b));
    renderLibrary();
  });
  $('lib-new').addEventListener('click', () => {
    if (S.libTab === 'rec') openRecipe(null);
    else openAddToLibrary();
  });
  $('lib-list').addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    if (row.dataset.kind === 'ing') openReview(S.ings.get(row.dataset.id), { isNew: false });
    else openRecipe(S.recipes.find((r) => r.id === row.dataset.id));
  });
}

function renderLibrary() {
  const q = ($('lib-search').value || '').trim().toLowerCase();
  const host = $('lib-list');
  host.textContent = '';
  const m = (s) => (s || '').toLowerCase().indexOf(q) >= 0;

  if (S.libTab === 'rec') {
    const list = S.recipes.filter((r) => !q || m(r.name));
    list.forEach((r) => {
      const row = recipeRow(r);
      row.appendChild(el('span', 'row-edit', '✎'));
      host.appendChild(row);
    });
    $('lib-count').textContent = S.recipes.length + ' SAVED MEALS';
    if (!list.length) host.appendChild(el('div', 'empty', 'No saved meals yet. Tap + to build one.'));
    return;
  }

  const all = Array.from(S.ings.values());
  const list = all
    .filter((i) => !q || m(i.name) || m(i.brand) || m(i.barcode))
    .sort((a, b) => {
      const av = a.source === 'verify' ? 0 : 1;
      const bv = b.source === 'verify' ? 0 : 1;
      if (av !== bv) return av - bv;
      return a.name.localeCompare(b.name);
    });
  const toCheck = all.filter((i) => i.source === 'verify').length;
  $('lib-count').textContent = all.length + ' INGREDIENTS' + (toCheck ? ' · ' + toCheck + ' TO CHECK' : '');
  list.forEach((i) => host.appendChild(ingRow(i, true)));
  if (!list.length) host.appendChild(el('div', 'empty', 'Nothing matches.'));
}

/* ============================================================
   RECIPES
   ============================================================ */

function bindRecipe() {
  $('rc-save').addEventListener('click', saveRecipe);
  $('rc-delete').addEventListener('click', deleteRecipe);
  $('rc-add-item').addEventListener('click', () => {
    const name = prompt('Search your library for an ingredient to add:');
    if (!name) return;
    const q = name.trim().toLowerCase();
    const hit = Array.from(S.ings.values()).find((i) => i.name.toLowerCase().indexOf(q) >= 0);
    if (!hit) { toast('No ingredient matches "' + name + '"'); return; }
    S.recipeDraft.items.push({ ingId: hit.id, g: hit.defaultG || Calc.basisOf(hit) });
    renderRecipeItems();
  });
  $('rc-items').addEventListener('click', (e) => {
    const rm = e.target.closest('.entry-del');
    if (!rm) return;
    S.recipeDraft.items.splice(Number(rm.dataset.i), 1);
    renderRecipeItems();
  });
  $('rc-items').addEventListener('input', (e) => {
    if (!e.target.matches('input[data-i]')) return;
    S.recipeDraft.items[Number(e.target.dataset.i)].g = Calc.num(e.target.value);
    renderRecipePreview();
  });
}

function openRecipe(recipe) {
  S.recipeDraft = recipe
    ? { id: recipe.id, name: recipe.name, items: (recipe.items || []).map((i) => Object.assign({}, i)) }
    : { id: null, name: '', items: [] };
  $('recipe-title').textContent = recipe ? 'Edit meal' : 'New saved meal';
  $('rc-name').value = S.recipeDraft.name;
  $('rc-delete').hidden = !recipe;
  renderRecipeItems();
  openSheet('recipe');
}

function renderRecipeItems() {
  const host = $('rc-items');
  host.textContent = '';
  S.recipeDraft.items.forEach((it, i) => {
    const ing = S.ings.get(it.ingId);
    const row = el('div', 'entry');
    const main = el('div', 'entry-main');
    main.appendChild(el('div', 'entry-name', ing ? ing.name : '(missing ingredient)'));
    main.appendChild(el('div', 'entry-sub', ing ? ('per ' + Calc.basisOf(ing) + ' ' + (ing.unit || 'g') + ' · ' + Calc.fmt(ing.kcal, 0) + ' kcal') : ''));
    row.appendChild(main);

    const inp = el('input');
    inp.type = 'number';
    inp.step = '0.5';
    inp.inputMode = 'decimal';
    inp.dataset.i = i;
    inp.value = it.g;
    inp.style.width = '76px';
    inp.setAttribute('aria-label', 'Grams of ' + (ing ? ing.name : 'item'));
    row.appendChild(inp);

    const rm = el('button', 'entry-del', '✕');
    rm.dataset.i = i;
    row.appendChild(rm);
    host.appendChild(row);
  });
  if (!S.recipeDraft.items.length) host.appendChild(el('div', 'empty', 'No ingredients yet.'));
  renderRecipePreview();
}

function renderRecipePreview() {
  const { macros, grams } = Calc.scaleRecipe(S.recipeDraft, S.ings);
  const host = $('rc-preview');
  host.textContent = '';
  [['kcal', 'kcal', 0], ['pro', 'protein', 1], ['car', 'carbs', 1], ['fat', 'fat', 1], ['fib', 'fiber', 1]]
    .forEach(([k, label, dp]) => {
      const cell = el('div', 'pp ' + k);
      cell.appendChild(el('div', 'pp-l', label));
      cell.appendChild(el('div', 'pp-v', Calc.fmt(macros[k], dp)));
      host.appendChild(cell);
    });
  void grams;
}

async function saveRecipe() {
  const name = ($('rc-name').value || '').trim();
  if (!name) { toast('Name the meal first'); return; }
  if (!S.recipeDraft.items.length) { toast('Add at least one ingredient'); return; }
  await DB.put('recipes', {
    id: S.recipeDraft.id || DB.uid(),
    name,
    items: S.recipeDraft.items,
    updated: Date.now()
  });
  await reload();
  closeSheets();
  renderLibrary();
  toast('Meal saved');
}

async function deleteRecipe() {
  if (!S.recipeDraft.id) return;
  await DB.del('recipes', S.recipeDraft.id);
  await reload();
  closeSheets();
  renderLibrary();
  toast('Meal deleted');
}

/* ============================================================
   WEIGHT
   ============================================================ */

function bindWeight() {
  $('w-save').addEventListener('click', async () => {
    const kg = Calc.num($('w-kg').value);
    const date = $('w-date').value || S.date;
    if (!(kg > 0)) { toast('Enter a weight'); return; }
    await DB.put('weights', { date, kg });
    await DB.saveSettings({ profile: Object.assign({}, S.settings.profile, { weight: kg }) });
    S.settings = await DB.settings();
    await reload();
    closeSheets();
    renderToday();
    toast('Logged');
  });
}

function openWeight() {
  const last = S.weights[S.weights.length - 1];
  $('w-kg').value = last ? last.kg : (S.settings.profile.weight || '');
  $('w-date').value = S.date;
  openSheet('weight');
}

/* ============================================================
   TRENDS
   ============================================================ */

/* What Trends charts, in order: key, heading, unit, bar colour.
   Adding or reordering a chart is a one-line change here. */
const TRENDS = [
  ['kcal', 'Energy',  'kcal', 'var(--accent)'],
  ['pro',  'Protein', 'g',    'var(--pro-bar)'],
  ['fib',  'Fiber',   'g',    'var(--fib-bar)'],
  ['fat',  'Fat',     'g',    'var(--fat-bar)']
];

async function renderTrends() {
  const days = [];
  for (let i = 13; i >= 0; i--) days.push(Calc.shiftDate(Calc.today(), -i));
  const rows = await DB.entriesInRange(days[0], days[days.length - 1]);

  const blank = () => {
    const o = {};
    TRENDS.forEach(([k]) => { o[k] = 0; });
    return o;
  };
  const byDate = new Map(days.map((d) => [d, blank()]));
  rows.forEach((e) => {
    const bucket = byDate.get(e.date);
    if (!bucket) return;
    TRENDS.forEach(([k]) => { bucket[k] += Calc.num(e[k]); });
  });

  const host = $('trend-charts');
  host.textContent = '';

  TRENDS.forEach(([key, heading, unit, color]) => {
    const values = days.map((d) => byDate.get(d)[key]);
    const target = Calc.num(S.settings.targets[key]);

    /* Average over logged days only. Counting an untracked day as zero
       would drag every average down and make the number meaningless. */
    const logged = values.filter((v) => v > 0);
    const avg = logged.length ? logged.reduce((a, b) => a + b, 0) / logged.length : 0;
    const dp = key === 'kcal' ? 0 : 1;

    const block = el('div', 'block');
    const head = el('div', 'block-head stack');
    head.appendChild(el('h2', null, heading + ' vs target'));
    head.appendChild(el('span', 'block-note', logged.length
      ? 'AVG ' + Calc.fmt(avg, dp) + ' ' + unit.toUpperCase() +
        (target ? ' · TARGET ' + Calc.fmt(target, 0) : '') +
        ' · ' + logged.length + ' LOGGED DAY' + (logged.length === 1 ? '' : 'S')
      : 'NOTHING LOGGED YET'));
    block.appendChild(head);

    const chart = el('div', 'chart');
    chart.innerHTML = barChart(days, values, target, color);
    block.appendChild(chart);
    host.appendChild(block);
  });

  const wt = S.weights.slice(-30);
  $('chart-wt').innerHTML = wt.length > 1
    ? lineChart(wt.map((w) => w.date), wt.map((w) => w.kg))
    : '<div class="empty">Log your weight a few times and the trend appears here.</div>';
  $('tr-wt-note').textContent = wt.length
    ? wt.length + ' READINGS · LATEST ' + Calc.fmt(wt[wt.length - 1].kg, 1) + ' KG'
    : '';
}

function barChart(labels, values, target, color) {
  const W = 340, H = 132, padL = 30, padR = 6, padT = 8, padB = 18;
  const max = Math.max(target * 1.25, ...values, 1);
  const iw = W - padL - padR;
  const ih = H - padT - padB;
  const bw = iw / labels.length;
  const y = (v) => padT + ih - (v / max) * ih;

  let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Daily values against target">';
  [0, max / 2, max].forEach((v) => {
    s += '<line x1="' + padL + '" y1="' + y(v).toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y(v).toFixed(1) +
      '" stroke="var(--line)" stroke-width="1"/>';
    s += '<text x="' + (padL - 4) + '" y="' + (y(v) + 3).toFixed(1) + '" text-anchor="end" font-size="8" fill="var(--faint)" font-family="monospace">' + Math.round(v) + '</text>';
  });
  values.forEach((v, i) => {
    const h = Math.max(0, padT + ih - y(v));
    const x = padL + i * bw + bw * 0.18;
    const w = bw * 0.64;
    if (v > 0) {
      s += '<rect x="' + x.toFixed(1) + '" y="' + y(v).toFixed(1) + '" width="' + w.toFixed(1) +
        '" height="' + h.toFixed(1) + '" rx="1.5" fill="' + color + '" opacity="' + (v >= target * 0.96 ? 1 : 0.55) + '"/>';
    } else {
      s += '<rect x="' + x.toFixed(1) + '" y="' + (padT + ih - 2) + '" width="' + w.toFixed(1) +
        '" height="2" rx="1" fill="var(--line-strong)"/>';
    }
    if (i % 3 === 0) {
      s += '<text x="' + (x + w / 2).toFixed(1) + '" y="' + (H - 5) + '" text-anchor="middle" font-size="7.5" fill="var(--faint)" font-family="monospace">' +
        labels[i].slice(8) + '.' + labels[i].slice(5, 7) + '</text>';
    }
  });
  s += '<line x1="' + padL + '" y1="' + y(target).toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y(target).toFixed(1) +
    '" stroke="var(--ink)" stroke-width="1.2" stroke-dasharray="4 3"/>';
  s += '<text x="' + (W - padR) + '" y="' + (y(target) - 4).toFixed(1) + '" text-anchor="end" font-size="8" fill="var(--ink)" font-family="monospace">target ' + Math.round(target) + '</text>';
  s += '</svg>';
  return s;
}

function lineChart(labels, values) {
  const W = 340, H = 120, padL = 34, padR = 8, padT = 10, padB = 18;
  const min = Math.min(...values) - 0.6;
  const max = Math.max(...values) + 0.6;
  const iw = W - padL - padR, ih = H - padT - padB;
  const x = (i) => padL + (values.length === 1 ? iw / 2 : (i / (values.length - 1)) * iw);
  const y = (v) => padT + ih - ((v - min) / (max - min || 1)) * ih;

  let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Body weight trend">';
  [min, (min + max) / 2, max].forEach((v) => {
    s += '<line x1="' + padL + '" y1="' + y(v).toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y(v).toFixed(1) + '" stroke="var(--line)" stroke-width="1"/>';
    s += '<text x="' + (padL - 4) + '" y="' + (y(v) + 3).toFixed(1) + '" text-anchor="end" font-size="8" fill="var(--faint)" font-family="monospace">' + v.toFixed(1) + '</text>';
  });
  const pts = values.map((v, i) => x(i).toFixed(1) + ',' + y(v).toFixed(1)).join(' ');
  s += '<polyline points="' + pts + '" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>';
  values.forEach((v, i) => {
    const last = i === values.length - 1;
    s += '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(v).toFixed(1) + '" r="' + (last ? 3.6 : 2) +
      '" fill="' + (last ? 'var(--brand-pink)' : 'var(--accent)') + '"/>';
  });
  s += '<text x="' + padL + '" y="' + (H - 4) + '" font-size="7.5" fill="var(--faint)" font-family="monospace">' + labels[0] + '</text>';
  s += '<text x="' + (W - padR) + '" y="' + (H - 4) + '" text-anchor="end" font-size="7.5" fill="var(--faint)" font-family="monospace">' + labels[labels.length - 1] + '</text>';
  s += '</svg>';
  return s;
}

/* ============================================================
   SETTINGS
   ============================================================ */

function bindSettings() {
  ['p-age', 'p-height', 'p-weight', 'p-activity'].forEach((id) => {
    $(id).addEventListener('change', async () => {
      S.settings = await DB.saveSettings({
        profile: {
          age: Calc.num($('p-age').value),
          height: Calc.num($('p-height').value),
          weight: Calc.num($('p-weight').value),
          activity: parseFloat($('p-activity').value)
        }
      });
      renderDerived();
    });
  });

  ['t-kcal', 't-pro', 't-car', 't-fat', 't-fib'].forEach((id) => {
    $(id).addEventListener('change', async () => {
      S.settings = await DB.saveSettings({
        targets: {
          kcal: Calc.num($('t-kcal').value), pro: Calc.num($('t-pro').value),
          car: Calc.num($('t-car').value), fat: Calc.num($('t-fat').value),
          fib: Calc.num($('t-fib').value)
        }
      });
      renderToday();
    });
  });

  $('t-def').addEventListener('change', async () => {
    S.settings = await DB.saveSettings({ deficitPct: Calc.num($('t-def').value) });
    renderDerived();
  });

  $('t-suggest').addEventListener('click', async () => {
    const d = Calc.deriveTargets(S.settings.profile, S.settings.deficitPct);
    S.settings = await DB.saveSettings({ targets: d.targets });
    renderSettings();
    renderToday();
    toast('Targets recalculated from your profile');
  });

  ['ai-provider', 'ai-key', 'ai-model'].forEach((id) => {
    $(id).addEventListener('change', async () => {
      S.settings = await DB.saveSettings({
        aiProvider: $('ai-provider').value,
        aiKey: $('ai-key').value.trim(),
        aiModel: $('ai-model').value.trim()
      });
      $('ai-status').textContent = 'Saved on this phone.';
    });
  });

  $('ai-provider').addEventListener('change', () => {
    const p = $('ai-provider').value;
    if (p === 'gemini' && !/gemini/.test($('ai-model').value)) $('ai-model').value = 'gemini-2.5-flash';
    if (p === 'anthropic' && !/claude/.test($('ai-model').value)) $('ai-model').value = 'claude-sonnet-4-5';
  });

  $('theme-pick').addEventListener('change', async () => {
    applyTheme($('theme-pick').value);
    S.settings = await DB.saveSettings({ theme: $('theme-pick').value });
  });

  $('usda-key').addEventListener('change', async () => {
    const cleaned = $('usda-key').value.replace(/[^A-Za-z0-9]/g, '');
    $('usda-key').value = cleaned;
    S.settings = await DB.saveSettings({ usdaKey: cleaned });
    $('usda-status').textContent = 'Saved on this phone — ' + cleaned.length +
      ' characters' + (cleaned.length && cleaned.length !== 40 ? ' (theirs are 40)' : '') + '.';
  });

  $('usda-test').addEventListener('click', async () => {
    const st = $('usda-status');
    if (!(S.settings.usdaKey || '').trim()) { st.textContent = 'Paste a key first.'; return; }
    st.textContent = 'Testing…';
    try {
      const r = await Vision.testUsda(S.settings.usdaKey);
      st.textContent = '✓ Works — "kiwifruit" returned ' + r.matches + ' matches with ' +
        r.extras + ' vitamins and minerals each. Key is ' + r.keyLength + ' characters.';
    } catch (e) {
      st.textContent = '✕ ' + e.message;
    }
  });

  $('ai-test').addEventListener('click', async () => {
    const st = $('ai-status');
    if (S.settings.aiProvider === 'none') { st.textContent = 'Label reading is off.'; return; }
    if (!S.settings.aiKey) { st.textContent = 'Paste a key first.'; return; }
    st.textContent = 'Testing…';
    try {
      await Vision.testConnection(S.settings);
      st.textContent = '✓ Key and model work. Photographing a label will read it.';
    } catch (e) {
      st.textContent = '✕ ' + e.message;
    }
  });

  $('d-export').addEventListener('click', async () => {
    busy(true, 'Packing your data…');
    try {
      const data = await DB.exportAll(true);
      download(JSON.stringify(data), 'bibis-app-backup-' + Calc.today() + '.json', 'application/json');
      $('d-status').textContent = 'Exported ' + data.ingredients.length + ' ingredients, ' +
        data.entries.length + ' log entries, photos included.';
    } catch (e) { toast(e.message); }
    busy(false);
  });

  $('d-import').addEventListener('click', () => { $('d-file').value = ''; $('d-file').click(); });
  $('d-file').addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    if (!confirm('Restore this backup? Existing items with the same id are overwritten; anything else is kept.')) return;
    busy(true, 'Restoring…');
    try {
      const data = JSON.parse(await file.text());
      const n = await DB.importAll(data, 'merge');
      S.settings = await DB.settings();
      await reload();
      renderAll();
      renderSettings();
      $('d-status').textContent = 'Restored ' + n.ingredients + ' ingredients and ' + n.entries + ' log entries.';
    } catch (e) { toast(e.message, 4500); }
    busy(false);
  });

  $('d-csv').addEventListener('click', async () => {
    const all = await DB.all('entries');
    all.sort((a, b) => (a.date + a.slot).localeCompare(b.date + b.slot));
    const head = ['date', 'slot', 'item', 'amount', 'unit', 'kcal', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g'];
    const rows = all.map((e) => [
      e.date, e.slot, '"' + String(e.name).replace(/"/g, '""') + '"',
      e.g, e.unit || 'g',
      Calc.fmt(e.kcal, 0), Calc.fmt(e.pro, 1), Calc.fmt(e.car, 1), Calc.fmt(e.fat, 1), Calc.fmt(e.fib, 1)
    ].join(','));
    download([head.join(',')].concat(rows).join('\n'), 'bibis-app-' + Calc.today() + '.csv', 'text/csv');
    $('d-status').textContent = 'Exported ' + all.length + ' log entries.';
  });

  $('d-wipe').addEventListener('click', async () => {
    if (!confirm('Erase every ingredient, meal, log entry and photo on this phone? This cannot be undone.')) return;
    if (!confirm('Really erase everything? Export a backup first if you are unsure.')) return;
    await DB.wipe();
    S.thumbs.clear();
    S.settings = await DB.settings();
    await seedLibrary();
    await reload();
    renderAll();
    renderSettings();
    show('today');
    $('welcome').hidden = false;   // erased means back to first run
  });
}

function renderSettings() {
  const p = S.settings.profile, t = S.settings.targets;
  $('p-age').value = p.age;
  $('p-height').value = p.height;
  $('p-weight').value = p.weight;
  $('p-activity').value = String(p.activity);
  $('t-kcal').value = t.kcal;
  $('t-pro').value = t.pro;
  $('t-car').value = t.car;
  $('t-fat').value = t.fat;
  $('t-fib').value = t.fib;
  $('t-def').value = S.settings.deficitPct;
  $('ai-provider').value = S.settings.aiProvider;
  $('ai-key').value = S.settings.aiKey;
  $('ai-model').value = S.settings.aiModel;
  $('usda-key').value = S.settings.usdaKey || '';
  $('theme-pick').value = THEME_BAR[S.settings.theme] ? S.settings.theme : 'pink';
  renderDerived();
}

function renderDerived() {
  const d = Calc.deriveTargets(S.settings.profile, S.settings.deficitPct);
  const w = Calc.num(S.settings.profile.weight) || 1;
  $('p-derived').innerHTML =
    'Resting rate <b>' + d.rmr + ' kcal</b> · maintenance <b>' + d.tdee + ' kcal</b><br>' +
    'A ' + Calc.num(S.settings.deficitPct) + '% deficit gives <b>' + d.targets.kcal + ' kcal</b>, ' +
    'protein at 2.0 g/kg gives <b>' + d.targets.pro + ' g</b><br>' +
    'Your current targets sit at <b>' + Calc.fmt(Calc.num(S.settings.targets.pro) / w, 2) + ' g/kg</b> protein';
}

function download(text, filename, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ============================================================ */

boot().catch((e) => {
  document.body.innerHTML = '<div style="padding:24px;font-family:system-ui">' +
    '<h1 style="font-size:19px">Bibi&rsquo;s App could not start</h1><p>' + e.message + '</p></div>';
});
