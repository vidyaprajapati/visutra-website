// VISUTRA Billing — HSN/SAC → GST rate quick reference
// --------------------------------------------------------
// This is a curated list of COMMON categories to speed up data entry —
// it is NOT the complete official GST rate schedule (that runs to
// thousands of entries and is revised periodically by GST Council
// notifications). Always verify against the official CBIC rate finder
// before finalising, especially for anything not listed here:
// https://cbic-gst.gov.in/hindi/gst-goods-services-rates.html
//
// Rates reflect the GST 2.0 rate rationalisation effective 22 Sep 2025
// (primary slabs simplified to 5% / 18%, with a special 40% slab for
// luxury/sin goods, and niche 0.25%/3% rates for gems/precious metals).
// `rate: null` means the rate depends on transaction value or other
// factors — those entries show a note instead of auto-filling a number.

const HSN_GST_REFERENCE = [
  // --- Home textiles & furnishing (Chapter 63) — VISUTRA's own category ---
  { hsn: '6301', desc: 'Blankets and travelling rugs', rate: 5 },
  { hsn: '6302', desc: 'Bed linen, table linen, toilet linen, kitchen linen', rate: 5 },
  { hsn: '6303', desc: 'Curtains, drapes, interior blinds, bed/curtain valances', rate: 5 },
  { hsn: '6304', desc: 'Other furnishing articles — cushion covers, bedspreads, appliance/furniture covers', rate: 5 },
  { hsn: '6305', desc: 'Sacks and bags for packaging', rate: 5 },
  { hsn: '6306', desc: 'Tarpaulins, tents, camping goods, sails', rate: 5 },
  { hsn: '6309', desc: 'Worn clothing and other worn textile articles', rate: 5 },
  { hsn: '6310', desc: 'Used or new rags, scrap twine/rope/cordage', rate: 5 },

  // --- Fabrics & yarn (Chapters 50-60) ---
  { hsn: '5208', desc: 'Woven cotton fabric', rate: 5 },
  { hsn: '5407', desc: 'Woven synthetic filament yarn fabric', rate: 5 },
  { hsn: '5512', desc: 'Woven synthetic staple fibre fabric', rate: 5 },

  // --- Apparel (Chapters 61-62) — value-based, not a single rate ---
  { hsn: '6109', desc: 'T-shirts, singlets, vests (knitted)', rate: null, note: 'Apparel: 5% if sale value ≤ ₹2,500/piece, 18% if above — pick manually based on your price.' },
  { hsn: '6203', desc: "Men's suits, jackets, trousers (woven)", rate: null, note: 'Apparel: 5% if sale value ≤ ₹2,500/piece, 18% if above — pick manually based on your price.' },
  { hsn: '6204', desc: "Women's suits, dresses, skirts (woven)", rate: null, note: 'Apparel: 5% if sale value ≤ ₹2,500/piece, 18% if above — pick manually based on your price.' },

  // --- Footwear ---
  { hsn: '6403', desc: 'Footwear with leather uppers', rate: null, note: 'Footwear: 5% if sale value ≤ ₹2,500/pair, 18% if above — pick manually based on your price.' },

  // --- Common general goods ---
  { hsn: '3926', desc: 'Other articles of plastic', rate: 18 },
  { hsn: '4819', desc: 'Cartons, boxes, packing containers of paper/paperboard', rate: 18 },
  { hsn: '4901', desc: 'Printed books', rate: 0 },
  { hsn: '8471', desc: 'Computers and related equipment', rate: 18 },
  { hsn: '8517', desc: 'Mobile phones and telecom equipment', rate: 18 },
  { hsn: '9403', desc: 'Furniture (other than medical/dental/barber furniture)', rate: 18 },
  { hsn: '9404', desc: 'Mattress supports, cushions, quilts, pouffes', rate: 5 },

  // --- Common services (SAC) ---
  { hsn: '9988', desc: 'Job work / tailoring services', rate: 5 },
  { hsn: '9954', desc: 'Construction services', rate: 18 },
  { hsn: '9983', desc: 'Professional, technical & business services (general)', rate: 18 },

  // --- Examples of the special/niche slabs, for awareness ---
  { hsn: '7108', desc: 'Gold (unwrought or semi-manufactured)', rate: 3 },
  { hsn: '7102', desc: 'Diamonds, unsorted/rough', rate: 0.25 },
  { hsn: '2202', desc: 'Aerated / carbonated beverages', rate: 40 },
  { hsn: '2403', desc: 'Tobacco products, pan masala', rate: 40 }
];
