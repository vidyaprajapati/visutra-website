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

/* Runs all three extractors against one page's text and returns every hit
   found, each tagged with its marketplace. A single page normally yields at
   most one hit, but this doesn't assume that — a page could legitimately
   match more than once (e.g. an Amazon invoice with several line items). */
function extractAllMarketplaceItems(text){
  const results = [];
  const flipkart = extractFlipkartSkuQty(text);
  if(flipkart) results.push({ marketplace: 'FLIPKART', sku: flipkart.sku, qty: flipkart.qty });
  const meesho = extractMeeshoSkuQty(text);
  if(meesho && meesho.sku !== 'Unknown SKU') results.push({ marketplace: 'MEESHO', sku: meesho.sku, qty: meesho.qty });
  extractAmazonItems(text).forEach(it => results.push({ marketplace: 'AMAZON', sku: it.sku, qty: it.qty }));
  return results;
}

/* Small, dependency-free hash for duplicate-label detection (Part 39 of the
   spec) — not cryptographic, just enough to fingerprint "have I seen this
   exact page's text before". */
function hashText(str){
  let h = 0;
  for(let i = 0; i < str.length; i++){
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return 'h' + (h >>> 0).toString(36);
}
