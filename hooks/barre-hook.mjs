#!/usr/bin/env node
// Hook Claude Code → Barre.
// Envoie chaque événement au serveur de la barre. Pour une demande d'autorisation
// (PermissionRequest), attend la réponse touchée sur la barre et la renvoie à Claude.
//
// Règle d'or : ne jamais gêner Claude. Si la barre est éteinte, injoignable ou
// ne répond pas, le hook sort sans rien dire et Claude pose sa question
// normalement dans le terminal.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NEW_CONFIG = path.join(os.homedir(), '.config', 'barre', 'config.json');
const CONFIG_PATH = process.env.BARRE_CONFIG || (fs.existsSync(NEW_CONFIG) ? NEW_CONFIG : path.join(HERE, '..', 'config.json'));

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function quit() {
  process.exit(0);
}

// Sessions lancées par la barre elle-même (priorités du jour) : on ne les suit pas.
if (process.env.BARRE_INTERNAL === '1') quit();

const raw = await readStdin();
let input;
let config;
try {
  input = JSON.parse(raw);
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch {
  quit();
}

const isPermission = input.hook_event_name === 'PermissionRequest';
// Session lancée avec le canal de la barre (raccourci « claude ») : la question
// s'affiche tout de suite dans le terminal ET sur la barre (la barre répond « relais »).
const viaChannel = process.env.BARRE_CHANNEL === '1';
if (viaChannel) {
  input.barre_channel = true;
  if (process.env.BARRE_SID) input.barre_sid = process.env.BARRE_SID;
}
const host = !config.host || config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
const url = `http://${host}:${config.port || 4747}/api/hook`;
// La barre répond tout de suite « relais » quand le canal est branché ; sinon on
// garde l'attente normale (la question reste visible sur la barre).
const waitMs = isPermission ? ((config.permissionTimeoutSec || 90) + 5) * 1000 : 2500;

let answer;
try {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(waitMs)
  });
  if (!isPermission) quit();
  answer = await r.json();
} catch {
  quit();
}

const decision = answer && answer.decision;
let output = null;
if (decision === 'allow') {
  output = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
} else if (decision === 'deny') {
  output = {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'deny', message: 'Refusé depuis la barre. Demande-moi comment procéder autrement.' }
    }
  };
}
// "ask" (pas de réponse à temps) : aucune sortie → question habituelle dans le terminal.
// Sur macOS l'écriture dans un pipe est asynchrone : on attend la fin avant de sortir.
if (output) process.stdout.write(JSON.stringify(output), quit);
else quit();
