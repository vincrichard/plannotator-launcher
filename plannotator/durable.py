"""Own review processes independently of CLI callers; retain feedback and completion events."""
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit
import lifecycle

TERMINAL = {'completed', 'failed', 'cancelled', 'interrupted'}
STOPPED = TERMINAL | {'suspended'}


def atomic(path, value):
    temp = path.with_suffix('.tmp')
    with temp.open('w') as out:
        json.dump(value, out); out.write('\n'); out.flush(); os.fsync(out.fileno())
    temp.replace(path)


def store():
    from mobile import private_dir
    path = Path(os.environ.get('PLANNOTATOR_REVIEW_STATE_DIR', str(Path.home() / '.local/state/plannotator-reviews')))
    private_dir(path)
    return path


def directory(sid):
    if not re.fullmatch('[a-f0-9]{32}', sid):
        raise RuntimeError('Invalid review ID')
    path = store() / sid
    if not path.is_dir():
        raise RuntimeError('Unknown review ID')
    return path


def identity(pid):
    try:
        return Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
    except (OSError, IndexError):
        return None


def status(path):
    record = json.loads((path / 'session.json').read_text())
    if record['status'] not in STOPPED and record.get('supervisor_start') and identity(record['supervisor_pid']) != record['supervisor_start']:
        return {**record, 'status': 'interrupted', 'error': 'Review supervisor stopped unexpectedly; retained files have not been deleted.'}
    return record


def launch(args, title, route_state, port, notify_command=None, generate_guide=False):
    from mobile import private_dir
    sid = secrets.token_hex(16)
    path = store() / sid; private_dir(path)
    atomic(path / 'session.json', {'id': sid, 'title': title, 'cwd': os.getcwd(), 'status': 'starting', 'created_at': time.time()})
    atomic(path / 'launch.json', {'args': args, 'route_state': str(route_state), 'port': port, 'notify_command': notify_command, 'generate_guide': generate_guide, 'agent_target': agent_target(notifications=False),
        'parent_env': {k: os.environ[k] for k in (*lifecycle.PARENT_ENV, 'PLANNOTATOR_REVIEW_NOTIFY') if k in os.environ},
        'lifecycle': True, 'host_token': secrets.token_hex(32), 'route_token': secrets.token_hex(32)})
    return start_supervisor(path)


def start_supervisor(path):
    launch = json.loads((path / 'launch.json').read_text())
    env = {k: v for k, v in os.environ.items() if k not in lifecycle.PARENT_ENV}
    env.update(launch.get('parent_env', {}))
    with (path / 'supervisor.log').open('a') as log:
        child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), str(path)], env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True, close_fds=True)
    print(f'Review session: {path.name}\nDurable record: {path}', file=sys.stderr, flush=True)
    for _ in range(650):
        record = json.loads((path / 'session.json').read_text())
        if record['status'] != 'starting':
            return record
        if child.poll() is not None:
            raise RuntimeError(f'Review supervisor exited; inspect {path}/supervisor.log')
        time.sleep(.1)
    raise RuntimeError(f'Review startup is still pending; retrieve with --status {path.name}. It was not cancelled.')


def wait(path):
    while True:
        record = status(path)
        if record['status'] in STOPPED:
            return record
        time.sleep(.25)


def result(path):
    record = status(path)
    if record['status'] == 'completed':
        feedback = json.loads((path / 'feedback.json').read_text())
        if feedback.get('decision') == 'annotated':
            feedback['follow_up'] = feedback_follow_up(path, record)
        print(json.dumps(feedback))
        return 0
    print(json.dumps(record))
    return 2 if record['status'] not in TERMINAL else 1


def feedback_follow_up(path, record):
    """Describe capture at retrieval time, including reviews started by older supervisors."""
    instructions = (
        'If the submitted feedback requests code changes, capture_before before editing, applying, or syncing those changes. '
        'Use the original review checkout, comparison base, and launching session for the next review. '
        'For a separate review checkout, capture it before syncing the authorized edits; keep unrelated work intact. '
        'Apply and verify the requested changes, sync the review checkout if needed, then run capture_after before launching the next review. '
        'These explicit captures do not require installed turn hooks. Reuse the same turn_id on retries; retain the original baseline when resuming partial work. '
        'If edits already started without a baseline, report last-turn capture unavailable instead of capturing a misleading before-state. '
        'Before sharing the next review, check /api/diff gitContext.diffOptions for Last turn changes and verify it contains only this feedback round. '
        'Question-only feedback needs no capture or new review.'
    )
    try:
        launch = json.loads((path / 'launch.json').read_text())
        env = launch.get('parent_env') or {}
    except (OSError, ValueError):
        env = {}
    session = env.get('PLANNOTATOR_DISCUSSION_SESSION_ID')
    if session is None:
        tag = env.get('PLANNOTATOR_SESSION_TAG', '')
        session = tag.removeprefix('claude-code:') if tag.startswith('claude-code:') else env.get('CLAUDE_CODE_SESSION_ID') or env.get('CODEX_THREAD_ID')
    unsupported = env.get('PLANNOTATOR_DISCUSSION_PROVIDER') == 'opencode' or (env.get('OPENCODE_SESSION_ID') and not env.get('PLANNOTATOR_DISCUSSION_PROVIDER'))
    cwd = record.get('cwd')
    if unsupported or not isinstance(session, str) or not re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', session) or not isinstance(cwd, str) or not Path(cwd).is_absolute():
        return {'instructions': 'Last-turn capture is unavailable: this review has no supported recorded session/checkout identity. '
                'Apply only authorized feedback and explain that limitation; do not invent an identity or promise Last turn changes.'}
    commands = {}
    for key, event in [('capture_before', 'UserPromptSubmit'), ('capture_after', 'Stop')]:
        payload = {'hook_event_name': event, 'cwd': cwd, 'session_id': session, 'turn_id': 'review-feedback:' + record['id']}
        commands[key] = "printf '%s\\n' " + shlex.quote(json.dumps(payload)) + ' | plannotator turn-snapshot'
    return {'instructions': instructions, **commands}


def agent_target(env=None, notifications=True, ready_only=False):
    """Identify only the launching session, never Herdr's focused/newest agent."""
    env = os.environ if env is None else env
    pane = env.get('HERDR_PANE_ID')
    if env.get('HERDR_ENV') != '1' or not pane or (notifications and env.get('PLANNOTATOR_REVIEW_NOTIFY') == '0'):
        return None
    provider = env.get('PLANNOTATOR_DISCUSSION_PROVIDER')
    session = env.get('PLANNOTATOR_DISCUSSION_SESSION_ID')
    if provider is None and session is None:
        tag = env.get('PLANNOTATOR_SESSION_TAG', '')
        claude = tag.removeprefix('claude-code:') if tag.startswith('claude-code:') else env.get('CLAUDE_CODE_SESSION_ID')
        for kind, value in [('opencode', env.get('OPENCODE_SESSION_ID')), ('claude', claude), ('codex', env.get('CODEX_THREAD_ID'))]:
            if value:
                provider, session = kind, value
                break
    if provider not in ('codex', 'claude', 'opencode') or not session:
        return None
    try:
        def query(*args):
            response = subprocess.run(['herdr', *args], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=3, check=True)
            return json.loads(response.stdout)['result']
        agent = query('agent', 'get', pane)['agent']
        live = agent.get('agent_session') or {}
        if agent['agent'] != provider or live.get('kind') != 'id' or live.get('value') != session:
            return None
        if agent.get('agent_status') not in ('idle', 'working', 'done'):
            return None
        if ready_only and (agent.get('agent_status') not in ('idle', 'done') or agent.get('interactive_ready') is not True):
            return None
        process = query('pane', 'process-info', '--pane', agent['pane_id'])['process_info']
        # A suspended agent may retain its identity while a shell owns the pane.
        if not any(p.get('name') == provider or Path((p.get('argv') or [''])[0]).name == provider for p in process['foreground_processes']):
            return None
        pid = process['foreground_process_group_id']
        started = identity(pid)
        if not started:
            return None
        return {'pane_id': agent['pane_id'], 'terminal_id': agent['terminal_id'], 'provider': provider, 'session_id': session, 'pid': pid, 'started': started}
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
        return None


def notify(path, record, command, target=None):
    event = {'id': record['id'], 'status': record['status'], 'title': record['title'], 'result_file': str(path / 'feedback.json'), 'created_at': time.time()}
    # Save feedback availability even when the originating agent cannot be reached.
    atomic(path / 'notification.json', event)
    if command is None and record['status'] == 'completed' and target and agent_target() == target:
        message = f"Feedback is ready for review {record['id']}. Retrieve it with plannotator-mobile --result {record['id']} and read the submitted decision, message, and follow_up instructions before acting."
        command = ['herdr', 'agent', 'prompt', target['pane_id'], message]
    if command:
        command = [arg.replace('{review_id}', record['id']).replace('{result_file}', str(path / 'feedback.json')) for arg in command]
        try:
            sent = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
            event['delivery'] = 'sent' if sent.returncode == 0 else 'failed'
        except (OSError, subprocess.TimeoutExpired):
            event['delivery'] = 'failed'
    else:
        event['delivery'] = 'durable-only'
    atomic(path / 'notification.json', event)


def stop(child):
    if child.poll() is not None: return
    os.killpg(child.pid, signal.SIGTERM)
    try: child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL); child.wait()


def data_directory():
    # Match Plannotator's data-dir resolver before overriding it for this review.
    home = Path.home()
    configured = os.environ.get('PLANNOTATOR_DATA_DIR', '').strip()
    if configured:
        if configured == '~': return home
        if configured.startswith(('~/', '~\\')): return home / configured[2:]
        return Path(configured).resolve()
    legacy = home / '.plannotator'
    xdg = os.environ.get('XDG_DATA_HOME', '').strip()
    return Path(xdg) / 'plannotator' if not legacy.exists() and Path(xdg).is_absolute() else legacy


def supervise(path):
    from mobile import private_dir
    os.umask(0o077)
    record = json.loads((path / 'session.json').read_text())
    launch = json.loads((path / 'launch.json').read_text())
    route = Path(launch['route_state']) / record['id']
    data = path / 'data'
    original = data_directory()
    child = None
    suspended = False
    try:
        record.update(supervisor_pid=os.getpid(), supervisor_start=identity(os.getpid()))
        atomic(path / 'session.json', record)
        private_dir(route); private_dir(data)
        # Viewed records already include worktree, branch, scope and file identity.
        try:
            progress = original / 'review-progress'
            progress.mkdir(mode=0o700, parents=True, exist_ok=True)
            if not (data / 'review-progress').exists():
                (data / 'review-progress').symlink_to(progress.resolve(), target_is_directory=True)
        except OSError as error:
            print(f'Could not share viewed-file progress; using this review only: {error}', file=sys.stderr)
        if (original / 'config.json').exists() and not (data / 'config.json').exists():
            shutil.copyfile(original / 'config.json', data / 'config.json')
        prompts = data / 'review_prompts'
        if original.resolve() != data.resolve() and not prompts.exists() and not prompts.is_symlink():
            prompts.symlink_to((original / 'review_prompts').resolve(), target_is_directory=True)
        env = {**os.environ, 'PLANNOTATOR_REMOTE': '0', 'PLANNOTATOR_PORT': '0', 'PLANNOTATOR_SKIP_BROWSER_OPEN': '1', 'PLANNOTATOR_READY_FILE': str(path / 'ready.json'), 'PLANNOTATOR_DATA_DIR': str(data)}
        env.pop('PLANNOTATOR_URL_HOST', None)
        if launch.get('lifecycle'):
            env.update(PLANNOTATOR_REVIEW_ID=record['id'], PLANNOTATOR_REVIEW_CHECKPOINT=str(path / 'checkpoint.json'), PLANNOTATOR_REVIEW_CONTROL_TOKEN=launch['host_token'])
        args = launch['args']
        command = ['plannotator', 'review', *args] + ([] if '--json' in args else ['--json'])
        with (path / 'stdout.log').open('wb') as out, (path / 'stderr.log').open('ab') as err:
            child = subprocess.Popen(command, env=env, cwd=record['cwd'], stdin=subprocess.DEVNULL, stdout=out, stderr=err, start_new_session=True, close_fds=True)
            record.update(review_pid=child.pid, review_start=identity(child.pid))
            for _ in range(600):
                if (path / 'cancel').exists():
                    break
                try:
                    ready = json.loads((path / 'ready.json').read_text()); break
                except (OSError, ValueError):
                    pass
                if child.poll() is not None:
                    raise RuntimeError('Review exited before becoming ready; see stderr.log')
                time.sleep(.1)
            else:
                raise RuntimeError('Review did not become ready in 60 seconds')
            if not (path / 'cancel').exists():
                upstream = urlsplit(ready['url'])
                if upstream.scheme != 'http' or upstream.hostname not in ('localhost', '127.0.0.1') or not upstream.port:
                    raise RuntimeError('Unexpected review URL')
                if record.get('resumed_at'):
                    with urllib.request.urlopen(f'http://127.0.0.1:{upstream.port}/api/diff', timeout=15) as response:
                        restored = json.load(response).get('reviewLifecycle', {})
                    if restored.get('id') != record['id'] or restored.get('frozen') is not True:
                        raise RuntimeError('Application did not restore the saved review; checkpoint remains offline')
                token = launch.get('route_token') or secrets.token_hex(32)
                registration = {'pid': child.pid, 'port': upstream.port, 'token': token, 'title': record['title']}
                if launch.get('lifecycle'):
                    registration.update(status='running', record=str(path), owner=launch.get('agent_target'))
                atomic(route / 'route.json', registration)
                record.update(status='running', direct_url=ready['url'], proxy_url=f"http://127.0.0.1:{launch['port']}/reviews/{record['id']}/?access={token}")
                if launch.get('generate_guide') and not record.get('resumed_at'):
                    # Use the normal guide job: the review server owns generation and persistence.
                    request = urllib.request.Request(f'http://127.0.0.1:{upstream.port}/api/agents/jobs',
                        data=json.dumps({'provider': 'guide', 'label': 'Requested review guide'}).encode(),
                        headers={'Content-Type': 'application/json'})
                    try:
                        with urllib.request.urlopen(request, timeout=20) as response:
                            job = json.load(response)['job']
                        if not isinstance(job.get('id'), str) or not job['id']:
                            raise ValueError('Guide launch returned no job id')
                        record['guide_job_id'] = job['id']
                    except urllib.error.HTTPError as error:
                        record['guide_error'] = f'HTTP {error.code}: {error.read(4096).decode(errors="replace")}'
                    except Exception as error:
                        record['guide_error'] = str(error)
                atomic(path / 'session.json', record)
                next_suspend_attempt = 0
                next_idle_check = 0
                while child.poll() is None and not (path / 'cancel').exists():
                    requested = (path / 'suspend').exists()
                    idle = False
                    if time.time() >= next_idle_check:
                        idle = lifecycle.is_idle(path, record, time.time())
                        next_idle_check = time.time() + 30
                    if launch.get('lifecycle') and (requested or (idle and time.time() >= next_suspend_attempt)):
                        try:
                            lifecycle.checkpoint(path, record, launch['host_token'], automatic=not requested)
                            suspended = True
                            stop(child)
                            break
                        except Exception as error:
                            record['suspend_error'] = f'Could not safely suspend; review remains running: {error}'
                            atomic(path / 'session.json', record)
                            (path / 'suspend').unlink(missing_ok=True)
                            next_suspend_attempt = time.time() + 300
                    time.sleep(.25)
            cancelled = (path / 'cancel').exists() and child.poll() is None
            if cancelled:
                stop(child)
            code = child.wait()
            out.flush(); os.fsync(out.fileno())
        if suspended:
            record.update(status='suspended', suspended_at=time.time(), resume_prompt=lifecycle.resume_prompt(record['id']))
            record.pop('suspend_error', None)
        elif cancelled:
            record.update(status='cancelled', exit_code=code)
        else:
            try:
                feedback = json.loads((path / 'stdout.log').read_text())
            except (OSError, ValueError):
                feedback = None
            if code == 0 and isinstance(feedback, dict) and feedback.get('decision') in ('approved', 'annotated', 'dismissed') and isinstance(feedback.get('message'), str):
                atomic(path / 'feedback.json', feedback)
                record.update(status='completed', exit_code=code)
            else:
                record.update(status='suspended' if record.get('resumed_at') and (path / 'checkpoint.json').exists() else 'failed', exit_code=code, error='Review ended without valid submitted feedback; retained stdout.log, stderr.log and drafts are available.')
    except Exception as error:
        record.update(status='suspended' if record.get('resumed_at') and (path / 'checkpoint.json').exists() else 'failed', error=str(error))
    finally:
        if child and child.poll() is None:
            stop(child)
        if record['status'] == 'suspended':
            atomic(route / 'route.json', {'status': 'suspended', 'record': str(path), 'token': launch['route_token'], 'title': record['title'], 'owner': launch.get('agent_target')})
        else:
            (route / 'route.json').unlink(missing_ok=True)
        record['ended_at'] = time.time()
        atomic(path / 'session.json', record)
        if suspended and os.environ.get('PLANNOTATOR_REVIEW_NOTIFY') != '0':
            # Record the attempt before pasting: a crashed notifier must not paste twice.
            atomic(path / 'resume-prompt.json', {'attempted': True})
            try: prepared = lifecycle.prepare_prompt(path)
            except Exception: prepared = {'prepared': False, 'reason': 'Review changed before the prompt could be prepared'}
            atomic(path / 'resume-prompt.json', prepared)
        if record['status'] != 'suspended':
            notify(path, record, launch['notify_command'], launch.get('agent_target'))


if __name__ == '__main__':
    supervise(Path(sys.argv[1]))
