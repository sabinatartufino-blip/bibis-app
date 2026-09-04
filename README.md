# Bibi's App

**Healthy food, happier you.** A macro tracker built for one person. No account, no server, no analytics — everything
lives in your phone's own storage. It installs to the home screen like any app and works
with no signal.

Four ways to get a food's numbers in:

1. **Scan the barcode** → looked up in [Open Food Facts](https://world.openfoodfacts.org)
   (free, no key, good European coverage)
2. **Photograph the nutrition label** → a vision model reads it and returns the values
   *plus the basis they apply to*
3. **Search by name** → for food with no barcode and no label: a kiwi, a carrot, rolled oats.
   Answers from the **Swiss Food Composition Database bundled with the app** — 1 246 foods,
   ~35 nutrients each, instant and offline with no key. Falls through to USDA FoodData Central,
   then the vision model, then an Open Food Facts text search when the Swiss data has no match.
   Searching accepts German, French and Serbian/Croatian food names: *Gruyère* finds *Greyerzer*,
   *Hüttenkäse* finds *Cottage cheese*, *Rüebli* finds *Carrot*
4. **Type them in** → always available

Nothing an extraction produces is saved until you look at it and tap Save. A misread
"per serving" column would silently poison every future calculation, so it always asks.

---

## Setting it up (about 10 minutes, once)

### 1. Put the files on GitHub

1. Create a new repository at [github.com/new](https://github.com/new). Name it
   `bibis-app` and set it to **Public**. On a free GitHub account, Pages only publishes
   from public repositories — a private repo needs Pro or above. Nothing in these files is
   secret (your API key is never committed; it lives in the phone's browser storage), so
   public costs you nothing but is worth knowing. If you'd rather keep the source private,
   Netlify and Cloudflare Pages both publish from a private GitHub repo on their free tiers.
2. On the new repo's page, click **uploading an existing file**.
3. Unzip `bibis-app.zip` and drag *the contents* in — `index.html`, `sw.js`,
   `manifest.webmanifest`, `README.md`, and the `css`, `js` and `icons` folders.
   Do not drag the outer folder itself; `index.html` must sit at the top level.
4. Commit.

### 2. Turn on GitHub Pages

**Settings** → **Pages** → under *Source* pick **Deploy from a branch**, branch `main`,
folder `/ (root)` → **Save**.

Wait a minute or two, then reload that page — it shows your URL:

```
https://<your-username>.github.io/bibis-app/
```

HTTPS is what matters here: the camera, the service worker and home-screen install all
require it, and Pages gives it to you for free.

### 3. Install it on your phone

1. Open that URL in **Chrome on Android**.
2. Menu (⋮) → **Add to Home screen** → **Install**.
3. Launch it from the icon. No address bar, no tabs — it behaves as its own app.

On first launch it asks for age, height, weight, sex and activity, derives daily targets
from those (Mifflin–St Jeor, minus 10 %, protein at 2 g/kg), and starts with an **empty
library** — so anyone can install it from this URL and get their own numbers rather than
inheriting someone else's. Every target stays editable in Settings › Daily targets.

If you want something to look at first, **or start with the sample plan** on that screen
loads 18 ingredients plus **Morning bowl** and **Afternoon shake** as saved meals.

Nothing is shared between installs. All data lives in that phone's own browser storage —
no account, no server, no sync — so two people using this URL never see each other's log.
Android Chrome is the target: barcode scanning uses `BarcodeDetector`, which iOS Safari
does not implement. Photographing a label and typing values work on any phone.

### 4. Add a USDA key for name searches (optional, one minute, free)

Searching by name works with no key at all — it falls back to the vision model, then to an
Open Food Facts text search. But for whole foods the right source is the reference table:

1. [fdc.nal.usda.gov/api-key-signup](https://fdc.nal.usda.gov/api-key-signup) — name and
   email, the key arrives immediately
2. In the app: **Settings › Food databases** → paste it → **Test the USDA key**

A ✓ means "kiwifruit" returned matches. Searches then use the **Foundation** and **SR Legacy**
datasets, which are measured whole-food values per 100 g rather than manufacturer-submitted
label data.

### 5. Add a key for label reading (optional)

Barcode scanning and manual entry work with no key at all. The key is only for reading a
photographed label.

**Google Gemini — has a free tier, so start here**

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey), sign in, **Create API key**.
2. In the app: **Settings › Label reading** → provider *Google Gemini*, paste the key.
3. Tap **Test the connection**. A ✓ means you're done.

**Anthropic Claude — pay per use, cents per scan**

1. Get a key at [console.anthropic.com](https://console.anthropic.com/settings/keys).
2. Provider *Anthropic Claude*, paste the key, test.

If the test says *no model called …*, the model name has moved on since this was written.
Put a current one in the **Model** field — that field exists precisely so a renamed model
never breaks the app.

Your key is stored in this phone's browser storage. It is never committed to the repo,
never included in a backup file, and goes nowhere except to the API you picked.

---

## Using it

**Today** — four meal slots. The `+` on a slot, or the round button, opens the add sheet:
search your library, or scan / photograph / type something new. Tap a logged item to
change the amount; the `✕` removes it. Arrows at the top move between days.

The five tiles at the top show the day against your targets, with how much is left to go.

**Library** — every ingredient, with a photo thumbnail where you've attached one. Anything
tagged **CHECK** carries a value I estimated rather than read off a package — the whey, the
Zene sauce and the coconut milk. Open each one, compare against the tub, and fix the numbers.

The tag on each row says where its values came from: `PLAN` (seeded from your note), `OFF`
(Open Food Facts), `PHOTO` (read from a label photo), `TYPED` (you entered it).

**Saved meals** — the second tab in Library. Build a meal once, log it as one item at any
percentage of the full portion.

**Trends** — 14 days of energy and protein against target, plus your weight line. Days with
nothing logged show as a flat mark rather than a zero, so a missed day doesn't drag the
average down.

**Settings** — profile, targets, the key, and your data.

### The basis field is the important one

Every ingredient stores the amount its label values refer to. Set it to `100` for a normal
per-100 g table, or to `30` for a pack that only prints a "per 30 g serving" column. Then
type the numbers exactly as printed and portions still scale correctly. Getting this wrong
is the one error that silently corrupts everything downstream, which is why the review sheet
highlights it.

---

## Back it up

There is no cloud copy. A lost or wiped phone loses the data.

**Settings › Your data › Export backup** writes a single JSON file with everything,
photos included. Do it every few weeks and keep it somewhere ordinary — email it to
yourself, drop it in your cloud drive. **Restore backup** reads it back, on this phone or
a new one.

**Export log as CSV** gives you the day log as a spreadsheet, if you'd rather analyse a
month in Excel.

---

## Updating the app later

Edit a file on GitHub (or re-upload it) and **bump the cache name in `sw.js`**:

```js
const CACHE = 'bibis-app-v2';   // was v1
```

Without that bump, phones keep serving the version they already cached — that's the same
mechanism that makes it work offline. With it, the next launch picks up the change.

---

## Notes and limits

- **Android Chrome** is the target. The barcode scanner uses the browser's built-in
  `BarcodeDetector`, which Chrome on Android has and most other browsers don't; where it's
  missing you can still type the number under the bars and look it up.
- **iOS Safari** will run the app and install it, but won't decode barcodes from the camera.
- Open Food Facts is community-entered. Coverage of Swiss and Serbian products is decent but
  not complete, and the occasional entry is simply wrong — that's what the review step is for.
- A vision model reading a curved, glossy or badly-lit label can misread a digit. Photograph
  the table straight-on in good light, and read the numbers before saving.
- Nothing here is medical advice. The targets are arithmetic from the profile you enter —
  Mifflin–St Jeor for the resting rate, protein at 2.0 g/kg, fat floored near 0.9 g/kg,
  carbs taking the remaining energy. Worth confirming with a physician or a registered
  dietitian who can check them against bloodwork.

## Where the food data comes from

| Source | Coverage | Key | Offline |
|---|---|---|---|
| Swiss Food Composition Database V 7.1 | 1 246 Swiss/European foods, ~35 nutrients | none | yes, bundled |
| USDA FoodData Central | US reference tables, full nutrient panel | free | no |
| Open Food Facts | branded products worldwide, by barcode | none | no |
| Vision model | whatever is printed on the label in front of you | free tier | no |

The Swiss data is published by the **Federal Food Safety and Veterinary Office (FSVO)** at
[naehrwertdaten.ch](https://naehrwertdaten.ch) and is free to use, including in a nutrition
diary app, **subject to acknowledgment of the source** — which is why the attribution in
Settings › About must stay. `data/swiss.json` is generated from their Excel release; the
converter is documented at the top of the file it produces.

Reference intake percentages are the EU Nutrient Reference Values from Regulation (EU)
No 1169/2011, Annex XIII — the same figures printed as "% RI" on European labels.

Three conventions in the Swiss source are worth knowing, because they decide what the app
claims: a *trace* value and a *below detection limit* value are both stored as **0**, while
*not determined* is stored as **absent**. Absent is never summed as zero — the day's totals
say what share of your energy each nutrient figure actually covers.

## Visual identity

Everything is driven by CSS custom properties at the top of `css/app.css`, so the whole app
re-skins from one block. The two brand colours:

| | Hex | Where it appears |
|---|---|---|
| Olive | `#31471B` | Primary actions, the add button, active tab, weight line, fiber |
| Dusty pink | `#D9827C` | "On target" moments, the over-target bar, latest weight point, protein |

Cream `#F6F3EC` is the page, `#FFFDFA` the cards, and the ink is a near-black tinted olive
(`#1E2915`) rather than grey, so the neutrals sit in the same family as the logo.

Four macro hues are spaced around the two brand colours so no two bars read alike —
rose (protein), wheat (carbs), plum (fat), olive (fiber). Each has a darker text variant,
because `#D9827C` works as a bar but is too light to read as a number on cream.

A dark theme is defined the same way and follows the phone's setting. The olive inverts to a
light sage (`#A8C47E`) so it still reads as the brand colour on a dark ground; the pink holds
its hue and only lightens.

The icons come from your logo: `icon-192` and `icon-512` are the tile as-is, and
`icon-maskable-512` insets it on cream so Android can crop to a circle without cutting into
the artwork. `mark-128.png` is the small mark shown in Settings.

## What's in here

```
index.html               all screens
css/app.css              one stylesheet — the palette block is at the top
js/db.js                 IndexedDB: ingredients, meals, log, weights, settings
js/calc.js               the arithmetic, target derivation, seed data
js/vision.js             Open Food Facts, the vision call, camera scanning
js/app.js                screens and interaction
sw.js                    offline cache
manifest.webmanifest     install metadata
icons/                   home-screen icons, generated from the logo
```

No build step, no dependencies, no npm. Every file is one you can read and change.
