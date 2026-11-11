#!/usr/bin/env python3
"""Launch an isolated Plannotator review behind the fixed SSH-forwarded proxy."""
import fcntl
import argparse
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parent
PORT = 19433
STATE = Path('/tmp') / f'plannotator-mobile-{os.getuid()}'


def private_dir(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError(f'Expected an owner-only directory: {path}')


def ensure_proxy():
    private_dir(STATE)
    with (STATE / 'startup.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        def healthy():
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/health', timeout=1) as response:
                    return json.load(response) == {'name': 'plannotator-review-proxy', 'version': 1}
            except Exception:
                return False
        if healthy():
            return
        with (STATE / 'proxy.log').open('a') as log:
            child = subprocess.Popen([shutil.which('node'), str(ROOT.parent / 'gateway.mjs'), str(STATE), str(PORT)], stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True, close_fds=True)
        for _ in range(100):
            if healthy():
                (STATE / 'proxy.pid').write_text(str(child.pid))
                return
            if child.poll() is not None:
                break
            time.sleep(.05)
        raise RuntimeError(f'Proxy failed to start; see {STATE / "proxy.log"}')


def main():
    os.umask(0o077)
    args = sys.argv[1:]
    if args == ['--help']:
        print('Usage: plannotator-mobile [--title "Review name"] [Plannotator review arguments]\n'
              '--title names the review in the Reviews launcher; defaults to the working directory name.\n'
              'Runs Plannotator 0.28.20-references.33 with a unique route on 127.0.0.1:19433, separate from Herdr localhost links.\n'
              'Links go to stderr; the final Plannotator decision JSON goes to stdout.\n'
              'The review runs in a detached supervisor. Ctrl-C stops waiting, not the review.\n'
              'Use --detach for a launch receipt; --wait ID or --result ID retrieves durable feedback.\n'
              '--generate-guide starts a Guided Review job; agents must use it only when the user explicitly requests a guide.\n'
              'Use --status ID, --list, --notifications, --ack ID, or explicit --cancel ID.\n'
              'New reviews suspend after 72 hours without reviewer interaction. Saved reviews use --resume ID.\n'
              'Use --suspend ID, or --prepare-resume ID to paste a resume prompt without sending it.\n'
              'Completed feedback prompts the verified launching Herdr agent when available.\n'
              '--notify-command JSON_ARGV overrides automatic agent delivery; no desktop toast.\n'
              'Phone/desktop SSH: ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:19433:127.0.0.1:19433 your-review-host\n'
              'Use --proxy-status to start/check the shared proxy without launching a review.\n'
              'Use --launcher-link to print the running reviews dashboard URL (no unlock required).')
        return 0
    parser = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
    parser.add_argument('--detach', action='store_true')
    parser.add_argument('--generate-guide', action='store_true')
    parser.add_argument('--notify-command', type=json.loads, help='JSON argv; {review_id} and {result_file} placeholders, no shell')
    parser.add_argument('--title', default=Path.cwd().name or 'Code review')
    options, args = parser.parse_known_args(args)
    if options.notify_command is not None and (not isinstance(options.notify_command, list) or not options.notify_command or not all(isinstance(arg, str) and arg for arg in options.notify_command)):
        raise RuntimeError('--notify-command must be a nonempty JSON array of strings')
    import durable
    if args in (['--list'], ['--notifications']):
        records = []
        for path in durable.store().iterdir():
            if not (path / 'session.json').is_file(): continue
            record = durable.status(path)
            if args == ['--notifications'] and (not (path / 'notification.json').exists() or (path / 'ack').exists()): continue
            records.append({key: record.get(key) for key in ('id', 'title', 'cwd', 'status', 'created_at', 'ended_at', 'suspended_at', 'resume_prompt')})
        print(json.dumps(records)); return 0
    if args and args[0] in ('--status', '--result', '--wait', '--cancel', '--ack', '--suspend', '--resume', '--prepare-resume'):
        if len(args) != 2: raise RuntimeError('Expected one review ID')
        path = durable.directory(args[1])
        if args[0] == '--suspend':
            print(json.dumps(durable.lifecycle.request_suspend(path))); return 0
        if args[0] == '--prepare-resume':
            print(json.dumps(durable.lifecycle.prepare_prompt(path))); return 0
        if args[0] == '--resume':
            ensure_proxy()
            record = durable.lifecycle.resume(path)
            print(json.dumps(record)); return 0 if record['status'] == 'running' else 1
        if args[0] == '--status': print(json.dumps(durable.status(path))); return 0
        if args[0] == '--cancel':
            durable.lifecycle.request_close(path)
            print(json.dumps({'id': args[1], 'cancel_requested': True})); return 0
        if args[0] == '--ack':
            if durable.status(path)['status'] not in durable.TERMINAL: raise RuntimeError('The review has not finished')
            (path / 'ack').touch(mode=0o600); return 0
        if args[0] == '--wait': durable.wait(path)
        return durable.result(path)
    title = options.title.strip()
    if not title or len(title) > 120 or any(ord(c) < 32 for c in title):
        raise RuntimeError('Review title must be 1–120 characters without control characters')
    ensure_proxy()
    if args == ['--launcher-link']:
        print(f'http://127.0.0.1:{PORT}/reviews/')
        return 0
    if args == ['--proxy-status']:
        print(f'Proxy ready: http://127.0.0.1:{PORT} (loopback; reachable over SSH)')
        return 0
    if subprocess.check_output(['plannotator', '--version'], text=True).strip() != 'plannotator 0.28.20-references.33':
        raise RuntimeError('This adapter is verified for Plannotator 0.28.20-references.33. Re-test before using a different version.')
    if '--tailscale' in args:
        raise RuntimeError('Use the SSH proxy link for mobile reviews')
    record = durable.launch(args, title, STATE, PORT, options.notify_command, generate_guide=options.generate_guide)
    sid = record['id']
    if record.get('proxy_url'):
        print(f"Mobile:  {record['proxy_url']}\nDesktop: {record['proxy_url']}\nLocal:   {record['direct_url']}", file=sys.stderr, flush=True)
    if record.get('guide_error'):
        print(f"Guide generation could not start: {record['guide_error']}. The review remains available; do not relaunch it.", file=sys.stderr, flush=True)
    if options.detach:
        print(json.dumps(record))
        return 0 if record['status'] in ('running', 'completed') and not record.get('guide_error') else 1
    print(f"Waiting for feedback. Cancelling this wait leaves the review running. Retrieve: plannotator-mobile --result {sid}", file=sys.stderr, flush=True)
    durable.wait(durable.directory(sid))
    return durable.result(durable.directory(sid))


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as error:
        print(f'plannotator-mobile: {error}', file=sys.stderr)
        sys.exit(1)
