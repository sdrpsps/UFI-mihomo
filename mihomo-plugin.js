// Unofficial Mihomo (Clash Meta) plugin for compatible ZTE UFI Tools environments.
// Supports GitHub mirror download, manual kernel upload (ELF / .gz), subscription import,
// scheduled auto-update, YAML editing/validation, and TProxy transparent proxy.
//<script>
(() => {
  'use strict';

  const ENV = (typeof window !== 'undefined' && window.__MIHOMO_PLUGIN_CONFIG__) || {};
  const ROOT = ENV.ROOT || '/data/mihomo';
  const BIN = `${ROOT}/bin/mihomo`;
  const CONFIG_DIR = `${ROOT}/config`;
  const CONFIG = `${CONFIG_DIR}/config.yaml`;
  const SUB_CONFIG = `${CONFIG_DIR}/subscriptions.json`;
  const INSTALL_CONFIG = `${CONFIG_DIR}/install.json`;
  const SUB_DIR = `${ROOT}/subscriptions`;
  const DASHBOARD_DIR = `${CONFIG_DIR}/ui`;
  const SERVICE = `${ROOT}/scripts/mihomo.service`;
  const UPDATE_SUB_SCRIPT_PATH = `${ROOT}/scripts/update-sub.sh`;
  const SUB_STATUS_FILE = `${ROOT}/run/sub_status.json`;
  const LOG_DIR = `${ROOT}/logs`;
  const LOG = ENV.LOG || `${LOG_DIR}/mihomo.log`;
  const SUB_LOG = ENV.SUB_LOG || `${LOG_DIR}/sub.log`;
  const INSTALL_LOG = ENV.INSTALL_LOG || `${LOG_DIR}/install.log`;
  const BOOT = ENV.BOOT || '/sdcard/ufi_tools_boot.sh';
  const CURL = ENV.CURL || '/data/data/com.minikano.f50_sms/files/curl';
  const UPLOAD_ROOT = ENV.UPLOAD_ROOT || '/data/data/com.minikano.f50_sms/files';
  const API_PORT = ENV.API_PORT || 9090;
  const MIXED_PORT = ENV.MIXED_PORT || 7890;
  const TPROXY_PORT = ENV.TPROXY_PORT || 7893;
  const DNS_PORT = ENV.DNS_PORT || 1053;
  const GITHUB_RELEASE_BASE = ENV.GITHUB_RELEASE_BASE || 'https://github.com/MetaCubeX/mihomo/releases';
  const GITHUB_API_LATEST = ENV.GITHUB_API_LATEST || 'https://api.github.com/repos/MetaCubeX/mihomo/releases/latest';
  const ZASHBOARD_RAW_URL = 'https://github.com/Zephyruso/zashboard/releases/latest/download/dist.zip';

  const MIRROR_PRESETS = ENV.MIRROR_PRESETS || [
    { label: 'gh-proxy.org（推荐）', value: 'https://gh-proxy.org/' },
    { label: 'ghfast.top', value: 'https://ghfast.top/' },
    { label: 'ghproxy.net', value: 'https://ghproxy.net/' },
    { label: 'mirror.ghproxy.com', value: 'https://mirror.ghproxy.com/' },
    { label: '直连 GitHub（无镜像）', value: '' },
    { label: '自定义镜像源…', value: 'custom' },
  ];

  const normalizeMirrorPrefix = (raw = '') => {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return '';
    return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
  };

  const applyMirror = (url, mirrorPrefix = '') => {
    const prefix = normalizeMirrorPrefix(mirrorPrefix);
    return prefix ? `${prefix}${url}` : url;
  };

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const randomString = (length = 16) => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let value = '';
    for (let i = 0; i < length; i++) value += chars[Math.floor(Math.random() * chars.length)];
    return value;
  };
  const escapeHtml = (value = '') => String(value)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  const shQuote = (value = '') => `'${String(value).replaceAll("'", `'"'"'`)}'`;
  const shell = async (command, timeout = 100000) => {
    const marker = '__MIHOMO_RC__=';
    const wrapped = `(\n${command}\n)\nprintf '\\n${marker}%s\\n' $?`;
    const res = await runShellWithRoot(wrapped, timeout);
    if (!res || !res.success) return res || { success: false, content: 'root_shell 调用失败' };
    const raw = String(res.content ?? '');
    const match = raw.match(/\n?__MIHOMO_RC__=(\d+)\s*$/);
    if (!match) return { success: true, content: raw };
    const rc = Number(match[1]);
    const content = raw.slice(0, match.index).replace(/\n$/, '');
    return { success: rc === 0, content, exitCode: rc };
  };
  const utf8ToBase64 = (value) => {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  };

  const lsGet = (key, fallback = '') => {
    try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch { return fallback; }
  };
  const lsSet = (key, value) => {
    try { localStorage.setItem(key, value); } catch { /* ignore */ }
  };

  const requireRoot = async () => {
    const res = await shell('whoami');
    if (res.success && /^root$/m.test((res.content || '').trim())) return true;
    createToast('没有开启高级功能或未取得 root 权限。', 'red');
    return false;
  };

  const isInstalled = async () => {
    const res = await shell(`test -x ${BIN} && test -x ${SERVICE} && echo installed`);
    return !!(res.success && (res.content || '').includes('installed'));
  };

  const requireInstalled = async () => {
    if (await isInstalled()) return true;
    createToast('尚未安装 mihomo，请先点击“安装/在线更新内核”', 'red');
    return false;
  };
  const requireReady = async () => (await requireRoot()) && (await requireInstalled());

  const readJsonFile = async (path, fallback = {}) => {
    const res = await shell(`test -f ${shQuote(path)} && cat ${shQuote(path)} || echo '{}'`);
    try {
      const parsed = JSON.parse((res.content || '{}').trim() || '{}');
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
      return fallback;
    }
  };

  const writeJsonFile = async (path, obj) => {
    const encoded = utf8ToBase64(JSON.stringify(obj, null, 2));
    const dir = path.slice(0, path.lastIndexOf('/'));
    const res = await shell(`mkdir -p ${shQuote(dir)} && echo ${shQuote(encoded)} | base64 -d > ${shQuote(path)} && chmod 600 ${shQuote(path)}`);
    if (!res.success) throw new Error(res.content || `写入 ${path} 失败`);
  };

  const isRunning = async () => {
    const res = await shell(`
      RUN=0; SUB=0; HOURS=""
      if test -x ${SERVICE} && sh ${SERVICE} status 2>/dev/null; then RUN=1; fi
      if test -x ${SERVICE} && sh ${SERVICE} sub-status 2>/dev/null; then SUB=1; fi
      if test -f ${SUB_CONFIG}; then
        HOURS=$(sed -n 's/.*"intervalHours"[[:space:]]*:[[:space:]]*\\([0-9]*\\).*/\\1/p' ${SUB_CONFIG} | head -n 1)
      fi
      printf 'RUN=%s SUB=%s HOURS=%s\\n' "$RUN" "$SUB" "$HOURS"
    `);
    const out = res.content || '';
    const running = /RUN=1/.test(out);
    const subRunning = /SUB=1/.test(out);
    const hoursMatch = out.match(/HOURS=(\d+)/);
    const hours = hoursMatch ? hoursMatch[1] : '24';
    const label = document.querySelector('#running_mihomo');
    if (label) {
      const subBadge = subRunning ? ` | 定时订阅: 每${hours}h` : '';
      label.textContent = running
        ? `mihomo 🟢 运行中${subBadge}`
        : `mihomo 🔴 已停止${subBadge}`;
    }
    return running;
  };

  const isBootEnabled = async () => {
    const res = await shell(`grep -qF '${SERVICE} start' ${BOOT} 2>/dev/null; echo $?`);
    return (res.content || '').trim().split(/\s+/).pop() === '0';
  };

  const refreshBootButton = async () => {
    const button = document.querySelector('#mihomo_boot');
    if (button) button.style.background = (await isBootEnabled()) ? 'var(--dark-btn-color-active)' : '';
  };

  const confirmDialog = (id, title, body, ok = '确认', cancel = '取消') => new Promise((resolve) => {
    const { el, close } = createFixedToast(id, `
      <div style="pointer-events:all;width:90vw;max-width:560px">
        <div class="title" style="margin:0">${escapeHtml(title)}</div>
        <div style="margin-top:10px;font-size:.7rem;line-height:1.75">${body}</div>
        <div style="margin-top:14px;text-align:right;display:flex;justify-content:flex-end;gap:10px">
          <button class="ok">${escapeHtml(ok)}</button><button class="cancel">${escapeHtml(cancel)}</button>
        </div>
      </div>`);
    const done = (answer) => { close(); resolve(answer); };
    el.querySelector('.ok').onclick = () => done(true);
    el.querySelector('.cancel').onclick = () => done(false);
  });

  const showLog = (initial = '', initialMode = 'core') => {
    let timer = null;
    let autoScroll = true;
    let mode = initialMode;
    const currentPath = () => (mode === 'sub' ? SUB_LOG : (mode === 'install' ? INSTALL_LOG : LOG));
    const id = `mihomo_log_${randomString(5)}`;
    const { el, close } = createFixedToast(id, `
      <div style="pointer-events:all;width:86vw;max-width:850px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <div class="title log_title" style="margin:0">mihomo 内核日志（最后 200 行）</div>
          <div style="display:flex;gap:6px">
            <button class="tab_core">内核日志</button>
            <button class="tab_sub">订阅日志</button>
            <button class="tab_install">安装日志</button>
          </div>
        </div>
        <pre class="log" style="background:#000d;color:#0f0;box-sizing:border-box;line-height:1.4;margin:10px 0;padding:8px;max-height:430px;overflow:auto;font-size:.64rem;white-space:pre-wrap">${escapeHtml(initial)}</pre>
        <div style="text-align:right;display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
          <button class="download">下载</button><button class="scroll">暂停滚动</button>
          <button class="refresh">刷新</button><button class="clear">清空</button><button class="close">关闭</button>
        </div>
      </div>`);
    const logEl = el.querySelector('.log');
    const titleEl = el.querySelector('.log_title');
    const tabCore = el.querySelector('.tab_core');
    const tabSub = el.querySelector('.tab_sub');
    const tabInstall = el.querySelector('.tab_install');

    const updateTabUI = () => {
      const titles = {
        core: 'mihomo 内核日志（最后 200 行）',
        sub: 'mihomo 订阅日志（最后 200 行）',
        install: 'mihomo 安装日志（最后 200 行）',
      };
      titleEl.textContent = titles[mode] || titles.core;
      tabCore.style.background = mode === 'core' ? 'var(--dark-btn-color-active)' : '';
      tabSub.style.background = mode === 'sub' ? 'var(--dark-btn-color-active)' : '';
      tabInstall.style.background = mode === 'install' ? 'var(--dark-btn-color-active)' : '';
    };

    const refresh = async (notify = false) => {
      const res = await shell(`tail -n 200 ${shQuote(currentPath())} 2>/dev/null`);
      logEl.textContent = res.content || '(暂无日志)';
      if (autoScroll) logEl.scrollTop = logEl.scrollHeight;
      if (notify) createToast('日志已刷新', 'green');
    };

    tabCore.onclick = () => { mode = 'core'; updateTabUI(); refresh(); };
    tabSub.onclick = () => { mode = 'sub'; updateTabUI(); refresh(); };
    tabInstall.onclick = () => { mode = 'install'; updateTabUI(); refresh(); };
    el.querySelector('.refresh').onclick = () => refresh(true);
    el.querySelector('.clear').onclick = async () => {
      const res = await shell(`: > ${shQuote(currentPath())}`);
      if (res.success) { logEl.textContent = ''; createToast('日志已清空', 'green'); }
    };
    el.querySelector('.scroll').onclick = (event) => {
      autoScroll = !autoScroll;
      event.target.textContent = autoScroll ? '暂停滚动' : '自动滚动';
    };
    el.querySelector('.download').onclick = () => {
      const blob = new Blob([logEl.textContent], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.download = `mihomo-${mode}-log-${Date.now()}.txt`;
      a.href = url;
      a.click();
      URL.revokeObjectURL(url);
    };
    el.querySelector('.close').onclick = () => { if (timer) clearInterval(timer); close(); };
    updateTabUI();
    refresh();
    timer = setInterval(refresh, 1500);
  };

  // Embedded device-side scripts (synced from mihomo.service and update-sub.sh)
  const SERVICE_SCRIPT_B64 = 'IyEvc3lzdGVtL2Jpbi9zaAojIFVub2ZmaWNpYWwgTWlob21vIChDbGFzaCBNZXRhKSBUUHJveHkgc2VydmljZSBoZWxwZXIgZm9yIGNvbXBhdGlibGUgWlRFIFVGSSBUb29scyBlbnZpcm9ubWVudHMuCiMgUmV2aWV3IGludGVyZmFjZSBuYW1lcyBhbmQgZmlyZXdhbGwgcnVsZXMgYmVmb3JlIHVzZS4KUk9PVD0ke1JPT1Q6LS9kYXRhL21paG9tb30KQklOPSRST09UL2Jpbi9taWhvbW8KQ09ORklHX0RJUj0kUk9PVC9jb25maWcKQ09ORklHPSRDT05GSUdfRElSL2NvbmZpZy55YW1sClNVQl9DT05GSUc9JENPTkZJR19ESVIvc3Vic2NyaXB0aW9ucy5qc29uClNVQl9TQ1JJUFQ9JFJPT1Qvc2NyaXB0cy91cGRhdGUtc3ViLnNoClBJREZJTEU9JFJPT1QvcnVuL21paG9tby5waWQKU1VCX1BJREZJTEU9JFJPT1QvcnVuL21paG9tby1zdWIucGlkCkxPRz0ke0xPRzotJFJPT1QvbG9ncy9taWhvbW8ubG9nfQpTVUJfTE9HPSR7U1VCX0xPRzotJFJPT1QvbG9ncy9zdWIubG9nfQpMQU5fSUY9JHtMQU5fSUY6LWJyMH0KVFBST1hZX1BPUlQ9JHtUUFJPWFlfUE9SVDotNzg5M30KRE5TX1BPUlQ9JHtETlNfUE9SVDotMTA1M30KREFTSEJPQVJEX1BPUlQ9JHtEQVNIQk9BUkRfUE9SVDotOTA5MH0KTUlYRURfUE9SVD0ke01JWEVEX1BPUlQ6LTc4OTB9CkZXTUFSSz0ke0ZXTUFSSzotMHgyMDI0fQpST1VURV9UQUJMRT0ke1JPVVRFX1RBQkxFOi0yMDI0fQpTVEFSVF9XQUlUPSR7TUlIT01PX1NUQVJUX1dBSVQ6LTJ9CkxPR19NQVhfQllURVM9JHtMT0dfTUFYX0JZVEVTOi0yMDk3MTUyfQpMT0dfS0VFUF9MSU5FUz0ke0xPR19LRUVQX0xJTkVTOi0xMDAwfQpCTE9DS19RVUlDPSR7TUlIT01PX0JMT0NLX1FVSUM6LTF9CkVOQUJMRV9JUFY2PSR7TUlIT01PX0lQVjY6LTF9CkdPX01BWFBST0NTPSR7TUlIT01PX0dPTUFYUFJPQ1M6LTJ9CkdPX01FTUxJTUlUPSR7TUlIT01PX0dPTUVNTElNSVQ6LTEyOE1pQn0KR09fR0M9JHtNSUhPTU9fR09HQzotNTB9CkNQVV9NQVNLPSR7TUlIT01PX0NQVV9NQVNLOi1hdXRvfQoKdHJpbV9sb2coKSB7CiAgRj0iJDEiCiAgaWYgISB0ZXN0IC1mICIkRiI7IHRoZW4gcmV0dXJuIDA7IGZpCiAgU1o9JCh3YyAtYyA8ICIkRiIgMj4vZGV2L251bGwgfCB0ciAtZCAnIFxuJyB8fCBlY2hvIDApCiAgY2FzZSAiJFNaIiBpbiAnJ3wqWyEwLTldKikgU1o9MCA7OyBlc2FjCiAgaWYgdGVzdCAiJFNaIiAtZ3QgIiRMT0dfTUFYX0JZVEVTIjsgdGhlbgogICAgdGFpbCAtbiAiJExPR19LRUVQX0xJTkVTIiAiJEYiID4gIiRGLnRtcCIgMj4vZGV2L251bGwgJiYgY2F0ICIkRi50bXAiID4gIiRGIiAyPi9kZXYvbnVsbCB8fCA6ID4gIiRGIgogICAgcm0gLWYgIiRGLnRtcCIKICBmaQp9CgpyZXNvbHZlX3BpZCgpIHsKICBQRj0iJDEiCiAgUEFUVEVSTj0iJDIiCiAgUElEPSQoY2F0ICIkUEYiIDI+L2Rldi9udWxsKQogIGlmIHRlc3QgLXogIiRQSUQiIHx8ICEga2lsbCAtMCAiJFBJRCIgMj4vZGV2L251bGw7IHRoZW4KICAgIFBJRD0kKHBncmVwIC1mICIkUEFUVEVSTiIgMj4vZGV2L251bGwgfCBoZWFkIC1uIDEpCiAgZmkKICBpZiB0ZXN0IC1uICIkUElEIiAmJiBraWxsIC0wICIkUElEIiAyPi9kZXYvbnVsbDsgdGhlbgogICAgcHJpbnRmICclcycgIiRQSUQiCiAgICByZXR1cm4gMAogIGZpCiAgcmV0dXJuIDEKfQoKaXNfYXV0b191cGRhdGVfZW5hYmxlZCgpIHsKICB0ZXN0IC1mICIkU1VCX0NPTkZJRyIgJiYgZ3JlcCAtRXEgJyJhdXRvVXBkYXRlIltbOnNwYWNlOl1dKjpbWzpzcGFjZTpdXSp0cnVlJyAiJFNVQl9DT05GSUciIDI+L2Rldi9udWxsCn0KCnN0YXJ0X3N1Yl9zY2hlZHVsZXIoKSB7CiAgbWtkaXIgLXAgIiRST09UL3J1biIgIiRST09UL2xvZ3MiCiAgaWYgISB0ZXN0IC14ICIkU1VCX1NDUklQVCI7IHRoZW4gcmV0dXJuIDA7IGZpCiAgaWYgISBpc19hdXRvX3VwZGF0ZV9lbmFibGVkOyB0aGVuCiAgICBzdG9wX3N1Yl9zY2hlZHVsZXIgPi9kZXYvbnVsbCAyPiYxIHx8IHRydWUKICAgIHJldHVybiAwCiAgZmkKICBTUElEPSQocmVzb2x2ZV9waWQgIiRTVUJfUElERklMRSIgIiRTVUJfU0NSSVBUIGRhZW1vbiIgfHwgdHJ1ZSkKICBpZiB0ZXN0IC1uICIkU1BJRCI7IHRoZW4KICAgIGVjaG8gIiRTUElEIiA+ICIkU1VCX1BJREZJTEUiCiAgICBlY2hvICflrprml7borqLpmIXmm7TmlrDlt7LlnKjov5DooYwnCiAgICByZXR1cm4gMAogIGZpCiAgbm9odXAgc2ggIiRTVUJfU0NSSVBUIiBkYWVtb24gPj4gIiRTVUJfTE9HIiAyPiYxICYKICBlY2hvICIkISIgPiAiJFNVQl9QSURGSUxFIgogIGVjaG8gJ+WumuaXtuiuoumYheabtOaWsOW3suWQr+WKqCcKfQoKc3RvcF9zdWJfc2NoZWR1bGVyKCkgewogIFNQSUQ9JChyZXNvbHZlX3BpZCAiJFNVQl9QSURGSUxFIiAiJFNVQl9TQ1JJUFQgZGFlbW9uIiB8fCB0cnVlKQogIGlmIHRlc3QgLW4gIiRTUElEIjsgdGhlbgogICAga2lsbCAiJFNQSUQiIDI+L2Rldi9udWxsIHx8IHRydWUKICAgIHNsZWVwIDEKICAgIGtpbGwgLTkgIiRTUElEIiAyPi9kZXYvbnVsbCB8fCB0cnVlCiAgZmkKICBybSAtZiAiJFNVQl9QSURGSUxFIgogIGVjaG8gJ+WumuaXtuiuoumYheabtOaWsOW3suWBnOatoicKfQoKY2xlYW51cF90cHJveHkoKSB7CiAgaXB0YWJsZXMgLXcgMTAgLXQgbWFuZ2xlIC1EIFBSRVJPVVRJTkcgLWkgIiRMQU5fSUYiIC1tIHNvY2tldCAtLXRyYW5zcGFyZW50IC1qIE1JSE9NT19ESVZFUlQgMj4vZGV2L251bGwgfHwgdHJ1ZQogIGlwdGFibGVzIC13IDEwIC10IG1hbmdsZSAtRiBNSUhPTU9fRElWRVJUIDI+L2Rldi9udWxsIHx8IHRydWUKICBpcHRhYmxlcyAtdyAxMCAtdCBtYW5nbGUgLVggTUlIT01PX0RJVkVSVCAyPi9kZXYvbnVsbCB8fCB0cnVlCiAgaXB0YWJsZXMgLXcgMTAgLXQgbWFuZ2xlIC1EIFBSRVJPVVRJTkcgLWkgIiRMQU5fSUYiIC1qIE1JSE9NTyAyPi9kZXYvbnVsbCB8fCB0cnVlCiAgaXB0YWJsZXMgLXcgMTAgLXQgbWFuZ2xlIC1GIE1JSE9NTyAyPi9kZXYvbnVsbCB8fCB0cnVlCiAgaXB0YWJsZXMgLXcgMTAgLXQgbWFuZ2xlIC1YIE1JSE9NTyAyPi9kZXYvbnVsbCB8fCB0cnVlCiAgaXB0YWJsZXMgLXcgMTAgLXQgbmF0IC1EIFBSRVJPVVRJTkcgLWkgIiRMQU5fSUYiIC1qIE1JSE9NT19ETlMgMj4vZGV2L251bGwgfHwgdHJ1ZQogIGlwdGFibGVzIC13IDEwIC10IG5hdCAtRiBNSUhPTU9fRE5TIDI+L2Rldi9udWxsIHx8IHRydWUKICBpcHRhYmxlcyAtdyAxMCAtdCBuYXQgLVggTUlIT01PX0ROUyAyPi9kZXYvbnVsbCB8fCB0cnVlCiAgaXB0YWJsZXMgLXcgMTAgLUQgRk9SV0FSRCAtaSAiJExBTl9JRiIgLXAgdWRwIC0tZHBvcnQgNDQzIC1qIFJFSkVDVCAyPi9kZXYvbnVsbCB8fCB0cnVlCiAgaXB0YWJsZXMgLXcgMTAgLUQgRk9SV0FSRCAtaSAiJExBTl9JRiIgLXAgdWRwIC0tZHBvcnQgNDQzIC1qIERST1AgMj4vZGV2L251bGwgfHwgdHJ1ZQogIGlwdGFibGVzIC13IDEwIC1EIElOUFVUIC1pICIkTEFOX0lGIiAtcCB0Y3AgLS1kcG9ydCAiJERBU0hCT0FSRF9QT1JUIiAtaiBBQ0NFUFQgMj4vZGV2L251bGwgfHwgdHJ1ZQogIGlwdGFibGVzIC13IDEwIC1EIElOUFVUIC1pICIkTEFOX0lGIiAtcCB0Y3AgLS1kcG9ydCAiJE1JWEVEX1BPUlQiIC1qIEFDQ0VQVCAyPi9kZXYvbnVsbCB8fCB0cnVlCiAgaXB0YWJsZXMgLXcgMTAgLUQgSU5QVVQgLWkgIiRMQU5fSUYiIC1wIHRjcCAtLWRwb3J0ICIkRE5TX1BPUlQiIC1qIEFDQ0VQVCAyPi9kZXYvbnVsbCB8fCB0cnVlCiAgaXB0YWJsZXMgLXcgMTAgLUQgSU5QVVQgLWkgIiRMQU5fSUYiIC1wIHVkcCAtLWRwb3J0ICIkRE5TX1BPUlQiIC1qIEFDQ0VQVCAyPi9kZXYvbnVsbCB8fCB0cnVlCiAgd2hpbGUgaXAgcnVsZSBkZWwgZndtYXJrICIkRldNQVJLIiB0YWJsZSAiJFJPVVRFX1RBQkxFIiAyPi9kZXYvbnVsbDsgZG8gOjsgZG9uZQogIGlwIHJvdXRlIGZsdXNoIHRhYmxlICIkUk9VVEVfVEFCTEUiIDI+L2Rldi9udWxsIHx8IHRydWUKCiAgaWYgY29tbWFuZCAtdiBpcDZ0YWJsZXMgPi9kZXYvbnVsbCAyPiYxOyB0aGVuCiAgICBpcDZ0YWJsZXMgLXcgMTAgLXQgbWFuZ2xlIC1EIFBSRVJPVVRJTkcgLWkgIiRMQU5fSUYiIC1tIHNvY2tldCAtLXRyYW5zcGFyZW50IC1qIE1JSE9NTzZfRElWRVJUIDI+L2Rldi9udWxsIHx8IHRydWUKICAgIGlwNnRhYmxlcyAtdyAxMCAtdCBtYW5nbGUgLUYgTUlIT01PNl9ESVZFUlQgMj4vZGV2L251bGwgfHwgdHJ1ZQogICAgaXA2dGFibGVzIC13IDEwIC10IG1hbmdsZSAtWCBNSUhPTU82X0RJVkVSVCAyPi9kZXYvbnVsbCB8fCB0cnVlCiAgICBpcDZ0YWJsZXMgLXcgMTAgLXQgbWFuZ2xlIC1EIFBSRVJPVVRJTkcgLWkgIiRMQU5fSUYiIC1qIE1JSE9NTzYgMj4vZGV2L251bGwgfHwgdHJ1ZQogICAgaXA2dGFibGVzIC13IDEwIC10IG1hbmdsZSAtRiBNSUhPTU82IDI+L2Rldi9udWxsIHx8IHRydWUKICAgIGlwNnRhYmxlcyAtdyAxMCAtdCBtYW5nbGUgLVggTUlIT01PNiAyPi9kZXYvbnVsbCB8fCB0cnVlCiAgICBpcDZ0YWJsZXMgLXcgMTAgLUQgRk9SV0FSRCAtaSAiJExBTl9JRiIgLXAgdWRwIC0tZHBvcnQgNDQzIC1qIFJFSkVDVCAyPi9kZXYvbnVsbCB8fCB0cnVlCiAgICBpcDZ0YWJsZXMgLXcgMTAgLUQgRk9SV0FSRCAtaSAiJExBTl9JRiIgLXAgdWRwIC0tZHBvcnQgNDQzIC1qIERST1AgMj4vZGV2L251bGwgfHwgdHJ1ZQogIGZpCiAgd2hpbGUgaXAgLTYgcnVsZSBkZWwgZndtYXJrICIkRldNQVJLIiB0YWJsZSAiJFJPVVRFX1RBQkxFIiAyPi9kZXYvbnVsbDsgZG8gOjsgZG9uZQogIGlwIC02IHJvdXRlIGZsdXNoIHRhYmxlICIkUk9VVEVfVEFCTEUiIDI+L2Rldi9udWxsIHx8IHRydWUKfQoKc2V0dXBfdHByb3h5X2lwdjYoKSB7CiAgaWYgdGVzdCAiJEVOQUJMRV9JUFY2IiAhPSAiMSI7IHRoZW4gcmV0dXJuIDA7IGZpCiAgaWYgISBjb21tYW5kIC12IGlwNnRhYmxlcyA+L2Rldi9udWxsIDI+JjE7IHRoZW4gcmV0dXJuIDA7IGZpCgogIGlmICEgaXAgLTYgcnVsZSBhZGQgZndtYXJrICIkRldNQVJLIiB0YWJsZSAiJFJPVVRFX1RBQkxFIiAyPi9kZXYvbnVsbCBcCiAgICB8fCAhIGlwIC02IHJvdXRlIGFkZCBsb2NhbCA6Oi8wIGRldiBsbyB0YWJsZSAiJFJPVVRFX1RBQkxFIiAyPi9kZXYvbnVsbDsgdGhlbgogICAgd2hpbGUgaXAgLTYgcnVsZSBkZWwgZndtYXJrICIkRldNQVJLIiB0YWJsZSAiJFJPVVRFX1RBQkxFIiAyPi9kZXYvbnVsbDsgZG8gOjsgZG9uZQogICAgaXAgLTYgcm91dGUgZmx1c2ggdGFibGUgIiRST1VURV9UQUJMRSIgMj4vZGV2L251bGwgfHwgdHJ1ZQogICAgcmV0dXJuIDAKICBmaQoKICBGQUtFX0lQNl9SQU5HRT0iIgogIGlmIHRlc3QgLWYgIiRDT05GSUciOyB0aGVuCiAgICBGQUtFX0lQNl9SQU5HRT0kKHNlZCAtbiAicy9eW1s6c3BhY2U6XV0qZmFrZS1pcC1yYW5nZTY6W1s6c3BhY2U6XV0qWydcIl0qXChbXidcIiNbOnNwYWNlOl1dKlwpWydcIl0qLiovXDEvcCIgIiRDT05GSUciIHwgaGVhZCAtbiAxKQogIGZpCiAgaWYgdGVzdCAteiAiJEZBS0VfSVA2X1JBTkdFIjsgdGhlbgogICAgRkFLRV9JUDZfUkFOR0U9ImZjMDA6Oi8xOCIKICBmaQoKICBpZiAhIGlwNnRhYmxlcyAtdyAxMCAtdCBtYW5nbGUgLU4gTUlIT01PNiAyPi9kZXYvbnVsbDsgdGhlbgogICAgcmV0dXJuIDAKICBmaQogIGlwNnRhYmxlcyAtdyAxMCAtdCBtYW5nbGUgLUEgTUlIT01PNiAtbSBhZGRydHlwZSAtLWRzdC10eXBlIExPQ0FMIC1qIFJFVFVSTiAyPi9kZXYvbnVsbCB8fCB0cnVlCiAgZm9yIHN1Ym5ldDYgaW4gXAogICAgOjovMTI4IDo6MS8xMjggOjpmZmZmOjA6MC85NiAyMDAxOmRiODo6LzMyIGZlODA6Oi8xMCBmZjAwOjovOAogIGRvCiAgICBpcDZ0YWJsZXMgLXcgMTAgLXQgbWFuZ2xlIC1BIE1JSE9NTzYgLWQgIiRzdWJuZXQ2IiAtaiBSRVRVUk4gMj4vZGV2L251bGwgfHwgdHJ1ZQogIGRvbmUKICBpcDZ0YWJsZXMgLXcgMTAgLXQgbWFuZ2xlIC1BIE1JSE9NTzYgLXAgdWRwIC0tZHBvcnQgMTIzIC1qIFJFVFVSTiAyPi9kZXYvbnVsbCB8fCB0cnVlCiAgaWYgdGVzdCAiJEJMT0NLX1FVSUMiID0gIjEiOyB0aGVuCiAgICBpcDZ0YWJsZXMgLXcgMTAgLXQgbWFuZ2xlIC1BIE1JSE9NTzYgLXAgdWRwIC0tZHBvcnQgNDQzIC1qIFJFVFVSTiAyPi9kZXYvbnVsbCB8fCB0cnVlCiAgZmkKICAjIFJvdXRlIElQdjYgZmFrZS1pcCByYW5nZSB0byBUUFJPWFkgYmVmb3JlIGJ5cGFzc2luZyByZW1haW5pbmcgVUxBIChmYzAwOjovNykKICBpZiB0ZXN0IC1uICIkRkFLRV9JUDZfUkFOR0UiOyB0aGVuCiAgICBpcDZ0YWJsZXMgLXcgMTAgLXQgbWFuZ2xlIC1BIE1JSE9NTzYgLWQgIiRGQUtFX0lQNl9SQU5HRSIgLXAgdGNwIC1qIFRQUk9YWSBcCiAgICAgIC0tb24taXAgOjoxIC0tb24tcG9ydCAiJFRQUk9YWV9QT1JUIiAtLXRwcm94eS1tYXJrICIkRldNQVJLIiAyPi9kZXYvbnVsbCB8fCB0cnVlCiAgICBpcDZ0YWJsZXMgLXcgMTAgLXQgbWFuZ2xlIC1BIE1JSE9NTzYgLWQgIiRGQUtFX0lQNl9SQU5HRSIgLXAgdWRwIC1qIFRQUk9YWSBcCiAgICAgIC0tb24taXAgOjoxIC0tb24tcG9ydCAiJFRQUk9YWV9QT1JUIiAtLXRwcm94eS1tYXJrICIkRldNQVJLIiAyPi9kZXYvbnVsbCB8fCB0cnVlCiAgZmkKICBpcDZ0YWJsZXMgLXcgMTAgLXQgbWFuZ2xlIC1BIE1JSE9NTzYgLWQgZmMwMDo6LzcgLWogUkVUVVJOIDI+L2Rldi9udWxsIHx8IHRydWUKICBpZiAhIGlwNnRhYmxlcyAtdyAxMCAtdCBtYW5nbGUgLUEgTUlIT01PNiAtcCB0Y3AgLWogVFBST1hZIFwKICAgICAgLS1vbi1pcCA6OjEgLS1vbi1wb3J0ICIkVFBST1hZX1BPUlQiIC0tdHByb3h5LW1hcmsgIiRGV01BUksiIDI+L2Rldi9udWxsIFwKICAgIHx8ICEgaXA2dGFibGVzIC13IDEwIC10IG1hbmdsZSAtQSBNSUhPTU82IC1wIHVkcCAtaiBUUFJPWFkgXAogICAgICAtLW9uLWlwIDo6MSAtLW9uLXBvcnQgIiRUUFJPWFlfUE9SVCIgLS10cHJveHktbWFyayAiJEZXTUFSSyIgMj4vZGV2L251bGwgXAogICAgfHwgISBpcDZ0YWJsZXMgLXcgMTAgLXQgbWFuZ2xlIC1JIFBSRVJPVVRJTkcgMSAtaSAiJExBTl9JRiIgLWogTUlIT01PNiAyPi9kZXYvbnVsbDsgdGhlbgogICAgaXA2dGFibGVzIC13IDEwIC10IG1hbmdsZSAtRCBQUkVST1VUSU5HIC1pICIkTEFOX0lGIiAtaiBNSUhPTU82IDI+L2Rldi9udWxsIHx8IHRydWUKICAgIGlwNnRhYmxlcyAtdyAxMCAtdCBtYW5nbGUgLUYgTUlIT01PNiAyPi9kZXYvbnVsbCB8fCB0cnVlCiAgICBpcDZ0YWJsZXMgLXcgMTAgLXQgbWFuZ2xlIC1YIE1JSE9NTzYgMj4vZGV2L251bGwgfHwgdHJ1ZQogICAgd2hpbGUgaXAgLTYgcnVsZSBkZWwgZndtYXJrICIkRldNQVJLIiB0YWJsZSAiJFJPVVRFX1RBQkxFIiAyPi9kZXYvbnVsbDsgZG8gOjsgZG9uZQogICAgaXAgLTYgcm91dGUgZmx1c2ggdGFibGUgIiRST1VURV9UQUJMRSIgMj4vZGV2L251bGwgfHwgdHJ1ZQogICAgcmV0dXJuIDAKICBmaQoKICBpZiBpcDZ0YWJsZXMgLXcgMTAgLXQgbWFuZ2xlIC1OIE1JSE9NTzZfRElWRVJUIDI+L2Rldi9udWxsOyB0aGVuCiAgICBpZiBpcDZ0YWJsZXMgLXcgMTAgLXQgbWFuZ2xlIC1BIE1JSE9NTzZfRElWRVJUIC1qIE1BUksgLS1zZXQtbWFyayAiJEZXTUFSSyIgMj4vZGV2L251bGwgXAogICAgICAmJiBpcDZ0YWJsZXMgLXcgMTAgLXQgbWFuZ2xlIC1BIE1JSE9NTzZfRElWRVJUIC1qIEFDQ0VQVCAyPi9kZXYvbnVsbCBcCiAgICAgICYmIGlwNnRhYmxlcyAtdyAxMCAtdCBtYW5nbGUgLUkgUFJFUk9VVElORyAxIC1pICIkTEFOX0lGIiAtbSBzb2NrZXQgLS10cmFuc3BhcmVudCAtaiBNSUhPTU82X0RJVkVSVCAyPi9kZXYvbnVsbDsgdGhlbgogICAgICA6CiAgICBlbHNlCiAgICAgIGlwNnRhYmxlcyAtdyAxMCAtdCBtYW5nbGUgLUYgTUlIT01PNl9ESVZFUlQgMj4vZGV2L251bGwgfHwgdHJ1ZQogICAgICBpcDZ0YWJsZXMgLXcgMTAgLXQgbWFuZ2xlIC1YIE1JSE9NTzZfRElWRVJUIDI+L2Rldi9udWxsIHx8IHRydWUKICAgIGZpCiAgZmkKCiAgaWYgdGVzdCAiJEJMT0NLX1FVSUMiID0gIjEiOyB0aGVuCiAgICBpcDZ0YWJsZXMgLXcgMTAgLUkgRk9SV0FSRCAxIC1pICIkTEFOX0lGIiAtcCB1ZHAgLS1kcG9ydCA0NDMgLWogUkVKRUNUIDI+L2Rldi9udWxsIFwKICAgICAgfHwgaXA2dGFibGVzIC13IDEwIC1JIEZPUldBUkQgMSAtaSAiJExBTl9JRiIgLXAgdWRwIC0tZHBvcnQgNDQzIC1qIERST1AgMj4vZGV2L251bGwgfHwgdHJ1ZQogIGZpCn0KCnNldHVwX3Rwcm94eSgpIHsKICBjbGVhbnVwX3Rwcm94eQogIGlwIHJ1bGUgYWRkIGZ3bWFyayAiJEZXTUFSSyIgdGFibGUgIiRST1VURV9UQUJMRSIgfHwgcmV0dXJuIDEKICBpcCByb3V0ZSBhZGQgbG9jYWwgMC4wLjAuMC8wIGRldiBsbyB0YWJsZSAiJFJPVVRFX1RBQkxFIiB8fCByZXR1cm4gMQoKICBpcHRhYmxlcyAtdyAxMCAtdCBtYW5nbGUgLU4gTUlIT01PIHx8IHJldHVybiAxCiAgaXB0YWJsZXMgLXcgMTAgLXQgbWFuZ2xlIC1BIE1JSE9NTyAtcCB0Y3AgLS1kcG9ydCA1MyAtaiBSRVRVUk4gfHwgcmV0dXJuIDEKICBpcHRhYmxlcyAtdyAxMCAtdCBtYW5nbGUgLUEgTUlIT01PIC1wIHVkcCAtLWRwb3J0IDUzIC1qIFJFVFVSTiB8fCByZXR1cm4gMQogIGZvciBzdWJuZXQgaW4gXAogICAgMC4wLjAuMC84IDEwLjAuMC4wLzggMTAwLjY0LjAuMC8xMCAxMjcuMC4wLjAvOCBcCiAgICAxNjkuMjU0LjAuMC8xNiAxNzIuMTYuMC4wLzEyIDE5Mi4wLjAuMC8yNCAxOTIuMC4yLjAvMjQgXAogICAgMTkyLjg4Ljk5LjAvMjQgMTkyLjE2OC4wLjAvMTYgMTk4LjUxLjEwMC4wLzI0IDIwMy4wLjExMy4wLzI0IFwKICAgIDIyNC4wLjAuMC80IDI0MC4wLjAuMC80IDI1NS4yNTUuMjU1LjI1NS8zMgogIGRvCiAgICBpcHRhYmxlcyAtdyAxMCAtdCBtYW5nbGUgLUEgTUlIT01PIC1kICIkc3VibmV0IiAtaiBSRVRVUk4gfHwgcmV0dXJuIDEKICBkb25lCiAgaXB0YWJsZXMgLXcgMTAgLXQgbWFuZ2xlIC1BIE1JSE9NTyAtcCB1ZHAgLS1kcG9ydCAxMjMgLWogUkVUVVJOIHx8IHJldHVybiAxCiAgaWYgdGVzdCAiJEJMT0NLX1FVSUMiID0gIjEiOyB0aGVuCiAgICBpcHRhYmxlcyAtdyAxMCAtdCBtYW5nbGUgLUEgTUlIT01PIC1wIHVkcCAtLWRwb3J0IDQ0MyAtaiBSRVRVUk4gfHwgcmV0dXJuIDEKICBmaQogIGlwdGFibGVzIC13IDEwIC10IG1hbmdsZSAtQSBNSUhPTU8gLXAgdGNwIC1qIFRQUk9YWSBcCiAgICAtLW9uLWlwIDEyNy4wLjAuMSAtLW9uLXBvcnQgIiRUUFJPWFlfUE9SVCIgLS10cHJveHktbWFyayAiJEZXTUFSSyIgfHwgcmV0dXJuIDEKICBpcHRhYmxlcyAtdyAxMCAtdCBtYW5nbGUgLUEgTUlIT01PIC1wIHVkcCAtaiBUUFJPWFkgXAogICAgLS1vbi1pcCAxMjcuMC4wLjEgLS1vbi1wb3J0ICIkVFBST1hZX1BPUlQiIC0tdHByb3h5LW1hcmsgIiRGV01BUksiIHx8IHJldHVybiAxCiAgaXB0YWJsZXMgLXcgMTAgLXQgbWFuZ2xlIC1JIFBSRVJPVVRJTkcgMSAtaSAiJExBTl9JRiIgLWogTUlIT01PIHx8IHJldHVybiAxCgogICMgRmFzdC1wYXRoIGVzdGFibGlzaGVkIHRyYW5zcGFyZW50IHNvY2tldHMgdG8gc2tpcCBwZXItcGFja2V0IE1JSE9NTyBjaGFpbiB0cmF2ZXJzYWwKICBpZiBpcHRhYmxlcyAtdyAxMCAtdCBtYW5nbGUgLU4gTUlIT01PX0RJVkVSVCAyPi9kZXYvbnVsbDsgdGhlbgogICAgaWYgaXB0YWJsZXMgLXcgMTAgLXQgbWFuZ2xlIC1BIE1JSE9NT19ESVZFUlQgLWogTUFSSyAtLXNldC1tYXJrICIkRldNQVJLIiAyPi9kZXYvbnVsbCBcCiAgICAgICYmIGlwdGFibGVzIC13IDEwIC10IG1hbmdsZSAtQSBNSUhPTU9fRElWRVJUIC1qIEFDQ0VQVCAyPi9kZXYvbnVsbCBcCiAgICAgICYmIGlwdGFibGVzIC13IDEwIC10IG1hbmdsZSAtSSBQUkVST1VUSU5HIDEgLWkgIiRMQU5fSUYiIC1tIHNvY2tldCAtLXRyYW5zcGFyZW50IC1qIE1JSE9NT19ESVZFUlQgMj4vZGV2L251bGw7IHRoZW4KICAgICAgOgogICAgZWxzZQogICAgICBpcHRhYmxlcyAtdyAxMCAtdCBtYW5nbGUgLUYgTUlIT01PX0RJVkVSVCAyPi9kZXYvbnVsbCB8fCB0cnVlCiAgICAgIGlwdGFibGVzIC13IDEwIC10IG1hbmdsZSAtWCBNSUhPTU9fRElWRVJUIDI+L2Rldi9udWxsIHx8IHRydWUKICAgIGZpCiAgZmkKCiAgaWYgdGVzdCAiJEJMT0NLX1FVSUMiID0gIjEiOyB0aGVuCiAgICBpcHRhYmxlcyAtdyAxMCAtSSBGT1JXQVJEIDEgLWkgIiRMQU5fSUYiIC1wIHVkcCAtLWRwb3J0IDQ0MyAtaiBSRUpFQ1QgMj4vZGV2L251bGwgXAogICAgICB8fCBpcHRhYmxlcyAtdyAxMCAtSSBGT1JXQVJEIDEgLWkgIiRMQU5fSUYiIC1wIHVkcCAtLWRwb3J0IDQ0MyAtaiBEUk9QIDI+L2Rldi9udWxsIHx8IHRydWUKICBmaQoKICBpcHRhYmxlcyAtdyAxMCAtdCBuYXQgLU4gTUlIT01PX0ROUyB8fCByZXR1cm4gMQogIGlwdGFibGVzIC13IDEwIC10IG5hdCAtQSBNSUhPTU9fRE5TIC1wIHRjcCAtLWRwb3J0IDUzIC1qIFJFRElSRUNUIC0tdG8tcG9ydHMgIiRETlNfUE9SVCIgfHwgcmV0dXJuIDEKICBpcHRhYmxlcyAtdyAxMCAtdCBuYXQgLUEgTUlIT01PX0ROUyAtcCB1ZHAgLS1kcG9ydCA1MyAtaiBSRURJUkVDVCAtLXRvLXBvcnRzICIkRE5TX1BPUlQiIHx8IHJldHVybiAxCiAgaXB0YWJsZXMgLXcgMTAgLXQgbmF0IC1JIFBSRVJPVVRJTkcgMSAtaSAiJExBTl9JRiIgLWogTUlIT01PX0ROUyB8fCByZXR1cm4gMQoKICBpcHRhYmxlcyAtdyAxMCAtSSBJTlBVVCAxIC1pICIkTEFOX0lGIiAtcCB0Y3AgLS1kcG9ydCAiJERBU0hCT0FSRF9QT1JUIiAtaiBBQ0NFUFQgfHwgcmV0dXJuIDEKICBpcHRhYmxlcyAtdyAxMCAtSSBJTlBVVCAxIC1pICIkTEFOX0lGIiAtcCB0Y3AgLS1kcG9ydCAiJE1JWEVEX1BPUlQiIC1qIEFDQ0VQVCB8fCByZXR1cm4gMQogIGlwdGFibGVzIC13IDEwIC1JIElOUFVUIDEgLWkgIiRMQU5fSUYiIC1wIHRjcCAtLWRwb3J0ICIkRE5TX1BPUlQiIC1qIEFDQ0VQVCB8fCByZXR1cm4gMQogIGlwdGFibGVzIC13IDEwIC1JIElOUFVUIDEgLWkgIiRMQU5fSUYiIC1wIHVkcCAtLWRwb3J0ICIkRE5TX1BPUlQiIC1qIEFDQ0VQVCB8fCByZXR1cm4gMQoKICBzZXR1cF90cHJveHlfaXB2NiB8fCB0cnVlCn0KCnJlc29sdmVfY3B1X21hc2soKSB7CiAgY2FzZSAiJENQVV9NQVNLIiBpbgogICAgJyd8b2ZmfG5vbmV8MCkgcmV0dXJuIDAgOzsKICAgIGF1dG8pIDs7CiAgICAqKSBwcmludGYgJyVzJyAiJENQVV9NQVNLIjsgcmV0dXJuIDAgOzsKICBlc2FjCiAgIyBBdXRvLWRldGVjdCBsaXR0bGUvZWZmaWNpZW5jeSBjb3JlcyBvbiBoZXRlcm9nZW5lb3VzIChiaWcuTElUVExFKSBTb0NzIG9ubHkuCiAgIyBPbiBob21vZ2VuZW91cyBTb0NzIChhbGwgY29yZXMgc2hhcmUgdGhlIHNhbWUgbWF4X2ZyZXEpLCBkbyBub3QgcGluLgogIGF3ayAnCiAgICBCRUdJTiB7IG1pbl9mID0gMDsgbWF4X2YgPSAwOyBjb3VudCA9IDAgfQogICAgewogICAgICBpZHggPSBGSUxFTkFNRQogICAgICBzdWIoL1wvY3B1ZnJlcVwvY3B1aW5mb19tYXhfZnJlcSQvLCAiIiwgaWR4KQogICAgICBzdWIoL14uKlwvY3B1LywgIiIsIGlkeCkKICAgICAgZiA9ICQxICsgMAogICAgICBpZiAoaWR4IH4gL15bMC05XSskLyAmJiBmID4gMCkgewogICAgICAgIGZyZXFbaWR4XSA9IGYKICAgICAgICBpZiAobWluX2YgPT0gMCB8fCBmIDwgbWluX2YpIG1pbl9mID0gZgogICAgICAgIGlmIChmID4gbWF4X2YpIG1heF9mID0gZgogICAgICAgIGNvdW50KysKICAgICAgfQogICAgfQogICAgRU5EIHsKICAgICAgaWYgKGNvdW50IDwgMiB8fCBtaW5fZiA8PSAwIHx8IG1heF9mIDw9IG1pbl9mKSBleGl0IDAKICAgICAgbWFzayA9IDAKICAgICAgZm9yIChpIGluIGZyZXEpIHsKICAgICAgICBpZiAoZnJlcVtpXSA9PSBtaW5fZiAmJiAoaSArIDApIDwgMzEpIHsKICAgICAgICAgIGJpdCA9IDEKICAgICAgICAgIGZvciAoayA9IDA7IGsgPCAoaSArIDApOyBrKyspIGJpdCAqPSAyCiAgICAgICAgICBtYXNrICs9IGJpdAogICAgICAgIH0KICAgICAgfQogICAgICBpZiAobWFzayA+IDApIHByaW50ZiAiJXgiLCBtYXNrCiAgICB9CiAgJyAvc3lzL2RldmljZXMvc3lzdGVtL2NwdS9jcHVbMC05XSovY3B1ZnJlcS9jcHVpbmZvX21heF9mcmVxIDI+L2Rldi9udWxsCn0KCnN0YXJ0X3NlcnZpY2UoKSB7CiAgbWtkaXIgLXAgIiRST09UL3J1biIgIiRDT05GSUdfRElSIiAiJFJPT1QvbG9ncyIKICBlY2hvICdbMS80XSDmo4Dmn6Xml6Xlv5fkuI7ov5DooYznirbmgIEnCiAgdHJpbV9sb2cgIiRMT0ciCiAgdHJpbV9sb2cgIiRTVUJfTE9HIgogIFBJRD0kKHJlc29sdmVfcGlkICIkUElERklMRSIgIiRCSU4gLWQgJENPTkZJR19ESVIgLWYgJENPTkZJRyIgfHwgdHJ1ZSkKICBpZiB0ZXN0IC1uICIkUElEIjsgdGhlbgogICAgZWNobyAiJFBJRCIgPiAiJFBJREZJTEUiCiAgICBlY2hvICJbMy80XSDmo4DmtYvliLDov5vnqIsgKFBJRD0kUElEKSDlt7LlnKjov5DooYzvvIzliLfmlrAgVFByb3h5IOinhOWImS4uLiIKICAgIHNldHVwX3Rwcm94eSB8fCB7IGVjaG8gJ1RQcm94eSDop4TliJnlronoo4XlpLHotKUnOyByZXR1cm4gMTsgfQogICAgc3RhcnRfc3ViX3NjaGVkdWxlciB8fCB0cnVlCiAgICBlY2hvICdbNC80XSBtaWhvbW8g5bey5Zyo6L+Q6KGM77yMVFByb3h5IOinhOWImeW3suWIt+aWsCcKICAgIHJldHVybiAwCiAgZmkKICBlY2hvICdbMi80XSDmoKHpqozphY3nva7lubblkK/liqggbWlob21vIOi/m+eoiy4uLicKICAiJEJJTiIgLXQgLWQgIiRDT05GSUdfRElSIiAtZiAiJENPTkZJRyIgfHwgcmV0dXJuIDEKICBFRkZfTUFTSz0kKHJlc29sdmVfY3B1X21hc2sgfHwgdHJ1ZSkKICBpZiB0ZXN0IC1uICIkRUZGX01BU0siICYmIGNvbW1hbmQgLXYgdGFza3NldCA+L2Rldi9udWxsIDI+JjE7IHRoZW4KICAgIEdPTUFYUFJPQ1M9IiRHT19NQVhQUk9DUyIgR09NRU1MSU1JVD0iJEdPX01FTUxJTUlUIiBHT0dDPSIkR09fR0MiIFwKICAgICAgbm9odXAgdGFza3NldCAiJEVGRl9NQVNLIiAiJEJJTiIgLWQgIiRDT05GSUdfRElSIiAtZiAiJENPTkZJRyIgPj4gIiRMT0ciIDI+JjEgJgogIGVsc2UKICAgIEdPTUFYUFJPQ1M9IiRHT19NQVhQUk9DUyIgR09NRU1MSU1JVD0iJEdPX01FTUxJTUlUIiBHT0dDPSIkR09fR0MiIFwKICAgICAgbm9odXAgIiRCSU4iIC1kICIkQ09ORklHX0RJUiIgLWYgIiRDT05GSUciID4+ICIkTE9HIiAyPiYxICYKICBmaQogIFBJRD0kIQogIGVjaG8gIiRQSUQiID4gIiRQSURGSUxFIgogIHNsZWVwICIkU1RBUlRfV0FJVCIKICBpZiAhIGtpbGwgLTAgIiRQSUQiIDI+L2Rldi9udWxsOyB0aGVuCiAgICBlY2hvICflkK/liqjlpLHotKXvvIzor7fmn6XnnIvlhoXmoLjml6Xlv5cnCiAgICBybSAtZiAiJFBJREZJTEUiCiAgICByZXR1cm4gMQogIGZpCiAgZWNobyAiWzMvNF0g6L+b56iL5bey5ZCv5YqoIChQSUQ9JFBJRCnvvIzmraPlnKjlronoo4UgVFByb3h5IOS4jiBETlMg6KeE5YiZLi4uIgogIGlmICEgc2V0dXBfdHByb3h5OyB0aGVuCiAgICBlY2hvICdUUHJveHkg6KeE5YiZ5a6J6KOF5aSx6LSl77yM5bey5Zue5ruaJwogICAgY2xlYW51cF90cHJveHkKICAgIGtpbGwgIiRQSUQiIDI+L2Rldi9udWxsIHx8IHRydWUKICAgIHJtIC1mICIkUElERklMRSIKICAgIHJldHVybiAxCiAgZmkKICBzdGFydF9zdWJfc2NoZWR1bGVyIHx8IHRydWUKICBlY2hvICdbNC80XSBtaWhvbW8gVFByb3h5IOWQr+WKqOaIkOWKnycKfQoKc3RvcF9zZXJ2aWNlKCkgewogIGlmIHRlc3QgIiR7S0VFUF9TQ0hFRFVMRVI6LTB9IiAhPSAiMSI7IHRoZW4KICAgIGVjaG8gJ1sxLzNdIOWBnOatouWumuaXtuiuoumYheWuiOaKpOi/m+eoiy4uLicKICAgIHN0b3Bfc3ViX3NjaGVkdWxlciB8fCB0cnVlCiAgZmkKICBlY2hvICdbMi8zXSDmuIXnkIYgVFByb3h5IOS4jiBETlMg6Ziy54Gr5aKZL+i3r+eUseinhOWImS4uLicKICBjbGVhbnVwX3Rwcm94eQogIGVjaG8gJ1szLzNdIOWBnOatoiBtaWhvbW8g6L+b56iLLi4uJwogIFBJRD0kKHJlc29sdmVfcGlkICIkUElERklMRSIgIiRCSU4gLWQgJENPTkZJR19ESVIgLWYgJENPTkZJRyIgfHwgdHJ1ZSkKICBpZiB0ZXN0IC16ICIkUElEIjsgdGhlbgogICAgZWNobyAnbWlob21vIOacqui/kOihjO+8jFRQcm94eSDop4TliJnlt7LmuIXnkIYnCiAgICBybSAtZiAiJFBJREZJTEUiCiAgICByZXR1cm4gMAogIGZpCiAga2lsbCAiJFBJRCIgMj4vZGV2L251bGwgfHwgdHJ1ZQogIENPVU5UPTAKICB3aGlsZSBraWxsIC0wICIkUElEIiAyPi9kZXYvbnVsbCAmJiB0ZXN0ICIkQ09VTlQiIC1sdCAxMDsgZG8KICAgIHNsZWVwIDEKICAgIENPVU5UPSQoKENPVU5UICsgMSkpCiAgZG9uZQogIGtpbGwgLTkgIiRQSUQiIDI+L2Rldi9udWxsIHx8IHRydWUKICBybSAtZiAiJFBJREZJTEUiCiAgZWNobyAnbWlob21vIOW3suWBnOatou+8jFRQcm94eSDop4TliJnlt7LmuIXnkIYnCn0KCmNhc2UgIiQxIiBpbgogIHN0YXJ0KSBzdGFydF9zZXJ2aWNlIDs7CiAgc3RvcCkgc3RvcF9zZXJ2aWNlIDs7CiAgcmVzdGFydCkgS0VFUF9TQ0hFRFVMRVI9MSBzdG9wX3NlcnZpY2U7IHN0YXJ0X3NlcnZpY2UgOzsKICBzdGF0dXMpIHJlc29sdmVfcGlkICIkUElERklMRSIgIiRCSU4gLWQgJENPTkZJR19ESVIgLWYgJENPTkZJRyIgPi9kZXYvbnVsbCA7OwogIHN1Yi1zdGFydCkgc3RhcnRfc3ViX3NjaGVkdWxlciA7OwogIHN1Yi1zdG9wKSBzdG9wX3N1Yl9zY2hlZHVsZXIgOzsKICBzdWItc3RhdHVzKSByZXNvbHZlX3BpZCAiJFNVQl9QSURGSUxFIiAiJFNVQl9TQ1JJUFQgZGFlbW9uIiA+L2Rldi9udWxsIDs7CiAgKikgZWNobyAn55So5rOVOiBtaWhvbW8uc2VydmljZSB7c3RhcnR8c3RvcHxyZXN0YXJ0fHN0YXR1c3xzdWItc3RhcnR8c3ViLXN0b3B8c3ViLXN0YXR1c30nOyBleGl0IDEgOzsKZXNhYwo=';
  const UPDATE_SUB_SCRIPT_B64 = 'IyEvc3lzdGVtL2Jpbi9zaAojIFVub2ZmaWNpYWwgTWlob21vIHN1YnNjcmlwdGlvbiB1cGRhdGVyICYgc2NoZWR1bGVyIGZvciBjb21wYXRpYmxlIFpURSBVRkkgVG9vbHMgZW52aXJvbm1lbnRzLgpST09UPSR7Uk9PVDotL2RhdGEvbWlob21vfQpCSU49JHtCSU46LSRST09UL2Jpbi9taWhvbW99CkNPTkZJR19ESVI9JHtDT05GSUdfRElSOi0kUk9PVC9jb25maWd9CkNPTkZJRz0ke0NPTkZJRzotJENPTkZJR19ESVIvY29uZmlnLnlhbWx9ClNVQl9DT05GSUc9JHtTVUJfQ09ORklHOi0kQ09ORklHX0RJUi9zdWJzY3JpcHRpb25zLmpzb259ClNVQl9ESVI9JHtTVUJfRElSOi0kUk9PVC9zdWJzY3JpcHRpb25zfQpEQVNIQk9BUkRfRElSPSR7REFTSEJPQVJEX0RJUjotJENPTkZJR19ESVIvdWl9ClNFUlZJQ0U9JHtTRVJWSUNFOi0kUk9PVC9zY3JpcHRzL21paG9tby5zZXJ2aWNlfQpTVEFUVVNfRklMRT0ke1NUQVRVU19GSUxFOi0kUk9PVC9ydW4vc3ViX3N0YXR1cy5qc29ufQpTVUJfTE9HPSR7U1VCX0xPRzotJFJPT1QvbG9ncy9zdWIubG9nfQpDVVJMPSR7Q1VSTDotL2RhdGEvZGF0YS9jb20ubWluaWthbm8uZjUwX3Ntcy9maWxlcy9jdXJsfQpKUT0ke0pROi0vZGF0YS9kYXRhL2NvbS5taW5pa2Fuby5mNTBfc21zL2ZpbGVzL2pxfQpNSVhFRF9QT1JUPSR7TUlYRURfUE9SVDotNzg5MH0KVFBST1hZX1BPUlQ9JHtUUFJPWFlfUE9SVDotNzg5M30KRE5TX1BPUlQ9JHtETlNfUE9SVDotMTA1M30KQVBJX1BPUlQ9JHtBUElfUE9SVDotOTA5MH0KTE9HX01BWF9CWVRFUz0ke0xPR19NQVhfQllURVM6LTIwOTcxNTJ9CkxPR19LRUVQX0xJTkVTPSR7TE9HX0tFRVBfTElORVM6LTEwMDB9CkNPUkVfTE9HPSR7TE9HOi0kUk9PVC9sb2dzL21paG9tby5sb2d9CkRFRkFVTFRfVUlfVVJMPSR7REVGQVVMVF9VSV9VUkw6LWh0dHBzOi8vZ2l0aHViLmNvbS9aZXBoeXJ1c28vemFzaGJvYXJkL3JlbGVhc2VzL2xhdGVzdC9kb3dubG9hZC9kaXN0LnppcH0KCnRyaW1fbG9nKCkgewogIEY9IiQxIgogIGlmICEgdGVzdCAtZiAiJEYiOyB0aGVuIHJldHVybiAwOyBmaQogIFNaPSQod2MgLWMgPCAiJEYiIDI+L2Rldi9udWxsIHwgdHIgLWQgJyBcbicgfHwgZWNobyAwKQogIGNhc2UgIiRTWiIgaW4gJyd8KlshMC05XSopIFNaPTAgOzsgZXNhYwogIGlmIHRlc3QgIiRTWiIgLWd0ICIkTE9HX01BWF9CWVRFUyI7IHRoZW4KICAgIHRhaWwgLW4gIiRMT0dfS0VFUF9MSU5FUyIgIiRGIiA+ICIkRi50bXAiIDI+L2Rldi9udWxsICYmIGNhdCAiJEYudG1wIiA+ICIkRiIgMj4vZGV2L251bGwgfHwgOiA+ICIkRiIKICAgIHJtIC1mICIkRi50bXAiCiAgZmkKfQoKaWYgISB0ZXN0IC14ICIkQ1VSTCI7IHRoZW4KICBDVVJMPSQoY29tbWFuZCAtdiBjdXJsIDI+L2Rldi9udWxsIHx8IGVjaG8gIiRDVVJMIikKZmkKCmxvZ19tc2coKSB7CiAgVFM9JChkYXRlICcrJVktJW0tJWQgJUg6JU06JVMnIDI+L2Rldi9udWxsIHx8IGVjaG8gJ3Vua25vd24tdGltZScpCiAgbWtkaXIgLXAgIiQoZGlybmFtZSAiJFNVQl9MT0ciKSIgMj4vZGV2L251bGwgfHwgdHJ1ZQogIHByaW50ZiAnWyVzXSAlc1xuJyAiJFRTIiAiJDEiID4+ICIkU1VCX0xPRyIgMj4vZGV2L251bGwgfHwgdHJ1ZQogIHByaW50ZiAnWyVzXSAlc1xuJyAiJFRTIiAiJDEiCn0KCmpzb25fZXNjYXBlKCkgewogIHByaW50ZiAnJXMnICIkMSIgfCBzZWQgJ3MvXFwvXFxcXC9nOyBzLyIvXFwiL2cnIHwgdHIgJ1xyXG4nICcgICcKfQoKd3JpdGVfc3RhdHVzKCkgewogIFNUQVRFPSIkMSIKICBNU0c9IiQyIgogIFBST1hJRVM9IiR7MzotMH0iCiAgTk9XX1RTPSQoZGF0ZSArJXMgMj4vZGV2L251bGwgfHwgZWNobyAwKQogIE5PV19TVFI9JChkYXRlICcrJVktJW0tJWQgJUg6JU06JVMnIDI+L2Rldi9udWxsIHx8IGVjaG8gJycpCiAgbWtkaXIgLXAgIiRST09UL3J1biIKICBjYXQgPiAiJFNUQVRVU19GSUxFIiA8PEVPRgp7InN0YXR1cyI6IiQoanNvbl9lc2NhcGUgIiRTVEFURSIpIiwibWVzc2FnZSI6IiQoanNvbl9lc2NhcGUgIiRNU0ciKSIsInByb3hpZXMiOiRQUk9YSUVTLCJ0aW1lc3RhbXAiOiROT1dfVFMsInVwZGF0ZWRBdCI6IiQoanNvbl9lc2NhcGUgIiROT1dfU1RSIikifQpFT0YKfQoKcmVhZF9qc29uX2ZpZWxkKCkgewogIEtFWT0iJDEiCiAgREVGQVVMVD0iJDIiCiAgaWYgISB0ZXN0IC1mICIkU1VCX0NPTkZJRyI7IHRoZW4KICAgIHByaW50ZiAnJXMnICIkREVGQVVMVCIKICAgIHJldHVybiAwCiAgZmkKICBpZiB0ZXN0IC14ICIkSlEiOyB0aGVuCiAgICBWQUw9JCgiJEpRIiAtciAtLWFyZyBrICIkS0VZIiAnaWYgaGFzKCRrKSBhbmQgLlska10gIT0gbnVsbCB0aGVuIC5bJGtdIHwgdG9zdHJpbmcgZWxzZSBlbXB0eSBlbmQnICIkU1VCX0NPTkZJRyIgMj4vZGV2L251bGwpCiAgICBpZiB0ZXN0IC1uICIkVkFMIjsgdGhlbgogICAgICBwcmludGYgJyVzJyAiJFZBTCIKICAgICAgcmV0dXJuIDAKICAgIGZpCiAgZmkKICAjIFBPU0lYIGZhbGxiYWNrIGZvciBmbGF0IEpTT04gb2JqZWN0cwogIFZBTD0kKHNlZCAtbiAicy8uKlwiJEtFWVwiW1s6c3BhY2U6XV0qOltbOnNwYWNlOl1dKlwiXChbXlwiXSpcKVwiLiovXDEvcCIgIiRTVUJfQ09ORklHIiB8IGhlYWQgLW4gMSkKICBpZiB0ZXN0IC16ICIkVkFMIjsgdGhlbgogICAgVkFMPSQoc2VkIC1uICJzLy4qXCIkS0VZXCJbWzpzcGFjZTpdXSo6W1s6c3BhY2U6XV0qXChbMC05YS16QS1aLl8tXSpcKS4qL1wxL3AiICIkU1VCX0NPTkZJRyIgfCBoZWFkIC1uIDEpCiAgZmkKICBpZiB0ZXN0IC1uICIkVkFMIjsgdGhlbgogICAgcHJpbnRmICclcycgIiRWQUwiCiAgZWxzZQogICAgcHJpbnRmICclcycgIiRERUZBVUxUIgogIGZpCn0KCmV4dHJhY3RfeWFtbF92YWx1ZSgpIHsKICBLRVk9IiQxIgogIGlmIHRlc3QgLWYgIiRDT05GSUciOyB0aGVuCiAgICBzZWQgLW4gInMvXiRLRVk6W1s6c3BhY2U6XV0qWydcIl0qXChbXidcIiNbOnNwYWNlOl1dKlwpWydcIl0qLiovXDEvcCIgIiRDT05GSUciIHwgaGVhZCAtbiAxCiAgZmkKfQoKbWVyZ2VfcnVudGltZV95YW1sKCkgewogIFJBV19GSUxFPSIkMSIKICBPVVRfRklMRT0iJDIiCiAgU0VDUkVUPSIkMyIKICBVSV9VUkw9IiQ0IgogIGF3ayBcCiAgICAtdiBtaXhlZF9wb3J0PSIkTUlYRURfUE9SVCIgXAogICAgLXYgdHByb3h5X3BvcnQ9IiRUUFJPWFlfUE9SVCIgXAogICAgLXYgYXBpX3BvcnQ9IiRBUElfUE9SVCIgXAogICAgLXYgZG5zX3BvcnQ9IiRETlNfUE9SVCIgXAogICAgLXYgZGFzaGJvYXJkX2Rpcj0iJERBU0hCT0FSRF9ESVIiIFwKICAgIC12IHVpX3VybD0iJFVJX1VSTCIgXAogICAgLXYgc2VjcmV0PSIkU0VDUkVUIiAnCiAgQkVHSU4gewogICAgbWFuYWdlZFsicG9ydCJdID0gMQogICAgbWFuYWdlZFsic29ja3MtcG9ydCJdID0gMQogICAgbWFuYWdlZFsicmVkaXItcG9ydCJdID0gMQogICAgbWFuYWdlZFsibWl4ZWQtcG9ydCJdID0gMQogICAgbWFuYWdlZFsidHByb3h5LXBvcnQiXSA9IDEKICAgIG1hbmFnZWRbImFsbG93LWxhbiJdID0gMQogICAgbWFuYWdlZFsiYmluZC1hZGRyZXNzIl0gPSAxCiAgICBtYW5hZ2VkWyJsb2ctbGV2ZWwiXSA9IDEKICAgIG1hbmFnZWRbImlwdjYiXSA9IDEKICAgIG1hbmFnZWRbImZpbmQtcHJvY2Vzcy1tb2RlIl0gPSAxCiAgICBtYW5hZ2VkWyJ0Y3AtY29uY3VycmVudCJdID0gMQogICAgbWFuYWdlZFsidW5pZmllZC1kZWxheSJdID0gMQogICAgbWFuYWdlZFsia2VlcC1hbGl2ZS1pZGxlIl0gPSAxCiAgICBtYW5hZ2VkWyJrZWVwLWFsaXZlLWludGVydmFsIl0gPSAxCiAgICBtYW5hZ2VkWyJnZW9kYXRhLWxvYWRlciJdID0gMQogICAgbWFuYWdlZFsidHVuIl0gPSAxCiAgICBtYW5hZ2VkWyJleHRlcm5hbC1jb250cm9sbGVyIl0gPSAxCiAgICBtYW5hZ2VkWyJleHRlcm5hbC11aSJdID0gMQogICAgbWFuYWdlZFsiZXh0ZXJuYWwtdWktdXJsIl0gPSAxCiAgICBtYW5hZ2VkWyJzZWNyZXQiXSA9IDEKCiAgICBwcmludCAiIyBNYW5hZ2VkIGJ5IFVGSSBUb29scyBtaWhvbW8gcGx1Z2luIgogICAgcHJpbnQgIm1peGVkLXBvcnQ6ICIgbWl4ZWRfcG9ydAogICAgcHJpbnQgInRwcm94eS1wb3J0OiAiIHRwcm94eV9wb3J0CiAgICBwcmludCAiYWxsb3ctbGFuOiB0cnVlIgogICAgcHJpbnQgImJpbmQtYWRkcmVzczogJ1wnJyonXCcnIgogICAgcHJpbnQgImxvZy1sZXZlbDogZXJyb3IiCiAgICBwcmludCAiaXB2NjogdHJ1ZSIKICAgIHByaW50ICJmaW5kLXByb2Nlc3MtbW9kZTogb2ZmIgogICAgcHJpbnQgInRjcC1jb25jdXJyZW50OiBmYWxzZSIKICAgIHByaW50ICJ1bmlmaWVkLWRlbGF5OiBmYWxzZSIKICAgIHByaW50ICJrZWVwLWFsaXZlLWlkbGU6IDYwIgogICAgcHJpbnQgImtlZXAtYWxpdmUtaW50ZXJ2YWw6IDYwIgogICAgcHJpbnQgImdlb2RhdGEtbG9hZGVyOiBtZW1jb25zZXJ2YXRpdmUiCiAgICBwcmludCAidHVuOiIKICAgIHByaW50ICIgIGVuYWJsZTogZmFsc2UiCiAgICBwcmludCAiZXh0ZXJuYWwtY29udHJvbGxlcjogMC4wLjAuMDoiIGFwaV9wb3J0CiAgICBwcmludCAiZXh0ZXJuYWwtdWk6ICIgZGFzaGJvYXJkX2RpcgogICAgcHJpbnQgImV4dGVybmFsLXVpLXVybDogJ1wnJyIgdWlfdXJsICInXCcnIgogICAgcHJpbnQgInNlY3JldDogJ1wnJyIgc2VjcmV0ICInXCcnIgogICAgcHJpbnQgIiIKCiAgICBza2lwX2Jsb2NrID0gMAogICAgaW5fZG5zID0gMAogICAgaGFzX2RucyA9IDAKICAgIGRuc19saXN0ZW5fc2V0ID0gMAogICAgZG5zX2VuYWJsZV9zZXQgPSAwCiAgICBkbnNfaXB2Nl9zZXQgPSAwCiAgfQogIHsKICAgIHN1YigvXHIkLywgIiIpCiAgICBpZiAoJDAgfiAvXltBLVphLXowLTlfLV0rW1s6c3BhY2U6XV0qOi8pIHsKICAgICAga2V5ID0gJDAKICAgICAgc3ViKC9bWzpzcGFjZTpdXSo6LiokLywgIiIsIGtleSkKICAgICAgcmVzdCA9ICQwCiAgICAgIHN1YigvXltBLVphLXowLTlfLV0rW1s6c3BhY2U6XV0qOi8sICIiLCByZXN0KQogICAgICBnc3ViKC9eW1s6c3BhY2U6XV0rfFtbOnNwYWNlOl1dKyQvLCAiIiwgcmVzdCkKCiAgICAgIGlmIChpbl9kbnMpIHsKICAgICAgICBpZiAoIWRuc19lbmFibGVfc2V0KSBwcmludCAiICBlbmFibGU6IHRydWUiCiAgICAgICAgaWYgKCFkbnNfbGlzdGVuX3NldCkgcHJpbnQgIiAgbGlzdGVuOiAwLjAuMC4wOiIgZG5zX3BvcnQKICAgICAgICBpZiAoIWRuc19pcHY2X3NldCkgcHJpbnQgIiAgaXB2NjogdHJ1ZSIKICAgICAgICBpbl9kbnMgPSAwCiAgICAgIH0KCiAgICAgIGlmIChrZXkgaW4gbWFuYWdlZCkgewogICAgICAgIHNraXBfYmxvY2sgPSAocmVzdCA9PSAiIiA/IDEgOiAwKQogICAgICAgIG5leHQKICAgICAgfQogICAgICBza2lwX2Jsb2NrID0gMAoKICAgICAgaWYgKGtleSA9PSAiZG5zIikgewogICAgICAgIGhhc19kbnMgPSAxCiAgICAgICAgaW5fZG5zID0gMQogICAgICAgIGRuc19saXN0ZW5fc2V0ID0gMAogICAgICAgIGRuc19lbmFibGVfc2V0ID0gMAogICAgICAgIGRuc19pcHY2X3NldCA9IDAKICAgICAgICBwcmludCAiZG5zOiIKICAgICAgICBuZXh0CiAgICAgIH0KICAgICAgcHJpbnQgJDAKICAgICAgbmV4dAogICAgfQoKICAgIGlmIChza2lwX2Jsb2NrKSB7CiAgICAgIGlmICgkMCB+IC9eW1s6c3BhY2U6XV0rLyB8fCAkMCB+IC9eW1s6c3BhY2U6XV0qJC8pIG5leHQKICAgICAgc2tpcF9ibG9jayA9IDAKICAgIH0KCiAgICBpZiAoaW5fZG5zKSB7CiAgICAgIGlmICgkMCB+IC9eIHsxLDJ9bGlzdGVuW1s6c3BhY2U6XV0qOi8pIHsKICAgICAgICBwcmludCAiICBsaXN0ZW46IDAuMC4wLjA6IiBkbnNfcG9ydAogICAgICAgIGRuc19saXN0ZW5fc2V0ID0gMQogICAgICAgIG5leHQKICAgICAgfQogICAgICBpZiAoJDAgfiAvXiB7MSwyfWVuYWJsZVtbOnNwYWNlOl1dKjovKSB7CiAgICAgICAgcHJpbnQgIiAgZW5hYmxlOiB0cnVlIgogICAgICAgIGRuc19lbmFibGVfc2V0ID0gMQogICAgICAgIG5leHQKICAgICAgfQogICAgICBpZiAoJDAgfiAvXiB7MSwyfWlwdjZbWzpzcGFjZTpdXSo6LykgewogICAgICAgIHByaW50ICIgIGlwdjY6IHRydWUiCiAgICAgICAgZG5zX2lwdjZfc2V0ID0gMQogICAgICAgIG5leHQKICAgICAgfQogICAgfQoKICAgIHByaW50ICQwCiAgfQogIEVORCB7CiAgICBpZiAoaW5fZG5zKSB7CiAgICAgIGlmICghZG5zX2VuYWJsZV9zZXQpIHByaW50ICIgIGVuYWJsZTogdHJ1ZSIKICAgICAgaWYgKCFkbnNfbGlzdGVuX3NldCkgcHJpbnQgIiAgbGlzdGVuOiAwLjAuMC4wOiIgZG5zX3BvcnQKICAgICAgaWYgKCFkbnNfaXB2Nl9zZXQpIHByaW50ICIgIGlwdjY6IHRydWUiCiAgICB9CiAgICBpZiAoIWhhc19kbnMpIHsKICAgICAgcHJpbnQgIiIKICAgICAgcHJpbnQgImRuczoiCiAgICAgIHByaW50ICIgIGVuYWJsZTogdHJ1ZSIKICAgICAgcHJpbnQgIiAgbGlzdGVuOiAwLjAuMC4wOiIgZG5zX3BvcnQKICAgICAgcHJpbnQgIiAgaXB2NjogdHJ1ZSIKICAgICAgcHJpbnQgIiAgZW5oYW5jZWQtbW9kZTogZmFrZS1pcCIKICAgICAgcHJpbnQgIiAgZmFrZS1pcC1yYW5nZTogMTk4LjE4LjAuMS8xNiIKICAgICAgcHJpbnQgIiAgZmFrZS1pcC1yYW5nZTY6IGZjMDA6Oi8xOCIKICAgICAgcHJpbnQgIiAgZGVmYXVsdC1uYW1lc2VydmVyOiIKICAgICAgcHJpbnQgIiAgICAtIDIyMy41LjUuNSIKICAgICAgcHJpbnQgIiAgICAtIDExOS4yOS4yOS4yOSIKICAgICAgcHJpbnQgIiAgbmFtZXNlcnZlcjoiCiAgICAgIHByaW50ICIgICAgLSAyMjMuNS41LjUiCiAgICAgIHByaW50ICIgICAgLSAxMTkuMjkuMjkuMjkiCiAgICB9CiAgfScgIiRSQVdfRklMRSIgPiAiJE9VVF9GSUxFIgp9CgpydW5fdXBkYXRlKCkgewogIG1rZGlyIC1wICIkU1VCX0RJUiIgIiRDT05GSUdfRElSIiAiJFJPT1QvcnVuIiAiJFJPT1QvbG9ncyIKICB0cmltX2xvZyAiJENPUkVfTE9HIgogIHRyaW1fbG9nICIkU1VCX0xPRyIKICBTVUJfVVJMPSQocmVhZF9qc29uX2ZpZWxkICJ1cmwiICIiKQogIFNVQl9VQT0kKHJlYWRfanNvbl9maWVsZCAidWEiICJjbGFzaC12ZXJnZS92MS43LjciKQogIEFVVE9fUEFUQ0g9JChyZWFkX2pzb25fZmllbGQgImF1dG9QYXRjaCIgInRydWUiKQoKICBpZiB0ZXN0IC16ICIkU1VCX1VSTCI7IHRoZW4KICAgIGxvZ19tc2cgIuiuoumYheWcsOWdgOS4uuepuu+8jOivt+WFiOWcqOiuoumYheiuvue9ruS4reWhq+WGmeWcsOWdgCIKICAgIHdyaXRlX3N0YXR1cyAiZXJyb3IiICLorqLpmIXlnLDlnYDkuLrnqboiIDAKICAgIHJldHVybiAxCiAgZmkKCiAgY2FzZSAiJFNVQl9VUkwiIGluCiAgICBodHRwOi8vKnxodHRwczovLyopIDs7CiAgICAqKQogICAgICBsb2dfbXNnICLorqLpmIXlnLDlnYDljY/orq7ml6DmlYg6ICRTVUJfVVJMIgogICAgICB3cml0ZV9zdGF0dXMgImVycm9yIiAi6K6i6ZiF5Zyw5Z2A5b+F6aG75Li6IEhUVFAvSFRUUFMiIDAKICAgICAgcmV0dXJuIDEKICAgICAgOzsKICBlc2FjCgogIFJBV19GSUxFPSIkU1VCX0RJUi9zdWIucmF3LnlhbWwiCiAgQ0FORElEQVRFPSIkQ09ORklHX0RJUi9jb25maWcuY2FuZGlkYXRlLnlhbWwiCiAgcm0gLWYgIiRSQVdfRklMRSIgIiRDQU5ESURBVEUiCgogIGxvZ19tc2cgIuW8gOWni+S4i+i9veiuoumYhS4uLiIKICBpZiAhICIkQ1VSTCIgLWZzU0wgLUEgIiRTVUJfVUEiIC0tY29ubmVjdC10aW1lb3V0IDE1IC0tbWF4LXRpbWUgOTAgIiRTVUJfVVJMIiAtbyAiJFJBV19GSUxFIiAyPi9kZXYvbnVsbDsgdGhlbgogICAgbG9nX21zZyAi55u06L+e5LiL6L295aSx6LSl77yM5bCd6K+V6YCa6L+H5pys5Zyw5Luj55CGIDEyNy4wLjAuMTokTUlYRURfUE9SVCDkuIvovb0uLi4iCiAgICBpZiAhICIkQ1VSTCIgLWZzU0wgLUEgIiRTVUJfVUEiIC0tY29ubmVjdC10aW1lb3V0IDE1IC0tbWF4LXRpbWUgOTAgLXggImh0dHA6Ly8xMjcuMC4wLjE6JE1JWEVEX1BPUlQiICIkU1VCX1VSTCIgLW8gIiRSQVdfRklMRSIgMj4vZGV2L251bGw7IHRoZW4KICAgICAgbG9nX21zZyAi6K6i6ZiF5LiL6L295aSx6LSl77yM6K+35qOA5p+l572R57uc5oiW6K6i6ZiF5Zyw5Z2AIgogICAgICB3cml0ZV9zdGF0dXMgImVycm9yIiAi6K6i6ZiF5LiL6L295aSx6LSlIiAwCiAgICAgIHJldHVybiAxCiAgICBmaQogIGZpCgogIGlmICEgdGVzdCAtcyAiJFJBV19GSUxFIjsgdGhlbgogICAgbG9nX21zZyAi6K6i6ZiF5paH5Lu25Li656m6IgogICAgd3JpdGVfc3RhdHVzICJlcnJvciIgIuiuoumYheaWh+S7tuS4uuepuiIgMAogICAgcmV0dXJuIDEKICBmaQoKICBpZiAhIGdyZXAgLUVxICdeW1s6c3BhY2U6XV0qKHByb3hpZXN8cHJveHktcHJvdmlkZXJzKVtbOnNwYWNlOl1dKjonICIkUkFXX0ZJTEUiOyB0aGVuCiAgICBsb2dfbXNnICLkuIvovb3lhoXlrrnnvLrlsJEgcHJveGllcyDmiJYgcHJveHktcHJvdmlkZXJz77yM5LiN5piv5pyJ5pWI55qEIENsYXNoL01paG9tbyBZQU1MIOmFjee9riIKICAgIHdyaXRlX3N0YXR1cyAiZXJyb3IiICLpnZ7mnInmlYjnmoQgQ2xhc2gvTWlob21vIFlBTUwg6YWN572uIiAwCiAgICByZXR1cm4gMQogIGZpCgogIGlmIHRlc3QgIiRBVVRPX1BBVENIIiA9ICJmYWxzZSI7IHRoZW4KICAgIGNwICIkUkFXX0ZJTEUiICIkQ0FORElEQVRFIgogIGVsc2UKICAgIFNFQ1JFVD0kKGV4dHJhY3RfeWFtbF92YWx1ZSAic2VjcmV0IikKICAgIFVJX1VSTD0kKGV4dHJhY3RfeWFtbF92YWx1ZSAiZXh0ZXJuYWwtdWktdXJsIikKICAgIGlmIHRlc3QgLXogIiRVSV9VUkwiOyB0aGVuCiAgICAgIFVJX1VSTD0iJERFRkFVTFRfVUlfVVJMIgogICAgZmkKICAgIG1lcmdlX3J1bnRpbWVfeWFtbCAiJFJBV19GSUxFIiAiJENBTkRJREFURSIgIiRTRUNSRVQiICIkVUlfVVJMIgogIGZpCiAgY2htb2QgNjAwICIkQ0FORElEQVRFIgoKICBDSEVDS19PVVQ9JCgiJEJJTiIgLXQgLWQgIiRDT05GSUdfRElSIiAtZiAiJENBTkRJREFURSIgMj4mMSkKICBpZiB0ZXN0ICQ/IC1uZSAwOyB0aGVuCiAgICBybSAtZiAiJENBTkRJREFURSIKICAgIGxvZ19tc2cgIumFjee9ruagoemqjOWksei0pe+8iOaXp+mFjee9ruacquimhueblu+8iTogJENIRUNLX09VVCIKICAgIHdyaXRlX3N0YXR1cyAiZXJyb3IiICJtaWhvbW8gLXQg5qCh6aqM5aSx6LSlOiAkQ0hFQ0tfT1VUIiAwCiAgICByZXR1cm4gMQogIGZpCgogIFBST1hZX0NPVU5UPSQoZ3JlcCAtRWMgJ15bWzpzcGFjZTpdXSotW1s6c3BhY2U6XV0qXHs/W1s6c3BhY2U6XV0qbmFtZVtbOnNwYWNlOl1dKjonICIkQ0FORElEQVRFIiAyPi9kZXYvbnVsbCB8fCBlY2hvIDApCiAgaWYgdGVzdCAtZiAiJENPTkZJRyI7IHRoZW4KICAgIGNwICIkQ09ORklHIiAiJENPTkZJRy5iYWsiIDI+L2Rldi9udWxsIHx8IHRydWUKICBmaQogIG12ICIkQ0FORElEQVRFIiAiJENPTkZJRyIKCiAgaWYgdGVzdCAteCAiJFNFUlZJQ0UiOyB0aGVuCiAgICBpZiAhIHNoICIkU0VSVklDRSIgcmVzdGFydCA+PiAiJFNVQl9MT0ciIDI+JjE7IHRoZW4KICAgICAgaWYgdGVzdCAtZiAiJENPTkZJRy5iYWsiOyB0aGVuCiAgICAgICAgY3AgIiRDT05GSUcuYmFrIiAiJENPTkZJRyIKICAgICAgICBzaCAiJFNFUlZJQ0UiIHN0YXJ0ID4+ICIkU1VCX0xPRyIgMj4mMSB8fCB0cnVlCiAgICAgIGZpCiAgICAgIGxvZ19tc2cgIumHjeWQryBtaWhvbW8g5aSx6LSl77yM5bey5Zue5rua6Iez5pen6YWN572uIgogICAgICB3cml0ZV9zdGF0dXMgImVycm9yIiAi6YeN5ZCv5aSx6LSl77yM5bey5Zue5rua5pen6YWN572uIiAwCiAgICAgIHJldHVybiAxCiAgICBmaQogIGZpCgogIGxvZ19tc2cgIuiuoumYheabtOaWsOaIkOWKn+W5tuW3sueUn+aViO+8iOajgOa1i+WIsOe6piAkUFJPWFlfQ09VTlQg5p2h6IqC54K5L+etlueVpemhue+8iSIKICB3cml0ZV9zdGF0dXMgIm9rIiAi6K6i6ZiF5pu05paw5oiQ5YqfIiAiJFBST1hZX0NPVU5UIgogIHJldHVybiAwCn0KCnJ1bl9kYWVtb24oKSB7CiAgU0xFRVBfU1RFUD0ke1NVQl9TQ0hFRFVMRVJfVElDSzotMzAwfQogIExBU1RfUlVOPTAKICBpZiB0ZXN0IC1mICIkU1RBVFVTX0ZJTEUiOyB0aGVuCiAgICBMQVNUX1JVTj0kKHNlZCAtbiAncy8uKiJ0aW1lc3RhbXAiW1s6c3BhY2U6XV0qOltbOnNwYWNlOl1dKlwoWzAtOV0qXCkuKi9cMS9wJyAiJFNUQVRVU19GSUxFIiB8IGhlYWQgLW4gMSkKICAgIHRlc3QgLW4gIiRMQVNUX1JVTiIgfHwgTEFTVF9SVU49MAogIGZpCiAgbG9nX21zZyAi5a6a5pe26K6i6ZiF5pu05paw5a6I5oqk6L+b56iL5bey5ZCv5YqoIgogIFRJQ0s9MAogIHdoaWxlIHRydWU7IGRvCiAgICBpZiB0ZXN0ICQoKFRJQ0sgJSAxMikpIC1lcSAwOyB0aGVuCiAgICAgIHRyaW1fbG9nICIkQ09SRV9MT0ciCiAgICAgIHRyaW1fbG9nICIkU1VCX0xPRyIKICAgIGZpCiAgICBUSUNLPSQoKFRJQ0sgKyAxKSkKICAgIEFVVE9fVVBEQVRFPSQocmVhZF9qc29uX2ZpZWxkICJhdXRvVXBkYXRlIiAiZmFsc2UiKQogICAgaWYgdGVzdCAiJEFVVE9fVVBEQVRFIiAhPSAidHJ1ZSI7IHRoZW4KICAgICAgbG9nX21zZyAi5a6a5pe25pu05paw5bey5YWz6Zet77yM5a6I5oqk6L+b56iL6YCA5Ye6IgogICAgICBleGl0IDAKICAgIGZpCiAgICBpZiB0ZXN0IC1uICIke1NVQl9JTlRFUlZBTF9TRUNPTkRTOi19IjsgdGhlbgogICAgICBJTlRFUlZBTF9TRUM9IiRTVUJfSU5URVJWQUxfU0VDT05EUyIKICAgIGVsc2UKICAgICAgSE9VUlM9JChyZWFkX2pzb25fZmllbGQgImludGVydmFsSG91cnMiICIyNCIpCiAgICAgIGNhc2UgIiRIT1VSUyIgaW4KICAgICAgICAnJ3wqWyEwLTldKikgSE9VUlM9MjQgOzsKICAgICAgZXNhYwogICAgICBpZiB0ZXN0ICIkSE9VUlMiIC1sdCAxOyB0aGVuIEhPVVJTPTE7IGZpCiAgICAgIElOVEVSVkFMX1NFQz0kKChIT1VSUyAqIDM2MDApKQogICAgZmkKICAgIE5PVz0kKGRhdGUgKyVzIDI+L2Rldi9udWxsIHx8IGVjaG8gMCkKICAgIERJRkY9JCgoTk9XIC0gTEFTVF9SVU4pKQogICAgaWYgdGVzdCAiJERJRkYiIC1nZSAiJElOVEVSVkFMX1NFQyI7IHRoZW4KICAgICAgbG9nX21zZyAi6Kem5Y+R5a6a5pe26K6i6ZiF5pu05paw77yI6Ze06ZqUICR7SU5URVJWQUxfU0VDfXPvvIkiCiAgICAgIHJ1bl91cGRhdGUgfHwgdHJ1ZQogICAgICBMQVNUX1JVTj0kKGRhdGUgKyVzIDI+L2Rldi9udWxsIHx8IGVjaG8gIiROT1ciKQogICAgZmkKICAgIHNsZWVwICIkU0xFRVBfU1RFUCIKICBkb25lCn0KCmNhc2UgIiQxIiBpbgogIHJ1bikgcnVuX3VwZGF0ZSA7OwogIGRhZW1vbikgcnVuX2RhZW1vbiA7OwogICopIGVjaG8gJ+eUqOazlTogdXBkYXRlLXN1Yi5zaCB7cnVufGRhZW1vbn0nOyBleGl0IDEgOzsKZXNhYwo=';

  const INIT_DIRS_SH = `mkdir -p ${ROOT}/bin ${CONFIG_DIR} ${ROOT}/scripts ${ROOT}/run ${ROOT}/tmp ${SUB_DIR} ${DASHBOARD_DIR} ${LOG_DIR}`;
  const WRITE_SCRIPTS_SH = `
    echo ${shQuote(SERVICE_SCRIPT_B64)} | base64 -d > ${SERVICE}
    chmod 755 ${SERVICE}
    echo ${shQuote(UPDATE_SUB_SCRIPT_B64)} | base64 -d > ${UPDATE_SUB_SCRIPT_PATH}
    chmod 755 ${UPDATE_SUB_SCRIPT_PATH}`;
  const DECOMPRESS_FN_SH = `
    decompress_gz() {
      SRC="$1"; DST="$2"; rm -f "$DST"
      for CMD in "gzip -dc" "gunzip -c" "zcat" "toybox gzip -dc" "toybox gunzip -c" "busybox gzip -dc"; do
        if $CMD "$SRC" > "$DST" 2>/dev/null && test -s "$DST"; then return 0; fi
      done
      rm -f "$DST"; return 1
    }`;
  const SWAP_AND_START_SH = `
    if test -x ${SERVICE}; then sh ${SERVICE} stop || true; fi
    rm -f ${BIN}.bak
    if test -x ${BIN}; then mv ${BIN} ${BIN}.bak; fi
    mv ${BIN}.new ${BIN}
    if ${BIN} -t -d ${CONFIG_DIR} -f ${CONFIG} && sh ${SERVICE} start; then
      rm -f ${BIN}.bak
    else
      if test -x ${BIN}.bak; then
        mv ${BIN}.bak ${BIN}
        sh ${SERVICE} start || true
      fi
      echo '新内核启动失败，已回滚旧内核'
      exit 4
    fi`;
  const REMOVE_BOOT_SH = `if test -f ${BOOT}; then (grep -vF '${SERVICE} start' ${BOOT} || true) > ${BOOT}.tmp && mv ${BOOT}.tmp ${BOOT}; fi`;

  const ensureScriptsInstalled = async () => {
    const res = await shell(`${INIT_DIRS_SH}\n${WRITE_SCRIPTS_SH}`);
    if (!res.success) throw new Error(res.content || '写入服务与订阅脚本失败');
  };

  const uploadFileToDevice = async (file) => {
    const formData = new FormData();
    formData.append('file', file);
    const response = await fetch(`${KANO_baseURL}/upload_img`, { method: 'POST', headers: common_headers, body: formData });
    const data = await response.json();
    if (!data.url || !/^[A-Za-z0-9_./-]+$/.test(data.url)) {
      throw new Error(data.error || '上传接口未返回有效路径');
    }
    return `${UPLOAD_ROOT}/${data.url.replace(/^\/+/, '')}`;
  };

  const runServiceWithLog = async (action, title, successMsg) => {
    if (!(await requireReady())) return false;
    const actionLog = `${LOG_DIR}/action.log`;
    const actionPid = `${ROOT}/run/action.pid`;
    const actionRc = `${ROOT}/run/action.rc`;
    const actionScript = `${ROOT}/tmp/action.sh`;
    const progress = createFixedToast(
      `mihomo_action_${action}`,
      `<div style="pointer-events:all;width:86vw;max-width:680px">
        <div class="title" style="margin:0">${escapeHtml(title)}</div>
        <div class="status" style="margin:10px 0 6px">正在执行…</div>
        <div style="height:10px;background:#ffffff22;border-radius:8px;overflow:hidden">
          <div class="bar" style="height:100%;width:10%;background:#35c46a;border-radius:8px;transition:width .3s"></div>
        </div>
        <pre class="log" style="background:#000d;color:#0f0;box-sizing:border-box;line-height:1.4;margin:10px 0;padding:8px;height:210px;max-height:42vh;overflow:auto;font-size:.64rem;white-space:pre-wrap">正在准备执行…</pre>
        <div style="text-align:right"><button class="close_btn" style="display:none">关闭</button></div>
      </div>`,
      '',
    );
    const barEl = progress.el.querySelector('.bar');
    const statusEl = progress.el.querySelector('.status');
    const logEl = progress.el.querySelector('.log');
    const closeBtn = progress.el.querySelector('.close_btn');
    closeBtn.onclick = () => progress.close();

    const scriptBody = `#!/system/bin/sh\ntrap 'RC=$?; echo "$RC" > ${shQuote(actionRc)}; rm -f ${shQuote(actionPid)}' EXIT\nsh ${SERVICE} ${action}\n`;
    const launchRes = await shell(`
      ${INIT_DIRS_SH}
      rm -f ${shQuote(actionRc)} ${shQuote(actionPid)}
      : > ${shQuote(actionLog)}
      echo ${shQuote(utf8ToBase64(scriptBody))} | base64 -d > ${shQuote(actionScript)}
      chmod 755 ${shQuote(actionScript)}
      nohup sh ${shQuote(actionScript)} >> ${shQuote(actionLog)} 2>&1 </dev/null &
      echo $! > ${shQuote(actionPid)}
    `, 15000);

    if (!launchRes.success) {
      barEl.style.width = '100%';
      barEl.style.background = '#e55353';
      statusEl.textContent = `${title}启动失败`;
      logEl.textContent = launchRes.content || '无法启动操作脚本';
      closeBtn.style.display = 'inline-block';
      createToast(`${title}失败`, 'red');
      return false;
    }

    const startTime = Date.now();
    let finalRc = null;
    let lastLog = '';
    while (finalRc === null) {
      await wait(400);
      const poll = await shell(`
        if test -f ${shQuote(actionRc)}; then
          echo "DONE=$(cat ${shQuote(actionRc)} 2>/dev/null | head -n 1)"
        elif test -f ${shQuote(actionPid)} && kill -0 "$(cat ${shQuote(actionPid)} 2>/dev/null)" 2>/dev/null; then
          echo 'RUNNING=1'
        else
          echo 'DONE=1'
        fi
        echo '===MIHOMO_LOG==='
        tail -n 100 ${shQuote(actionLog)} 2>/dev/null || true
      `, 10000);

      const out = poll.content || '';
      const sepMarker = '===MIHOMO_LOG===\n';
      const sepIdx = out.indexOf(sepMarker);
      const meta = sepIdx >= 0 ? out.slice(0, sepIdx) : out;
      const logText = sepIdx >= 0 ? out.slice(sepIdx + sepMarker.length) : '';
      if (logText) {
        lastLog = logText;
        logEl.textContent = logText;
        logEl.scrollTop = logEl.scrollHeight;
      }

      const stageMatches = [...lastLog.matchAll(/\[(\d+)\/(\d+)\]\s*([^\n]+)/g)];
      if (stageMatches.length) {
        const last = stageMatches[stageMatches.length - 1];
        const step = Number(last[1]);
        const total = Math.max(1, Number(last[2]));
        barEl.style.width = `${Math.min(95, Math.max(15, Math.round((step / total) * 95)))}%`;
        statusEl.textContent = `[${step}/${total}] ${last[3].trim()}`;
      }

      const doneMatch = meta.match(/^DONE=(\d+)/m);
      if (doneMatch) { finalRc = Number(doneMatch[1]); break; }
      if (Date.now() - startTime > 60000) { finalRc = 124; break; }
    }

    await isRunning();
    if (finalRc !== 0) {
      barEl.style.width = '100%';
      barEl.style.background = '#e55353';
      statusEl.textContent = `${title}失败（退出码 ${finalRc}）`;
      closeBtn.style.display = 'inline-block';
      createToast(`${title}失败（退出码 ${finalRc}），请查看弹窗日志`, 'red');
      return false;
    }

    barEl.style.width = '100%';
    statusEl.textContent = successMsg;
    await wait(600);
    progress.close();
    createToast(successMsg, 'green');
    return true;
  };

  const restart = async (quiet = false) => {
    if (quiet) {
      if (!(await requireReady())) return false;
      const res = await shell(`${BIN} -t -d ${CONFIG_DIR} -f ${CONFIG} && sh ${SERVICE} restart`, 100000);
      await wait(1200);
      await isRunning();
      return !!res.success;
    }
    return runServiceWithLog('restart', '重启 mihomo', 'mihomo 已重启');
  };

  const saveUploadedConfig = async (file) => {
    try {
      const source = await uploadFileToDevice(file);
      const candidate = `${CONFIG_DIR}/config.candidate.yaml`;
      const res = await shell(`
        mv ${shQuote(source)} ${candidate} || exit 1
        chmod 600 ${candidate}
        ${BIN} -t -d ${CONFIG_DIR} -f ${candidate} || { rm -f ${candidate}; exit 2; }
        cp ${CONFIG} ${CONFIG}.bak 2>/dev/null || true
        mv ${candidate} ${CONFIG}
        sh ${SERVICE} restart
      `, 100000);
      if (!res.success) throw new Error(res.content || '配置校验或重启失败');
      createToast('配置已通过校验并生效', 'green');
      await wait(800);
      await isRunning();
      return true;
    } catch (error) {
      createToast(`保存失败，旧配置未被覆盖：<br>${escapeHtml(error.message || error)}`, 'red');
      return false;
    }
  };

  const extractCurrentSecret = (yamlText = '') => {
    const match = String(yamlText).match(/^secret:\s*['"]?([^\s'"#]+)['"]?/m);
    return match ? match[1] : '';
  };

  const getActualSecret = async () => {
    const res = await shell(`grep '^secret:' ${CONFIG} 2>/dev/null | head -n 1`, 10000);
    return extractCurrentSecret(res.content || '');
  };

  const buildPanelUrl = async (withTimestamp = true) => {
    const host = UFI_DATA.lan_ipaddr;
    const sec = await getActualSecret();
    const params = new URLSearchParams({ hostname: host, port: String(API_PORT) });
    if (withTimestamp) params.set('t', String(Date.now()));
    if (sec) params.set('secret', sec);
    return `http://${host}:${API_PORT}/ui/?${params.toString()}`;
  };

  const showInstalledDialog = async (id, title, extraNote = '') => {
    const actualSecret = await getActualSecret();
    const panelHref = await buildPanelUrl(false);
    const secretLine = actualSecret
      ? `面板密码：<code>${escapeHtml(actualSecret)}</code>`
      : '面板密码：无（默认免密，可在“面板密码”按钮中设置）';
    await confirmDialog(id, title,
      `默认 Mixed 代理：<b>${escapeHtml(UFI_DATA.lan_ipaddr)}:${MIXED_PORT}</b><br>` +
      `面板：<a target="_blank" href="${panelHref}">http://${escapeHtml(UFI_DATA.lan_ipaddr)}:${API_PORT}/ui/</a><br>` +
      `${secretLine}${extraNote ? `<br>${extraNote}` : ''}`, '知道了');
  };

  const buildDefaultConfig = (secret = '', mirrorPrefix = '') => {
    const uiUrl = applyMirror(ZASHBOARD_RAW_URL, mirrorPrefix);
    const yamlSecret = String(secret || '').replaceAll("'", "''");
    return [
      `mixed-port: ${MIXED_PORT}`,
      `tproxy-port: ${TPROXY_PORT}`,
      'allow-lan: true',
      "bind-address: '*'",
      'mode: rule',
      'log-level: error',
      'ipv6: true',
      'find-process-mode: off',
      'tcp-concurrent: false',
      'unified-delay: false',
      'keep-alive-idle: 60',
      'keep-alive-interval: 60',
      'geodata-loader: memconservative',
      'tun:',
      '  enable: false',
      `external-controller: 0.0.0.0:${API_PORT}`,
      `external-ui: ${DASHBOARD_DIR}`,
      `external-ui-url: '${uiUrl}'`,
      `secret: '${yamlSecret}'`,
      'profile:',
      '  store-selected: true',
      '  store-fake-ip: false',
      'sniffer:',
      '  enable: false',
      'dns:',
      '  enable: true',
      `  listen: 0.0.0.0:${DNS_PORT}`,
      '  ipv6: true',
      '  enhanced-mode: fake-ip',
      '  fake-ip-range: 198.18.0.1/16',
      '  fake-ip-range6: fc00::/18',
      '  default-nameserver:',
      '    - 223.5.5.5',
      '    - 119.29.29.29',
      '  nameserver:',
      '    - 223.5.5.5',
      '    - 119.29.29.29',
      'proxies: []',
      'proxy-groups:',
      '  - name: PROXY',
      '    type: select',
      '    proxies:',
      '      - DIRECT',
      'rules:',
      '  - MATCH,DIRECT',
      '',
    ].join('\n');
  };

  const readInstallSettings = async () => {
    const fileData = await readJsonFile(INSTALL_CONFIG, {});
    const defaultMirror = MIRROR_PRESETS[0]?.value || 'https://gh-proxy.org/';
    return {
      mirrorPreset: fileData.mirrorPreset ?? lsGet('mihomo_mirror_preset', defaultMirror),
      customMirror: fileData.customMirror ?? lsGet('mihomo_custom_mirror', ''),
      version: fileData.version ?? '',
      directUrl: fileData.directUrl ?? '',
    };
  };

  const saveInstallSettings = async (settings) => {
    lsSet('mihomo_mirror_preset', settings.mirrorPreset || '');
    lsSet('mihomo_custom_mirror', settings.customMirror || '');
    try { await writeJsonFile(INSTALL_CONFIG, settings); } catch { /* may not exist before install */ }
  };

  const resolveActiveMirror = (settings) => {
    if (settings.mirrorPreset === 'custom') return normalizeMirrorPrefix(settings.customMirror);
    return normalizeMirrorPrefix(settings.mirrorPreset);
  };

  const readSubscriptions = async () => readJsonFile(SUB_CONFIG, {});

  const saveSubscriptions = async (subscriptions) => {
    await writeJsonFile(SUB_CONFIG, subscriptions);
  };

  const syncSubScheduler = async (autoUpdate) => {
    if (!(await isInstalled())) return;
    await ensureScriptsInstalled();
    const cmd = autoUpdate ? `sh ${SERVICE} sub-start` : `sh ${SERVICE} sub-stop`;
    await shell(cmd, 30000);
    await isRunning();
  };

  const updateSubscriptions = async () => {
    if (!(await requireReady())) return false;
    const progress = createFixedToast('mihomo_subscription_update', `
      <div style="pointer-events:all;width:82vw;max-width:520px">
        <div class="title" style="margin:0">更新 mihomo 订阅</div>
        <div class="status" style="margin:12px 0">正在准备订阅更新脚本…</div>
        <div style="height:10px;background:#ffffff22;border-radius:8px;overflow:hidden"><div class="bar" style="height:100%;width:15%;background:#35c46a;transition:width .4s"></div></div>
        <div class="detail" style="margin-top:8px;font-size:.62rem;opacity:.8">更新前会自动备份，mihomo -t 校验失败不会覆盖旧配置</div>
      </div>`);
    const setProgress = (percent, status) => {
      progress.el.querySelector('.bar').style.width = `${percent}%`;
      progress.el.querySelector('.status').textContent = status;
    };
    try {
      const subscriptions = await readSubscriptions();
      if (!subscriptions.url) throw new Error('请先打开“导入/订阅设置”填写 Clash / Mihomo 订阅地址');
      await ensureScriptsInstalled();
      setProgress(40, '正在下载、合并配置并校验…');
      const res = await shell(`sh ${UPDATE_SUB_SCRIPT_PATH} run`, 100000);
      if (!res.success) {
        const st = await readJsonFile(SUB_STATUS_FILE, {});
        throw new Error(st.message || res.content || '订阅更新失败');
      }
      const st = await readJsonFile(SUB_STATUS_FILE, {});
      setProgress(100, '订阅更新成功');
      await wait(500);
      progress.close();
      await isRunning();
      const extra = st.proxies ? `（约 ${st.proxies} 条节点/策略项）` : '';
      createToast(`mihomo 订阅更新并生效成功${extra}`, 'green');
      return true;
    } catch (error) {
      progress.close();
      createToast(`订阅更新失败：<br>${escapeHtml(error.message || error)}`, 'red');
      return false;
    }
  };

  const editSubscriptions = async () => {
    if (!(await requireRoot())) return;
    const current = await readSubscriptions();
    const status = await readJsonFile(SUB_STATUS_FILE, {});
    const statusText = status.updatedAt
      ? `上次更新：${escapeHtml(status.updatedAt)}（${status.status === 'ok' ? '成功' : '失败'} - ${escapeHtml(status.message || '')}）`
      : '尚未执行过订阅更新';
    const intervalOptions = [
      { label: '每 6 小时', value: 6 },
      { label: '每 12 小时', value: 12 },
      { label: '每 24 小时（每天）', value: 24 },
      { label: '每 72 小时（每3天）', value: 72 },
      { label: '每 168 小时（每周）', value: 168 },
    ];
    const currentInterval = Number(current.intervalHours) || 24;
    const isPresetInterval = intervalOptions.some((o) => o.value === currentInterval);

    const { el, close } = createFixedToast('mihomo_subscriptions', `
      <div style="pointer-events:all;width:88vw;max-width:720px">
        <div class="title" style="margin:0">导入订阅与定时更新设置</div>
        <label style="display:block;margin-top:10px">Clash / Mihomo 订阅地址（YAML）</label>
        <input class="sub_url" type="url" style="width:100%;box-sizing:border-box" placeholder="https://...">
        <label style="display:block;margin-top:10px">User-Agent（可选，默认 clash-verge/v1.7.7）</label>
        <input class="sub_ua" type="text" style="width:100%;box-sizing:border-box" placeholder="clash-verge/v1.7.7">
        <label style="display:flex;align-items:center;gap:6px;margin-top:10px;font-size:.7rem">
          <input class="auto_patch" type="checkbox">
          自动注入/保留 UFI TProxy(7893)、DNS(1053) 与面板(9090) 配置（推荐）
        </label>
        <div style="margin-top:12px;padding:8px;border:1px solid #ffffff22;border-radius:8px">
          <label style="display:flex;align-items:center;gap:6px;font-size:.72rem;font-weight:bold">
            <input class="auto_update" type="checkbox">
            启用定时自动更新订阅（后台守护进程，随服务/开机自启）
          </label>
          <div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap">
            <span style="font-size:.68rem">更新间隔：</span>
            <select class="interval_select" style="padding:4px">
              ${intervalOptions.map((o) => `<option value="${o.value}">${o.label}</option>`).join('')}
              <option value="custom">自定义小时数…</option>
            </select>
            <input class="interval_custom" type="number" min="1" max="720" style="width:90px;display:none" placeholder="小时">
          </div>
          <div style="margin-top:6px;font-size:.62rem;opacity:.8">${statusText}</div>
        </div>
        <div style="margin-top:10px;font-size:.62rem;opacity:.8">配置保存在设备 ${SUB_CONFIG}</div>
        <div style="margin-top:14px;text-align:right;display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap">
          <button class="save_and_import">保存并立即导入</button>
          <button class="save">仅保存设置</button>
          <button class="cancel">取消</button>
        </div>
      </div>`);

    const urlInput = el.querySelector('.sub_url');
    const uaInput = el.querySelector('.sub_ua');
    const autoPatchInput = el.querySelector('.auto_patch');
    const autoUpdateInput = el.querySelector('.auto_update');
    const intervalSelect = el.querySelector('.interval_select');
    const intervalCustom = el.querySelector('.interval_custom');

    urlInput.value = current.url || '';
    uaInput.value = current.ua || 'clash-verge/v1.7.7';
    autoPatchInput.checked = current.autoPatch !== false;
    autoUpdateInput.checked = !!current.autoUpdate;
    intervalSelect.value = isPresetInterval ? String(currentInterval) : 'custom';
    intervalCustom.value = String(currentInterval);
    intervalCustom.style.display = isPresetInterval ? 'none' : 'inline-block';

    intervalSelect.onchange = () => {
      intervalCustom.style.display = intervalSelect.value === 'custom' ? 'inline-block' : 'none';
    };

    const collectAndSave = async () => {
      const urlText = urlInput.value.trim();
      const ua = uaInput.value.trim() || 'clash-verge/v1.7.7';
      const autoPatch = autoPatchInput.checked;
      const autoUpdate = autoUpdateInput.checked;
      const rawHours = intervalSelect.value === 'custom' ? Number(intervalCustom.value) : Number(intervalSelect.value);
      const intervalHours = Number.isFinite(rawHours) && rawHours >= 1 ? Math.floor(rawHours) : 24;
      const parsed = new URL(urlText);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('订阅地址必须使用 HTTP 或 HTTPS');
      await saveSubscriptions({ url: urlText, ua, autoPatch, autoUpdate, intervalHours });
      await syncSubScheduler(autoUpdate);
      return { autoUpdate, intervalHours };
    };

    el.querySelector('.cancel').onclick = close;
    el.querySelector('.save').onclick = async () => {
      try {
        const { autoUpdate, intervalHours } = await collectAndSave();
        close();
        createToast(autoUpdate ? `订阅设置已保存，已开启每 ${intervalHours} 小时定时更新` : '订阅设置已保存', 'green');
      } catch (error) {
        createToast(escapeHtml(error.message || error), 'red');
      }
    };
    el.querySelector('.save_and_import').onclick = async () => {
      try {
        await collectAndSave();
        close();
        await updateSubscriptions();
      } catch (error) {
        createToast(escapeHtml(error.message || error), 'red');
      }
    };
  };

  const buildMirrorCandidates = (activeMirror) => {
    const list = [];
    const add = (m) => {
      const norm = normalizeMirrorPrefix(m);
      if (!list.includes(norm)) list.push(norm);
    };
    add(activeMirror);
    for (const preset of MIRROR_PRESETS) {
      if (preset.value && preset.value !== 'custom') add(preset.value);
    }
    add(''); // direct GitHub fallback
    return list;
  };

  const installOrUpdate = async (options = null) => {
    if (!(await requireRoot())) return false;
    const settings = options || (await readInstallSettings());
    const activeMirror = resolveActiveMirror(settings);
    const mirrorCandidates = buildMirrorCandidates(activeMirror);
    const installed = await isInstalled();
    const secret = '';
    const progress = createFixedToast(
      'mihomo_install_progress',
      `<div style="pointer-events:all;width:88vw;max-width:760px">
        <div class="title" style="margin:0">mihomo 安装器</div>
        <div class="status" style="margin:10px 0 6px">正在启动安装任务…</div>
        <div style="height:10px;background:#ffffff22;border-radius:8px;overflow:hidden">
          <div class="bar" style="height:100%;width:5%;background:#35c46a;border-radius:8px;transition:width .4s"></div>
        </div>
        <pre class="log" style="background:#000d;color:#0f0;box-sizing:border-box;line-height:1.4;margin:10px 0;padding:8px;height:260px;max-height:48vh;overflow:auto;font-size:.64rem;white-space:pre-wrap">正在初始化安装日志…</pre>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <div class="detail" style="font-size:.62rem;opacity:.8">安装日志：${escapeHtml(INSTALL_LOG)}</div>
          <div style="display:flex;gap:8px">
            <button class="close_btn" style="display:none">关闭</button>
          </div>
        </div>
      </div>`,
      '',
    );

    const barEl = progress.el.querySelector('.bar');
    const statusEl = progress.el.querySelector('.status');
    const detailEl = progress.el.querySelector('.detail');
    const logEl = progress.el.querySelector('.log');
    const closeBtn = progress.el.querySelector('.close_btn');
    closeBtn.onclick = () => progress.close();

    const defaultConfig = buildDefaultConfig(secret, activeMirror);
    const mirrorListShell = mirrorCandidates.map((m) => shQuote(m)).join(' ');
    const customVersion = String(settings.version || '').trim();
    const directUrl = String(settings.directUrl || '').trim();
    const installScriptPath = `${ROOT}/tmp/install.sh`;
    const installPidPath = `${ROOT}/run/install.pid`;
    const installRcPath = `${ROOT}/run/install.rc`;

    const installScript = `#!/system/bin/sh
set -e
trap 'RC=$?; echo "$RC" > ${shQuote(installRcPath)}; rm -f ${shQuote(installPidPath)}' EXIT
stage() { echo "$1"; }
CURL_BIN=${shQuote(CURL)}
if ! test -x "$CURL_BIN"; then CURL_BIN=$(command -v curl 2>/dev/null || echo "$CURL_BIN"); fi
fetch_file() {
  URL="$1"; OUT="$2"
  "$CURL_BIN" -fsSL --connect-timeout 15 --max-time 90 "$URL" -o "$OUT" 2>&1 \
    || "$CURL_BIN" -fsSL --connect-timeout 15 --max-time 90 -x http://127.0.0.1:${MIXED_PORT} "$URL" -o "$OUT" 2>&1
}
fetch_download() {
  URL="$1"; OUT="$2"; HDR="$3"
  rm -f "$OUT" "$HDR"
  "$CURL_BIN" -fsSL -D "$HDR" --connect-timeout 15 --max-time 300 "$URL" -o "$OUT" 2>&1 \
    || { rm -f "$OUT" "$HDR"; "$CURL_BIN" -fsSL -D "$HDR" --connect-timeout 15 --max-time 300 -x http://127.0.0.1:${MIXED_PORT} "$URL" -o "$OUT" 2>&1; }
}

stage '[1/7] 检测设备架构与版本'
MACHINE=$(uname -m 2>/dev/null || echo unknown)
ABI=$(getprop ro.product.cpu.abi 2>/dev/null || true)
ABI2=$(getprop ro.product.cpu.abilist 2>/dev/null || true)
case "$ABI" in
  arm64-v8a|aarch64|arm64) ARCH=arm64-v8 ;;
  armeabi-v7a|armeabi|armv7*|armhf) ARCH=armv7 ;;
  x86_64|amd64) ARCH=amd64 ;;
  x86|i386|i486|i586|i686) ARCH=386 ;;
  *)
    case "$MACHINE $ABI2" in
      *arm64-v8a*|*aarch64*|*arm64*) ARCH=arm64-v8 ;;
      *armeabi-v7a*|*armeabi*|*armv8l*|*armv7*|*armhf*) ARCH=armv7 ;;
      *x86_64*|*amd64*) ARCH=amd64 ;;
      *x86*|*i386*|*i486*|*i586*|*i686*) ARCH=386 ;;
      *) echo "不支持的架构: uname=$MACHINE, abi=$ABI, abilist=$ABI2"; exit 3 ;;
    esac
    ;;
esac

DIRECT_URL=${shQuote(directUrl)}
TAG=${shQuote(customVersion)}
if test -z "$DIRECT_URL" && test -z "$TAG"; then
  rm -f ${ROOT}/tmp/latest.json ${ROOT}/tmp/latest.html
  for M in ${mirrorListShell}; do
    LATEST_URL="\${M}${GITHUB_RELEASE_BASE}/latest"
    stage "探测最新版本: $LATEST_URL"
    EFF_URL=$("$CURL_BIN" -fsSLI --connect-timeout 10 --max-time 20 -o /dev/null -w '%{url_effective}' "$LATEST_URL" 2>/dev/null || true)
    TAG=$(printf '%s' "$EFF_URL" | sed -n 's|.*/releases/tag/\\(v[0-9A-Za-z._-]*\\).*|\\1|p' | head -n 1)
    if test -n "$TAG"; then stage "通过镜像重定向获取到版本: $TAG ($M)"; break; fi
    if fetch_file "$LATEST_URL" ${ROOT}/tmp/latest.html; then
      TAG=$(sed -n 's|.*/releases/tag/\\(v[0-9A-Za-z._-]*\\).*|\\1|p' ${ROOT}/tmp/latest.html | head -n 1)
      if test -n "$TAG"; then stage "通过镜像页面获取到版本: $TAG ($M)"; break; fi
    fi
  done
  if test -z "$TAG"; then
    for M in ${mirrorListShell}; do
      API_URL="\${M}${GITHUB_API_LATEST}"
      stage "尝试 GitHub API: $API_URL"
      if fetch_file "$API_URL" ${ROOT}/tmp/latest.json; then
        TAG=$(sed -n 's/.*"tag_name"[ ]*:[ ]*"\\([^"]*\\)".*/\\1/p' ${ROOT}/tmp/latest.json | head -n 1)
        if test -n "$TAG"; then stage "通过 GitHub API 获取到版本: $TAG ($M)"; break; fi
      fi
    done
  fi
  if test -z "$TAG"; then
    stage '无法自动获取最新版本号，请更换 GitHub 镜像源、填写版本号或手动上传内核'
    exit 2
  fi
fi
stage "架构=android-$ARCH, 版本=\${TAG:-自定义直链}"

stage '[2/7] 通过镜像源下载 Android 内核'
rm -f ${ROOT}/tmp/mihomo.download ${ROOT}/tmp/mihomo.headers ${ROOT}/bin/mihomo.new
DOWNLOADED=0
if test -n "$DIRECT_URL"; then
  stage "尝试直链下载: $DIRECT_URL"
  if fetch_download "$DIRECT_URL" ${ROOT}/tmp/mihomo.download ${ROOT}/tmp/mihomo.headers && test -s ${ROOT}/tmp/mihomo.download; then
    DOWNLOADED=1
  fi
else
  RAW_ASSET="${GITHUB_RELEASE_BASE}/download/$TAG/mihomo-android-$ARCH-$TAG.gz"
  for M in ${mirrorListShell}; do
    TRY_URL="\${M}\${RAW_ASSET}"
    stage "尝试下载: $TRY_URL"
    if fetch_download "$TRY_URL" ${ROOT}/tmp/mihomo.download ${ROOT}/tmp/mihomo.headers && test -s ${ROOT}/tmp/mihomo.download; then
      DOWNLOADED=1
      stage "下载成功: $TRY_URL"
      break
    fi
  done
fi
if test "$DOWNLOADED" != "1"; then
  stage '所有镜像源均下载失败，请更换自定义镜像源或使用手动上传内核'
  exit 2
fi

stage '[3/7] 解压并验证内核'
${DECOMPRESS_FN_SH}
cp ${ROOT}/tmp/mihomo.download ${ROOT}/tmp/mihomo.download.gz
if decompress_gz ${ROOT}/tmp/mihomo.download.gz ${ROOT}/bin/mihomo.new; then
  stage 'gzip 解压成功'
else
  # 若不是 gzip 包（例如自定义直链下载的是裸 ELF 二进制），再直接拷贝
  MAGIC=$(head -c 2 ${ROOT}/tmp/mihomo.download 2>/dev/null | od -An -tx1 2>/dev/null | tr -d ' \n' || true)
  if test "$MAGIC" = "1f8b"; then
    stage '错误：下载文件是 .gz 压缩包，但设备缺少可用的 gzip/gunzip 解压命令'
    exit 3
  fi
  cp ${ROOT}/tmp/mihomo.download ${ROOT}/bin/mihomo.new
fi
rm -f ${ROOT}/tmp/mihomo.download.gz
chmod 755 ${ROOT}/bin/mihomo.new
${ROOT}/bin/mihomo.new -v

stage '[4/7] 创建并校验配置'
if ! test -f ${CONFIG}; then
  echo ${shQuote(utf8ToBase64(defaultConfig))} | base64 -d > ${CONFIG}
  chmod 600 ${CONFIG}
elif grep -q "${ROOT}/dashboard" ${CONFIG} 2>/dev/null; then
  stage "自动修正旧配置 external-ui 路径 -> ${DASHBOARD_DIR}"
  sed "s|${ROOT}/dashboard|${DASHBOARD_DIR}|g" ${CONFIG} > ${CONFIG}.fix && mv ${CONFIG}.fix ${CONFIG}
  chmod 600 ${CONFIG}
fi
if ! test -f ${SUB_CONFIG}; then echo '{}' > ${SUB_CONFIG}; chmod 600 ${SUB_CONFIG}; fi
${ROOT}/bin/mihomo.new -t -d ${CONFIG_DIR} -f ${CONFIG}

stage '[5/7] 安装服务与订阅脚本'
${WRITE_SCRIPTS_SH}

stage '[6/7] 启动服务'
${SWAP_AND_START_SH}
rm -rf ${ROOT}/tmp/mihomo.download ${ROOT}/tmp/mihomo.headers ${ROOT}/tmp/latest.json ${ROOT}/tmp/latest.html
stage '[7/7] 安装完成'
${BIN} -v | head -n 1
`;

    const launchRes = await shell(`
      ${INIT_DIRS_SH}
      rm -f ${shQuote(installRcPath)} ${shQuote(installPidPath)}
      : > ${shQuote(INSTALL_LOG)}
      echo ${shQuote(utf8ToBase64(installScript))} | base64 -d > ${shQuote(installScriptPath)}
      chmod 755 ${shQuote(installScriptPath)}
      nohup sh ${shQuote(installScriptPath)} >> ${shQuote(INSTALL_LOG)} 2>&1 </dev/null &
      echo $! > ${shQuote(installPidPath)}
    `, 20000);

    if (!launchRes.success) {
      barEl.style.background = '#e55353';
      statusEl.textContent = '启动安装任务失败';
      logEl.textContent = launchRes.content || '无法启动安装脚本';
      closeBtn.style.display = 'inline-block';
      createToast(`启动安装失败：${escapeHtml(launchRes.content || '')}`, 'red');
      return false;
    }

    const formatBytes = (bytes) => {
      if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
      if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${bytes} B`;
    };

    const startTime = Date.now();
    let finalRc = null;
    let lastLog = '';
    let prevDlCur = 0;
    let prevDlTime = Date.now();
    while (finalRc === null) {
      await wait(700);
      const now = Date.now();
      const elapsedSec = Math.floor((now - startTime) / 1000);
      const poll = await shell(`
        if test -f ${shQuote(installRcPath)}; then
          echo "DONE=$(cat ${shQuote(installRcPath)} 2>/dev/null | head -n 1)"
        elif test -f ${shQuote(installPidPath)} && kill -0 "$(cat ${shQuote(installPidPath)} 2>/dev/null)" 2>/dev/null; then
          echo 'RUNNING=1'
        else
          echo 'DONE=1'
        fi
        DL_CUR=0
        DL_TOT=0
        if test -f ${ROOT}/tmp/mihomo.download; then
          DL_CUR=$(wc -c < ${ROOT}/tmp/mihomo.download 2>/dev/null | tr -d ' \\n' || echo 0)
        fi
        if test -f ${ROOT}/tmp/mihomo.headers; then
          DL_TOT=$(grep -i '^content-length:' ${ROOT}/tmp/mihomo.headers 2>/dev/null | tail -n 1 | sed 's/[^0-9]//g' || echo 0)
        fi
        echo "DL_CUR=\${DL_CUR:-0}"
        echo "DL_TOT=\${DL_TOT:-0}"
        echo '===MIHOMO_LOG==='
        tail -n 120 ${shQuote(INSTALL_LOG)} 2>/dev/null || true
      `, 15000);

      const out = poll.content || '';
      const sepMarker = '===MIHOMO_LOG===\n';
      const sepIdx = out.indexOf(sepMarker);
      const meta = sepIdx >= 0 ? out.slice(0, sepIdx) : out;
      const logText = sepIdx >= 0 ? out.slice(sepIdx + sepMarker.length) : '';
      if (logText) {
        lastLog = logText;
        logEl.textContent = logText;
        logEl.scrollTop = logEl.scrollHeight;
      }

      const dlCur = Number((meta.match(/^DL_CUR=(\d+)/m) || [])[1] || 0);
      const dlTot = Number((meta.match(/^DL_TOT=(\d+)/m) || [])[1] || 0);
      const dtSec = Math.max(0.2, (now - prevDlTime) / 1000);
      const speedBps = dlCur >= prevDlCur ? (dlCur - prevDlCur) / dtSec : 0;
      prevDlCur = dlCur;
      prevDlTime = now;

      const stageMatches = [...lastLog.matchAll(/\[(\d)\/7\]\s*([^\n]+)/g)];
      if (stageMatches.length) {
        const lastStage = stageMatches[stageMatches.length - 1];
        const step = Number(lastStage[1]);
        if (step === 2 && dlCur > 0) {
          if (dlTot > 0) {
            const dlPct = Math.min(100, Math.round((dlCur / dlTot) * 100));
            const barPct = Math.min(72, 20 + Math.round((dlPct / 100) * 52));
            barEl.style.width = `${barPct}%`;
            statusEl.textContent = `[2/7] 下载内核：${formatBytes(dlCur)} / ${formatBytes(dlTot)} (${dlPct}%) · ${formatBytes(speedBps)}/s`;
          } else {
            barEl.style.width = '45%';
            statusEl.textContent = `[2/7] 下载内核：已下载 ${formatBytes(dlCur)} · ${formatBytes(speedBps)}/s`;
          }
        } else {
          const pct = Math.min(96, Math.max(10, Math.round((step / 7) * 95)));
          barEl.style.width = `${pct}%`;
          statusEl.textContent = `[${step}/7] ${lastStage[2].trim()}`;
        }
      }
      detailEl.textContent = `已耗时 ${elapsedSec} 秒；日志：${INSTALL_LOG}`;

      const doneMatch = meta.match(/^DONE=(\d+)/m);
      if (doneMatch) {
        finalRc = Number(doneMatch[1]);
        break;
      }
      if (elapsedSec > 420) {
        finalRc = 124;
        break;
      }
    }

    if (finalRc !== 0) {
      barEl.style.width = '100%';
      barEl.style.background = '#e55353';
      statusEl.textContent = `安装失败（退出码 ${finalRc}），请查看上方实时日志`;
      closeBtn.style.display = 'inline-block';
      createToast(`安装/更新失败（退出码 ${finalRc}），请查看弹窗日志`, 'red');
      return false;
    }

    barEl.style.width = '100%';
    statusEl.textContent = '[7/7] 安装完成';
    await isRunning();
    await refreshBootButton();
    progress.close();
    createToast('mihomo 已安装/更新成功', 'green');
    if (!installed) {
      await showInstalledDialog('mihomo_installed', '安装完成', '默认配置为直连，请点击“导入/订阅设置”填入订阅链接或上传 YAML 配置。');
    }
    return true;
  };

  const openInstallDialog = async (triggerCoreUpload) => {
    if (!(await requireRoot())) return;
    const settings = await readInstallSettings();
    const { el, close } = createFixedToast('mihomo_install_dialog', `
      <div style="pointer-events:all;width:88vw;max-width:640px">
        <div class="title" style="margin:0">安装 / 在线更新 mihomo 内核</div>
        <label style="display:block;margin-top:10px">GitHub 镜像源（失败时会自动回退其它镜像）</label>
        <select class="mirror_preset" style="width:100%;padding:6px;box-sizing:border-box">
          ${MIRROR_PRESETS.map((p) => `<option value="${escapeHtml(p.value)}">${escapeHtml(p.label)}</option>`).join('')}
        </select>
        <input class="custom_mirror" type="url" style="width:100%;box-sizing:border-box;margin-top:8px;display:none" placeholder="自定义镜像前缀，例如 https://gh-proxy.org/">
        <label style="display:block;margin-top:10px">指定版本号（可选，留空自动获取最新版）</label>
        <input class="version_input" type="text" style="width:100%;box-sizing:border-box" placeholder="例如 v1.19.34">
        <label style="display:block;margin-top:10px">自定义直链下载地址（可选，支持 .gz 或裸二进制）</label>
        <input class="direct_url" type="url" style="width:100%;box-sizing:border-box" placeholder="留空则从 GitHub Release + 镜像源自动下载">
        <div style="margin-top:10px;font-size:.62rem;opacity:.8">若当前网络无法下载，也可直接点击下方“手动上传内核”进行离线安装或升级（支持 ELF 与官方 .gz 包）。</div>
        <div style="margin-top:14px;text-align:right;display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap">
          <button class="upload_core">手动上传内核</button>
          <button class="start_install">开始下载安装</button>
          <button class="cancel">取消</button>
        </div>
      </div>`);

    const mirrorSelect = el.querySelector('.mirror_preset');
    const customMirrorInput = el.querySelector('.custom_mirror');
    const versionInput = el.querySelector('.version_input');
    const directUrlInput = el.querySelector('.direct_url');

    const hasPreset = MIRROR_PRESETS.some((p) => p.value === settings.mirrorPreset);
    mirrorSelect.value = hasPreset ? settings.mirrorPreset : 'custom';
    customMirrorInput.value = settings.customMirror || (!hasPreset ? settings.mirrorPreset : '');
    customMirrorInput.style.display = mirrorSelect.value === 'custom' ? 'block' : 'none';
    versionInput.value = settings.version || '';
    directUrlInput.value = settings.directUrl || '';

    mirrorSelect.onchange = () => {
      customMirrorInput.style.display = mirrorSelect.value === 'custom' ? 'block' : 'none';
    };

    el.querySelector('.cancel').onclick = close;
    el.querySelector('.upload_core').onclick = () => { close(); triggerCoreUpload(); };
    el.querySelector('.start_install').onclick = async () => {
      const next = {
        mirrorPreset: mirrorSelect.value,
        customMirror: customMirrorInput.value.trim(),
        version: versionInput.value.trim(),
        directUrl: directUrlInput.value.trim(),
      };
      if (next.mirrorPreset === 'custom' && next.customMirror) {
        try { new URL(next.customMirror); } catch { return createToast('自定义镜像源 URL 格式无效', 'red'); }
      }
      if (next.directUrl) {
        try { new URL(next.directUrl); } catch { return createToast('直链下载地址 URL 格式无效', 'red'); }
      }
      await saveInstallSettings(next);
      close();
      await installOrUpdate(next);
    };
  };

  const installUploadedCore = async (file) => {
    if (!(await requireRoot())) return false;
    const magic = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    const isElf = magic[0] === 0x7f && magic[1] === 0x45 && magic[2] === 0x4c && magic[3] === 0x46;
    const isGzip = magic[0] === 0x1f && magic[1] === 0x8b;
    if (!isElf && !isGzip) {
      createToast('只能上传 ELF 可执行文件或官方 .gz 内核压缩包', 'red');
      return false;
    }
    if (file.size > 100 * 1024 * 1024) {
      createToast('内核文件不能超过 100MB', 'red');
      return false;
    }
    const installed = await isInstalled();
    const secret = '';
    const settings = await readInstallSettings();
    const defaultConfig = buildDefaultConfig(secret, resolveActiveMirror(settings));
    try {
      createToast('正在上传并校验内核文件…');
      const source = await uploadFileToDevice(file);
      const res = await shell(`
        ${INIT_DIRS_SH}
        ${DECOMPRESS_FN_SH}
        if ${isGzip ? 'true' : 'false'}; then
          mv ${shQuote(source)} ${ROOT}/tmp/upload_core.gz || exit 1
          if ! decompress_gz ${ROOT}/tmp/upload_core.gz ${BIN}.new; then
            rm -f ${ROOT}/tmp/upload_core.gz ${BIN}.new; echo 'gzip 解压失败'; exit 1
          fi
          rm -f ${ROOT}/tmp/upload_core.gz
        else
          mv ${shQuote(source)} ${BIN}.new || exit 1
        fi
        chmod 755 ${BIN}.new
        if ! test -f ${CONFIG}; then
          echo ${shQuote(utf8ToBase64(defaultConfig))} | base64 -d > ${CONFIG}
          chmod 600 ${CONFIG}
        fi
        if ! test -f ${SUB_CONFIG}; then echo '{}' > ${SUB_CONFIG}; chmod 600 ${SUB_CONFIG}; fi
        ${BIN}.new -v && ${BIN}.new -t -d ${CONFIG_DIR} -f ${CONFIG} || { rm -f ${BIN}.new; exit 2; }
        ${WRITE_SCRIPTS_SH}
        ${SWAP_AND_START_SH}
      `, 100000);
      if (!res.success) throw new Error(res.content || '内核验证或替换失败');
      createToast(`内核安装/更新成功：<br>${escapeHtml(res.content)}`, 'green');
      await isRunning();
      await refreshBootButton();
      if (!installed) await showInstalledDialog('mihomo_uploaded_installed', '离线安装完成');
      return true;
    } catch (error) {
      createToast(`内核上传失败：<br>${escapeHtml(error.message || error)}`, 'red');
      return false;
    }
  };

  const makeButton = (text, handler, className = 'btn') => {
    const button = document.createElement('button');
    button.classList.add(className);
    button.textContent = text;
    button.onclick = handler;
    return button;
  };

  (async () => {
    while (!window.UFI_DATA || !UFI_DATA.lan_ipaddr) await wait(100);
    const anchor = document.querySelector('.functions-container');
    if (!anchor || document.querySelector('#KANO_MIHOMO')) return;
    anchor.insertAdjacentHTML('afterend', `
      <div id="KANO_MIHOMO" style="width:100%;margin-top:10px">
        <div class="title" style="margin:6px 0"><strong id="running_mihomo">mihomo</strong><div style="display:inline-block" id="collapse_mihomo_btn"></div></div>
        <div class="collapse" id="collapse_mihomo" data-name="close" style="height:0;overflow:hidden">
          <div class="collapse_box">
            <div id="mihomo_actions" style="padding:10px;display:flex;gap:10px;flex-wrap:wrap"></div>
          </div>
        </div>
      </div>`);

    const box = document.querySelector('#mihomo_actions');
    const configInput = document.createElement('input');
    configInput.type = 'file';
    configInput.accept = '.yaml,.yml,text/yaml,application/x-yaml,text/plain';
    configInput.style.display = 'none';
    configInput.onchange = async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        if (!(await requireReady())) return;
        if (file.size > 4 * 1024 * 1024) return createToast('配置文件不能超过 4MB', 'red');
        await saveUploadedConfig(file);
      } finally { configInput.value = ''; }
    };

    const coreInput = document.createElement('input');
    coreInput.type = 'file';
    coreInput.accept = '.gz,*/*';
    coreInput.style.display = 'none';
    coreInput.onchange = async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        await installUploadedCore(file);
      } finally { coreInput.value = ''; }
    };

    const edit = async () => {
      if (!(await requireReady())) return;
      const res = await shell(`cat ${CONFIG}`);
      if (!res.success) return createToast('读取配置失败', 'red');
      const { el, close } = createFixedToast('mihomo_editor', `<div style="pointer-events:all;width:86vw;max-width:850px"><div class="title" style="margin:0">编辑 mihomo YAML</div><div class="inner" style="margin:10px 0"></div><div style="text-align:right"><button class="save">校验并保存</button> <button class="cancel">关闭</button></div></div>`);
      const textarea = document.createElement('textarea');
      textarea.value = res.content;
      textarea.style.cssText = 'width:100%;height:500px;max-height:62vh;box-sizing:border-box;background:#000d;color:#0f0;border:0;padding:8px;font-family:monospace;line-height:1.4';
      el.querySelector('.inner').appendChild(textarea);
      el.querySelector('.cancel').onclick = close;
      el.querySelector('.save').onclick = async () => {
        if (!textarea.value.trim()) return createToast('配置不能为空', 'red');
        if (await saveUploadedConfig(new File([textarea.value], 'config.yaml', { type: 'text/yaml' }))) close();
      };
    };

    const start = () => runServiceWithLog('start', '启动 mihomo', 'mihomo 已启动');
    const stop = () => runServiceWithLog('stop', '停止 mihomo', 'mihomo 已停止');

    let uninstallClicks = 0;
    let uninstallTimer = null;
    const uninstall = async () => {
      uninstallClicks++;
      clearTimeout(uninstallTimer);
      uninstallTimer = setTimeout(() => { uninstallClicks = 0; }, 3000);
      if (uninstallClicks < 3) return createToast(`再点击 ${3 - uninstallClicks} 次确认卸载`, 'red');
      uninstallClicks = 0;
      if (!(await requireRoot())) return;
      const res = await shell(`sh ${SERVICE} stop 2>/dev/null || true; rm -rf ${ROOT}; ${REMOVE_BOOT_SH}`);
      createToast(res.success ? 'mihomo 已卸载' : `卸载失败：${escapeHtml(res.content)}`, res.success ? 'green' : 'red');
      await isRunning();
      await refreshBootButton();
    };

    const toggleBoot = async () => {
      if (!(await requireReady())) return;
      if (await isBootEnabled()) {
        await shell(REMOVE_BOOT_SH);
        createToast('已取消开机自启', 'green');
      } else {
        await shell(`touch ${BOOT}; grep -qxF '${SERVICE} start' ${BOOT} || echo '${SERVICE} start' >> ${BOOT}`);
        createToast('已设置开机自启', 'green');
      }
      await refreshBootButton();
    };

    const openUrl = (url) => {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.click();
    };
    const ensurePanelRunning = async () => {
      if (!(await requireReady())) return false;
      if (!(await isRunning())) {
        createToast('mihomo 未运行，正在启动…');
        const res = await shell(`${BIN} -t -d ${CONFIG_DIR} -f ${CONFIG} && sh ${SERVICE} start`, 100000);
        if (!res.success) {
          createToast(`面板启动失败：<br>${escapeHtml(res.content || '请查看日志')}`, 'red');
          return false;
        }
        await wait(800);
      }
      return isRunning();
    };
    const openPanel = async () => {
      if (!(await ensurePanelRunning())) return;
      openUrl(await buildPanelUrl());
    };

    const editSecret = async () => {
      if (!(await requireReady())) return;
      const curSecret = await getActualSecret();
      const { el, close } = createFixedToast('mihomo_secret_dialog', `
        <div style="pointer-events:all;width:86vw;max-width:540px">
          <div class="title" style="margin:0">修改 Dashboard 面板密码</div>
          <div style="margin-top:8px;font-size:.66rem;opacity:.85">当前状态：${curSecret ? '已设置密码' : '未设置密码（免密登录）'}</div>
          <label style="display:block;margin-top:10px">新密码（留空表示取消密码、免密登录）</label>
          <input class="secret_input" type="text" style="width:100%;box-sizing:border-box" placeholder="留空表示不设置密码">
          <div style="margin-top:14px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
            <div style="display:flex;gap:8px">
              <button class="gen_btn">随机生成</button>
              <button class="clear_btn">清空密码</button>
            </div>
            <div style="display:flex;gap:8px">
              <button class="save">保存并生效</button>
              <button class="cancel">取消</button>
            </div>
          </div>
        </div>`);
      const input = el.querySelector('.secret_input');
      input.value = curSecret;
      el.querySelector('.gen_btn').onclick = () => { input.value = randomString(16); };
      el.querySelector('.clear_btn').onclick = () => { input.value = ''; };
      el.querySelector('.cancel').onclick = close;
      el.querySelector('.save').onclick = async () => {
        const nextSecret = input.value.trim();
        if (/\s/.test(nextSecret)) return createToast('密码不能包含空格或换行', 'red');
        const readRes = await shell(`cat ${CONFIG}`);
        if (!readRes.success) return createToast('读取配置失败', 'red');
        const yamlSafe = nextSecret.replaceAll("'", "''");
        const secretLine = `secret: '${yamlSafe}'`;
        const updatedYaml = /^secret\s*:/m.test(readRes.content)
          ? readRes.content.replace(/^secret\s*:.*$/m, secretLine)
          : `${secretLine}\n${readRes.content}`;
        if (await saveUploadedConfig(new File([updatedYaml], 'config.yaml', { type: 'text/yaml' }))) {
          close();
          createToast(nextSecret ? '面板密码已更新并生效' : '已清空面板密码（免密登录）', 'green');
        }
      };
    };

    box.append(configInput, coreInput,
      makeButton('打开面板', openPanel),
      makeButton('启动', start), makeButton('停止', stop), makeButton('重启', () => restart(false)),
      makeButton('开机自启', toggleBoot),
      makeButton('更新订阅', updateSubscriptions), makeButton('导入/订阅设置', editSubscriptions),
      makeButton('编辑配置', edit), makeButton('上传配置', () => configInput.click()),
      makeButton('查看日志', async () => { const res = await shell(`tail -n 200 ${shQuote(LOG)} 2>/dev/null`); showLog(res.content, 'core'); }),
      makeButton('面板密码', editSecret),
      makeButton('安装/在线更新内核', () => openInstallDialog(() => coreInput.click())),
      makeButton('卸载', uninstall));

    const buttons = [...box.querySelectorAll('button')];
    const bootButton = buttons.find((button) => button.textContent === '开机自启');
    if (bootButton) bootButton.id = 'mihomo_boot';

    collapseGen('#collapse_mihomo_btn', '#collapse_mihomo', '#collapse_mihomo', async () => {
      await isRunning();
      await refreshBootButton();
    });
    await isRunning();
    await refreshBootButton();
  })();
})();
//</script>
