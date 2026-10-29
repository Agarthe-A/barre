#!/usr/bin/env node
// patrimoine — mettre à jour et consulter le patrimoine affiché sur la barre.
// Installé en lien symbolique : /opt/homebrew/bin/patrimoine → ~/barre/bin/patrimoine.mjs
// Aide : patrimoine aide

import { executer } from '../lib/cli-patrimoine.mjs';

try {
  process.exitCode = await executer(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`Erreur inattendue : ${e && e.message}\n`);
  process.exitCode = 1;
}
