#!/usr/bin/env node
import fs from 'node:fs/promises';
import {openSync, closeSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
import {readRoute, validName, validPort} from './server.mjs';

process.umask(0o077);
const state = path.join(os.homedir(), '.local/state/agent-sites');
const port = 19433;
const origin = `http://127.0.0.1:${port}`;
const [command, name, target, ...extra] = process.argv.slice(2);
const usage = `Usage:
  agent-site publish NAME DIRECTORY    Publish an HTML folder
  agent-site proxy NAME PORT           Forward an app serving /sites/NAME/
  agent-site list                      Print private access links
  agent-site remove NAME               Unregister a site (keeps its files/server)
  agent-site start                     Start the detached service
  agent-site status                    Check the service

Names use lowercase letters, digits and hyphens. The service uses port ${port}.
Keep one SSH forward open on each device:
  ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:${port}:127.0.0.1:${port} your-review-host
`;
const link = (name, route) => `${origin}/sites/${name}/?access=${route.token}`;

async function healthy() {
  return new Promise(resolve => {
    const request = http.get({hostname: '127.0.0.1', port, path: '/sites/health'}, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => body += chunk);
      response.on('error', () => resolve(false));
      response.on('end', () => {
        try {
          const result = JSON.parse(body);
          resolve(response.statusCode === 200 && result.name === 'agent-sites' && result.version === 1);
        } catch { resolve(false); }
      });
    });
    request.setTimeout(300, () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

async function start() {
  if (await healthy()) return;
  const log = openSync(path.join(state, 'service.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../gateway.mjs', import.meta.url))], {detached: true, stdio: ['ignore', log, log]});
    child.on('error', error => console.error(error.message));
    child.unref();
  } finally { closeSync(log); }
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await healthy()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error(`Service could not start; see ${state}/service.log. Check that port ${port} is free.`);
}

async function main() {
  if (!command || ['--help', '-h', 'help'].includes(command)) { console.log(usage); return; }
  if (!['publish', 'proxy', 'list', 'remove', 'start', 'status'].includes(command) || extra.length) throw Error(usage);
  if (['publish', 'proxy', 'remove'].includes(command)) {
    if (!validName(name) || (command === 'remove' ? target !== undefined : target === undefined)) throw Error(usage);
  } else if (name !== undefined) throw Error(usage);
  await fs.mkdir(state, {recursive: true, mode: 0o700});
  const info = await fs.lstat(state);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) throw Error(`Expected an owner-only directory: ${state}`);
  if (command === 'status') {
    const ready = await healthy();
    console.log(ready ? `Ready: ${origin}/sites/` : 'Agent sites is not running');
    process.exitCode = ready ? 0 : 1;
    return;
  }
  if (command === 'start') { await start(); console.log(`Ready: ${origin}/sites/`); return; }
  if (command === 'remove') { await fs.unlink(path.join(state, `${name}.json`)); console.log(`Removed ${name}; source files and upstream server were kept.`); return; }
  if (command === 'list') {
    for (const file of (await fs.readdir(state)).sort()) {
      if (!file.endsWith('.json')) continue;
      const name = file.slice(0, -5), route = await readRoute(state, name);
      console.log(`${name}\t${link(name, route)}\t${route.path || `127.0.0.1:${route.port}`}`);
    }
    return;
  }
  let route;
  if (command === 'publish') {
    const directory = await fs.realpath(path.resolve(target));
    if (!(await fs.stat(directory)).isDirectory()) throw Error('Publish a directory containing index.html');
    if (!(await fs.stat(path.join(directory, 'index.html'))).isFile()) throw Error('The directory must contain index.html');
    route = {kind: 'directory', path: directory};
  } else {
    const upstreamPort = Number(target);
    if (!validPort(upstreamPort) || upstreamPort === port) throw Error('Expected a local HTTP port from 1 to 65535 other than 19433');
    route = {kind: 'proxy', port: upstreamPort};
  }
  let previous;
  try { previous = await readRoute(state, name); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous && (previous.kind !== route.kind || previous.path !== route.path || previous.port !== route.port)) throw Error(`Name ${name} already points elsewhere; choose a new name or remove it first.`);
  route.token = previous?.token || randomBytes(32).toString('hex');
  if (!previous) {
    const temporary = path.join(state, `${name}.${randomBytes(8).toString('hex')}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify(route) + '\n', {mode: 0o600, flag: 'wx'});
      // link publishes atomically and refuses to overwrite a concurrent registration.
      await fs.link(temporary, path.join(state, `${name}.json`));
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  await start();
  console.log(link(name, route));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
