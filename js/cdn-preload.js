(() => {
  const p = new URLSearchParams(location.search);
  if (window.__PEGGLE_GENERATED_PLAYER__ || location.hash || p.has('campaign') || p.has('level') || p.has('levels') || /^\/\d{4}\/?$/.test(location.pathname)) return;
  window.__PEGGLE_PRIMARY_CAMPAIGN_PRELOAD__ = fetch(new URL('cdn-data/primary.initial.json', document.baseURI), {mode:'cors'})
    .then(r => r.ok ? r.json() : null).catch(() => null);
})();
