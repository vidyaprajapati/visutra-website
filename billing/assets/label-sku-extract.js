/* VISUTRA — shared marketplace shipping-label parsing.
   Extraction logic for Amazon and Meesho mirrors the already-working,
   already-tested code in tools/label-cropper.html (kept untouched there —
   this is a copy of the same proven regexes for a different consumer, not a
   rewrite). Flipkart is new here, built from a real sample label. */

/* Best-effort marketplace guess from a page's raw text — used to label the
   detected item and to decide which extractor(s) to try first, not as a
   hard gate (all three extractors still run regardless, since Amazon's
   invoice page in particular often doesn't say "Amazon" prominently). */
function detectMarketplaceFromText(text){
  const lower = text.toLowerCase();
  if(lower.includes('flipkart')) return 'FLIPKART';
  if(lower.includes('meesho')) return 'MEESHO';
  if(lower.includes('amazon')) return 'AMAZON';
  return null;
}

/* ---------------- Meesho ----------------
   Copied from tools/label-cropper.html's extractMeeshoSkuQty(). */
function extractMeeshoSkuQty(text){
  const headerMatch = text.match(/SKU\s*Size\s*Qty\s*Color\s*Order\s*No\.?/i);
  if(headerMatch){
    const afterHeader = text.slice(headerMatch.index + headerMatch[0].length).trim();
    const skuMatch = afterHeader.match(/\S+/);
    if(skuMatch){
      const sku = skuMatch[0];
      const orderNoMatch = afterHeader.match(/\d{6,}_\d{1,3}/);
      const searchZone = orderNoMatch ? afterHeader.slice(0, orderNoMatch.index) : afterHeader;
      const qtyMatches = searchZone.match(/\b\d{1,3}\b/g);
      const qty = qtyMatches && qtyMatches.length ? parseInt(qtyMatches[qtyMatches.length - 1], 10) : 1;
      return { sku, qty: qty || 1 };
    }
  }
  const allOrderNos = text.match(/\d{6,}_\d{1,3}\b/g);
  if(allOrderNos && allOrderNos.length){
    const idx = text.lastIndexOf(allOrderNos[allOrderNos.length - 1]);
    const before = text.slice(0, idx).slice(-120);
    const tokens = before.trim().split(/\s+/).filter(t => t.length >= 3 && /[A-Za-z0-9]/.test(t));
    if(tokens.length){
      const codeLike = tokens.filter(t => /[-_]/.test(t) || (/[A-Za-z]/.test(t) && /\d/.test(t)));
      return { sku: codeLike[codeLike.length - 1] || tokens[tokens.length - 1], qty: 1 };
    }
  }
  return null;
}

/* ---------------- Amazon ----------------
   Copied from tools/label-cropper.html's detectAmazonSkus() item regex —
   reads "... ( SKU ) HSN:code price qty price ..." off the tax invoice.
   Returns every line item found on the page (an order can have more than one
   product), not just the first. */
function extractAmazonItems(text){
  const itemRegex = /\(\s*([^()]+?)\s*\)\s*HSN\s*:\s*\d+\s*(?:₹|Rs\.?|INR)?\s*[\d,]+(?:\.\d+)?\s+(\d+)\s+(?:₹|Rs\.?|INR)?\s*[\d,]+(?:\.\d+)?/gi;
  const items = [];
  let m;
  while((m = itemRegex.exec(text)) !== null){
    items.push({ sku: m[1].trim(), qty: parseInt(m[2], 10) || 1 });
  }
  return items;
}

/* ---------------- Flipkart ----------------
   Built from a real Flipkart label+invoice PDF. Two independent anchors are
   tried, since the label section and the tax-invoice section both print the
   SKU in a stable, distinct spot — either is enough on its own:

   1) Label's own "SKU ID | Description" table:
        "SKU ID | Description QTY 1 VST-WA-FA30-6_7.5 | Visutra Top Loading
         Washing Machine Cover Grey 1"
      -> SKU is the token right after the header (and the row's leading
         index number), up to the next "|". Qty is the next standalone
         1-3 digit number after that.

   2) Tax invoice's product line, which always prints the SKU immediately
      before "| IMEI/SrNo":
        "... WA-FA30-6_7.5 | VST-WA-FA30-6_7.5 | IMEI/SrNo: [[]] HSN: 63049291
         | IGST: 5.00% | CESS: 0.00% 1 230.00 ..."
      -> SKU is captured directly; Qty is the first number right after the
         GST/CESS block that follows it. */
function extractFlipkartSkuQty(text){
  // Tier 1 — label table.
  const headerMatch = text.match(/SKU\s*ID\s*\|\s*Description/i);
  if(headerMatch){
    let after = text.slice(headerMatch.index + headerMatch[0].length);
    after = after.replace(/^\s*QTY\s*/i, '');
    after = after.replace(/^\s*\d+\s+/, ''); // drop the row's leading index number
    const skuMatch = after.match(/^\s*([A-Za-z0-9][A-Za-z0-9\-_.]{2,60}?)\s*\|/);
    if(skuMatch){
      const sku = skuMatch[1].trim();
      const afterSku = after.slice(skuMatch[0].length);
      const qtyMatch = afterSku.match(/\b(\d{1,3})\b/);
      return { sku, qty: qtyMatch ? (parseInt(qtyMatch[1], 10) || 1) : 1 };
    }
  }
  // Tier 2 — tax invoice product line, anchored on "| IMEI/SrNo".
  const imeiMatch = text.match(/\|\s*([A-Za-z0-9][A-Za-z0-9\-_.]{2,60})\s*\|\s*IMEI\s*\/?\s*SrNo/i);
  if(imeiMatch){
    const sku = imeiMatch[1].trim();
    const after = text.slice(imeiMatch.index + imeiMatch[0].length);
    // Qty is the first standalone number after the CESS % that follows HSN/IGST.
    const cessMatch = after.match(/CESS\s*:\s*[\d.]+\s*%/i);
    const searchZone = cessMatch ? after.slice(cessMatch.index + cessMatch[0].length) : after;
    const qtyMatch = searchZone.match(/\b(\d{1,3})\b/);
    return { sku, qty: qtyMatch ? (parseInt(qtyMatch[1], 10) || 1) : 1 };
  }
  return null;
}

/* Reads every SKU on one page, tagged with its marketplace. A marketplace
   named in the page text is tried first, and the FIRST extractor that finds
   something wins — so a Flipkart page can't also be mis-read by Meesho's
   looser Order-No fallback and counted twice (that used to happen when all
   three always ran). Amazon's strict pattern goes before Meesho's fallback.
   Amazon can return several line items for one page. */
function extractAllMarketplaceItems(text){
  const lower = String(text || '').toLowerCase();
  const hint = lower.includes('flipkart') ? 'FLIPKART' : lower.includes('meesho') ? 'MEESHO' : lower.includes('amazon') ? 'AMAZON' : null;
  const tryers = {
    FLIPKART: () => { const r = extractFlipkartSkuQty(text); return r ? [r] : []; },
    MEESHO:   () => { const r = extractMeeshoSkuQty(text); return (r && r.sku !== 'Unknown SKU') ? [r] : []; },
    AMAZON:   () => extractAmazonItems(text)
  };
  const order = hint ? [hint, ...['FLIPKART','AMAZON','MEESHO'].filter(x => x !== hint)] : ['FLIPKART','AMAZON','MEESHO'];
  for(const mk of order){
    const items = tryers[mk]();
    if(items.length) return items.map(it => ({ marketplace: mk, sku: it.sku, qty: it.qty }));
  }
  return [];
}

/* ---------------- Shipment identity (duplicate protection) ----------------
   Every "has this label already been counted?" check across the app is keyed
   on WHICH SHIPMENT a label is, not on a slice of its text. The old key used
   the first 200 characters of the page, which on an Amazon invoice is the
   same heading + seller block on every order — so two different orders of
   the same SKU looked identical and the second was treated as a reprint.

   Order IDs, by marketplace (as printed on the label / invoice):
     Amazon   : 404-1234567-1234567
     Flipkart : OD + 15–21 digits
     Meesho   : sub-order no. 123456789012345_1
   If none is found the WHOLE page text is hashed (never a slice). */
function shipmentIdFromText(text, marketplace){
  const t = String(text || '');
  const pick = re => { const m = t.match(re); return m ? m[1] : null; };
  const byMk = {
    AMAZON:   () => pick(/\b(\d{3}-\d{7}-\d{7})\b/),
    FLIPKART: () => pick(/\b(OD\d{15,21})\b/i),
    MEESHO:   () => pick(/\b(\d{6,}_\d{1,3})\b/)
  };
  const first = marketplace && byMk[marketplace] ? byMk[marketplace]() : null;
  if(first) return first;
  for(const mk of ['AMAZON','FLIPKART','MEESHO']){ const v = byMk[mk](); if(v) return v; }
  return null;
}
/* 53-bit string hash (cyrb53) — far fewer collisions than a 32-bit hash
   over thousands of labels. Used only for the no-order-ID fallback. */
function hash53(str){
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for(let i = 0; i < str.length; i++){
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
function safeDocId(s){
  return String(s).replace(/[\/\\\s#?\[\]*`]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 400) || 'x';
}
function shipmentPart(marketplace, text){
  const id = shipmentIdFromText(text, marketplace);
  return id ? 'id-' + id : 'tx-' + hash53(String(text || ''));
}
/* One per PRODUCT LINE on a shipment: product stock deductions & returns. */
function labelKey(marketplace, sku, text){
  return safeDocId(`L_${marketplace}_${shipmentPart(marketplace, text)}_${String(sku).trim().toLowerCase()}`);
}
/* One per SHIPMENT (whatever it contains): packing — one packet per label. */
function packingKey(marketplace, text){
  return safeDocId(`P_${marketplace}_${shipmentPart(marketplace, text)}`);
}

/* Small, dependency-free 32-bit hash — kept for the older, non-stock uses
   (order-draft page tracking, file signatures). Stock dedup uses the keys
   above instead. */
function hashText(str){
  let h = 0;
  for(let i = 0; i < str.length; i++){
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return 'h' + (h >>> 0).toString(36);
}

/* ---------------- Multiple SKUs per marketplace field ----------------
   A product's Amazon / Meesho / Flipkart SKU field can hold several SKUs
   (one product listed under different codes — sizes, colours, relistings),
   separated by commas, semicolons or new lines. Stored as one string
   ("A, B, C") so older single-SKU products keep working unchanged. */
function splitSkuList(v){
  const seen = new Set();
  return String(v == null ? '' : v).split(/[,;\n\r]+/).map(x => x.trim()).filter(x => {
    const k = x.toLowerCase();
    if(!x || seen.has(k)) return false;
    seen.add(k); return true;
  });
}
function joinSkuList(v){ return splitSkuList(v).join(', '); }
function skuListHas(v, sku){
  const k = String(sku == null ? '' : sku).trim().toLowerCase();
  return !!k && splitSkuList(v).some(x => x.toLowerCase() === k);
}

/* ---------------- Per-SKU Active / Inactive ----------------
   A buyer product can switch individual marketplace SKUs off without
   removing them: mapping.inactiveSkus = ['MEESHO:vst-a', ...]. An inactive
   SKU is ignored by label matching (the label shows as unmapped) but stays
   reserved to that product. */
// ALL = "All platforms": one SKU code used on Amazon, Meesho AND Flipkart for the same product.
var SKU_FIELD_BY_MARKETPLACE = { AMAZON: 'amazonSku', MEESHO: 'meeshoSku', FLIPKART: 'flipkartSku', ALL: 'allSku' };
var SKU_FIELDS = ['amazonSku', 'meeshoSku', 'flipkartSku', 'allSku'];
function skuStateKey(marketplace, sku){ return String(marketplace).toUpperCase() + ':' + String(sku).trim().toLowerCase(); }
function isSkuInactive(m, marketplace, sku){
  return !!(m && Array.isArray(m.inactiveSkus) && m.inactiveSkus.includes(skuStateKey(marketplace, sku)));
}
function mappingMatchesSku(m, marketplace, sku){
  const field = SKU_FIELD_BY_MARKETPLACE[marketplace];
  if (field && field !== 'allSku' && skuListHas(m[field], sku) && !isSkuInactive(m, marketplace, sku)) return true;
  // An "All platforms" SKU matches a label / report / file from ANY marketplace.
  return skuListHas(m.allSku, sku) && !isSkuInactive(m, 'ALL', sku);
}
/* Which products already use this SKU in a way that would clash with adding
   it to `field` on another product:
     - a platform SKU clashes with the same code on that platform or in "All platforms"
     - an "All platforms" SKU clashes with the same code anywhere
   (The same code on DIFFERENT platforms for different products is allowed —
   e.g. VST-A = 9 kg cover on Meesho but 6 kg on Flipkart.) */
function skuClashes(mappings, field, sku, exceptId){
  return (mappings || []).filter(m => m.id !== exceptId && m.status !== 'INACTIVE' &&
    (field === 'allSku' ? SKU_FIELDS.some(f => skuListHas(m[f], sku)) : (skuListHas(m[field], sku) || skuListHas(m.allSku, sku))));
}

/* ---------------- Smart product suggestion for a new SKU ----------------
   Marketplace SKUs for one product usually share a pattern — e.g.
   VST-WFAT-222338-7-8.5-FA34 / -FA38 / -FA43, or vis-FA6___11 / ___27.
   Scores a new SKU against every SKU each product already has:
     prefix  = shared leading characters ÷ longer SKU's length
     tokens  = shared parts (split on - _ space etc.) ÷ all parts
   and takes the better of the two. Suggests the best product only when it
   scores ≥ 0.6 AND clearly beats the runner-up — otherwise suggests
   nothing rather than guess. It only PRE-SELECTS the dropdown; you still
   click Map yourself.
   candidates: [{ id, skus: [...] }]  →  { id, score } | null */
function skuSimilarity(a, b){
  a = String(a || '').trim().toLowerCase(); b = String(b || '').trim().toLowerCase();
  if(!a || !b) return 0;
  if(a === b) return 1;
  let i = 0; while(i < a.length && i < b.length && a[i] === b[i]) i++;
  const prefix = i / Math.max(a.length, b.length);
  const ta = new Set(a.split(/[^a-z0-9.]+/).filter(Boolean)), tb = new Set(b.split(/[^a-z0-9.]+/).filter(Boolean));
  let inter = 0; ta.forEach(t => { if(tb.has(t)) inter++; });
  const union = new Set([...ta, ...tb]).size || 1;
  return Math.max(prefix, inter / union);
}
function suggestBySku(sku, candidates){
  const scored = (candidates || []).map(c => ({
    id: c.id,
    score: (c.skus || []).reduce((best, s) => Math.max(best, skuSimilarity(sku, s)), 0)
  })).filter(c => c.score > 0).sort((x, y) => y.score - x.score);
  if(!scored.length || scored[0].score < 0.6) return null;
  if(scored[1] && scored[0].score - scored[1].score < 0.05) return null; // too close to call
  return scored[0];
}

/* ---------------- Customer STATE / PIN from a label page ----------------
   A shipping label or invoice page carries TWO addresses — the customer's ("Ship To", "Customer Address",
   "Shipping Address") and the seller's ("If undelivered, return to", "Sold By", "Ship From"). Only the customer's
   state is wanted, so the PIN is chosen by the nearest address heading in front of it, never "the first PIN on the page".
   Order of trust:  1. "Place of Supply: <state>" (an invoice's own statement of the customer's state)
                    2. a state NAME written just before the customer's PIN
                    3. the PIN's first digits, for the prefixes that belong to one state only (110xxx = Delhi …)
   Returns { state, stateCode, pin, via }  — state is '' when it cannot be told (never a guess). */
const LABEL_STATES = [['01','Jammu and Kashmir'],['02','Himachal Pradesh'],['03','Punjab'],['04','Chandigarh'],['05','Uttarakhand'],['06','Haryana'],['07','Delhi'],
  ['08','Rajasthan'],['09','Uttar Pradesh'],['10','Bihar'],['11','Sikkim'],['12','Arunachal Pradesh'],['13','Nagaland'],['14','Manipur'],['15','Mizoram'],
  ['16','Tripura'],['17','Meghalaya'],['18','Assam'],['19','West Bengal'],['20','Jharkhand'],['21','Odisha'],['22','Chhattisgarh'],['23','Madhya Pradesh'],
  ['24','Gujarat'],['26','Dadra and Nagar Haveli and Daman and Diu'],['27','Maharashtra'],['29','Karnataka'],['30','Goa'],['31','Lakshadweep'],['32','Kerala'],
  ['33','Tamil Nadu'],['34','Puducherry'],['35','Andaman and Nicobar Islands'],['36','Telangana'],['37','Andhra Pradesh'],['38','Ladakh']];
const LABEL_STATE_ALIASES = [['orissa','Odisha'],['pondicherry','Puducherry'],['uttaranchal','Uttarakhand'],['nct of delhi','Delhi'],['new delhi','Delhi'],
  ['chattisgarh','Chhattisgarh'],['chhatisgarh','Chhattisgarh'],['telengana','Telangana'],['dadra and nagar haveli','Dadra and Nagar Haveli and Daman and Diu'],
  ['daman and diu','Dadra and Nagar Haveli and Daman and Diu'],['andaman and nicobar','Andaman and Nicobar Islands'],['jammu kashmir','Jammu and Kashmir']];
// PIN prefixes that belong to exactly ONE state (the rest — e.g. 20–28 UP/Uttarakhand, 80–85 Bihar/Jharkhand — need the name)
const LABEL_PIN_STATE = { '11': 'Delhi', '12': 'Haryana', '13': 'Haryana', '14': 'Punjab', '15': 'Punjab', '17': 'Himachal Pradesh', '30': 'Rajasthan', '31': 'Rajasthan',
  '32': 'Rajasthan', '33': 'Rajasthan', '34': 'Rajasthan', '36': 'Gujarat', '37': 'Gujarat', '38': 'Gujarat', '39': 'Gujarat', '41': 'Maharashtra', '42': 'Maharashtra',
  '43': 'Maharashtra', '44': 'Maharashtra', '45': 'Madhya Pradesh', '46': 'Madhya Pradesh', '47': 'Madhya Pradesh', '48': 'Madhya Pradesh', '49': 'Chhattisgarh',
  '56': 'Karnataka', '57': 'Karnataka', '58': 'Karnataka', '59': 'Karnataka', '60': 'Tamil Nadu', '61': 'Tamil Nadu', '62': 'Tamil Nadu', '63': 'Tamil Nadu',
  '64': 'Tamil Nadu', '67': 'Kerala', '68': 'Kerala', '69': 'Kerala', '75': 'Odisha', '76': 'Odisha', '77': 'Odisha', '78': 'Assam' };
function labelStateCode(name){ const r = LABEL_STATES.find(s => s[1] === name); return r ? r[0] : ''; }
function _labelNorm(s){ return ' ' + String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim() + ' '; }
// every state NAME in `norm`, with where it starts (longest names first, so "Dadra and Nagar Haveli and Daman and Diu" beats "Daman and Diu")
function _labelStateHits(norm){
  const needles = LABEL_STATES.map(s => [_labelNorm(s[1]).trim(), s[1]]).concat(LABEL_STATE_ALIASES.map(a => [_labelNorm(a[0]).trim(), a[1]]))
    .sort((a, b) => b[0].length - a[0].length);
  const hits = [], taken = [];
  needles.forEach(([n, canon]) => {
    let from = 0, i;
    while((i = norm.indexOf(' ' + n + ' ', from)) !== -1){
      const start = i + 1, end = start + n.length;
      if(!taken.some(t => start < t[1] && end > t[0])){ hits.push({ pos: start, end, state: canon }); taken.push([start, end]); }
      from = i + 1;
    }
  });
  return hits.sort((a, b) => a.pos - b.pos);
}
function extractCustomerState(text){
  const norm = _labelNorm(text), none = { state: '', stateCode: '', pin: '', via: '' };
  if(norm.trim().length < 20) return none;
  const done = (state, pin, via) => ({ state, stateCode: labelStateCode(state), pin: pin || '', via });
  // PINs: six digits, first digit 1–8, not inside a longer number (order IDs, phone numbers, GSTINs)
  const pins = []; let m; const rePin = /(?:^| )([1-8]\d{5})(?= |$)/g;
  while((m = rePin.exec(norm)) !== null) pins.push({ pin: m[1], pos: m.index + (m[0].length - m[1].length) });
  const hits = _labelStateHits(norm);
  // nearest address heading in front of a position
  const lastIdx = (re, before) => { let best = -1, x; const r = new RegExp(re.source, 'g'); const part = norm.slice(Math.max(0, before - 450), before);
    while((x = r.exec(part)) !== null) best = Math.max(0, before - 450) + x.index; return best; };
  const CUST = /(customer address|shipping address|ship to|shipto|deliver to|delivery address|consignee|bill to|billing address|buyer address)/;
  const SELL = /(return address|return to|if undelivered|sold by|ship from|shipped from|pickup address|seller address|registered address|from address)/;
  const customerPin = pins.find(p => { const c = lastIdx(CUST, p.pos), s = lastIdx(SELL, p.pos); return c !== -1 && c > s; })
    || pins.find(p => lastIdx(SELL, p.pos) === -1) || null;
  // 1. an invoice's own "Place of Supply" line
  const ps = norm.indexOf(' place of supply ');
  if(ps !== -1){
    const win = norm.slice(ps + 17, ps + 17 + 55), h = _labelStateHits(' ' + win.trim() + ' ')[0];
    if(h) return done(h.state, customerPin && customerPin.pin, 'supply');
  }
  if(!customerPin) return none;
  // 2. the state NAME nearest in front of the customer's PIN (inside that address block)
  const near = hits.filter(h => h.end <= customerPin.pos + 1 && customerPin.pos - h.end <= 140 && !(lastIdx(SELL, h.pos) > lastIdx(CUST, h.pos)));
  if(near.length) return done(near[near.length - 1].state, customerPin.pin, 'name');
  // 3. the PIN's own prefix, where it belongs to a single state
  const st = LABEL_PIN_STATE[customerPin.pin.slice(0, 2)];
  return st ? done(st, customerPin.pin, 'pin') : { state: '', stateCode: '', pin: customerPin.pin, via: '' };
}
