const list = document.querySelector('#reviews');
const message = document.querySelector('#message');
const empty = document.querySelector('#empty');
const count = document.querySelector('#count');
const refresh = document.querySelector('#refresh');
let loading = false;
let lastList = '';
const pendingActions = new Set();
async function action(review, kind, button) {
  pendingActions.add(review.id);
  button.disabled = true;
  if (kind === 'save-close') button.textContent = 'Saving…';
  try {
    const response = await fetch(`/reviews/launcher/${kind}/${review.id}`, {method: 'POST', headers: {'X-Review-Action': '1'}});
    const result = await response.json().catch(() => ({error: response.status === 410 ? 'This review has already closed. Refresh the list.' : 'Review action failed'}));
    if (!response.ok) throw Error(result.error || 'Review action failed');
    if (kind === 'prepare') {
      message.textContent = result.prepared ? `Prompt prepared in ${result.pane_id}. Press Enter there when ready.` : result.reason;
    } else if (kind === 'resume' && result.status === 'running') {
      location.href = review.path;
    } else if (kind === 'save-close') {
      message.textContent = result.reason || (result.status === 'suspended' ? 'Review saved and closed. Use Resume review to continue.' : 'Review has closed.');
    } else {
      message.textContent = result.error || 'Saving review before stopping. Refresh to check its status.';
    }
    lastList = '';
  } catch (error) {
    message.textContent = error.message;
  } finally {
    pendingActions.delete(review.id);
    lastList = '';
    await update();
  }
}
async function update() {
  if (loading || document.hidden) return;
  loading = true;
  refresh.disabled = true;
  try {
    const response = await fetch('/reviews/launcher/reviews', {cache: 'no-store'});
    if (!response.ok) {
      list.replaceChildren();
      lastList = '';
      count.textContent = '';
      empty.hidden = true;
      message.textContent = 'Unable to load reviews. Try refreshing.';
      return;
    }
    const {reviews} = await response.json();
    if (['Loading reviews…', 'Unable to load reviews. Try refreshing.', 'Connection lost. Reconnect SSH, then refresh.'].includes(message.textContent)) message.textContent = '';
    count.textContent = String(reviews.length);
    empty.hidden = reviews.length > 0;
    const next = JSON.stringify(reviews);
    if (next === lastList) return;
    lastList = next;
    list.replaceChildren();
    for (const review of reviews) {
      const row = document.createElement('li');
      const link = document.createElement('a');
      link.href = review.path;
      link.setAttribute('aria-label', `Open ${review.title}`);
      const details = document.createElement('span');
      details.className = 'review-details';
      const title = document.createElement('strong');
      title.textContent = review.title;
      const id = document.createElement('small');
      id.textContent = [review.id.slice(0, 8), review.status === 'suspended' ? 'Saved · offline' : review.closing ? 'Closing…' : 'Running',
        new Date(review.createdAt).toLocaleString(),
        review.owner && `${review.owner.provider} · ${review.owner.pane}`].filter(Boolean).join(' · ');
      details.append(title, id);
      if (review.suspendError) {
        const warning = document.createElement('small');
        warning.textContent = review.suspendError;
        details.append(warning);
      }
      const openLabel = document.createElement('span');
      openLabel.className = 'open-label';
      openLabel.textContent = 'Open ↗';
      link.append(details, openLabel);
      row.append(link);
      if (review.resumable) {
        const controls = document.createElement('div');
        controls.className = 'review-actions';
        const button = document.createElement('button');
        const kind = review.status === 'suspended' ? 'resume' : 'save-close';
        button.textContent = pendingActions.has(review.id) ? 'Working…' : review.closing ? 'Closing…' : kind === 'resume' ? 'Resume review' : 'Close and save';
        button.addEventListener('click', () => action(review, kind, button));
        button.disabled = !!review.closing || pendingActions.has(review.id);
        if (kind === 'save-close') button.title = 'Save and stop. If resuming is unsupported, keep saved files and close.';
        controls.append(button);
        if (review.status === 'suspended') {
          const prompt = document.createElement('details');
          const summary = document.createElement('summary');
          summary.textContent = 'Resume through an agent';
          const text = document.createElement('textarea');
          text.readOnly = true;
          text.setAttribute('aria-label', 'Resume prompt to copy');
          text.value = `Resume saved Plannotator review ${review.id} with plannotator-mobile --resume ${review.id}. Preserve its saved diff, comments and discussions, and share the returned review links. Do not create a replacement review or refresh its diff unless I request it.`;
          text.addEventListener('click', () => text.select());
          prompt.append(summary, text);
          if (review.owner) {
            const prepare = document.createElement('button');
            prepare.textContent = 'Prepare prompt in original pane';
            prepare.addEventListener('click', () => action(review, 'prepare', prepare));
            const hint = document.createElement('small');
            hint.textContent = 'Use an empty agent input. This pastes text without sending Enter.';
            prompt.append(hint, prepare);
          }
          controls.append(prompt);
        }
        row.append(controls);
      }
      list.append(row);
    }
  } catch {
    message.textContent = 'Connection lost. Reconnect SSH, then refresh.';
  } finally {
    loading = false;
    refresh.disabled = false;
  }
}
refresh.addEventListener('click', update);
window.addEventListener('pageshow', update);
document.addEventListener('visibilitychange', update);
setInterval(update, 5000);
update();
