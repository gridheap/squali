(() => {
  if (window.weaveFontReady) return;
  const root = document.documentElement;
  const kit = document.currentScript.dataset.kit;
  const started = performance.now();
  window.weaveFontReady = new Promise(resolve => {
    let settled = false, timer, link;
    const finish = state => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (state !== 'active' && link) { link.disabled = true; link.remove(); }
      root.classList.remove('wf-loading', 'wf-active', 'wf-inactive');
      root.classList.add('wf-' + state);
      window.weaveFontTiming = { state, elapsedMs: performance.now() - started };
      resolve(state);
    };
    if (!/^[a-z0-9]{6,16}$/.test(kit || '')) { finish('inactive'); return; }
    root.classList.add('wf-loading');
    link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = `https://use.typekit.net/${kit}.css`; link.dataset.adobeFonts = kit;
    timer = setTimeout(() => finish('inactive'), 2800);
    link.onerror = () => finish('inactive');
    link.onload = () => {
      if (settled) return;
      clearTimeout(timer); timer = setTimeout(() => finish('inactive'), 2800);
      Promise.all([400, 600, 700].map(weight => document.fonts.load(`${weight} 16px "proxima-nova"`, 'Workspace changes')))
        .then(faces => finish(faces.every(f => f.length > 0) ? 'active' : 'inactive'), () => finish('inactive'));
    };
    document.head.append(link);
  });
})();
