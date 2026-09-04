/* ============================================================
   swiss.js — the Swiss Food Composition Database, on the phone.

   Data: Swiss Food Composition Database V 7.1, Federal Food Safety and
   Veterinary Office (FSVO), naehrwertdaten.ch. Free to use, including in a
   nutrition diary app, with acknowledgment of the source — which appears
   in Settings › About and on every result this file returns.

   1 246 foods, ~34 nutrients each, ~250 KB. It ships with the app, so this
   tier answers instantly and with no signal, no key and no request.

   Two quirks of the source that search has to handle:
     · the English edition keeps German names for Swiss cheeses, so Gruyère
       is filed as "Greyerzer" and would never be found by its own name
     · the synonyms column is populated for 5 of 1 246 records, so it is
       no help at all
   Hence the alias table below, and diacritic-insensitive matching.
   ============================================================ */

const Swiss = (() => {
  let data = null;
  let loading = null;

  /* What she is likely to type -> the word the database actually uses.
     German, French and Serbian/Croatian, since those are the languages
     the food in this kitchen gets named in. */
  const ALIASES = {
    // Swiss and German cheese and dairy
    gruyere: 'greyerzer', gruyère: 'greyerzer',
    huttenkase: 'cottage cheese', huettenkase: 'cottage cheese',
    quark: 'curds', topfen: 'curds', kase: 'cheese', kaese: 'cheese',
    joghurt: 'yogurt', jogurt: 'yogurt', sahne: 'cream', rahm: 'cream',
    milch: 'milk', mleko: 'milk', mlijeko: 'milk', sir: 'cheese',
    ruebli: 'carrot', rubli: 'carrot',
    // German staples
    apfel: 'apple', birne: 'pear', kartoffel: 'potato', karotte: 'carrot',
    zwiebel: 'onion', knoblauch: 'garlic', huhn: 'chicken', poulet: 'chicken',
    hahnchen: 'chicken', rind: 'beef', schwein: 'pork', ei: 'egg',
    eier: 'egg', brot: 'bread', brotchen: 'bread roll', reis: 'rice',
    nudeln: 'pasta', teigwaren: 'pasta', haferflocken: 'oat flakes',
    honig: 'honey', mandel: 'almond', walnuss: 'walnut', hasselnuss: 'hazelnut',
    spinat: 'spinach', tomate: 'tomato', gurke: 'cucumber', kurbis: 'pumpkin',
    lachs: 'salmon', thunfisch: 'tuna', linsen: 'lentil',
    kichererbsen: 'chickpea', banane: 'banana', erdbeere: 'strawberry',
    himbeere: 'raspberry', pfirsich: 'peach', traube: 'grape',
    zucker: 'sugar', salz: 'salt', mehl: 'flour', olivenol: 'olive oil',
    // French
    pomme: 'apple', poire: 'pear', poulet_fr: 'chicken', oeuf: 'egg',
    fromage: 'cheese', lait: 'milk', pain: 'bread', riz: 'rice',
    // Serbian / Croatian
    jabuka: 'apple', krompir: 'potato', krumpir: 'potato',
    sargarepa: 'carrot', mrkva: 'carrot', paradajz: 'tomato',
    piletina: 'chicken', jaje: 'egg', hleb: 'bread', kruh: 'bread',
    meso: 'meat', pasulj: 'bean', grasak: 'pea', kupus: 'cabbage'
  };

  /* è é ü ö ä ß etc. are exactly what someone types and exactly what the
     database does not contain, so both sides get flattened. */
  function norm(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/ß/g, 'ss')
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function load() {
    if (data) return Promise.resolve(data);
    if (loading) return loading;
    loading = fetch('data/swiss.json')
      .then((r) => {
        if (!r.ok) throw new Error('Swiss dataset missing (' + r.status + ').');
        return r.json();
      })
      .then((json) => {
        /* Precompute the normalised name once, not on every keystroke. */
        json.foods.forEach((f) => { f.push(norm(f[0])); });
        data = json;
        loading = null;
        return data;
      })
      .catch((e) => { loading = null; throw e; });
    return loading;
  }

  function expand(q) {
    const n = norm(q);
    const terms = [n];
    n.split(' ').forEach((word) => {
      const alias = ALIASES[word];
      if (alias && terms.indexOf(alias) < 0) terms.push(norm(alias));
    });
    return terms;
  }

  async function search(query, limit) {
    const d = await load();
    const terms = expand(query);
    const max = limit || 10;
    const NAME = d.foods[0].length - 1;   // index of the normalised name
    const hits = [];

    d.foods.forEach((f) => {
      const name = f[NAME];
      let score = 0;
      for (const t of terms) {
        if (!t) continue;
        if (name === t) score = Math.max(score, 100);
        else if (name.indexOf(t + ' ') === 0 || name.indexOf(t + ',') === 0) score = Math.max(score, 80);
        else if (name.indexOf(t) === 0) score = Math.max(score, 60);
        else if (name.indexOf(' ' + t) >= 0) score = Math.max(score, 40);
        else if (name.indexOf(t) > 0) score = Math.max(score, 20);
      }
      /* Prefer the plain ingredient over what has been done to it. Searching
         "apple" should land on the apple, not apple juice; shorter names
         then win the remaining ties. */
      if (score) {
        if (/\b(raw|fresh)\b/.test(name)) score += 6;
        if (/\b(juice|dried|candied|syrup|powder|canned|jam)\b/.test(name)) score -= 8;
        if (/\b(prepared|cooked|steamed|roasted|fried|salad|soup)\b/.test(name)) score -= 3;
        hits.push({ f, score: score - Math.min(name.length, 60) / 100 });
      }
    });

    hits.sort((a, b) => b.score - a.score);

    return hits.slice(0, max).map(({ f }) => {
      const n = {};
      d.keys.forEach((k, i) => {
        const v = f[4][i];
        if (v !== null && v !== undefined) n[k] = v;
      });
      Nut.deriveSalt(n);
      const extras = Object.keys(n).filter((k) => CORE.indexOf(k) < 0).length;
      const draft = {
        name: f[0],
        brand: f[2] ? '' : '',
        barcode: '',
        basis: 100,
        unit: 'g',
        n,
        source: 'swiss',
        note: 'Swiss Food Composition Database V ' + d.version +
              ' (FSVO) · per 100 g edible portion · ' + extras +
              ' vitamins, minerals and other nutrients',
        _label: f[0],
        _sub: d.categories[f[1]] + ' · ' + extras + ' extra nutrients'
      };
      CORE.forEach((k) => { draft[k] = n[k] !== undefined ? n[k] : 0; });
      return draft;
    });
  }

  function ready() { return !!data; }
  function version() { return data ? data.version : null; }
  function count() { return data ? data.foods.length : 0; }

  /* Warm the cache in the background once the app is idle, so the first
     search is instant rather than a 250 KB wait. */
  function preload() { load().catch(() => {}); }

  return { search, preload, ready, version, count };
})();
