/* VISUTRA — downloads inside the Android app (#10).
   Every page saves files the browser way: a temporary blob: link that is
   "clicked" (Label Cropper PDFs, jsPDF invoices, SheetJS Excel exports).
   An Android WebView ignores those clicks unless the app handles them, so
   inside the app nothing downloads.

   This script (loaded on every page that saves files) does nothing in a
   normal browser. Inside the VISUTRA app — when the app exposes
   window.AndroidBridge.saveFile(base64, fileName, mimeType) — it catches
   those download clicks, reads the file and hands it to the app, which
   saves it to Downloads. The app-side code is in ANDROID-DOWNLOADS.md.

   Inside an older app build WITHOUT the bridge, it shows a one-line notice
   instead of failing silently. */
(function(){
  const inWebView = /; wv\)/.test(navigator.userAgent) || /\bVISUTRA-App\b/i.test(navigator.userAgent);
  const hasBridge = () => !!(window.AndroidBridge && typeof window.AndroidBridge.saveFile === 'function');
  if(!inWebView && !hasBridge()) return; // normal browser — change nothing

  function toast(msg){
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);max-width:92vw;background:#1A1A1A;color:#fff;padding:10px 16px;border-radius:10px;font:14px/1.4 system-ui,sans-serif;z-index:99999;box-shadow:0 4px 18px rgba(0,0,0,.25)';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }
  function blobToBase64(blob){
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }
  async function handOver(href, fileName){
    const blob = await (await fetch(href)).blob();
    const b64 = await blobToBase64(blob);
    window.AndroidBridge.saveFile(b64, fileName || 'download', blob.type || 'application/octet-stream');
  }

  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function(){
    const href = this.getAttribute('href') || this.href || '';
    const isDownload = this.hasAttribute('download') && /^(blob:|data:)/.test(href);
    if(!isDownload) return origClick.apply(this, arguments);
    if(hasBridge()){
      handOver(href, this.getAttribute('download')).catch(err => {
        console.error('App download failed:', err);
        toast('Could not save the file in the app — try again, or open visutra.in in Chrome.');
      });
      return;
    }
    // Old app build without the bridge: try anyway, and tell the user why
    // nothing may appear.
    origClick.apply(this, arguments);
    toast('If the file didn’t download, update the VISUTRA app — or open visutra.in in Chrome.');
  };
})();
