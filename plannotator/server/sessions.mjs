import fs from 'node:fs';
import path from 'node:path';

function checkProcess(pid, started) {
  if (!Number.isInteger(pid) || pid <= 0) throw Error('Invalid review process');
  process.kill(pid, 0);
  if (started) {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (['Z', 'X'].includes(fields[0]) || fields[19] !== String(started)) throw Error('Review process ended');
  }
}

export function createSessionStore(state) {
  function read(id) {
    const route = path.join(state, id, 'route.json');
    const session = JSON.parse(fs.readFileSync(route, 'utf8'));
    let saved;
    if (session.record) {
      if (typeof session.record !== 'string' || path.basename(session.record) !== id) throw Error('Invalid review record');
      saved = JSON.parse(fs.readFileSync(path.join(session.record, 'session.json'), 'utf8'));
      if (saved.id !== id || !['running', 'starting', 'suspended'].includes(saved.status)) throw Error('Review ended');
    }
    const createdAt = Number.isFinite(saved?.created_at) && saved.created_at > 0
      ? saved.created_at * 1000 : fs.statSync(route).mtimeMs;
    if (session.status === 'suspended' && saved?.status === 'suspended') return {...session, createdAt};
    if (saved?.status === 'suspended' || !Number.isInteger(session.port) || session.port < 1 || session.port > 65535) throw Error('Invalid review');
    if (saved?.review_pid && saved.review_pid !== session.pid) throw Error('Review process changed');
    checkProcess(session.pid, saved?.review_start);
    if (saved?.supervisor_start) checkProcess(saved.supervisor_pid, saved.supervisor_start);
    return {...session, status: 'running', createdAt,
      closing: !!session.record && fs.existsSync(path.join(session.record, 'cancel')),
      suspendError: saved?.suspend_error};
  }

  function list() {
    const reviews = [];
    for (const id of fs.readdirSync(state)) {
      if (!/^[a-f0-9]{32}$/.test(id)) continue;
      try {
        const session = read(id);
        reviews.push({id, title: typeof session.title === 'string' ? session.title.slice(0, 120) : `Review ${id.slice(0, 8)}`, path: `/reviews/launcher/open/${id}`,
          createdAt: session.createdAt, status: session.status, closing: !!session.closing,
          ...(session.record ? {resumable: true, suspendError: session.suspendError,
            owner: session.owner ? {provider: session.owner.provider, pane: session.owner.pane_id} : null} : {})});
      } catch { /* Ended reviews and incomplete launches are not running sessions. */ }
    }
    reviews.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    return reviews;
  }
  return {read, list};
}
