import fs from 'node:fs/promises';
import path from 'node:path';

// Only called with each test's own temporary record directory, never user state.
export async function stopTestReviews(directory) {
  const ids = await fs.readdir(directory).catch(() => []);
  const records = ids.filter(id => /^[a-f0-9]{32}$/.test(id)).map(id => path.join(directory, id));
  for (const record of records) await fs.writeFile(path.join(record, 'cancel'), '', {mode: 0o600});
  const deadline = Date.now() + 15000;
  while (true) {
    const done = await Promise.all(records.map(async record => {
      const event = await fs.readFile(path.join(record, 'notification.json'), 'utf8').catch(() => '{}');
      return Boolean(JSON.parse(event).delivery);
    }));
    if (done.every(Boolean)) return;
    if (Date.now() > deadline) throw Error('Disposable review did not finish cleanup');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
