const userAgent = navigator.userAgent;
document.querySelector('#browser').textContent = /Firefox|FxiOS/.test(userAgent) ? 'Firefox' : /Edg/.test(userAgent) ? 'Edge' : /Chrome|CriOS/.test(userAgent) ? 'Chrome / Chromium' : /Safari/.test(userAgent) ? 'Safari' : 'Your browser';
document.querySelector('#address').textContent = location.host + location.pathname;
let taps = 0;
document.querySelector('#tap').addEventListener('click', () => {
  taps += 1;
  document.querySelector('#result').textContent = `Tap received! ${taps} ${taps === 1 ? 'tap' : 'taps'} so far.`;
});
