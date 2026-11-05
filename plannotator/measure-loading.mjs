import fs from 'node:fs/promises';

// Called by the disposable review harness; never points at a user's review.
export async function measureLoading(browser, sessions, origin, launcherToken, baselineOrigin) {
  const results = [];
  for (const [version, target] of [...(baselineOrigin ? [['baseline', baselineOrigin]] : []), ['optimized', origin]]) {
    const context = await browser.newContext({viewport: {width: 393, height: 851}, isMobile: true, hasTouch: true});
    try {
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false, latency: 100, downloadThroughput: 15e6 / 8, uploadThroughput: 5e6 / 8,
      });
      await cdp.send('Emulation.setCPUThrottlingRate', {rate: 4});
      await cdp.send('Performance.enable');
      await page.addInitScript(() => {
        window.loadLongTasks = [];
        new PerformanceObserver(list => window.loadLongTasks.push(...list.getEntries().map(e => e.duration)))
          .observe({type: 'longtask', buffered: true});
      });
      for (const [index, session] of sessions.entries()) {
        if (index > 0) {
          await page.goto(`${target}/?unlock=${launcherToken}`);
          await page.getByRole('link', {name: `Open ${session.title}`, exact: true}).waitFor();
        }
        const before = (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'ScriptDuration').value;
        const started = performance.now();
        if (index === 0) await page.goto(session.url.replace(origin, target));
        else await page.getByRole('link', {name: `Open ${session.title}`, exact: true}).click();
        await page.getByText('demo.js', {exact: false}).first().waitFor({timeout: 45000});
        const visibleMs = performance.now() - started;
        const after = (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'ScriptDuration').value;
        const data = await page.evaluate(() => {
          const navigation = performance.getEntriesByType('navigation')[0];
          const resources = performance.getEntriesByType('resource');
          const bundles = resources.filter(r => new URL(r.name).pathname.startsWith('/ui/'));
          return {
            ttfbMs: navigation.responseStart,
            documentCompleteMs: navigation.responseEnd,
            domReadyMs: navigation.domContentLoadedEventEnd,
            firstContentfulPaintMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
            transferBytes: navigation.transferSize + resources.reduce((sum, r) => sum + r.transferSize, 0),
            documentBytes: navigation.decodedBodySize,
            bundleTransferBytes: bundles.reduce((sum, r) => sum + r.transferSize, 0),
            longTaskMs: window.loadLongTasks.reduce((sum, duration) => sum + duration, 0),
          };
        });
        const result = {version, entry: index === 0 ? 'cold-agent-link' : 'warm-launcher', visibleMs, scriptMs: (after - before) * 1000, ...data};
        results.push(result);
        console.log('LOAD MEASUREMENT', JSON.stringify(result));
      }
    } finally { await context.close(); }
  }
  await fs.mkdir(new URL('./test-artifacts/', import.meta.url), {recursive: true});
  await fs.writeFile(new URL('./test-artifacts/loading-performance.json', import.meta.url), JSON.stringify({
    measuredAt: new Date().toISOString(),
    conditions: 'Headless Chromium, 393x851 viewport, 15 Mbps down / 5 Mbps up, 100 ms latency, 4x CPU slowdown; not a physical phone',
    results,
  }, null, 2) + '\n');
}
