(() => {
  const prefix = __REVIEW_PREFIX__;
  function route(value) {
    const url = new URL(String(value), document.baseURI);
    if (url.origin === location.origin && /^\/ui\/[a-f0-9]{64}\.(js|css)$/.test(url.pathname)) return url.href;
    if (['http:', 'https:'].includes(url.protocol) && url.origin === location.origin && !url.pathname.startsWith(prefix)) {
      // A review must never silently fall through to another review's route.
      if (url.pathname.startsWith('/reviews/')) throw new Error('Cross-review URL');
      url.pathname = prefix.slice(0, -1) + url.pathname;
    }
    return url.href;
  }
  const fetchOriginal = window.fetch;
  const snapshotReads = new Map();
  window.fetch = function(input, init) {
    const target = input instanceof Request ? new Request(route(input.url), input) : route(input);
    // The proxy forces snapshot polling; slow transfers must not accumulate duplicate reads.
    if (typeof input !== 'string' || init !== undefined ||
        ![prefix + 'api/external-annotations', prefix + 'api/agents/jobs'].includes(new URL(target).pathname)) {
      return fetchOriginal.call(this, target, init);
    }
    let pending = snapshotReads.get(target);
    if (!pending) {
      pending = fetchOriginal.call(this, target).then(async response => {
        await response.clone().arrayBuffer();
        return response;
      }).finally(() => snapshotReads.delete(target));
      snapshotReads.set(target, pending);
    }
    return pending.then(response => response.clone());
  };
  for (const name of ['EventSource', 'WebSocket', 'Worker', 'SharedWorker']) {
    if (!window[name]) continue;
    const Original = window[name];
    window[name] = class extends Original { constructor(url, options) { super(route(url), options); } };
  }
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) { return open.call(this, method, route(url), ...rest); };
  const beacon = navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon = (url, data) => beacon(route(url), data);
  // React sets resource URLs through properties or setAttribute; returned API URLs also need the prefix.
  for (const [type, attr] of [[HTMLImageElement, 'src'], [HTMLScriptElement, 'src'], [HTMLLinkElement, 'href'], [HTMLIFrameElement, 'src'], [HTMLAnchorElement, 'href'], [HTMLSourceElement, 'src'], [HTMLMediaElement, 'src']]) {
    const descriptor = Object.getOwnPropertyDescriptor(type.prototype, attr);
    if (descriptor?.set) Object.defineProperty(type.prototype, attr, {...descriptor, set(value) { descriptor.set.call(this, route(value)); }});
  }
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    if (['src', 'href', 'action', 'poster'].includes(name.toLowerCase()) && typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')) value = route(value);
    return setAttribute.call(this, name, value);
  };
})();
