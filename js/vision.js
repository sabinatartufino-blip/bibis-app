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
    startScanner, barcodeSupported
  };
})();
