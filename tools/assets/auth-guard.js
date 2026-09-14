// VISUTRA — free tools access guard
// -----------------------------------
// Requires a signed-in, verified, profile-complete account (same login as
// GST Billing) before the tool content is usable. Fails OPEN (lets the tool
// load normally) if Firebase hasn't been configured yet, so the site never
// breaks because of this gate during setup.
(function () {
  var overlay = document.createElement('div');
  overlay.id = 'vtAuthOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:#F7F1E3;z-index:99999;' +
    'display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;' +
    'font-family:system-ui,sans-serif;color:#1F1B16;font-size:15px;text-align:center;padding:20px';
  overlay.innerHTML = '<div>Checking your account&hellip;</div>';
  document.documentElement.appendChild(overlay);

  function goTo(path) {
    window.location.href = path;
  }
  function goToLogin() {
    var here = window.location.pathname + window.location.search;
    goTo('../billing/login.html?redirect=' + encodeURIComponent(here));
  }
  function goToCompleteProfile() {
    var here = window.location.pathname + window.location.search;
    goTo('../billing/complete-profile.html?redirect=' + encodeURIComponent(here));
  }

  function attachTopBar(user) {
    var bar = document.createElement('div');
    bar.id = 'vtUserBar';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9998;background:#1F1B16;' +
      'color:#fff;font-family:system-ui,sans-serif;font-size:12.5px;padding:6px 16px;' +
      'display:flex;justify-content:flex-end;align-items:center';
    bar.innerHTML = '<span id="vtUserMenuMount" style="color:#fff"></span>';
    function attach() {
      document.body.style.marginTop = '40px';
      document.body.prepend(bar);
      mountUserMenu('vtUserMenuMount', user, { showBillingLink: true, basePath: '../billing/' });
    }
    if (document.body) attach();
    else window.addEventListener('DOMContentLoaded', attach);
  }

  // Fail-open: if Firebase isn't set up yet, don't lock the site owner out of their own tools.
  var notConfigured = typeof firebaseConfig === 'undefined' ||
    !firebaseConfig.apiKey || firebaseConfig.apiKey.indexOf('PASTE_YOUR') === 0;
  if (notConfigured || typeof firebase === 'undefined') {
    overlay.remove();
    return;
  }

  firebase.auth().onAuthStateChanged(function (user) {
    var verified = user && (user.emailVerified || user.providerData.some(function (p) { return p.providerId === 'google.com'; }));
    if (!verified) { goToLogin(); return; }

    db.collection('users').doc(user.uid).get().then(function (snap) {
      var complete = snap.exists && snap.data().profileComplete;
      if (!complete) { goToCompleteProfile(); return; }
      overlay.remove();
      attachTopBar(user);
    });
  });
})();
