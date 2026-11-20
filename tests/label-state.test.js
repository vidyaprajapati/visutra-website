// Reading the CUSTOMER's state / PIN from a shipping label or invoice page (never the seller's return address).
// The page texts below follow the usual Meesho / Flipkart / Amazon layouts (address block, return address, order IDs).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'billing', 'assets', 'label-sku-extract.js'), 'utf8');
const L = vm.runInNewContext(src + '\n;({ extractCustomerState, labelStateCode, packingKey, shipmentIdFromText, LABEL_STATES })', {});
global.window = globalThis; const VPT = require('../billing/assets/profit-tools.js');
const got = t => { const r = L.extractCustomerState(t); return [r.state, r.stateCode, r.pin, r.via]; };

const MEESHO = (cust, ret) => `Meesho  Delivery Partner: Shadowfax  Order No. 123456789012345_1  Customer Address  ${cust}  Product Details  SKU Size Qty Order No.  WM-9KG-BLUE Free Size 1 123456789012345_1  COD: Rs.0  If undelivered, return to: ${ret}`;
test('Meesho-style label: the CUSTOMER address wins over the seller\'s return address', () => {
  assert.deepEqual(got(MEESHO('Ramesh Kumar, H.No 12 Gali 3, Muradnagar, Ghaziabad, Uttar Pradesh, 201206', 'VISUTRA, 55 Industrial Area, Noida, Uttar Pradesh, 201301')), ['Uttar Pradesh', '09', '201206', 'name']);
  // the trap: customer far away, seller's return address in another state
  assert.deepEqual(got(MEESHO('Anita Rao, 4th Cross, Andheri East, Mumbai, Maharashtra, 400069', 'VISUTRA, 55 Industrial Area, Noida, Uttar Pradesh, 201301')), ['Maharashtra', '27', '400069', 'name']);
  assert.deepEqual(got(MEESHO('S. Murugan, 7 Gandhi Road, Madurai, Tamil Nadu, 625001', 'VISUTRA, Noida, Uttar Pradesh, 201301'))[0], 'Tamil Nadu');
});
test('Flipkart-style label: "Ship To" … "State - PIN", "Sold By" is ignored', () => {
  assert.deepEqual(got('Flipkart  OD123456789012345678  Ship To: Mohan Lal, 14 MG Road, Indiranagar, Bengaluru, Karnataka - 560038  Sold By: Visu Trader, Ghaziabad, Uttar Pradesh - 201001  SKU: WM-9KG  Qty 1'), ['Karnataka', '29', '560038', 'name']);
});
test('Amazon invoice page: Place of Supply names the customer\'s state; HSN codes and order numbers are not PINs', () => {
  const t = 'Tax Invoice  Order Number: 404-1234567-1234567  Sold By: VISUTRA, Plot 5, Ghaziabad, UTTAR PRADESH, 201001  GST: 09BVHPP4321G1ZJ  Shipping Address: Pooja Singh, 12 Civil Lines, JAIPUR, RAJASTHAN, 302006  Place of Supply: RAJASTHAN  HSN 630790  Washing Machine Cover  Qty 1';
  assert.deepEqual(got(t), ['Rajasthan', '08', '302006', 'supply']);
  assert.equal(got('Order 404-1234567-1234567  HSN 630790  Place of Supply: GUJARAT  Sold By: X, Noida, Uttar Pradesh, 201301')[0], 'Gujarat', 'place of supply works even without a readable address');
});
test('PIN only (no state written): single-state prefixes work, ambiguous ones are NOT guessed', () => {
  assert.deepEqual(got('Ship To: Anil Verma, Sector 5 Rohini, 110085  Return address: X, Noida, UP, 201301'), ['Delhi', '07', '110085', 'pin']);
  assert.deepEqual(got('Customer Address Ravi, Baner Road, Pune 411045 If undelivered return to Y'), ['Maharashtra', '27', '411045', 'pin']);
  assert.deepEqual(got('Customer Address Hari, Rajpur Road, Dehradun 248001 If undelivered return to Y'), ['', '', '248001', ''], '24xxxx is UP or Uttarakhand — the name is needed');
});
test('long state names, spelling variants and "&"', () => {
  assert.equal(got('Ship To: A B, Port Blair, Andaman & Nicobar Islands - 744101  Sold By: Z, Delhi, Delhi, 110001')[0], 'Andaman and Nicobar Islands');
  assert.equal(got('Customer Address A B, Srinagar, Jammu & Kashmir, 190001 If undelivered return to Z, Noida, Uttar Pradesh, 201301')[0], 'Jammu and Kashmir');
  assert.equal(got('Customer Address A B, Bhubaneswar, Orissa, 751001 If undelivered return to Z, Noida, Uttar Pradesh, 201301')[0], 'Odisha');
  assert.equal(got('Ship To: A B, Silvassa, Dadra and Nagar Haveli and Daman and Diu, 396230  Sold By: Z, Surat, Gujarat, 395001')[0], 'Dadra and Nagar Haveli and Daman and Diu');
  assert.equal(got('Customer Address A B, New Delhi, 110001 If undelivered return to Z')[0], 'Delhi');
});
test('nothing readable → empty (never a guess); order IDs / phone numbers / GSTINs are never mistaken for a PIN', () => {
  assert.deepEqual(got(''), ['', '', '', '']);
  assert.deepEqual(got('Meesho Order No. 123456789012345_1 SKU WM-9KG Qty 1 Phone 9876543210 GSTIN 09BVHPP4321G1ZJ Invoice 26-27/0001'), ['', '', '', '']);
  assert.equal(got('Customer Address Nobody, Nowhere. If undelivered, return to: VISUTRA, Noida, Uttar Pradesh, 201301')[0], '', 'only the seller\'s address is on the page → no state for the customer');
});
test('the capture key of an order is the same from a label page and from the bare order ID in a report', () => {
  const page = MEESHO('Ramesh, Muradnagar, Uttar Pradesh, 201206', 'VISUTRA, Noida, Uttar Pradesh, 201301');
  assert.equal(L.packingKey('MEESHO', page), L.packingKey('MEESHO', '123456789012345_1'));
  assert.equal(L.packingKey('FLIPKART', 'Ship To x OD123456789012345678 y'), L.packingKey('FLIPKART', 'OD123456789012345678'));
  assert.equal(L.packingKey('AMAZON', 'Order Number: 404-1234567-1234567 foo'), L.packingKey('AMAZON', '404-1234567-1234567'));
});
test('the label reader and the profit tools use the same states and GST codes', () => {
  L.LABEL_STATES.forEach(([code, name]) => { assert.equal(VPT.STATES[code], name, code); assert.equal(VPT.normalizeState(name), name); assert.equal(L.labelStateCode(name), code); });
  assert.equal(L.LABEL_STATES.length, Object.keys(VPT.STATES).length);
});
