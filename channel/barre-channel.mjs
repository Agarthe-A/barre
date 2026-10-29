#!/usr/bin/env node
// Canal Claude Code → Barre (relais des demandes d'autorisation).
//
// Claude Code lance ce programme pour chaque session ouverte avec le raccourci
// « claude » (voir README). Quand une demande d'autorisation s'ouvre dans le
// terminal, Claude Code nous l'envoie en parallèle : on la transmet à la barre.
// Le terminal reste ouvert : la première réponse (terminal ou barre) gagne.
//
// Aucune dépendance. Protocole MCP sur stdin/stdout (une ligne JSON par message).
// Rien n'est jamais envoyé à Claude lui-même par ce canal.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NEW_CONFIG = path.join(os.homedir(), '.config', 'barre', 'config.json');
const CONFIG_PATH = process.env.BARRE_CONFIG || (fs.existsSync(NEW_CONFIG) ? NEW_CONFIG : path.join(HERE, '..', 'config.json'));
const CID = crypto.randomUUID();
const CWD = process.cwd();
// Identifiant du lancement « claude » (posé par le raccourci zsh), partagé avec le hook.
const SID = process.env.BARRE_SID || '';
const log = (...a) => process.stderr.write(`[barre-channel] ${a.join(' ')}\n`);

function config() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return null; }
}
function target() {
  const c = config();
  if (!c || !c.token) return null;
  const host = !c.host || c.host === '0.0.0.0' ? '127.0.0.1' : c.host;
  return { host, port: c.port || 4747, token: c.token };
}

// ---------------------------------------------------------------- MCP (stdio)

function send(msg) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
}

function onMessage(msg) {
  if (msg.method === 'initialize' && msg.id != null) {
    send({
      id: msg.id,
      result: {
        protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18',
        capabilities: {
          experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
          tools: {}
        },
        serverInfo: { name: 'barre', version: '1.0.0' },
        instructions: 'Ce canal relaie seulement les demandes d\'autorisation vers la barre tactile de Julian. Aucun message n\'arrive par ce canal et il n\'y a rien à y répondre.'
      }
    });
    return;
  }
  if (msg.method === 'tools/list' && msg.id != null) return send({ id: msg.id, result: { tools: [] } });
  if (msg.method === 'ping' && msg.id != null) return send({ id: msg.id, result: {} });
  if (msg.method === 'notifications/claude/channel/permission_request') return forward(msg.params || {});
  if (msg.id != null && msg.method) send({ id: msg.id, error: { code: -32601, message: 'Méthode inconnue' } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try { onMessage(JSON.parse(line)); } catch (err) { log('message illisible', err.message); }
  }
});
// Claude Code fermé → on s'arrête.
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));

// ---------------------------------------------------------------- Barre

function forward(p) {
  const t = target();
  if (!t) return;
  const body = JSON.stringify({
    cid: CID, cwd: CWD, sid: SID,
    request_id: String(p.request_id || ''), tool_name: String(p.tool_name || ''),
    description: String(p.description || ''), input_preview: String(p.input_preview || '')
  });
  const req = http.request({
    host: t.host, port: t.port, path: '/api/relay/request', method: 'POST', timeout: 5000,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${t.token}`, 'content-length': Buffer.byteLength(body) }
  }, (res) => res.resume());
  req.on('error', (err) => log('barre injoignable', err.message));
  req.on('timeout', () => req.destroy());
  req.end(body);
}

// Connexion permanente à la barre : elle nous renvoie les réponses touchées.
// Une seule reconnexion programmée à la fois (sinon les connexions se multiplient).
let retry = null;
function reconnect(ms) {
  if (retry) return;
  retry = setTimeout(() => { retry = null; connect(); }, ms);
}
function connect() {
  const t = target();
  if (!t) return reconnect(10000);
  const q = new URLSearchParams({ cid: CID, cwd: CWD, sid: SID }).toString();
  const req = http.get({
    host: t.host, port: t.port, path: `/api/relay/connect?${q}`,
    headers: { authorization: `Bearer ${t.token}`, accept: 'text/event-stream' }
  }, (res) => {
    if (res.statusCode !== 200) { res.resume(); return reconnect(5000); }
    res.setEncoding('utf8');
    let sse = '';
    res.on('data', (chunk) => {
      sse += chunk;
      let i;
      while ((i = sse.indexOf('\n\n')) >= 0) {
        const block = sse.slice(0, i);
        sse = sse.slice(i + 2);
        const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
        if (!data) continue;
        try {
          const v = JSON.parse(data);
          if (v.request_id && (v.behavior === 'allow' || v.behavior === 'deny')) {
            send({ method: 'notifications/claude/channel/permission', params: { request_id: v.request_id, behavior: v.behavior } });
          }
        } catch { /* ignoré */ }
      }
    });
    res.on('end', () => reconnect(3000));
    res.on('error', () => reconnect(3000));
  });
  req.on('error', () => reconnect(5000));
}
connect();
