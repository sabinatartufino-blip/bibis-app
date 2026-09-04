/* ============================================================
   db.js — IndexedDB layer. No dependencies, promise-based.

   Stores
     ingredients  {id, name, brand, barcode, basis, unit, kcal, pro, car,
                   fat, fib, labelPhoto:Blob, frontPhoto:Blob, source, updated}
     recipes      {id, name, items:[{ingId, g}], updated}
     entries      {id, date:'YYYY-MM-DD', slot, refKind, refId, name, g, unit,
                   kcal, pro, car, fat, fib, items?, created}
     weights      {date:'YYYY-MM-DD', kg}
     shopping     {id, name, ingId|null, note, done, created}
     meta         {key, value}          -- settings live here under 'settings'

   Log entries store their COMPUTED macros, not a pointer to the current
   library values. Editing an ingredient tomorrow must never silently
   rewrite what you ate today.
   ============================================================ */

const DB = (() => {
  const NAME = 'bibis-app';
  const VERSION = 2;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        if (!db.objectStoreNames.contains('ingredients')) {
          const s = db.createObjectStore('ingredients', { keyPath: 'id' });
          s.createIndex('name', 'name');
          s.createIndex('barcode', 'barcode');
        }
        if (!db.objectStoreNames.contains('recipes')) {
          db.createObjectStore('recipes', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('entries')) {
          const s = db.createObjectStore('entries', { keyPath: 'id' });
          s.createIndex('date', 'date');
        }
        if (!db.objectStoreNames.contains('weights')) {
          db.createObjectStore('weights', { keyPath: 'date' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
        /* v2: the shopping list. Guarded like the rest, so upgrading an
           existing database adds this store and touches nothing else. */
        if (!db.objectStoreNames.contains('shopping')) {
          db.createObjectStore('shopping', { keyPath: 'id' });
        }
        void e;
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  function tx(store, mode) {
    return open().then((db) => db.transaction(store, mode).objectStore(store));
  }

  function wrap(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  const api = {
    uid() {
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    },

    all(store) { return tx(store, 'readonly').then((s) => wrap(s.getAll())); },
    get(store, key) { return tx(store, 'readonly').then((s) => wrap(s.get(key))); },
    put(store, value) { return tx(store, 'readwrite').then((s) => wrap(s.put(value))); },
    del(store, key) { return tx(store, 'readwrite').then((s) => wrap(s.delete(key))); },

    clear(store) { return tx(store, 'readwrite').then((s) => wrap(s.clear())); },

    byIndex(store, index, value) {
      return tx(store, 'readonly').then((s) => wrap(s.index(index).getAll(value)));
    },

    entriesForDate(date) {
      return api.byIndex('entries', 'date', date);
    },

    entriesInRange(fromDate, toDate) {
      return tx('entries', 'readonly').then((s) => wrap(
        s.index('date').getAll(IDBKeyRange.bound(fromDate, toDate))
      ));
    },

    /* ---------- settings ---------- */
    async settings() {
      const row = await api.get('meta', 'settings');
      return Object.assign({}, DEFAULT_SETTINGS, row ? row.value : {});
    },
    async saveSettings(patch) {
      const cur = await api.settings();
      const next = Object.assign({}, cur, patch);
      await api.put('meta', { key: 'settings', value: next });
      return next;
    },

    /* ---------- backup ---------- */
    async exportAll(includePhotos) {
      const [ingredients, recipes, entries, weights, shopping, settings] = await Promise.all([
        api.all('ingredients'), api.all('recipes'), api.all('entries'),
        api.all('weights'), api.all('shopping'), api.settings()
      ]);
      const safeSettings = Object.assign({}, settings);
      delete safeSettings.aiKey;   // never write a key into a file that gets emailed around
      delete safeSettings.usdaKey;
      const ings = [];
      for (const i of ingredients) {
        const copy = Object.assign({}, i);
        if (includePhotos) {
          copy.labelPhoto = await blobToDataUrl(i.labelPhoto);
          copy.frontPhoto = await blobToDataUrl(i.frontPhoto);
        } else {
          delete copy.labelPhoto;
          delete copy.frontPhoto;
        }
        ings.push(copy);
      }
      return {
        format: 'bibis-app-backup',
        version: 1,
        exported: new Date().toISOString(),
        photos: !!includePhotos,
        settings: safeSettings,
        ingredients: ings,
        recipes, entries, weights, shopping
      };
    },

    async importAll(data, mode) {
      if (!data || (data.format !== 'bibis-app-backup' && data.format !== 'macrolog-backup')) {
        throw new Error('That file is not a backup from this app.');
      }
      if (mode === 'replace') {
        await Promise.all([
          api.clear('ingredients'), api.clear('recipes'),
          api.clear('entries'), api.clear('weights'), api.clear('shopping')
        ]);
      }
      for (const i of data.ingredients || []) {
        const copy = Object.assign({}, i);
        copy.labelPhoto = await dataUrlToBlob(i.labelPhoto);
        copy.frontPhoto = await dataUrlToBlob(i.frontPhoto);
        await api.put('ingredients', copy);
      }
      for (const r of data.recipes || []) await api.put('recipes', r);
      for (const e of data.entries || []) await api.put('entries', e);
      for (const w of data.weights || []) await api.put('weights', w);
      for (const sh of data.shopping || []) await api.put('shopping', sh);
      if (data.settings) {
        const keep = Object.assign({}, data.settings);
        delete keep.aiKey;
        delete keep.usdaKey;
        await api.saveSettings(keep);
      }
      return {
        ingredients: (data.ingredients || []).length,
        recipes: (data.recipes || []).length,
        entries: (data.entries || []).length,
        weights: (data.weights || []).length,
        shopping: (data.shopping || []).length
      };
    },

    async wipe() {
      await Promise.all([
        api.clear('ingredients'), api.clear('recipes'),
        api.clear('entries'), api.clear('weights'),
        api.clear('shopping'), api.clear('meta')
      ]);
    }
  };

  function blobToDataUrl(blob) {
    if (!blob) return Promise.resolve(null);
    return new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(blob);
    });
  }

  async function dataUrlToBlob(url) {
    if (!url || typeof url !== 'string' || url.indexOf('data:') !== 0) return null;
    try { return await (await fetch(url)).blob(); } catch (e) { return null; }
  }

  return api;
})();

/* A fallback only. First run asks for age, height, weight, sex and activity
   and overwrites both the profile and the targets before the app is used, and
   an existing install carries its own saved values. Everything stays editable
   in Settings afterwards. */
const DEFAULT_SETTINGS = {
  profile: { age: 53, height: 172, weight: 61.2, sex: 'female', activity: 1.375 },
  deficitPct: 10,
  targets: { kcal: 1550, pro: 122, car: 140, fat: 55, fib: 28 },
  aiProvider: 'gemini',
  aiKey: '',
  aiModel: 'gemini-2.5-flash',
  usdaKey: '',
  theme: 'pink',
  seeded: false,
  welcomed: false
};
