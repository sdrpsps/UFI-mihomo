#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginPath = path.join(repoRoot, 'mihomo-plugin.js');
const servicePath = path.join(repoRoot, 'mihomo.service');
const updateSubPath = path.join(repoRoot, 'update-sub.sh');

const runAsync = (cmd, args, opts = {}) => new Promise((resolve) => {
  const child = spawn(cmd, args, { env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const timer = opts.timeout ? setTimeout(() => { child.kill('SIGKILL'); }, opts.timeout) : null;
  child.on('close', (code) => {
    if (timer) clearTimeout(timer);
    resolve({ status: code ?? 1, stdout, stderr });
  });
});

const passed = [];
const runTest = async (name, fn) => {
  try {
    await fn();
    passed.push(name);
    console.log(`PASS  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err);
    process.exitCode = 1;
    throw err;
  }
};

const makeMockMihomoScript = (version = 'v1.19.99-mock', failValidate = false) => `#!/bin/sh
if [ "$1" = "-v" ]; then
  echo "Mihomo Meta ${version} android arm64"
  exit 0
fi
if [ "$1" = "-t" ]; then
  ${failValidate ? 'echo "configuration test failed: intentional mock error" >&2; exit 1' : ''}
  CFG=""
  while [ $# -gt 0 ]; do
    if [ "$1" = "-f" ]; then CFG="$2"; shift 2; else shift; fi
  done
  if [ -n "$CFG" ] && grep -q "INVALID_CONFIG_MARKER" "$CFG" 2>/dev/null; then
    echo "configuration test failed: INVALID_CONFIG_MARKER" >&2
    exit 1
  fi
  echo "configuration file $CFG test is successful"
  exit 0
fi
trap 'exit 0' TERM INT
while true; do sleep 1; done
`;

const createMockEnv = () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufi-mihomo-test-'));
  const mockBinDir = path.join(tmpDir, 'mock-bin');
  const rootDir = path.join(tmpDir, 'mihomo');
  const uploadRoot = path.join(tmpDir, 'ufi-files');
  const httpFixtureDir = path.join(tmpDir, 'mock-http');
  fs.mkdirSync(mockBinDir, { recursive: true });
  fs.mkdirSync(path.join(uploadRoot, 'uploads'), { recursive: true });
  fs.mkdirSync(httpFixtureDir, { recursive: true });

  const iptablesLog = path.join(tmpDir, 'iptables.log');
  const ipLog = path.join(tmpDir, 'ip.log');
  const hitsLog = path.join(httpFixtureDir, 'hits.log');
  const gzAssetPath = path.join(httpFixtureDir, 'mihomo-android-arm64-v8-v1.19.99.gz');
  fs.writeFileSync(gzAssetPath, zlib.gzipSync(Buffer.from(makeMockMihomoScript('v1.19.99-mirror'))));

  // Mock iptables
  fs.writeFileSync(path.join(mockBinDir, 'iptables'), `#!/bin/sh
echo "iptables $*" >> "${iptablesLog}"
if [ -n "$MOCK_IPTABLES_FAIL" ] && echo "$*" | grep -q "TPROXY"; then
  echo "iptables: No chain/target/match by that name." >&2
  exit 1
fi
exit 0
`, { mode: 0o755 });

  // Mock ip6tables
  fs.writeFileSync(path.join(mockBinDir, 'ip6tables'), `#!/bin/sh
echo "ip6tables $*" >> "${iptablesLog}"
exit 0
`, { mode: 0o755 });

  // Mock ip
  fs.writeFileSync(path.join(mockBinDir, 'ip'), `#!/bin/sh
echo "ip $*" >> "${ipLog}"
if [ "$1" = "rule" ] && [ "$2" = "del" ]; then exit 1; fi
if [ "$1" = "-6" ] && [ "$2" = "rule" ] && [ "$3" = "del" ]; then exit 1; fi
exit 0
`, { mode: 0o755 });

  // Mock getprop (Android arm64-v8a)
  fs.writeFileSync(path.join(mockBinDir, 'getprop'), `#!/bin/sh
if [ "$1" = "ro.product.cpu.abi" ]; then echo "arm64-v8a"; exit 0; fi
if [ "$1" = "ro.product.cpu.abilist" ]; then echo "arm64-v8a,armeabi-v7a"; exit 0; fi
exit 0
`, { mode: 0o755 });

  // Mock whoami -> root
  fs.writeFileSync(path.join(mockBinDir, 'whoami'), '#!/bin/sh\necho root\n', { mode: 0o755 });

  // Mock curl (handles -o, -w '%{url_effective}', -A, -x, mirror1=502, mirror2=200, subscription URLs)
  const mockCurlPath = path.join(mockBinDir, 'curl');
  fs.writeFileSync(mockCurlPath, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
let outFile = null;
let hdrFile = null;
let writeOut = null;
let url = '';
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-o') { outFile = args[++i]; continue; }
  if (a === '-D') { hdrFile = args[++i]; continue; }
  if (a === '-w') { writeOut = args[++i]; continue; }
  if (a === '-A' || a === '-x' || a === '--connect-timeout' || a === '--max-time') { i++; continue; }
  if (!a.startsWith('-')) url = a;
}
fs.appendFileSync(${JSON.stringify(hitsLog)}, url + '\\n');

// Mirror 1: simulate 502 failure to test automatic fallback
if (url.startsWith('https://mirror1.test/') || url.includes('/mirror1/')) {
  process.stderr.write('curl: (22) The requested URL returned error: 502\\n');
  process.exit(22);
}

// Mirror 2: GitHub release mirror (redirect + asset download)
if (url.startsWith('https://mirror2.test/')) {
  if (url.endsWith('/releases/latest')) {
    const eff = 'https://mirror2.test/https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.99';
    if (outFile && outFile !== '/dev/null') {
      fs.writeFileSync(outFile, '<html><a href="/MetaCubeX/mihomo/releases/tag/v1.19.99">v1.19.99</a></html>');
    }
    if (writeOut === '%{url_effective}') process.stdout.write(eff);
    process.exit(0);
  }
  if (url.includes('mihomo-android-arm64-v8-v1.19.99.gz')) {
    const buf = fs.readFileSync(${JSON.stringify(gzAssetPath)});
    if (hdrFile) fs.writeFileSync(hdrFile, 'HTTP/1.1 200 OK\\r\\nContent-Length: ' + buf.length + '\\r\\n\\r\\n');
    if (outFile) fs.writeFileSync(outFile, buf);
    else process.stdout.write(buf);
    process.exit(0);
  }
  process.exit(22);
}

// Subscription mock fixtures
const fixtures = {
  'https://sub.test/valid.yaml': [
    'port: 7890',
    'socks-port: 7891',
    'allow-lan: false',
    'ipv6: true',
    'tcp-concurrent: true',
    'tun:',
    '  enable: true',
    '  stack: mixed',
    '  auto-route: true',
    '  dns-hijack:',
    '    - any:53',
    'dns:',
    '  enable: false',
    '  ipv6: true',
    '  listen: 127.0.0.1:53',
    '  nameserver:',
    '    - 8.8.8.8',
    'proxies:',
    '  - { name: HK-01, type: ss, server: 1.2.3.4, port: 443, cipher: aes-128-gcm, password: pass }',
    '  - { name: JP-01, type: ss, server: 1.2.3.5, port: 443, cipher: aes-128-gcm, password: pass }',
    'proxy-groups:',
    '  - name: PROXY',
    '    type: select',
    '    proxies: [HK-01, JP-01, DIRECT]',
    'rules:',
    '  - MATCH,PROXY',
    '',
  ].join('\\n'),
  'https://sub.test/no-dns.yaml': 'proxies:\\n  - { name: SG-01, type: ss, server: 2.2.2.2, port: 443 }\\nrules:\\n  - MATCH,DIRECT\\n',
  'https://sub.test/invalid-html.yaml': '<html><body>Subscription expired</body></html>',
  'https://sub.test/fail-check.yaml': 'proxies:\\n  - { name: BAD, type: ss }\\n# INVALID_CONFIG_MARKER\\n',
};

if (Object.prototype.hasOwnProperty.call(fixtures, url)) {
  if (outFile) fs.writeFileSync(outFile, fixtures[url]);
  else process.stdout.write(fixtures[url]);
  process.exit(0);
}

process.stderr.write('curl: (22) 404 Not Found: ' + url + '\\n');
process.exit(22);
`, { mode: 0o755 });

  const baseEnv = {
    ...process.env,
    PATH: `${mockBinDir}:${process.env.PATH}`,
    ROOT: rootDir,
    LOG: path.join(tmpDir, 'mihomo.log'),
    SUB_LOG: path.join(tmpDir, 'mihomo-sub.log'),
    INSTALL_LOG: path.join(tmpDir, 'mihomo-install.log'),
    MIHOMO_START_WAIT: '1',
    CURL: mockCurlPath,
  };

  const getHits = () => (fs.existsSync(hitsLog) ? fs.readFileSync(hitsLog, 'utf8').trim().split('\n').filter(Boolean) : []);

  const cleanup = () => {
    try {
      const svc = path.join(rootDir, 'scripts', 'mihomo.service');
      if (fs.existsSync(svc)) {
        spawnSync('sh', [svc, 'stop'], { env: baseEnv, timeout: 5000 });
      }
    } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };

  return { tmpDir, mockBinDir, rootDir, uploadRoot, iptablesLog, ipLog, baseEnv, getHits, cleanup };
};

// ==================== PART 1: STATIC & SHELL TESTS ====================

await runTest('Static syntax, DOMParser <script> extraction & embedded script sync', async () => {
  execFileSync('node', ['--check', pluginPath]);
  execFileSync('sh', ['-n', servicePath]);
  execFileSync('sh', ['-n', updateSubPath]);

  const pluginJs = fs.readFileSync(pluginPath, 'utf8');
  const scriptMatch = pluginJs.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'mihomo-plugin.js must contain <script>...</script>');
  new Function(scriptMatch[1]);

  const svcB64 = pluginJs.match(/const SERVICE_SCRIPT_B64 = '([^']+)';/)?.[1];
  const subB64 = pluginJs.match(/const UPDATE_SUB_SCRIPT_B64 = '([^']+)';/)?.[1];
  assert.ok(svcB64 && subB64, 'Embedded base64 scripts must exist');
  assert.equal(Buffer.from(svcB64, 'base64').toString('utf8'), fs.readFileSync(servicePath, 'utf8'));
  assert.equal(Buffer.from(subB64, 'base64').toString('utf8'), fs.readFileSync(updateSubPath, 'utf8'));
});

await runTest('mihomo.service TProxy start / status / restart / stop & failure rollback', async () => {
  const env = createMockEnv();
  try {
    fs.mkdirSync(path.join(env.rootDir, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(env.rootDir, 'config'), { recursive: true });
    fs.mkdirSync(path.join(env.rootDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(env.rootDir, 'bin', 'mihomo'), makeMockMihomoScript(), { mode: 0o755 });
    fs.writeFileSync(path.join(env.rootDir, 'config', 'config.yaml'), 'mixed-port: 7890\n');
    const svc = path.join(env.rootDir, 'scripts', 'mihomo.service');
    fs.copyFileSync(servicePath, svc);
    fs.chmodSync(svc, 0o755);

    // Start (also verify oversized log is trimmed in-place via LOG_MAX_BYTES / LOG_KEEP_LINES)
    fs.writeFileSync(env.baseEnv.LOG, Array.from({ length: 50 }, (_, i) => `log-line-${i + 1}`).join('\n') + '\n');
    const startRes = await runAsync('sh', [svc, 'start'], {
      env: { ...env.baseEnv, LOG_MAX_BYTES: '100', LOG_KEEP_LINES: '5' },
      timeout: 10000,
    });
    assert.equal(startRes.status, 0, startRes.stdout + startRes.stderr);
    assert.match(startRes.stdout, /TProxy 启动成功/);
    const trimmedLines = fs.readFileSync(env.baseEnv.LOG, 'utf8').trim().split('\n');
    assert.equal(trimmedLines.length, 5, 'Oversized log must be trimmed to LOG_KEEP_LINES');
    assert.equal(trimmedLines[trimmedLines.length - 1], 'log-line-50');
    const iptLog = fs.readFileSync(env.iptablesLog, 'utf8');
    assert.match(iptLog, /-t mangle -A MIHOMO -p udp --dport 443 -j RETURN/);
    assert.match(iptLog, /-t mangle -A MIHOMO -p tcp -j TPROXY --on-ip 127\.0\.0\.1 --on-port 7893/);
    assert.match(iptLog, /-t mangle -I PREROUTING 1 -i br0 -m socket --transparent -j MIHOMO_DIVERT/);
    assert.match(iptLog, /-I FORWARD 1 -i br0 -p udp --dport 443 -j REJECT/);
    assert.match(iptLog, /ip6tables -w 10 -t mangle -A MIHOMO6 -d fc00::\/18 -p tcp -j TPROXY --on-ip ::1 --on-port 7893/);
    assert.match(iptLog, /ip6tables -w 10 -t mangle -A MIHOMO6 -d fc00::\/7 -j RETURN/);
    assert.match(iptLog, /ip6tables -w 10 -t mangle -I PREROUTING 1 -i br0 -m socket --transparent -j MIHOMO6_DIVERT/);
    assert.match(iptLog, /-t nat -A MIHOMO_DNS -p udp --dport 53 -j REDIRECT --to-ports 1053/);

    assert.equal((await runAsync('sh', [svc, 'status'], { env: env.baseEnv })).status, 0);
    assert.equal((await runAsync('sh', [svc, 'restart'], { env: env.baseEnv })).status, 0);
    assert.equal((await runAsync('sh', [svc, 'status'], { env: env.baseEnv })).status, 0);
    assert.equal((await runAsync('sh', [svc, 'stop'], { env: env.baseEnv })).status, 0);
    assert.notEqual((await runAsync('sh', [svc, 'status'], { env: env.baseEnv })).status, 0);

    const failRes = await runAsync('sh', [svc, 'start'], {
      env: { ...env.baseEnv, MOCK_IPTABLES_FAIL: '1' },
      timeout: 10000,
    });
    assert.notEqual(failRes.status, 0);
    assert.match(failRes.stdout, /已回滚/);
    assert.notEqual((await runAsync('sh', [svc, 'status'], { env: env.baseEnv })).status, 0);
  } finally {
    env.cleanup();
  }
});

await runTest('update-sub.sh import, YAML merge, validation rollback & scheduled daemon', async () => {
  const env = createMockEnv();
  try {
    fs.mkdirSync(path.join(env.rootDir, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(env.rootDir, 'config'), { recursive: true });
    fs.mkdirSync(path.join(env.rootDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(env.rootDir, 'bin', 'mihomo'), makeMockMihomoScript(), { mode: 0o755 });
    const cfgPath = path.join(env.rootDir, 'config', 'config.yaml');
    fs.writeFileSync(cfgPath, "mixed-port: 7890\nsecret: 'keep-my-secret'\n");
    const svc = path.join(env.rootDir, 'scripts', 'mihomo.service');
    const subSh = path.join(env.rootDir, 'scripts', 'update-sub.sh');
    fs.copyFileSync(servicePath, svc); fs.chmodSync(svc, 0o755);
    fs.copyFileSync(updateSubPath, subSh); fs.chmodSync(subSh, 0o755);

    const subCfgPath = path.join(env.rootDir, 'config', 'subscriptions.json');
    const statusPath = path.join(env.rootDir, 'run', 'sub_status.json');

    // 1) Valid YAML with existing DNS & conflicting port: 7890
    fs.writeFileSync(subCfgPath, JSON.stringify({ url: 'https://sub.test/valid.yaml', ua: 'clash-verge/v1.7.7', autoPatch: true }));
    let res = await runAsync('sh', [subSh, 'run'], { env: env.baseEnv, timeout: 15000 });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const merged1 = fs.readFileSync(cfgPath, 'utf8');
    assert.match(merged1, /^mixed-port: 7890$/m);
    assert.match(merged1, /^tproxy-port: 7893$/m);
    assert.match(merged1, /^ipv6: true$/m);
    assert.match(merged1, /^log-level: error$/m);
    assert.match(merged1, /^find-process-mode: off$/m);
    assert.match(merged1, /^tcp-concurrent: false$/m);
    assert.match(merged1, /^unified-delay: false$/m);
    assert.match(merged1, /^keep-alive-idle: 60$/m);
    assert.match(merged1, /^keep-alive-interval: 60$/m);
    assert.match(merged1, /^geodata-loader: memconservative$/m);
    assert.match(merged1, /^tun:\n  enable: false$/m);
    assert.doesNotMatch(merged1, /stack: mixed/);
    assert.doesNotMatch(merged1, /auto-route: true/);
    assert.match(merged1, /^secret: 'keep-my-secret'$/m);
    assert.match(merged1, /^  listen: 0\.0\.0\.0:1053$/m);
    assert.match(merged1, /^  enable: true$/m);
    assert.match(merged1, /^  ipv6: true$/m);
    assert.doesNotMatch(merged1, /^port: 7890$/m);
    assert.doesNotMatch(merged1, /^socks-port: 7891$/m);
    const st1 = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    assert.equal(st1.status, 'ok');
    assert.ok(st1.proxies >= 2);

    // 2) Valid YAML without DNS block -> appends fallback DNS
    fs.writeFileSync(subCfgPath, JSON.stringify({ url: 'https://sub.test/no-dns.yaml', autoPatch: true }));
    res = await runAsync('sh', [subSh, 'run'], { env: env.baseEnv, timeout: 15000 });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const merged2 = fs.readFileSync(cfgPath, 'utf8');
    assert.match(merged2, /dns:\n  enable: true\n  listen: 0\.0\.0\.0:1053/);

    // 3) Invalid HTML subscription -> fails & preserves config.yaml
    const beforeFail = fs.readFileSync(cfgPath, 'utf8');
    fs.writeFileSync(subCfgPath, JSON.stringify({ url: 'https://sub.test/invalid-html.yaml', autoPatch: true }));
    res = await runAsync('sh', [subSh, 'run'], { env: env.baseEnv, timeout: 15000 });
    assert.notEqual(res.status, 0);
    assert.equal(fs.readFileSync(cfgPath, 'utf8'), beforeFail);

    // 4) Fails mihomo -t -> fails & preserves config.yaml
    fs.writeFileSync(subCfgPath, JSON.stringify({ url: 'https://sub.test/fail-check.yaml', autoPatch: true }));
    res = await runAsync('sh', [subSh, 'run'], { env: env.baseEnv, timeout: 15000 });
    assert.notEqual(res.status, 0);
    assert.equal(fs.readFileSync(cfgPath, 'utf8'), beforeFail);

    // 5) Scheduled daemon auto-update (real background loop!)
    const hitsBefore = env.getHits().length;
    fs.writeFileSync(subCfgPath, JSON.stringify({
      url: 'https://sub.test/valid.yaml',
      autoPatch: true,
      autoUpdate: true,
      intervalHours: 24,
    }));
    const schedEnv = { ...env.baseEnv, SUB_INTERVAL_SECONDS: '1', SUB_SCHEDULER_TICK: '1' };
    res = await runAsync('sh', [svc, 'sub-start'], { env: schedEnv, timeout: 10000 });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal((await runAsync('sh', [svc, 'sub-status'], { env: schedEnv })).status, 0);

    await new Promise((r) => setTimeout(r, 2600));
    assert.ok(env.getHits().length > hitsBefore, 'Scheduled daemon must automatically fetch subscription');

    res = await runAsync('sh', [svc, 'sub-stop'], { env: schedEnv, timeout: 10000 });
    assert.equal(res.status, 0);
    assert.notEqual((await runAsync('sh', [svc, 'sub-status'], { env: schedEnv })).status, 0);
  } finally {
    env.cleanup();
  }
});

// ==================== PART 2: FULL FRONTEND PLUGIN INTEGRATION TESTS ====================

class MockElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.id = '';
    this.classList = {
      _set: new Set(),
      add(...cs) { cs.forEach((c) => this._set.add(c)); },
      contains(c) { return this._set.has(c); },
    };
    this.style = { cssText: '' };
    this.children = [];
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.src = '';
    this.onclick = null;
    this.onchange = null;
    this._html = '';
  }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.children.push(node); return node; }
  click() { if (this.onclick) return this.onclick({ target: this }); }
  insertAdjacentHTML(_pos, html) {
    this._html += html;
    const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    for (const id of ids) {
      if (!this._doc.byId.has(id)) {
        const el = new MockElement('div');
        el.id = id;
        el._doc = this._doc;
        this._doc.byId.set(id, el);
      }
    }
  }
  querySelector(sel) {
    if (sel.startsWith('#')) return this._doc?.byId.get(sel.slice(1)) || null;
    if (sel.startsWith('.')) {
      const cls = sel.slice(1);
      if (!this._byClass) this._byClass = new Map();
      if (!this._byClass.has(cls)) {
        const el = new MockElement('div');
        el._doc = this._doc;
        this._byClass.set(cls, el);
      }
      return this._byClass.get(cls);
    }
    return null;
  }
  querySelectorAll(sel) {
    if (sel === 'button') return this.children.filter((c) => c.tagName === 'BUTTON');
    return [];
  }
}

const mountPluginHarness = async (env) => {
  const toasts = [];
  const fixedToasts = new Map();
  let uploadSeq = 0;
  const doc = {
    byId: new Map(),
    createElement(tag) {
      const el = new MockElement(tag);
      el._doc = doc;
      return el;
    },
    querySelector(sel) {
      if (sel === '.functions-container') return anchor;
      if (sel.startsWith('#')) return doc.byId.get(sel.slice(1)) || null;
      return null;
    },
  };
  const anchor = doc.createElement('div');

  const store = new Map();
  const mockFetch = async (url, init = {}) => {
    if (String(url).endsWith('/upload_img') && init.method === 'POST') {
      uploadSeq += 1;
      const file = init.body.get('file');
      const buf = Buffer.from(await file.arrayBuffer());
      const fname = `upload_${Date.now()}_${uploadSeq}.bin`;
      fs.mkdirSync(path.join(env.uploadRoot, 'uploads'), { recursive: true });
      fs.writeFileSync(path.join(env.uploadRoot, 'uploads', fname), buf);
      return {
        ok: true,
        status: 200,
        json: async () => ({ url: `/uploads/${fname}` }),
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const sandboxGlobals = {
    window: {
      UFI_DATA: { lan_ipaddr: '192.168.0.1' },
      __MIHOMO_PLUGIN_CONFIG__: {
        ROOT: env.rootDir,
        LOG: env.baseEnv.LOG,
        SUB_LOG: env.baseEnv.SUB_LOG,
        INSTALL_LOG: env.baseEnv.INSTALL_LOG,
        BOOT: path.join(env.tmpDir, 'ufi_tools_boot.sh'),
        CURL: env.baseEnv.CURL,
        UPLOAD_ROOT: env.uploadRoot,
        GITHUB_RELEASE_BASE: 'https://github.com/MetaCubeX/mihomo/releases',
        GITHUB_API_LATEST: 'https://mirror1.test/api-disabled',
        MIRROR_PRESETS: [
          { label: 'Mirror 1 (Failing 502)', value: 'https://mirror1.test/' },
          { label: 'Mirror 2 (Working)', value: 'https://mirror2.test/' },
          { label: '自定义镜像源…', value: 'custom' },
        ],
      },
    },
    document: doc,
    UFI_DATA: { lan_ipaddr: '192.168.0.1' },
    KANO_baseURL: '/api',
    common_headers: {},
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    createToast: (msg, color = '') => toasts.push({ msg: String(msg), color }),
    createFixedToast: (id, html) => {
      const el = doc.createElement('div');
      el._html = html;
      const modal = { el, close: () => fixedToasts.delete(id) };
      fixedToasts.set(id, modal);
      return modal;
    },
    collapseGen: () => {},
    // Match real UFI-TOOLS v4.1.5 /api/root_shell behavior: HTTP 200 always sets success:true regardless of shell exit code!
    runShellWithRoot: async (cmd) => {
      const res = await runAsync('sh', ['-c', cmd], { env: env.baseEnv, timeout: 30000 });
      const content = `${res.stdout || ''}${res.stderr || ''}`;
      return { success: true, content };
    },
    fetch: mockFetch,
    FormData: globalThis.FormData,
    File: globalThis.File,
    Blob: globalThis.Blob,
    URL: globalThis.URL,
    URLSearchParams: globalThis.URLSearchParams,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    btoa: globalThis.btoa,
    atob: globalThis.atob,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };

  const pluginJs = fs.readFileSync(pluginPath, 'utf8');
  const scriptCode = pluginJs.match(/<script>([\s\S]*?)<\/script>/)[1];
  const keys = Object.keys(sandboxGlobals);
  const runner = new Function(...keys, scriptCode);
  runner(...keys.map((k) => sandboxGlobals[k]));

  await new Promise((r) => setTimeout(r, 300));
  const actionsBox = doc.querySelector('#mihomo_actions');
  assert.ok(actionsBox, 'Plugin must mount #mihomo_actions');

  const getBtn = (label) => {
    const btn = actionsBox.children.find((c) => c.tagName === 'BUTTON' && c.textContent === label);
    assert.ok(btn, `Button "${label}" must exist`);
    return btn;
  };
  const coreInput = actionsBox.children.find((c) => c.tagName === 'INPUT' && c.accept === '.gz,*/*');
  assert.ok(coreInput, 'coreInput must exist');

  return { doc, toasts, fixedToasts, getBtn, coreInput };
};

await runTest('Frontend E2E: GitHub mirror fallback install -> Sub import & scheduler -> Boot -> 3-click Uninstall', async () => {
  const env = createMockEnv();
  try {
    const ui = await mountPluginHarness(env);

    // 0) Before install: clicking "启动" must show clear toast (never silent), and "导入/订阅设置" must open!
    await ui.getBtn('启动').click();
    assert.ok(ui.toasts.some((t) => t.color === 'red' && t.msg.includes('尚未安装 mihomo')), 'Uninstalled action must toast');
    await ui.getBtn('导入/订阅设置').click();
    assert.ok(ui.fixedToasts.get('mihomo_subscriptions'), 'Subscription modal should open even before install');
    ui.fixedToasts.get('mihomo_subscriptions').close();

    // 1) Click "安装/在线更新内核" -> Mirror 1 fails (502) -> falls back to Mirror 2 -> installs & starts!
    await ui.getBtn('安装/在线更新内核').click();
    const installModal = ui.fixedToasts.get('mihomo_install_dialog');
    assert.ok(installModal, 'Install modal should open');
    const installPromise = installModal.el.querySelector('.start_install').onclick();
    const dismissTimer = setInterval(() => {
      const doneDlg = ui.fixedToasts.get('mihomo_installed');
      if (doneDlg) doneDlg.el.querySelector('.ok').onclick();
    }, 100);
    await installPromise;
    clearInterval(dismissTimer);

    const hits = env.getHits();
    assert.ok(hits.some((h) => h.startsWith('https://mirror1.test/')), 'Should try Mirror 1 first');
    assert.ok(hits.some((h) => h.startsWith('https://mirror2.test/') && h.includes('mihomo-android-arm64-v8-v1.19.99.gz')), 'Should fall back to Mirror 2 and download .gz');
    assert.ok(fs.existsSync(path.join(env.rootDir, 'bin', 'mihomo')), 'mihomo binary installed');
    assert.ok(fs.existsSync(path.join(env.rootDir, 'config', 'config.yaml')), 'default config.yaml created');
    assert.match(fs.readFileSync(path.join(env.rootDir, 'config', 'config.yaml'), 'utf8'), /^secret: ''$/m, 'Default install must have empty secret');
    assert.match(ui.doc.querySelector('#running_mihomo').textContent, /🟢 运行中/);

    // 1a) Test live-log Stop & Start buttons via UI
    await ui.getBtn('停止').click();
    assert.match(ui.doc.querySelector('#running_mihomo').textContent, /🔴 已停止/);
    await ui.getBtn('启动').click();
    assert.match(ui.doc.querySelector('#running_mihomo').textContent, /🟢 运行中/);

    // 1b) Change & clear Dashboard password via "面板密码" button
    await ui.getBtn('面板密码').click();
    const secModal = ui.fixedToasts.get('mihomo_secret_dialog');
    assert.ok(secModal, 'Secret modal should open');
    secModal.el.querySelector('.secret_input').value = 'my-new-pass';
    await secModal.el.querySelector('.save').onclick();
    assert.match(fs.readFileSync(path.join(env.rootDir, 'config', 'config.yaml'), 'utf8'), /^secret: 'my-new-pass'$/m);

    await ui.getBtn('面板密码').click();
    const secModal2 = ui.fixedToasts.get('mihomo_secret_dialog');
    secModal2.el.querySelector('.clear_btn').onclick();
    await secModal2.el.querySelector('.save').onclick();
    assert.match(fs.readFileSync(path.join(env.rootDir, 'config', 'config.yaml'), 'utf8'), /^secret: ''$/m);

    // 2) Open "导入/订阅设置" -> save URL + autoUpdate=true + interval=12h -> "保存并立即导入"
    await ui.getBtn('导入/订阅设置').click();
    const subModal = ui.fixedToasts.get('mihomo_subscriptions');
    assert.ok(subModal, 'Subscription modal should open');
    subModal.el.querySelector('.sub_url').value = 'https://sub.test/valid.yaml';
    subModal.el.querySelector('.sub_ua').value = 'clash-verge/v1.7.7';
    subModal.el.querySelector('.auto_patch').checked = true;
    subModal.el.querySelector('.auto_update').checked = true;
    subModal.el.querySelector('.interval_select').value = '12';
    await subModal.el.querySelector('.save_and_import').onclick();

    const subCfg = JSON.parse(fs.readFileSync(path.join(env.rootDir, 'config', 'subscriptions.json'), 'utf8'));
    assert.equal(subCfg.autoUpdate, true);
    assert.equal(subCfg.intervalHours, 12);
    const updatedYaml = fs.readFileSync(path.join(env.rootDir, 'config', 'config.yaml'), 'utf8');
    assert.match(updatedYaml, /HK-01/);
    assert.match(updatedYaml, /^tproxy-port: 7893$/m);
    assert.match(updatedYaml, /^  listen: 0\.0\.0\.0:1053$/m);
    assert.match(ui.doc.querySelector('#running_mihomo').textContent, /定时订阅: 每12h/);

    // 3) Toggle Boot on & off
    const bootFile = path.join(env.tmpDir, 'ufi_tools_boot.sh');
    await ui.getBtn('开机自启').click();
    assert.match(fs.readFileSync(bootFile, 'utf8'), /mihomo\.service start/);
    await ui.getBtn('开机自启').click();
    assert.doesNotMatch(fs.readFileSync(bootFile, 'utf8'), /mihomo\.service start/);

    // 4) 3-click Uninstall safety
    await ui.getBtn('卸载').click();
    assert.ok(fs.existsSync(env.rootDir), '1st click must not uninstall');
    await ui.getBtn('卸载').click();
    assert.ok(fs.existsSync(env.rootDir), '2nd click must not uninstall');
    await ui.getBtn('卸载').click();
    assert.ok(!fs.existsSync(env.rootDir), '3rd click must remove /data/mihomo');
  } finally {
    env.cleanup();
  }
});

await runTest('Frontend E2E: Manual Kernel Upload (invalid rejection, offline .gz bootstrap, .gz upgrade, failed-check rollback)', async () => {
  const env = createMockEnv();
  try {
    const ui = await mountPluginHarness(env);

    // 1) Reject invalid file (plain text)
    const badFile = new File(['not an elf or gzip'], 'bad.txt');
    await ui.coreInput.onchange({ target: { files: [badFile] } });
    assert.ok(ui.toasts.some((t) => t.color === 'red' && t.msg.includes('ELF')), 'Invalid file must be rejected');
    assert.ok(!fs.existsSync(path.join(env.rootDir, 'bin', 'mihomo')));

    // 2) Offline fresh install via .gz upload (when mihomo is NOT installed yet!)
    const gzV1 = zlib.gzipSync(Buffer.from(makeMockMihomoScript('v1.19.50-offline')));
    const gzFileV1 = new File([gzV1], 'mihomo-android-arm64-v8-v1.19.50.gz');
    const dismissTimer = setInterval(() => {
      const dlg = ui.fixedToasts.get('mihomo_uploaded_installed');
      if (dlg) dlg.el.querySelector('.ok').onclick();
    }, 100);
    await ui.coreInput.onchange({ target: { files: [gzFileV1] } });
    clearInterval(dismissTimer);

    assert.ok(fs.existsSync(path.join(env.rootDir, 'bin', 'mihomo')), 'Offline .gz upload must install mihomo');
    assert.match(execFileSync(path.join(env.rootDir, 'bin', 'mihomo'), ['-v']).toString(), /v1\.19\.50-offline/);
    assert.match(ui.doc.querySelector('#running_mihomo').textContent, /🟢 运行中/);

    // 3) Upgrade existing install via .gz upload (v2)
    const gzV2 = zlib.gzipSync(Buffer.from(makeMockMihomoScript('v1.19.60-upgraded')));
    const gzFileV2 = new File([gzV2], 'mihomo-android-arm64-v8-v1.19.60.gz');
    await ui.coreInput.onchange({ target: { files: [gzFileV2] } });
    assert.match(execFileSync(path.join(env.rootDir, 'bin', 'mihomo'), ['-v']).toString(), /v1\.19\.60-upgraded/);

    // 4) Upload broken kernel (fails -t) -> rejected & v2 remains untouched!
    const gzBroken = zlib.gzipSync(Buffer.from(makeMockMihomoScript('v9.9.9-broken', true)));
    const gzFileBroken = new File([gzBroken], 'mihomo-broken.gz');
    await ui.coreInput.onchange({ target: { files: [gzFileBroken] } });
    assert.match(execFileSync(path.join(env.rootDir, 'bin', 'mihomo'), ['-v']).toString(), /v1\.19\.60-upgraded/);
  } finally {
    env.cleanup();
  }
});

console.log(`\nALL ${passed.length} TESTS PASSED!`);
