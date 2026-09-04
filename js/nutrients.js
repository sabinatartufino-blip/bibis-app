/* ============================================================
   nutrients.js — the full nutrient registry.

   Reference intakes are the EU Nutrient Reference Values from
   Regulation (EU) No 1169/2011, Annex XIII Part A — the same figures
   printed as "% RI" on every European label. They are adult values and
   deliberately generic: they are not personalised targets, and for a few
   nutrients (vitamin D especially) national bodies recommend more.

   `nrv: null` means the EU sets no reference value for that nutrient, so
   the app shows the amount and no percentage rather than inventing one.
   ============================================================ */

const NUTRIENT_GROUPS = [
  { id: 'energy', name: 'Energy and macronutrients' },
  { id: 'fat', name: 'Fat detail' },
  { id: 'carb', name: 'Carbohydrate detail' },
  { id: 'mineral', name: 'Minerals' },
  { id: 'vitamin', name: 'Vitamins' },
  { id: 'other', name: 'Other' }
];

/* key, label, unit, EU NRV, group, decimals */
const NUTRIENTS = [
  ['kcal', 'Energy',            'kcal', null, 'energy', 0],
  ['pro',  'Protein',           'g',    null, 'energy', 1],
  ['car',  'Carbohydrate',      'g',    null, 'energy', 1],
  ['fat',  'Fat',               'g',    null, 'energy', 1],
  ['fib',  'Fiber',             'g',    null, 'energy', 1],

  ['sat',  'of which saturates','g',    null, 'fat',    1],
  ['mono', 'Monounsaturated',   'g',    null, 'fat',    1],
  ['poly', 'Polyunsaturated',   'g',    null, 'fat',    1],
  ['chol', 'Cholesterol',       'mg',   null, 'fat',    0],

  ['sug',  'of which sugars',   'g',    null, 'carb',   1],
  ['starch', 'Starch',          'g',    null, 'carb',   1],

  ['na',   'Sodium',            'mg',   null, 'mineral', 0],
  ['salt', 'Salt equivalent',   'g',    null, 'mineral', 2],
  ['k',    'Potassium',         'mg',   2000, 'mineral', 0],
  ['cl',   'Chloride',          'mg',   800,  'mineral', 0],
  ['ca',   'Calcium',           'mg',   800,  'mineral', 0],
  ['p',    'Phosphorus',        'mg',   700,  'mineral', 0],
  ['mg',   'Magnesium',         'mg',   375,  'mineral', 0],
  ['fe',   'Iron',              'mg',   14,   'mineral', 1],
  ['zn',   'Zinc',              'mg',   10,   'mineral', 1],
  ['cu',   'Copper',            'mg',   1,    'mineral', 2],
  ['mn',   'Manganese',         'mg',   2,    'mineral', 2],
  ['f',    'Fluoride',          'mg',   3.5,  'mineral', 2],
  ['se',   'Selenium',          'µg',   55,   'mineral', 1],
  ['cr',   'Chromium',          'µg',   40,   'mineral', 1],
  ['mo',   'Molybdenum',        'µg',   50,   'mineral', 1],
  ['i',    'Iodine',            'µg',   150,  'mineral', 1],

  ['va',   'Vitamin A',         'µg',   800,  'vitamin', 0],
  ['vd',   'Vitamin D',         'µg',   5,    'vitamin', 1],
  ['ve',   'Vitamin E',         'mg',   12,   'vitamin', 1],
  ['vk',   'Vitamin K',         'µg',   75,   'vitamin', 1],
  ['vc',   'Vitamin C',         'mg',   80,   'vitamin', 1],
  ['b1',   'Thiamin (B1)',      'mg',   1.1,  'vitamin', 2],
  ['b2',   'Riboflavin (B2)',   'mg',   1.4,  'vitamin', 2],
  ['b3',   'Niacin (B3)',       'mg',   16,   'vitamin', 1],
  ['b6',   'Vitamin B6',        'mg',   1.4,  'vitamin', 2],
  ['b9',   'Folate',            'µg',   200,  'vitamin', 0],
  ['b12',  'Vitamin B12',       'µg',   2.5,  'vitamin', 2],
  ['b7',   'Biotin',            'µg',   50,   'vitamin', 1],
  ['b5',   'Pantothenic acid',  'mg',   6,    'vitamin', 1],

  ['water', 'Water',            'g',    null, 'other',  0],
  ['alc',  'Alcohol',           'g',    null, 'other',  1]
];

/* lookup by key */
const NUT = {};
NUTRIENTS.forEach(([key, label, unit, nrv, group, dp]) => {
  NUT[key] = { key, label, unit, nrv, group, dp };
});

/* the five that drive targets and the Today tiles */
const CORE = ['kcal', 'pro', 'car', 'fat', 'fib'];

/* every key, in display order */
const ALL_KEYS = NUTRIENTS.map((n) => n[0]);

const Nut = {
  /* Ingredients created before the full panel existed carry only the five
     macros as top-level fields. Normalise both shapes into one object.
     A key that is ABSENT means "not known" — never zero. */
  of(ing) {
    if (!ing) return {};
    const out = {};
    if (ing.n && typeof ing.n === 'object') {
      ALL_KEYS.forEach((k) => {
        const v = parseFloat(ing.n[k]);
        if (isFinite(v)) out[k] = v;
      });
    }
    CORE.forEach((k) => {
      if (out[k] === undefined) {
        const v = parseFloat(ing[k]);
        if (isFinite(v)) out[k] = v;
      }
    });
    return out;
  },

  /* scale a nutrient object by grams/basis, keeping absences absent */
  scale(nutrients, grams, basis) {
    const b = basis > 0 ? basis : 100;
    const g = parseFloat(grams);
    const factor = (isFinite(g) ? g : 0) / b;
    const out = {};
    Object.keys(nutrients).forEach((k) => { out[k] = nutrients[k] * factor; });
    return out;
  },

  /* Sum a day, and record what the sum is actually built from.
     For each nutrient: the total, how many entries carried it, and what
     share of the day's energy came from entries that did. A vitamin C
     figure covering 60 % of the day's energy is a different claim from
     one covering all of it, and the app says which. */
  total(entryNutrients, entryKcals) {
    const sum = {};
    const items = {};
    const kcalWith = {};
    let kcalAll = 0;

    entryNutrients.forEach((n, i) => {
      const kc = parseFloat(entryKcals[i]) || 0;
      kcalAll += kc;
      ALL_KEYS.forEach((k) => {
        const v = n[k];
        if (v === undefined || !isFinite(v)) return;
        sum[k] = (sum[k] || 0) + v;
        items[k] = (items[k] || 0) + 1;
        kcalWith[k] = (kcalWith[k] || 0) + kc;
      });
    });

    const coverage = {};
    ALL_KEYS.forEach((k) => {
      coverage[k] = {
        items: items[k] || 0,
        ofItems: entryNutrients.length,
        energyShare: kcalAll > 0 ? (kcalWith[k] || 0) / kcalAll : (items[k] ? 1 : 0)
      };
    });

    return { sum, coverage, kcalAll };
  },

  pct(key, value) {
    const meta = NUT[key];
    if (!meta || !meta.nrv || !isFinite(value)) return null;
    return value / meta.nrv * 100;
  },

  fmt(key, value) {
    const meta = NUT[key];
    if (!meta || value === undefined || !isFinite(value)) return '—';
    return value.toFixed(meta.dp);
  },

  /* Sodium and salt are the same fact in two units; fill whichever is
     missing so a label that gives one still shows both.

     The factor is 2.5, which is what EU labelling rules prescribe
     (salt = sodium × 2.5, so 1 g salt = 400 mg sodium). The true molar
     ratio is 393.4 mg per gram — using it here would put this app 1.7 %
     out of step with every label it reads, so the regulatory factor wins. */
  deriveSalt(n) {
    if (n.na !== undefined && n.salt === undefined) n.salt = n.na * 2.5 / 1000;
    else if (n.salt !== undefined && n.na === undefined) n.na = n.salt * 1000 / 2.5;
    return n;
  },

  keysInGroup(groupId) {
    return NUTRIENTS.filter((n) => n[4] === groupId).map((n) => n[0]);
  },

  /* nutrients this ingredient actually knows about, beyond the core five */
  extraCount(ing) {
    const n = Nut.of(ing);
    return Object.keys(n).filter((k) => CORE.indexOf(k) < 0).length;
  }
};
