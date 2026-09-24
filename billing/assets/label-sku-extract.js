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
