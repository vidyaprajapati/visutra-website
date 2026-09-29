// Loads a real site page in jsdom with the Supabase adapter + the test client.
const fs = require('fs'), path = require('path');
const { JSDOM } = require('jsdom');
const PDFLib = require('pdf-lib');
const R = path.join(__dirname, '..', '..') + path.sep;
const { makeClient } = require('./fakesb');
const SKIP = /(user-menu|auth-guard|pwa|android-download|firebase-config|vt-firebase-compat)\.js$/;
const windows = [];
const read = rel => fs.readFileSync(R + rel, 'utf8');
function baseWindow(html, url, identity, stats, before){
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url });
  const w = dom.window; windows.push(w);
  w.supabase = { createClient: () => makeClient(() => identity, stats) };
  w.mountUserMenu = () => {}; w.renderBuyerSidebar = () => {}; w.scrollTo = () => {}; w.Element.prototype.scrollIntoView = () => {};
  w.confirm = () => true; w.prompt = () => ''; w.alert = () => {};
  w.HTMLCanvasElement.prototype.getContext = () => ({}); w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {}; w.HTMLAnchorElement.prototype.click = () => {};
  w.PDFLib = Object.assign({}, PDFLib, { PDFDocument: { create: async () => { const d = await PDFLib.PDFDocument.create(); const ap = d.addPage.bind(d); d.addPage = a => ap(a ? Array.from(a) : a); return d; }, load: b => PDFLib.PDFDocument.load(Uint8Array.from(b)) } });
  w.XLSX = require('xlsx');
  w.Chart = class { constructor(){} destroy(){} };
  if(before) before(w);
  return w;
}
function loadPage(rel, identity, opts = {}){
  const file = R + rel, dir = path.dirname(file);
  let html = fs.readFileSync(file, 'utf8');
  const locals = [...html.matchAll(/<script[^>]*src="([^"]+)"[^>]*><\/script>/g)].map(m => m[1]).filter(s => !/^https?:|^\/\//.test(s) && !SKIP.test(s));
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
  html = html.replace(/<script[\s\S]*?<\/script>/g, '');
  const stats = { reads: 0, rpcs: 0 };
  const w = baseWindow(html, 'https://visutra.in/' + rel + (opts.query || ''), identity, stats, opts.before);
  const code = [read('billing/assets/vt-firebase-compat.js'), read('billing/assets/firebase-config.js'),
    ...locals.map(s => fs.readFileSync(path.resolve(dir, s), 'utf8')), inline, 'window.db=db;window.auth=auth;', opts.hook || ''].join('\n;\n');
  w.eval(code);
  return { w, stats, $: id => w.document.getElementById(id) };
}
// Just the shared engines (adapter + SKU + stock core) for one signed-in user.
function loadCore(identity){
  const w = baseWindow('<!doctype html><body></body>', 'https://visutra.in/', identity, { reads: 0, rpcs: 0 });
  w.eval([read('billing/assets/vt-firebase-compat.js'), read('billing/assets/firebase-config.js'), read('billing/assets/label-sku-extract.js'),
    read('billing/assets/label-stock-core.js'), 'window.db=db;'].join('\n;\n'));
  return w;
}
async function mkPdf(n){ const d = await PDFLib.PDFDocument.create(); for(let i = 0; i < n; i++){ const p = d.addPage([595, 842]); p.drawText('p' + i, { x: 50, y: 700 }); } return d.save(); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
function closeAll(){ while(windows.length){ try{ windows.pop().close(); }catch(e){} } }
const A = { uid: 'aaaaaaaa-0000-0000-0000-000000000001', email: 'seller@visutra.in' };
const B = { uid: 'bbbbbbbb-0000-0000-0000-000000000002', email: 'buyer@shop.in' };
const C = { uid: 'cccccccc-0000-0000-0000-000000000003', email: 'stranger@x.in' };
module.exports = { loadPage, loadCore, mkPdf, sleep, closeAll, R, read, A, B, C };
