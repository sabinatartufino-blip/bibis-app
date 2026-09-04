/* ============================================================
   calc.js — nutrition arithmetic, target derivation, seed data.

   One formula runs the whole app:
       amount used  ÷  the basis the label refers to  ×  label value
   The basis is per-ingredient, so a pack printing "per 30 g serving"
   is entered exactly as printed and still scales correctly.
   ============================================================ */

const MACROS = ['kcal', 'pro', 'car', 'fat', 'fib'];

const MACRO_META = {
  kcal: { label: 'Energy', unit: 'kcal', dp: 0 },
  pro:  { label: 'Protein', unit: 'g', dp: 1 },
  car:  { label: 'Carbs', unit: 'g', dp: 1 },
  fat:  { label: 'Fat', unit: 'g', dp: 1 },
  fib:  { label: 'Fiber', unit: 'g', dp: 1 }
};

const Calc = {
  num(v) { const n = parseFloat(v); return isFinite(n) ? n : 0; },

  basisOf(ing) {
    const b = parseFloat(ing && ing.basis);
    return isFinite(b) && b > 0 ? b : 100;
  },

  /* macros for `grams` of an ingredient */
  scale(ing, grams) {
    const b = Calc.basisOf(ing);
    const g = Calc.num(grams);
    const out = {};
    MACROS.forEach((k) => { out[k] = Calc.num(ing[k]) * g / b; });
    return out;
  },

  /* macros for a whole recipe, given the ingredient library as a Map */
  scaleRecipe(recipe, ingMap) {
    const out = { kcal: 0, pro: 0, car: 0, fat: 0, fib: 0 };
    let grams = 0;
    (recipe.items || []).forEach((it) => {
      const ing = ingMap.get(it.ingId);
      if (!ing) return;
      const m = Calc.scale(ing, it.g);
      MACROS.forEach((k) => { out[k] += m[k]; });
      grams += Calc.num(it.g);
    });
    return { macros: out, grams };
  },

  sum(list) {
    const out = { kcal: 0, pro: 0, car: 0, fat: 0, fib: 0 };
    (list || []).forEach((e) => { MACROS.forEach((k) => { out[k] += Calc.num(e[k]); }); });
    return out;
  },

  fmt(v, dp) {
    const n = Calc.num(v);
    const d = dp === undefined ? 1 : dp;
    return n.toFixed(d);
  },

  /* ---------- target derivation ----------
     Mifflin–St Jeor. Protein at 2.0 g/kg because the goal is adding muscle
     after 50, where the usual 1.2 g/kg RDA is far too low. Fat floored near
     0.9 g/kg. Carbs take whatever energy is left.

     The sex constant is the one term here you cannot fudge: +5 for men,
     −161 for women — a 166 kcal spread on otherwise identical numbers. It
     used to be hardcoded to −161, which was right for one user and wrong for
     anyone the app gets handed to. Unset still means female, so existing
     targets are unchanged. */
  deriveTargets(profile, deficitPct) {
    const w = Calc.num(profile.weight) || 61;
    const h = Calc.num(profile.height) || 170;
    const a = Calc.num(profile.age) || 50;
    const act = Calc.num(profile.activity) || 1.375;
    const sexConst = profile.sex === 'male' ? 5 : -161;

    const rmr = 10 * w + 6.25 * h - 5 * a + sexConst;
    const tdee = rmr * act;
    const kcal = Math.round(tdee * (1 - Calc.num(deficitPct) / 100) / 10) * 10;

    const pro = Math.round(w * 2.0);
    const fat = Math.round(w * 0.9);
    const carKcal = kcal - pro * 4 - fat * 9;
    const car = Math.max(40, Math.round(carKcal / 4));
    const fib = 28;

    return {
      rmr: Math.round(rmr),
      tdee: Math.round(tdee),
      targets: { kcal, pro, car, fat, fib }
    };
  },

  /* energy split, for the day view */
  energySplit(m) {
    const ep = Calc.num(m.pro) * 4;
    const ec = Calc.num(m.car) * 4;
    const ef = Calc.num(m.fat) * 9;
    const total = ep + ec + ef || 1;
    return { pro: ep / total, car: ec / total, fat: ef / total, kcalFromMacros: ep + ec + ef };
  },

  today() { return Calc.dateKey(new Date()); },

  dateKey(d) {
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  },

  shiftDate(key, days) {
    const [y, m, d] = key.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + days);
    return Calc.dateKey(dt);
  },

  prettyDate(key) {
    const [y, m, d] = key.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  },

  dayName(key) {
    const t = Calc.today();
    if (key === t) return 'Today';
    if (key === Calc.shiftDate(t, -1)) return 'Yesterday';
    if (key === Calc.shiftDate(t, 1)) return 'Tomorrow';
    return Calc.prettyDate(key);
  }
};

const SLOTS = [
  { id: 'morning', name: 'Morning' },
  { id: 'lunch', name: 'Lunch' },
  { id: 'afternoon', name: 'Afternoon' },
  { id: 'evening', name: 'Evening' }
];

/* ============================================================
   SEED — the plan as it stands, so the app is useful on first open.
   name, brand, basis, unit, kcal, pro, car, fat, fib, default portion, slot
   ============================================================ */
const SEED_INGREDIENTS = [
  ['Cottage cheese, low-fat', '', 100, 'g', 98, 11.1, 3.4, 4.3, 0, 100, 'morning'],
  ['Egg whites', '', 100, 'g', 52, 10.9, 0.7, 0.2, 0, 20, 'morning'],
  ['Parmigiano', '', 100, 'g', 392, 35.8, 3.2, 25.8, 0, 10, 'morning'],
  ['Chia seeds', '', 100, 'g', 486, 16.5, 42.1, 30.7, 34.4, 2.5, 'morning'],
  ['Sesame seeds', '', 100, 'g', 573, 17.7, 23.4, 49.7, 11.8, 1, 'morning'],
  ['Flax seeds', '', 100, 'g', 534, 18.3, 28.9, 42.2, 27.3, 1, 'morning'],
  ['Sunflower seeds', '', 100, 'g', 584, 20.8, 20.0, 51.5, 8.6, 2, 'morning'],
  ['Pumpkin seeds', '', 100, 'g', 559, 30.2, 10.7, 49.1, 6.0, 4, 'morning'],
  ['Carrots, raw', '', 100, 'g', 41, 0.9, 9.6, 0.2, 2.8, 134, 'morning'],
  ['Champignons, raw', '', 100, 'g', 22, 3.1, 3.3, 0.3, 1.0, 112, 'morning'],
  ['Quorn mince', 'Quorn', 100, 'g', 105, 14.5, 4.5, 2.0, 6.0, 100, 'lunch'],
  ['Protein Zene sauce', 'Zene', 100, 'g', 40, 4.0, 5.0, 0.5, 1.0, 23, 'lunch'],
  ['Butter', '', 100, 'g', 717, 0.9, 0.1, 81.1, 0, 9, 'lunch'],
  ['Avocado', '', 100, 'g', 160, 2.0, 8.5, 14.7, 6.7, 75, 'lunch'],
  ['Peach', '', 100, 'g', 39, 0.9, 9.5, 0.3, 1.5, 150, 'afternoon'],
  ['Coconut milk drink, unsweetened', '', 100, 'ml', 20, 0.2, 0.9, 1.8, 0.1, 200, 'afternoon'],
  ['Dates, Medjool', '', 100, 'g', 277, 1.8, 75.0, 0.2, 6.7, 48, 'afternoon'],
  ['Whey isolate', '', 100, 'g', 373, 85.0, 4.0, 1.0, 0, 30, 'afternoon']
];

/* Items marked `verify` carry values I estimated rather than read off a
   pack — the app flags them until you confirm against the real label. */
const SEED_VERIFY = ['Protein Zene sauce', 'Whey isolate', 'Coconut milk drink, unsweetened'];

const SEED_RECIPES = [
  {
    name: 'Morning bowl',
    pick: ['Cottage cheese, low-fat', 'Egg whites', 'Parmigiano', 'Chia seeds',
           'Sesame seeds', 'Flax seeds', 'Sunflower seeds', 'Pumpkin seeds',
           'Carrots, raw', 'Champignons, raw', 'Butter']
  },
  {
    name: 'Afternoon shake',
    pick: ['Whey isolate', 'Coconut milk drink, unsweetened', 'Dates, Medjool']
  }
];
