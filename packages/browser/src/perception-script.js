// Evaluated verbatim by both browser drivers. No imports or transpiler helpers.
(opts) => {
  const norm = value => String(value || '').replace(/\s+/g, ' ').trim();
  const state = window.__tabductorPerception ||= { ids: new WeakMap(), next: 0,
    documentId: Math.random().toString(36).slice(2) };
  const identify = el => {
    if (!state.ids.has(el)) state.ids.set(el, `${state.documentId}-${++state.next}`);
    const id = state.ids.get(el);
    el.setAttribute('data-tabductor-node', id);
    return `[data-tabductor-node="${id}"]`;
  };
  const parentOf = el => el.parentElement || el.getRootNode()?.host || null;
  const visible = el => {
    // Native select options have no layout box until the picker opens. They are still
    // available choices, and their values must be observable before page.select.
    const rendered = el.tagName === 'OPTION' ? el.closest('select') : el;
    if (!rendered?.getClientRects().length) return false;
    for (let node = el; node; node = parentOf(node)) {
      const s = getComputedStyle(node);
      if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse' || node.hidden || node.inert || node.getAttribute('aria-hidden') === 'true') return false;
    }
    return true;
  };
  const roleOf = el => el.getAttribute('role') || ({ A: el.hasAttribute('href') ? 'link' : null,
    BUTTON: 'button', TEXTAREA: 'textbox', SELECT: 'combobox', OPTION: 'option', ARTICLE: 'article', MAIN: 'main',
    NAV: 'navigation', TABLE: 'table', TR: 'row', TD: 'cell', TH: 'columnheader', UL: 'list', OL: 'list', LI: 'listitem',
    H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
    INPUT: ({ checkbox:'checkbox', radio:'radio', submit:'button', button:'button', range:'slider', number:'spinbutton' })[el.type] || 'textbox'
  })[el.tagName] || (el.isContentEditable ? 'textbox' : null);
  const nameOf = el => {
    const root = el.getRootNode();
    const labelled = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      .map(id => root.getElementById?.(id)?.textContent || '').join(' ');
    return norm(labelled || el.getAttribute('aria-label') ||
      (el.labels ? [...el.labels].map(label => label.textContent).join(' ') : '') ||
      el.getAttribute('alt') || el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || el.getAttribute('data-content-editable-placeholder') ||
      (['button','submit','reset'].includes(el.type) ? el.value : '') || el.textContent).slice(0, 160) || null;
  };
  const all = [];
  let scanTruncated = false;
  const walk = root => {
    for (const el of root.children || []) {
      if (all.length >= 50000) { scanTruncated = true; return; }
      all.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
      walk(el);
    }
  };
  walk(document);
  const scoped = opts.selector ? all.filter(el => {
    try { return el.matches(opts.selector); } catch { return false; }
  }) : [document.body];
  if (opts.selector && scoped.length !== 1) throw new Error('inspection root is missing or ambiguous; perceive again');
  const scope = scoped[0];
  const inside = el => {
    if (!opts.selector) return true;
    for (let node = el; node; node = parentOf(node)) if (node === scope) return true;
    return false;
  };
  const salient = 'a[href],button,input,textarea,select,option,[role],[data-testid],[contenteditable="true"],h1,h2,h3,h4,h5,h6,article,main,nav,table,ul,ol,li';
  const meaningful = el => el.matches(salient) || (opts.inspect && [...el.childNodes].some(n => n.nodeType === 3 && norm(n.textContent)));
  const nodes = all.filter(el => inside(el) && visible(el) && (opts.structuralDetail || (opts.selector && el === scope) || meaningful(el)));
  const anchors = new Map(nodes.map((el, index) => [el, `e${index + 1}`]));
  const matches = nodes.filter(el => (!opts.role || roleOf(el) === opts.role) &&
    (!opts.query || norm(`${nameOf(el) || ''} ${el.textContent || ''}`).toLowerCase().includes(opts.query.toLowerCase())));
  // Rank before paging. Focused portal editors must not sit behind a large sidebar.
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  const within = (el, selector) => { for (let n = el; n; n = parentOf(n)) if (n.matches(selector)) return true; return false; };
  const overlays = '[role="dialog"],[role="menu"],[role="listbox"],[aria-modal="true"]';
  const rank = el => {
    const r = (el.tagName === 'OPTION' ? el.closest('select') : el).getBoundingClientRect();
    const viewport = r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    return (el === active ? 100 : 0) + (within(el, overlays) ? 60 : 0) +
      (viewport ? 20 : 0) + (el.isContentEditable || el.matches('input,textarea') ? 10 : 0) +
      (within(el, 'main,[role="main"],[role="grid"],table') ? 5 : 0);
  };
  if (!opts.structuralDetail) { const ranks = new Map(matches.map(el => [el, rank(el)])); matches.sort((a, b) => ranks.get(b) - ranks.get(a)); }
  const offset = Math.max(0, opts.elementOffset || 0);
  const limit = Math.min(300, Math.max(1, opts.elementLimit || 300));
  const path = el => {
    const parts = [];
    for (let node = el; node && node.tagName !== 'HTML'; node = parentOf(node)) {
      let part = node.tagName.toLowerCase();
      const siblings = [...(node.parentNode?.children || [])].filter(s => s.tagName === node.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      parts.unshift(part);
    }
    return parts.join(' > ');
  };
  const elements = matches.slice(offset, offset + limit).map(el => {
    const tag = el.tagName.toLowerCase();
    const text = norm(el.textContent).slice(0, 200) || null;
    const testId = el.getAttribute('data-testid');
    let locator = path(el), strategy = 'css-path';
    if (testId) {
      const base = `[data-testid=${JSON.stringify(testId)}]`;
      const peers = all.filter(n => n.getAttribute('data-testid') === testId);
      locator = peers.length === 1 ? base : `:nth-match(${base}, ${peers.indexOf(el) + 1})`;
      strategy = 'testid';
    } else if (['aria-label','alt','placeholder'].some(attr => el.getAttribute(attr))) {
      const attr = ['aria-label','alt','placeholder'].find(attr => el.getAttribute(attr));
      const base = `[${attr}=${JSON.stringify(el.getAttribute(attr))}]`;
      const peers = all.filter(n => n.getAttribute(attr) === el.getAttribute(attr));
      locator = peers.length === 1 ? base : `:nth-match(${base}, ${peers.indexOf(el) + 1})`; strategy = 'role';
    } else if (['main','article','navigation','region','grid','table','list','tablist'].includes(roleOf(el))) {
      const explicit = el.getAttribute('role');
      const base = explicit ? `${tag}[role=${JSON.stringify(explicit)}]` : tag;
      const peers = all.filter(n => n.tagName === el.tagName && (!explicit || n.getAttribute('role') === explicit));
      locator = peers.length === 1 ? base : `:nth-match(${base}, ${peers.indexOf(el) + 1})`; strategy = 'role';
    } else if (text && text.length < 160 && !['main','article','navigation','table','list','region'].includes(roleOf(el))) {
      const base = `${tag}:text-is(${JSON.stringify(text)})`;
      const peers = all.filter(n => n.tagName === el.tagName && norm(n.textContent) === text);
      locator = peers.length === 1 ? base : `:nth-match(${base}, ${peers.indexOf(el) + 1})`; strategy = 'text';
    }
    let parent = parentOf(el);
    while (parent && !anchors.has(parent)) parent = parentOf(parent);
    const rect = el.getBoundingClientRect();
    const bool = name => el.hasAttribute(name) ? el.getAttribute(name) === 'true' : null;
    const classes = [...el.classList].slice(0, 3).map(c => `.${CSS.escape(c)}`).join('');
    return { anchor: anchors.get(el), frameOrigin: location.origin, frameId: "main", tag, role: roleOf(el), name: nameOf(el), text, strategy, locator,
      controlLabel: norm(el.getAttribute('aria-label') || (el.labels ? [...el.labels].map(label => label.textContent).join(' ') : '') || el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || el.getAttribute('data-content-editable-placeholder')).slice(0, 120) || null,
      actionLocator: identify(el), parentAnchor: parent ? anchors.get(parent) : null,
      selectorHint: testId ? `[data-testid=${JSON.stringify(testId)}]` : el.id ? `#${CSS.escape(el.id)}` : tag + classes,
      href: el.tagName === 'A' ? el.href : null, inputType: el.tagName === 'INPUT' ? el.type : null,
      value: ['INPUT','TEXTAREA','SELECT','OPTION'].includes(el.tagName) && el.type !== 'password' ? String(el.value).slice(0, 200) : el.isContentEditable ? norm(el.innerText).slice(0, 200) : null,
      disabled: el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true',
      checked: ['checkbox','radio'].includes(el.type) ? el.checked : bool('aria-checked'),
      selected: el.tagName === 'OPTION' ? el.selected : bool('aria-selected'), expanded: bool('aria-expanded'),
      focused: el.getRootNode().activeElement === el,
      inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
      bounds: {x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height)} };
  });
  const shadowText = all.filter(el => inside(el) && el.shadowRoot && visible(el)).map(el => el.shadowRoot.textContent || '').join(' ');
  const full = norm((scope?.innerText || '') + ' ' + shadowText);
  const textOffset = Math.max(0, opts.textOffset || 0), maxChars = Math.min(20000, Math.max(1, opts.maxChars || 8000));
  const committedParts = [];
  const readCommitted = root => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (parent && visible(parent) && !parent.closest('input,textarea,select,script,style')) {
        const editor = parent.closest('[contenteditable="true"],[role="textbox"]');
        // Persistent rich-text blocks stay contenteditable even after a committed readback.
        // Only the active editor is draft evidence; ordinary text controls remain excluded.
        if (!editor || !editor.contains(active)) committedParts.push(node.textContent);
      }
    }
  };
  if (scope) readCommitted(scope);
  for (const el of all) if (inside(el) && el.shadowRoot && visible(el)) readCommitted(el.shadowRoot);
  const committedText = norm(committedParts.join(' ')).slice(0, 20000);
  const activeEditor = !!active && (active.isContentEditable || active.matches('textarea,[role="textbox"],input:not([type="button"]):not([type="submit"]):not([type="checkbox"])'));
  // Compute across the frame, not the requested page/query: paging is not UI progress.
  const openOverlays = all.filter(el => visible(el) && el.matches(overlays));
  const focusedOverlay = openOverlays.findLast(el => el.contains(active));
  const overlay = focusedOverlay || openOverlays.at(-1);
  const activeScope = overlay ? (['menu','listbox'].includes(roleOf(overlay)) ? roleOf(overlay) : 'dialog') : activeEditor ? 'editor' : 'page';
  const relevant = all.filter(el => visible(el) && el.matches(salient) && (overlay ? overlay.contains(el) : activeEditor ? el === active : !within(el, 'nav,[role="navigation"]')));
  const uiState = JSON.stringify([location.href, activeScope, relevant.map(el => [roleOf(el), nameOf(el),
    el.type === 'password' ? null : ('value' in el ? el.value : null), el === active, el.getAttribute('aria-busy'),
    el.getAttribute('aria-expanded'), el.getAttribute('aria-selected'), el.getAttribute('aria-checked'), el.disabled])]);
  let hash = 2166136261;
  for (let i = 0; i < uiState.length; i++) hash = Math.imul(hash ^ uiState.charCodeAt(i), 16777619);
  const uiFingerprint = (hash >>> 0).toString(16);
  const focusIdentity = active && active !== document.body ? identify(active) : '';
  return {committedText, activeEditor, activeScope, uiFingerprint, focusIdentity, url: location.href, title: document.title, scopeAnchor: opts.selector ? anchors.get(scope) : undefined, elements, text: full.slice(textOffset, textOffset + maxChars),
    coverage: {elementOffset: offset, totalElements: matches.length, nextElementOffset: offset + limit < matches.length ? offset + limit : null,
      textOffset, totalTextChars: full.length, nextTextOffset: textOffset + maxChars < full.length ? textOffset + maxChars : null, scanTruncated}};
}
