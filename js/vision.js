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
    const n = p.nutriments || {};
    const pick = (...keys) => {
      for (const k of keys) {
        const v = parseFloat(n[k]);
        if (isFinite(v)) return v;
      }
      return 0;
    };

    let kcal = pick('energy-kcal_100g');
    if (!kcal) {
      const kj = pick('energy-kj_100g', 'energy_100g');
      if (kj) kcal = Math.round(kj / 4.184 * 10) / 10;
    }

    return {
      name: p.product_name || p.product_name_en || p.product_name_de || '',
      brand: (p.brands || '').split(',')[0].trim(),
      barcode: clean,
      basis: 100,
      unit: 'g',
      kcal,
      pro: pick('proteins_100g'),
      car: pick('carbohydrates_100g'),
      fat: pick('fat_100g'),
      fib: pick('fiber_100g'),
      source: 'off',
      note: 'Open Food Facts, per 100 g. Community-entered — worth a glance before you trust it.'
    };
  }

  /* ---------- name search: whole foods with no barcode ----------
     A kiwi has no barcode and no label. Three sources, best first:
       USDA FoodData Central  — the actual reference tables, needs a free key
       the vision model       — reuses the key you already have
       Open Food Facts search — no key, but branded products, so noisy for raw food
     All three return candidates for you to pick from, never a silent answer. */

  const USDA_NUTRIENTS = { 208: 'kcal', 203: 'pro', 205: 'car', 204: 'fat', 291: 'fib' };

  async function searchByName(query, settings) {
    const q = String(query || '').trim();
    if (q.length < 2) throw new Error('Type at least two letters.');

    if ((settings.usdaKey || '').trim()) {
      try { return await searchUsda(q, settings.usdaKey.trim()); }
      catch (e) { if (e.badKey) throw e; /* otherwise fall through */ }
    }
    if (settings.aiProvider !== 'none' && (settings.aiKey || '').trim()) {
      return await searchViaModel(q, settings);
    }
    return await searchOff(q);
  }

  async function searchUsda(q, key) {
    const url = 'https://api.nal.usda.gov/fdc/v1/foods/search?' + new URLSearchParams({
      query: q,
      dataType: 'Foundation,SR Legacy',
      pageSize: '8',
      api_key: key
    });
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.status === 401 || res.status === 403) {
      const err = new Error('The USDA key was rejected — check it under Settings.');
      err.badKey = true;
      throw err;
    }
    if (!res.ok) throw new Error('USDA replied ' + res.status + '.');
    const json = await res.json();
    const foods = (json && json.foods) || [];
    if (!foods.length) throw new Error('Nothing in USDA matches "' + q + '".');

    const mapped = foods.map((f) => {
      const out = {
        name: tidyUsdaName(f.description),
        brand: f.brandOwner || '',
        barcode: '',
        basis: 100,
        unit: 'g',
        kcal: 0, pro: 0, car: 0, fat: 0, fib: 0,
        source: 'usda',
        note: 'USDA FoodData Central · ' + (f.dataType || '') + ' · per 100 g',
        _label: tidyUsdaName(f.description),
        _sub: (f.dataType || '') + (f.foodCategory ? ' · ' + f.foodCategory : '')
      };
      (f.foodNutrients || []).forEach((n) => {
        const numRaw = n.nutrientNumber !== undefined ? n.nutrientNumber : n.number;
        const num = parseInt(numRaw, 10);
        const keyName = USDA_NUTRIENTS[num];
        if (!keyName) return;
        const v = parseFloat(n.value !== undefined ? n.value : n.amount);
        if (!isFinite(v)) return;
        /* energy is listed twice on some records, in kcal and kJ */
        if (keyName === 'kcal') {
          const unit = String(n.unitName || n.nutrientUnit || '').toUpperCase();
          if (unit && unit !== 'KCAL') return;
        }
        out[keyName] = v;
      });
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
    const m = model || 'gemini-2.0-flash';
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
      const n = p.nutriments || {};
      const pick = (...keys) => {
        for (const k of keys) { const v = parseFloat(n[k]); if (isFinite(v)) return v; }
        return 0;
      };
      let kcal = pick('energy-kcal_100g');
      if (!kcal) { const kj = pick('energy-kj_100g', 'energy_100g'); if (kj) kcal = Math.round(kj / 4.184 * 10) / 10; }
      const name = p.product_name || '';
      return {
        name, brand: (p.brands || '').split(',')[0].trim(), barcode: '',
        basis: 100, unit: 'g',
        kcal, pro: pick('proteins_100g'), car: pick('carbohydrates_100g'),
        fat: pick('fat_100g'), fib: pick('fiber_100g'),
        source: 'off',
        note: 'Open Food Facts search, per 100 g. Community-entered — check before you trust it.',
        _label: name,
        _sub: [(p.brands || '').split(',')[0].trim(), Math.round(kcal) + ' kcal'].filter(Boolean).join(' · ')
      };
    }).filter((f) => f.name && (f.kcal || f.pro || f.car || f.fat));
    if (!out.length) throw new Error('Nothing in Open Food Facts matches "' + q + '". Type the values in instead.');
    return out;
  }

  async function testUsda(key) {
    const rows = await searchUsda('kiwifruit', String(key || '').trim());
    return rows.length;
  }

  /* ---------- tier 2: vision model ---------- */

  const PROMPT = [
    'This photograph shows a nutrition declaration on food packaging.',
    'Read it and return ONLY a JSON object, no prose and no code fences, with these keys:',
    '{"name":string,"brand":string,"basis":number,"unit":"g"|"ml",',
    ' "kcal":number,"pro":number,"car":number,"fat":number,"fib":number,',
    ' "basis_source":string,"confidence":"high"|"medium"|"low","warning":string}',
    '',
    'Rules:',
    '- Prefer the "per 100 g" or "per 100 ml" column when the label has one, and then basis is 100.',
    '- If the label ONLY gives values per serving, use that serving size as basis and say so in basis_source.',
    '- Never mix columns: every value must come from the same column as basis.',
    '- Energy in kcal. If only kJ is printed, divide by 4.184.',
    '- pro = protein, car = total carbohydrate (NOT "of which sugars"), fat = total fat',
    '  (NOT "of which saturates"), fib = fibre; use 0 when fibre is not declared.',
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
    const m = model || 'gemini-2.0-flash';
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
    return {
      _reference: obj.reference ? String(obj.reference) : '',
      name: String(obj.name || '').trim(),
      brand: String(obj.brand || '').trim(),
      barcode: '',
      basis,
      unit: obj.unit === 'ml' ? 'ml' : 'g',
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
