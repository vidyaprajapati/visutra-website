// VISUTRA — dynamic product loading
// Fetches live products from the Apps Script API (see assets/config.js).
// If the API isn't configured yet or the request fails, the static
// fallback cards already in the HTML stay visible — the site never breaks.
(function () {
  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var FALLBACK_IMG = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="250"><rect width="100%" height="100%" fill="#E4D8BD"/></svg>'
  );

  function cardHtml(p) {
    var price = p.price ? '<p class="price">\u20B9' + escapeHtml(p.price) + '</p>' : '';
    return (
      '<div class="card">' +
        '<div class="imgwrap"><img src="' + escapeHtml(p.imageUrl || '') + '" alt="' + escapeHtml(p.name) + '" loading="lazy" onerror="this.onerror=null;this.src=\'' + FALLBACK_IMG + '\'"></div>' +
        '<div class="body">' +
          (p.tag ? '<span class="tag">' + escapeHtml(p.tag) + '</span>' : '') +
          '<h3>' + escapeHtml(p.name) + '</h3>' +
          '<p>' + escapeHtml(p.description || '') + '</p>' +
          price +
          '<a class="btn navy" href="contact.html#enquiry">Enquire</a>' +
        '</div>' +
      '</div>'
    );
  }

  // opts: { featuredOnly: bool, limit: number }
  window.VISUTRA_loadProducts = function (containerId, staticId, opts) {
    opts = opts || {};
    var apiUrl = window.VISUTRA_API_URL;
    var container = document.getElementById(containerId);
    var staticEl = staticId ? document.getElementById(staticId) : null;
    if (!container || !apiUrl || apiUrl.indexOf('PASTE_YOUR') === 0) return;

    fetch(apiUrl + '?action=list')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.ok || !data.products || !data.products.length) return;
        var products = data.products;
        if (opts.featuredOnly) {
          var featured = products.filter(function (p) { return p.featured; });
          if (featured.length) products = featured;
        }
        if (opts.limit) products = products.slice(0, opts.limit);
        container.innerHTML = products.map(cardHtml).join('');
        container.hidden = false;
        if (staticEl) staticEl.hidden = true;
      })
      .catch(function (err) {
        console.warn('VISUTRA: live product feed unavailable, showing default catalog.', err);
      });
  };
})();
