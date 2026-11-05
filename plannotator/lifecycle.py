"""Suspend owned reviews only after the application saves a resumable checkpoint."""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request
import urllib.error
from urllib.parse import urlsplit

IDLE_SECONDS = 3 * 24 * 60 * 60
PARENT_ENV = ('CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID', 'OPENCODE_SESSION_ID',
              'PLANNOTATOR_SESSION_TAG', 'PLANNOTATOR_DISCUSSION_PROVIDER',
              'PLANNOTATOR_DISCUSSION_SESSION_ID', 'HERDR_ENV', 'HERDR_PANE_ID',
              'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_SOCKET_PATH')


def last_activity(path, record):
    try:
        value = json.loads((path / 'activity.json').read_text())['last_activity_at']
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
            return max(record.get('resumed_at', record['created_at']), value)
    except (OSError, ValueError, KeyError):
        pass
    return record.get('resumed_at', record['created_at'])


def is_idle(path, record, now):
    return now - last_activity(path, record) >= IDLE_SECONDS


def checkpoint(path, record, token, automatic=False):
    url = urlsplit(record['direct_url'])
    request = urllib.request.Request(f'http://127.0.0.1:{url.port}/api/host/suspend',
        data=json.dumps({'lastActivityAt': last_activity(path, record)} if automatic else {}).encode(),
        headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            saved = json.load(response)
    except urllib.error.HTTPError as error:
        try: reason = json.loads(error.read(8192)).get('error', f'HTTP {error.code}')
        except (ValueError, AttributeError): reason = f'HTTP {error.code}'
        raise RuntimeError(reason) from error
    if saved.get('saved') is not True or not (path / 'checkpoint.json').is_file():
        raise RuntimeError('Application did not confirm a saved review checkpoint')


def request_suspend(path):
    import durable
    record = durable.status(path)
    if record['status'] == 'suspended':
        return record
    if record['status'] != 'running':
        raise RuntimeError('Only a running review can be suspended')
    launch = json.loads((path / 'launch.json').read_text())
    if not launch.get('lifecycle'):
        raise RuntimeError('This review predates resumable reviews; it remains running with its drafts intact')
    (path / 'suspend').touch(mode=0o600)
    return {**record, 'suspend_requested': True}


def request_close(path):
    import durable
    record = durable.status(path)
    if record['status'] == 'suspended':
        raise RuntimeError('This review is already offline; its saved checkpoint has been retained')
    if record['status'] not in durable.TERMINAL:
        (path / 'cancel').touch(mode=0o600)
    return {**record, 'cancel_requested': True}


def save_and_close(path):
    """Explicit home-page close may retain disk files without a resumable checkpoint."""
    import durable
    with (path / 'lifecycle.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another review action is in progress; refresh before retrying')
        record = durable.status(path)
        if record['status'] in durable.STOPPED:
            return record
        launch = json.loads((path / 'launch.json').read_text())
        if launch.get('lifecycle'):
            request_suspend(path)
            deadline = time.monotonic() + 65
            while time.monotonic() < deadline:
                pending = (path / 'suspend').exists()
                record = durable.status(path)
                if record['status'] in durable.STOPPED:
                    return record
                if not pending and record.get('suspend_error'):
                    reason = record['suspend_error'].removeprefix('Could not safely suspend; review remains running: ')
                    # Old supervisors report strings; never turn transient save failures into cancellation.
                    if reason not in {
                        'Reviews with agent jobs cannot be suspended yet',
                        'Reviews with Ask AI sessions cannot be suspended yet',
                        'Reviews with external annotations cannot be suspended yet',
                        'Wait for the discussion answer before suspending',
                        'Suspension currently supports local Git text reviews only',
                        'Binary reviews cannot be suspended yet',
                        'Review checkpoint exceeds 64 MiB; keep the review running',
                        'Refresh the changed diff before suspending',
                        'Durable review lifecycle is disabled',
                    }:
                        raise RuntimeError(record['suspend_error'])
                    break
                time.sleep(.1)
            else:
                raise RuntimeError('Saving is still pending; refresh before retrying. Review was not cancelled.')
        return {**request_close(path), 'reason': 'Closing review; saved files are retained on disk. Start a new review to continue.'}


def resume(path):
    import durable
    with (path / 'lifecycle.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        record = durable.status(path)
        if record['status'] == 'running':
            return record
        if record['status'] != 'suspended':
            raise RuntimeError('Only a suspended review can be resumed')
        if not (path / 'checkpoint.json').is_file():
            raise RuntimeError('Saved review checkpoint is missing; no review was started')
        if not Path(record['cwd']).is_dir():
            raise RuntimeError('Original checkout is missing; restore it before resuming this review')
        for name in ('ready.json', 'cancel', 'suspend'):
            (path / name).unlink(missing_ok=True)
        record.update(status='starting', resumed_at=time.time())
        record.pop('supervisor_start', None)
        record.pop('supervisor_pid', None)
        record.pop('error', None)
        record.pop('suspend_error', None)
        record.pop('prompt_preparation', None)
        durable.atomic(path / 'session.json', record)
        try:
            return durable.start_supervisor(path)
        except Exception:
            current = durable.status(path)
            if current['status'] == 'starting' and not (current.get('supervisor_start') and durable.identity(current.get('supervisor_pid')) == current['supervisor_start']):
                record['status'] = 'suspended'
                durable.atomic(path / 'session.json', record)
            raise


def resume_prompt(sid):
    return (f'Resume saved Plannotator review {sid} with plannotator-mobile --resume {sid}. '
            'Preserve its saved diff, comments and discussions, and share the returned review links. '
            'Do not create a replacement review or refresh its diff unless I request it.')


def prepare_prompt(path):
    """Paste only into the verified idle owner; never send Enter or clear input."""
    import durable
    record = durable.status(path)
    if record['status'] != 'suspended':
        raise RuntimeError('Review is not suspended')
    prompt = resume_prompt(record['id'])
    launch = json.loads((path / 'launch.json').read_text())
    target = launch.get('agent_target')
    result = {'prompt': prompt, 'prepared': False}
    if not target:
        return {**result, 'reason': 'No verified launching agent was recorded; copy this prompt to your agent'}
    env = {k: v for k, v in os.environ.items() if k not in PARENT_ENV}
    env.update(launch.get('parent_env', {}))
    try:
        current = durable.agent_target(env, notifications=False, ready_only=True)
        # A process restarted in this pane may be the same explicitly resumed conversation.
        fields = ('pane_id', 'terminal_id', 'provider', 'session_id')
        if not current or any(current[k] != target[k] for k in fields):
            return {**result, 'reason': 'The original agent is unavailable or not ready; copy this prompt instead'}
        subprocess.run(['herdr', 'pane', 'send-text', current['pane_id'], prompt], env=env,
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       timeout=5, check=True)
        return {**result, 'prepared': True, 'pane_id': current['pane_id']}
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        return {**result, 'reason': 'Paste was not confirmed. Check the pane before trying again.'}


if __name__ == '__main__':
    import sys
    import durable
    os.umask(0o077)
    try:
        action, directory = sys.argv[1:]
        path = Path(directory)
        os.environ['PLANNOTATOR_REVIEW_STATE_DIR'] = str(path.parent)
        path = durable.directory(path.name)
        if action == 'suspend':
            value = request_suspend(path)
        elif action == 'save-close':
            value = save_and_close(path)
        elif action == 'close':
            value = request_close(path)
        elif action == 'resume':
            value = resume(path)
        elif action == 'prepare':
            value = prepare_prompt(path)
        else:
            raise RuntimeError('Unknown review action')
        print(json.dumps({k: value[k] for k in ('status', 'cancel_requested', 'suspend_requested', 'prompt', 'prepared', 'reason', 'pane_id', 'error') if k in value}))
    except Exception as error:
        print(json.dumps({'error': str(error)}))
        sys.exit(1)
