/* ============================================================
   vision.js — turning a package into numbers.

   Tier 1  barcode  -> Open Food Facts (free, no key, good EU coverage)
   Tier 2  photo    -> a vision model returns structured values
   Tier 3  manual   -> handled in the UI

   Nothing here writes to the database. Both tiers return a draft that
   the UI shows for confirmation first: a misread basis would poison
   every future calculation that uses the ingredient.
   ============================================================ */

const Vision = (() => {

  /* ---------- image handling ---------- */

  /* Downscale and re-encode before storing or uploading. 1200 px on the
     long edge keeps a nutrition table comfortably readable at ~150 KB. */
  function prepareImage(file, maxEdge, quality) {
    const edge = maxEdge || 1200;
    const q = quality || 0.75;
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        let { width: w, height: h } = img;
        const scale = Math.min(1, edge / Math.max(w, h));
        w = Math.round(w * scale);
        h = Math.round(h * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => {
          if (blob) resolve(blob); else reject(new Error('Could not process that image.'));
        }, 'image/jpeg', q);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
      img.src = url;
    });
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1]);
      fr.onerror = () => reject(new Error('Could not encode the image.'));
      fr.readAsDataURL(blob);
    });
  }

  /* Open Food Facts nutriment keys → canonical keys. OFF stores everything
     per 100 g in base SI units, so sodium/salt arrive in grams and the
     vitamins in grams too — hence the unit column. */
  const OFF_MAP = [
    ['pro', 'proteins_100g', 'G'], ['car', 'carbohydrates_100g', 'G'],
    ['fat', 'fat_100g', 'G'], ['fib', 'fiber_100g', 'G'],
    ['sug', 'sugars_100g', 'G'], ['sat', 'saturated-fat_100g', 'G'],
    ['mono', 'monounsaturated-fat_100g', 'G'], ['poly', 'polyunsaturated-fat_100g', 'G'],
    ['chol', 'cholesterol_100g', 'G'], ['starch', 'starch_100g', 'G'],
    ['na', 'sodium_100g', 'G'], ['salt', 'salt_100g', 'G'],
    ['k', 'potassium_100g', 'G'], ['ca', 'calcium_100g', 'G'],
    ['p', 'phosphorus_100g', 'G'], ['mg', 'magnesium_100g', 'G'],
    ['fe', 'iron_100g', 'G'], ['zn', 'zinc_100g', 'G'],
    ['cu', 'copper_100g', 'G'], ['mn', 'manganese_100g', 'G'],
    ['se', 'selenium_100g', 'G'], ['i', 'iodine_100g', 'G'],
    ['va', 'vitamin-a_100g', 'G'], ['vd', 'vitamin-d_100g', 'G'],
    ['ve', 'vitamin-e_100g', 'G'], ['vk', 'vitamin-k_100g', 'G'],
    ['vc', 'vitamin-c_100g', 'G'], ['b1', 'vitamin-b1_100g', 'G'],
    ['b2', 'vitamin-b2_100g', 'G'], ['b3', 'vitamin-pp_100g', 'G'],
    ['b6', 'vitamin-b6_100g', 'G'], ['b9', 'vitamin-b9_100g', 'G'],
    ['b12', 'vitamin-b12_100g', 'G'], ['b7', 'biotin_100g', 'G'],
    ['b5', 'pantothenic-acid_100g', 'G'], ['alc', 'alcohol_100g', 'G']
  ];

  function offNutrients(nutriments) {
    const src = nutriments || {};
    const out = {};

    let kcal = parseFloat(src['energy-kcal_100g']);
    if (!isFinite(kcal)) {
      const kj = parseFloat(src['energy-kj_100g']) || parseFloat(src['energy_100g']);
      if (isFinite(kj)) kcal = kj / 4.184;
    }
    if (isFinite(kcal)) out.kcal = Math.round(kcal * 10) / 10;

    OFF_MAP.forEach(([key, offKey, unit]) => {
      const v = parseFloat(src[offKey]);
      if (!isFinite(v)) return;
      const converted = convertUnit(v, unit, NUT[key].unit);
      if (converted === null) return;
      out[key] = converted;
    });
    return Nut.deriveSalt(out);
  }

  /* ---------- tier 1: Open Food Facts ---------- */

  async function lookupBarcode(code) {
    const clean = String(code).replace(/\D/g, '');
    if (clean.length < 6) throw new Error('That barcode looks too short.');

    const fields = [
      'product_name', 'product_name_de', 'product_name_en', 'brands',
      'nutriments', 'serving_quantity', 'serving_size', 'quantity'
    ].join(',');
    const url = 'https://world.openfoodfacts.org/api/v2/product/' +
      encodeURIComponent(clean) + '.json?fields=' + fields;

    let json;
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('Open Food Facts replied ' + res.status + '.');
      json = await res.json();
    } catch (e) {
      throw new Error('Could not reach Open Food Facts — check your connection. (' + e.message + ')');
    }

    if (!json || json.status === 0 || !json.product) {
      const err = new Error('No product with that barcode in Open Food Facts.');
      err.notFound = true;
      throw err;
    }

    const p = json.product;
    const n = offNutrients(p.nutriments);
    const extras = Object.keys(n).filter((k) => CORE.indexOf(k) < 0).length;

    const draft = {
      name: p.product_name || p.product_name_en || p.product_name_de || '',
      brand: (p.brands || '').split(',')[0].trim(),
      barcode: clean,
      basis: 100,
      unit: 'g',
      n,
      source: 'off',
      note: 'Open Food Facts, per 100 g' +
        (extras ? ' · ' + extras + ' extra nutrients' : ' · macros only, no vitamin or mineral data') +
        '. Community-entered — worth a glance before you trust it.'
    };
    CORE.forEach((k) => { draft[k] = n[k] !== undefined ? n[k] : 0; });
    return draft;
  }

  /* ---------- name search: whole foods with no barcode ----------
     A kiwi has no barcode and no label. Three sources, best first:
       USDA FoodData Central  — the actual reference tables, needs a free key
       the vision model       — reuses the key you already have
       Open Food Facts search — no key, but branded products, so noisy for raw food
     All three return candidates for you to pick from, never a silent answer. */

  /* USDA nutrient mapping.

     Matched on the nutrient NAME, not the number. Numbers are terse and a
     mistyped one silently files a value under the wrong nutrient — the
     worst possible failure here. Names are long, stable, and if one ever
     changes the nutrient simply reads as "no data" instead of as a lie.

     [canonical key, exact USDA name, expected unit] */
  const USDA_MAP = [
    ['kcal',   'energy',                                  'KCAL'],
    ['pro',    'protein',                                 'G'],
    ['car',    'carbohydrate, by difference',             'G'],
    ['fat',    'total lipid (fat)',                       'G'],
    ['fib',    'fiber, total dietary',                    'G'],
    ['sug',    'total sugars',                            'G'],
    ['starch', 'starch',                                  'G'],
    ['sat',    'fatty acids, total saturated',            'G'],
    ['mono',   'fatty acids, total monounsaturated',      'G'],
    ['poly',   'fatty acids, total polyunsaturated',      'G'],
    ['chol',   'cholesterol',                             'MG'],
    ['na',     'sodium, na',                              'MG'],
    ['k',      'potassium, k',                            'MG'],
    ['ca',     'calcium, ca',                             'MG'],
    ['p',      'phosphorus, p',                           'MG'],
    ['mg',     'magnesium, mg',                           'MG'],
    ['fe',     'iron, fe',                                'MG'],
    ['zn',     'zinc, zn',                                'MG'],
    ['cu',     'copper, cu',                              'MG'],
    ['mn',     'manganese, mn',                           'MG'],
    ['se',     'selenium, se',                            'UG'],
    ['i',      'iodine, i',                               'UG'],
    ['va',     'vitamin a, rae',                          'UG'],
    ['vd',     'vitamin d (d2 + d3)',                     'UG'],
    ['ve',     'vitamin e (alpha-tocopherol)',            'MG'],
    ['vk',     'vitamin k (phylloquinone)',               'UG'],
    ['vc',     'vitamin c, total ascorbic acid',          'MG'],
    ['b1',     'thiamin',                                 'MG'],
    ['b2',     'riboflavin',                              'MG'],
    ['b3',     'niacin',                                  'MG'],
    ['b6',     'vitamin b-6',                             'MG'],
    ['b9',     'folate, total',                           'UG'],
    ['b12',    'vitamin b-12',                            'UG'],
    ['b7',     'biotin',                                  'UG'],
    ['b5',     'pantothenic acid',                        'MG'],
    ['water',  'water',                                   'G'],
    ['alc',    'alcohol, ethyl',                          'G']
  ];

  const USDA_BY_NAME = {};
  USDA_MAP.forEach(([key, name, unit]) => { USDA_BY_NAME[name] = { key, unit }; });

  /* Convert to the unit the app stores this nutrient in. Anything we cannot
     convert with certainty is dropped rather than guessed at. */
  function convertUnit(value, from, to) {
    const f = String(from || '').toUpperCase();
    const t = String(to || '').toUpperCase();
    if (!f || f === t) return value;
    const scale = {
      'G>MG': 1000, 'MG>G': 0.001,
      'MG>UG': 1000, 'UG>MG': 0.001,
      'G>UG': 1e6, 'UG>G': 1e-6
    }[f + '>' + t];
    return scale === undefined ? null : value * scale;
  }

  function usdaNutrients(food) {
    const out = {};
    (food.foodNutrients || []).forEach((n) => {
      const rawName = n.nutrientName || (n.nutrient && n.nutrient.name) || '';
      const hit = USDA_BY_NAME[String(rawName).trim().toLowerCase()];
      if (!hit) return;
      const v = parseFloat(n.value !== undefined ? n.value : n.amount);
      if (!isFinite(v)) return;
      const unit = n.unitName || n.nutrientUnit || (n.nutrient && n.nutrient.unitName) || '';
      /* Energy appears twice on many records, kcal and kJ. Take kcal only. */
      if (hit.key === 'kcal' && String(unit).toUpperCase() !== 'KCAL') return;
      const converted = convertUnit(v, unit, hit.unit);
      if (converted === null) return;
      out[hit.key] = converted;
    });
    return Nut.deriveSalt(out);
  }

  async function searchByName(query, settings) {
    const q = String(query || '').trim();
    if (q.length < 2) throw new Error('Type at least two letters.');

    /* Whatever goes wrong with the preferred source, keep going to the next
       one — a broken key should cost you the better data, not the search.
       The reason is carried out on `_warn` so the UI can still say so. */
    let warn = '';

    if (cleanKey(settings.usdaKey)) {
      try {
        return await searchUsda(q, settings.usdaKey);
      } catch (e) {
        warn = e.message;
      }
    }

    if (settings.aiProvider !== 'none' && (settings.aiKey || '').trim()) {
      try {
        const rows = await searchViaModel(q, settings);
        if (warn) rows._warn = warn;
        return rows;
      } catch (e) {
        warn = warn ? warn + ' ' + e.message : e.message;
      }
    }

    const rows = await searchOff(q);
    if (warn) rows._warn = warn;
    return rows;
  }

  /* api.data.gov keys are 40 alphanumeric characters. A paste on a phone
     picks up spaces, newlines and the odd zero-width character, all of
     which produce a 403 that looks exactly like a wrong key. */
  function cleanKey(key) {
    return String(key || '').replace(/[^A-Za-z0-9]/g, '');
  }

  async function searchUsda(q, rawKey) {
    const key = cleanKey(rawKey);
    const url = 'https://api.nal.usda.gov/fdc/v1/foods/search?' + new URLSearchParams({
      query: q,
      dataType: 'Foundation,SR Legacy',
      pageSize: '8',
      api_key: key
    });
    const res = await fetch(url, { headers: { Accept: 'application/json' } });

    if (!res.ok) {
      /* api.data.gov sits in front of the USDA API and returns 403 for
         several different reasons. Only some of them are the key's fault,
         and only those should stop the search rather than falling through
         to the next source. */
      let code = '';
      let message = '';
      try {
        const body = await res.json();
        const e = body && (body.error || body);
        code = String((e && e.code) || '').toUpperCase();
        message = String((e && e.message) || '');
      } catch (e) { /* not JSON */ }

      if (code === 'OVER_RATE_LIMIT' || res.status === 429) {
        throw new Error('USDA rate limit reached — an hour’s worth of lookups. It resets shortly; the model answers in the meantime.');
      }
      if (code === 'API_KEY_MISSING' || !key) {
        const err = new Error('No USDA key was sent. Paste it again under Settings.');
        err.badKey = true;
        throw err;
      }
      if (res.status === 401 || res.status === 403) {
        const err = new Error('USDA rejected the key (' + (code || res.status) + '). ' +
          'It is ' + key.length + ' characters' +
          (key.length !== 40 ? ' — theirs are 40, so the paste looks incomplete' : '') +
          '.' + (message ? ' They said: ' + message : ''));
        err.badKey = true;
        throw err;
      }
      throw new Error('USDA replied ' + res.status + '.' + (message ? ' ' + message : ''));
    }

    const json = await res.json();
    const foods = (json && json.foods) || [];
    if (!foods.length) throw new Error('Nothing in USDA matches "' + q + '".');

    const mapped = foods.map((f) => {
      const n = usdaNutrients(f);
      const extras = Object.keys(n).filter((k) => CORE.indexOf(k) < 0).length;
      const out = {
        name: tidyUsdaName(f.description),
        brand: f.brandOwner || '',
        barcode: '',
        basis: 100,
        unit: 'g',
        n,
        source: 'usda',
        note: 'USDA FoodData Central · ' + (f.dataType || '') + ' · per 100 g · ' +
              extras + ' vitamins, minerals and other nutrients included',
        _label: tidyUsdaName(f.description),
        _sub: (f.dataType || '') + ' · ' + extras + ' extra nutrients'
      };
      CORE.forEach((k) => { out[k] = n[k] !== undefined ? n[k] : 0; });
      return out;
    }).filter((f) => f.kcal || f.pro || f.car || f.fat);

    /* USDA answered but nothing mapped — a field rename on their side would
       look like this. Throw rather than show empty rows, so searchByName
       falls through to the next source. */
    if (!mapped.length) throw new Error('USDA returned records this app could not read.');
    return mapped;
  }

  function tidyUsdaName(desc) {
    if (!desc) return '';
    /* "Kiwifruit, green, raw" reads better than the shouted original */
    const s = String(desc).trim();
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  }

  const NAME_PROMPT = [
    'Give the nutrition values for the food named below, per 100 g of the edible part as normally eaten.',
    'Return ONLY a JSON object, no prose and no code fences:',
    '{"name":string,"basis":100,"unit":"g"|"ml","kcal":number,"pro":number,',
    ' "car":number,"fat":number,"fib":number,"reference":string,"confidence":"high"|"medium"|"low"}',
    '',
    'Rules:',
    '- Use standard reference data (USDA SR Legacy / Foundation, or an equivalent national table)',
    '  and name which one in "reference".',
    '- Raw and unprepared unless the name says otherwise. Edible part only: no skin on a banana,',
    '  no stone in a peach.',
    '- car is total carbohydrate, not sugars. fat is total fat, not saturates. fib is dietary fibre.',
    '- unit is "ml" only for liquids normally measured by volume.',
    '- The name may be in German, Italian, French, Serbian or Croatian — answer for that food and',
    '  put its English name in "name".',
    '- If you are not reasonably sure of a value, say so via "confidence", never invent precision.',
    '',
    'Food: '
  ].join('\n');

  async function searchViaModel(q, settings) {
    const provider = settings.aiProvider;
    const raw = provider === 'anthropic'
      ? await callAnthropicText(NAME_PROMPT + q, settings.aiKey, settings.aiModel)
      : await callGeminiText(NAME_PROMPT + q, settings.aiKey, settings.aiModel);
    const draft = parseDraft(raw);
    draft.source = 'lookup';
    draft.name = draft.name || q;
    draft.note = 'Recalled by the model' +
      (draft._reference ? ' from ' + draft._reference : '') +
      ' — a reference table, not a scan. Check anything that looks off.' +
      (draft.confidence === 'low' ? ' ⚠ It was unsure.' : '');
    draft._label = draft.name;
    draft._sub = Calc.fmt(draft.kcal, 0) + ' kcal · ' + Calc.fmt(draft.pro, 1) + ' P · ' +
      Calc.fmt(draft.car, 1) + ' C · ' + Calc.fmt(draft.fat, 1) + ' F per 100 ' + draft.unit;
    return [draft];
  }

  async function callGeminiText(prompt, key, model) {
    const m = model || 'gemini-2.5-flash';
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(m) + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' }
      })
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(apiError(json, res.status, m));
    const parts = json && json.candidates && json.candidates[0] &&
      json.candidates[0].content && json.candidates[0].content.parts;
    const text = parts ? parts.map((p) => p.text || '').join('') : '';
    if (!text) throw new Error('The model returned nothing readable.');
    return text;
  }

  async function callAnthropicText(prompt, key, model) {
    const m = model || 'claude-sonnet-4-5';
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: m, max_tokens: 700, temperature: 0,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
      })
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(apiError(json, res.status, m));
    const text = (json && json.content || []).map((c) => c.text || '').join('');
    if (!text) throw new Error('The model returned nothing readable.');
    return text;
  }

  async function searchOff(q) {
    const url = 'https://world.openfoodfacts.org/cgi/search.pl?' + new URLSearchParams({
      search_terms: q,
      search_simple: '1',
      action: 'process',
      json: '1',
      page_size: '8',
      fields: 'product_name,brands,nutriments'
    });
    let json;
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('Open Food Facts replied ' + res.status + '.');
      json = await res.json();
    } catch (e) {
      throw new Error('Could not reach Open Food Facts. (' + e.message + ')');
    }
    const products = (json && json.products) || [];
    const out = products.map((p) => {
      const n = offNutrients(p.nutriments);
      const extras = Object.keys(n).filter((k) => CORE.indexOf(k) < 0).length;
      const name = p.product_name || '';
      const row = {
        name, brand: (p.brands || '').split(',')[0].trim(), barcode: '',
        basis: 100, unit: 'g', n,
        source: 'off',
        note: 'Open Food Facts search, per 100 g. Community-entered — check before you trust it.',
        _label: name,
        _sub: [(p.brands || '').split(',')[0].trim(),
               Math.round(n.kcal || 0) + ' kcal',
               extras + ' extra nutrients'].filter(Boolean).join(' · ')
      };
      CORE.forEach((k) => { row[k] = n[k] !== undefined ? n[k] : 0; });
      return row;
    }).filter((f) => f.name && (f.kcal || f.pro || f.car || f.fat));
    if (!out.length) throw new Error('Nothing in Open Food Facts matches "' + q + '". Type the values in instead.');
    return out;
  }

  async function testUsda(key) {
    const clean = cleanKey(key);
    const rows = await searchUsda('kiwifruit', clean);
    const extras = rows.length
      ? Object.keys(rows[0].n || {}).filter((k) => CORE.indexOf(k) < 0).length
      : 0;
    return { matches: rows.length, keyLength: clean.length, extras };
  }

  /* ---------- tier 2: vision model ---------- */

  const PROMPT = [
    'This photograph shows a nutrition declaration on food packaging.',
    'Read it and return ONLY a JSON object, no prose and no code fences, with these keys:',
    '{"name":string,"brand":string,"basis":number,"unit":"g"|"ml",',
    ' "kcal":number,"pro":number,"car":number,"fat":number,"fib":number,',
    ' "sat":number,"sug":number,"salt":number,',
    ' "basis_source":string,"confidence":"high"|"medium"|"low","warning":string}',
    '',
    'Rules:',
    '- Prefer the "per 100 g" or "per 100 ml" column when the label has one, and then basis is 100.',
    '- If the label ONLY gives values per serving, use that serving size as basis and say so in basis_source.',
    '- Never mix columns: every value must come from the same column as basis.',
    '- Energy in kcal. If only kJ is printed, divide by 4.184.',
    '- pro = protein, car = total carbohydrate (NOT "of which sugars"), fat = total fat',
    '  (NOT "of which saturates"), fib = fibre; use 0 when fibre is not declared.',
    '- sat = the "of which saturates" line, sug = the "of which sugars" line, salt = the salt',
    '  line in grams. Omit any of these three entirely if the label does not print them —',
    '  do not send 0 for a line that is simply absent.',
    '- Decimal commas mean decimal points: "1,8" is 1.8.',
    '- Labels may be in German, French, Italian, Serbian, Croatian or English.',
    '- unit is "ml" only for liquids declared per 100 ml.',
    '- Put anything uncertain, unreadable or unusual in warning; use "" when all is clear.',
    '- Values not present on the label are 0, never guessed.'
  ].join('\n');

  async function readLabel(blob, settings) {
    const provider = settings.aiProvider;
    const key = (settings.aiKey || '').trim();
    if (provider === 'none' || !provider) throw new Error('Label reading is switched off in Settings.');
    if (!key) throw new Error('No API key yet — add one under Settings › Label reading.');

    const b64 = await blobToBase64(blob);
    const raw = provider === 'anthropic'
      ? await callAnthropic(b64, key, settings.aiModel)
      : await callGemini(b64, key, settings.aiModel);

    const draft = parseDraft(raw);
    draft.source = 'ai';
    return draft;
  }

  async function callGemini(b64, key, model) {
    const m = model || 'gemini-2.5-flash';
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(m) + ':generateContent';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: PROMPT },
            { inline_data: { mime_type: 'image/jpeg', data: b64 } }
          ]
        }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' }
      })
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(apiError(json, res.status, m));
    const parts = json && json.candidates && json.candidates[0] &&
      json.candidates[0].content && json.candidates[0].content.parts;
    const text = parts ? parts.map((p) => p.text || '').join('') : '';
    if (!text) throw new Error('The model returned nothing readable.');
    return text;
  }

  async function callAnthropic(b64, key, model) {
    const m = model || 'claude-sonnet-4-5';
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: m,
        max_tokens: 700,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
            { type: 'text', text: PROMPT }
          ]
        }]
      })
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(apiError(json, res.status, m));
    const text = (json && json.content || []).map((c) => c.text || '').join('');
    if (!text) throw new Error('The model returned nothing readable.');
    return text;
  }

  function apiError(json, status, model) {
    const msg = json && json.error && (json.error.message || json.error.type);
    if (status === 401 || status === 403) return 'The API key was rejected. Check it under Settings.';
    if (status === 404) return 'No model called "' + model + '" — change the model name in Settings.';
    if (status === 429) return 'Rate limited. Wait a moment and try again.';
    return msg ? ('The API said: ' + msg) : ('The API returned ' + status + '.');
  }

  function parseDraft(text) {
    let obj = null;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) { try { obj = JSON.parse(m[0]); } catch (e2) { obj = null; } }
    }
    if (!obj || typeof obj !== 'object') {
      throw new Error('Could not make sense of the model reply. Try a straighter, better-lit photo.');
    }
    const n = (v) => {
      const f = parseFloat(String(v === undefined || v === null ? 0 : v).replace(',', '.'));
      return isFinite(f) && f >= 0 ? f : 0;
    };
    const basis = n(obj.basis) || 100;

    /* Only keys the model actually returned go into the nutrient object.
       An absent "of which saturates" line must stay absent, not become 0. */
    const nut = {};
    ['kcal', 'pro', 'car', 'fat', 'fib', 'sat', 'sug', 'salt'].forEach((k) => {
      if (obj[k] === undefined || obj[k] === null || obj[k] === '') return;
      const v = n(obj[k]);
      if (isFinite(v)) nut[k] = v;
    });
    Nut.deriveSalt(nut);

    return {
      _reference: obj.reference ? String(obj.reference) : '',
      name: String(obj.name || '').trim(),
      brand: String(obj.brand || '').trim(),
      barcode: '',
      basis,
      unit: obj.unit === 'ml' ? 'ml' : 'g',
      n: nut,
      kcal: n(obj.kcal),
      pro: n(obj.pro),
      car: n(obj.car),
      fat: n(obj.fat),
      fib: n(obj.fib),
      confidence: obj.confidence || 'medium',
      note: [
        'Read from your photo' + (basis !== 100 ? ' — the label gives values per ' + basis + (obj.unit === 'ml' ? ' ml' : ' g') + ', not per 100.' : ', per 100.'),
        obj.basis_source ? String(obj.basis_source) : '',
        obj.warning ? '⚠ ' + String(obj.warning) : '',
        obj.confidence === 'low' ? '⚠ The model was unsure — check every number.' : ''
      ].filter(Boolean).join(' ')
    };
  }

  async function testConnection(settings) {
    /* A 1x1 white JPEG is enough to prove the key, model name and CORS
       path all work, without spending a real request on a photo. */
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 8;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 8, 8);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.5));
    const b64 = await blobToBase64(blob);
    if (settings.aiProvider === 'anthropic') await callAnthropic(b64, settings.aiKey, settings.aiModel);
    else await callGemini(b64, settings.aiKey, settings.aiModel);
    return true;
  }

  /* ---------- barcode camera ---------- */

  function barcodeSupported() {
    return typeof window.BarcodeDetector === 'function';
  }

  async function startScanner(videoEl, onFound, onStatus) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This browser will not give the page a camera.');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
      audio: false
    });
    videoEl.srcObject = stream;
    await videoEl.play();

    let stopped = false;
    const stop = () => {
      stopped = true;
      stream.getTracks().forEach((t) => t.stop());
      videoEl.srcObject = null;
    };

    if (!barcodeSupported()) {
      onStatus('This browser cannot decode barcodes. Type the number underneath the bars instead.');
      return stop;
    }

    const detector = new window.BarcodeDetector({
      formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128']
    });

    const tick = async () => {
      if (stopped) return;
      try {
        const codes = await detector.detect(videoEl);
        if (codes && codes.length) {
          const value = codes[0].rawValue;
          if (value) { stop(); onFound(value); return; }
        }
      } catch (e) { /* a frame failed to decode; keep going */ }
      setTimeout(tick, 220);
    };
    tick();
    return stop;
  }

  return {
    prepareImage, lookupBarcode, readLabel, testConnection,
    searchByName, testUsda,
    startScanner, barcodeSupported
  };
})();
