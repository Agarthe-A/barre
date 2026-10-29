#!/usr/bin/env node
// Branche (ou débranche avec --remove) la barre dans ~/.claude/settings.json.
// Fait une sauvegarde horodatée avant toute modification et ne touche pas
// aux autres hooks déjà présents.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HOOK_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'barre-hook.mjs');
const SETTINGS = process.env.CLAUDE_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');
// Chemin stable de node (le lien Homebrew survit aux mises à jour, pas process.execPath).
const NODE = process.env.BARRE_NODE
  || ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find((p) => fs.existsSync(p))
  || process.execPath;
const MARK = 'barre-hook.mjs';
const remove = process.argv.includes('--remove');

const NEW_CONFIG = path.join(os.homedir(), '.config', 'barre', 'config.json');
const configPath = fs.existsSync(NEW_CONFIG) ? NEW_CONFIG : path.join(path.dirname(HOOK_SCRIPT), '..', 'config.json');
let permissionTimeoutSec = 90;
try { permissionTimeoutSec = JSON.parse(fs.readFileSync(configPath, 'utf8')).permissionTimeoutSec || 90; } catch {}

// Événements suivis. PermissionRequest attend la réponse de la barre,
// les autres ne font qu'informer (moins de 3 s, jamais bloquants).
const EVENTS = {
  PermissionRequest: permissionTimeoutSec + 30,
  Notification: 10,
  UserPromptSubmit: 10,
  Stop: 10,
  SessionStart: 10,
  SessionEnd: 10,
  // En arrière-plan : sert à retirer de la barre une demande déjà acceptée dans le terminal.
  PostToolUse: 10
};
const ASYNC = new Set(['PostToolUse']);

const settings = fs.existsSync(SETTINGS) ? JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) : {};
const backup = `${SETTINGS}.barre-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, backup);

settings.hooks = settings.hooks || {};

// On retire d'abord toute ancienne entrée de la barre (idempotent).
for (const ev of Object.keys(settings.hooks)) {
  settings.hooks[ev] = (settings.hooks[ev] || [])
    .map((group) => ({ ...group, hooks: (group.hooks || []).filter((h) => !String(h.command || '').includes(MARK)) }))
    .filter((group) => group.hooks.length > 0);
  if (settings.hooks[ev].length === 0) delete settings.hooks[ev];
}

if (!remove) {
  for (const [ev, timeout] of Object.entries(EVENTS)) {
    const entry = { hooks: [{ type: 'command', command: `"${NODE}" "${HOOK_SCRIPT}"`, timeout, ...(ASYNC.has(ev) ? { async: true } : {}) }] };
    if (ev === 'PermissionRequest' || ev === 'PostToolUse') entry.matcher = '*';
    settings.hooks[ev] = [...(settings.hooks[ev] || []), entry];
  }
}

fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
console.log(`${remove ? 'Barre débranchée de' : 'Barre branchée dans'} ${SETTINGS}`);
if (fs.existsSync(backup)) console.log(`Sauvegarde : ${backup}`);
console.log('Les sessions Claude Code déjà ouvertes doivent être relancées pour en tenir compte.');
