#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginPath = path.join(rootDir, 'mihomo-plugin.js');
const servicePath = path.join(rootDir, 'mihomo.service');
const updateSubPath = path.join(rootDir, 'update-sub.sh');

const serviceB64 = fs.readFileSync(servicePath).toString('base64');
const updateSubB64 = fs.readFileSync(updateSubPath).toString('base64');

let plugin = fs.readFileSync(pluginPath, 'utf8');
const svcRe = /const SERVICE_SCRIPT_B64 = '[^']*';/;
const subRe = /const UPDATE_SUB_SCRIPT_B64 = '[^']*';/;

if (!svcRe.test(plugin) || !subRe.test(plugin)) {
  throw new Error('Could not find SERVICE_SCRIPT_B64 or UPDATE_SUB_SCRIPT_B64 markers in mihomo-plugin.js');
}

plugin = plugin
  .replace(svcRe, `const SERVICE_SCRIPT_B64 = '${serviceB64}';`)
  .replace(subRe, `const UPDATE_SUB_SCRIPT_B64 = '${updateSubB64}';`);

fs.writeFileSync(pluginPath, plugin, 'utf8');
console.log(`Synced mihomo.service (${serviceB64.length} b64 chars) and update-sub.sh (${updateSubB64.length} b64 chars) into mihomo-plugin.js`);
