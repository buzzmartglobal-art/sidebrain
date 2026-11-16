/* Static-host bridge: the authenticated Library UI is served by the current Sidebrain endpoint.
   The host page discovers its backend asynchronously (sb_base + sb_token land in localStorage after
   the endpoint probe), so poll briefly instead of giving up on first tick. */
(() => {
  let done = false;
  const load = base => {
    if (done || !base || base === location.origin) return;
    done = true;
    const s = document.createElement('script');
    s.src = base.replace(/\/+$/, '') + '/library-ui.js?b=' + Date.now();
    document.head.appendChild(s);
  };
  let tries = 0;
  const tick = () => {
    tries++;
    let base = '', token = '';
    try { base = localStorage.getItem('sb_base') || ''; token = localStorage.getItem('sb_token') || ''; } catch (_) {}
    if (base && token) return load(base);
    if (tries < 45) setTimeout(tick, 1000);
  };
  setTimeout(tick, 600);
})();
