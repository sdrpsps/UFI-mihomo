#!/system/bin/sh
# Unofficial Mihomo subscription updater & scheduler for compatible ZTE UFI Tools environments.
ROOT=${ROOT:-/data/mihomo}
BIN=${BIN:-$ROOT/bin/mihomo}
CONFIG_DIR=${CONFIG_DIR:-$ROOT/config}
CONFIG=${CONFIG:-$CONFIG_DIR/config.yaml}
SUB_CONFIG=${SUB_CONFIG:-$CONFIG_DIR/subscriptions.json}
SUB_DIR=${SUB_DIR:-$ROOT/subscriptions}
DASHBOARD_DIR=${DASHBOARD_DIR:-$CONFIG_DIR/ui}
SERVICE=${SERVICE:-$ROOT/scripts/mihomo.service}
STATUS_FILE=${STATUS_FILE:-$ROOT/run/sub_status.json}
SUB_LOG=${SUB_LOG:-$ROOT/logs/sub.log}
CURL=${CURL:-/data/data/com.minikano.f50_sms/files/curl}
JQ=${JQ:-/data/data/com.minikano.f50_sms/files/jq}
MIXED_PORT=${MIXED_PORT:-7890}
TPROXY_PORT=${TPROXY_PORT:-7893}
DNS_PORT=${DNS_PORT:-1053}
API_PORT=${API_PORT:-9090}
LOG_MAX_BYTES=${LOG_MAX_BYTES:-2097152}
LOG_KEEP_LINES=${LOG_KEEP_LINES:-1000}
CORE_LOG=${LOG:-$ROOT/logs/mihomo.log}
DEFAULT_UI_URL=${DEFAULT_UI_URL:-https://github.com/Zephyruso/zashboard/releases/latest/download/dist.zip}

trim_log() {
  F="$1"
  if ! test -f "$F"; then return 0; fi
  SZ=$(wc -c < "$F" 2>/dev/null | tr -d ' \n' || echo 0)
  case "$SZ" in ''|*[!0-9]*) SZ=0 ;; esac
  if test "$SZ" -gt "$LOG_MAX_BYTES"; then
    tail -n "$LOG_KEEP_LINES" "$F" > "$F.tmp" 2>/dev/null && cat "$F.tmp" > "$F" 2>/dev/null || : > "$F"
    rm -f "$F.tmp"
  fi
}

if ! test -x "$CURL"; then
  CURL=$(command -v curl 2>/dev/null || echo "$CURL")
fi

log_msg() {
  TS=$(date '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo 'unknown-time')
  mkdir -p "$(dirname "$SUB_LOG")" 2>/dev/null || true
  printf '[%s] %s\n' "$TS" "$1" >> "$SUB_LOG" 2>/dev/null || true
  printf '[%s] %s\n' "$TS" "$1"
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\r\n' '  '
}

write_status() {
  STATE="$1"
  MSG="$2"
  PROXIES="${3:-0}"
  NOW_TS=$(date +%s 2>/dev/null || echo 0)
  NOW_STR=$(date '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo '')
  mkdir -p "$ROOT/run"
  cat > "$STATUS_FILE" <<EOF
{"status":"$(json_escape "$STATE")","message":"$(json_escape "$MSG")","proxies":$PROXIES,"timestamp":$NOW_TS,"updatedAt":"$(json_escape "$NOW_STR")"}
EOF
}

read_json_field() {
  KEY="$1"
  DEFAULT="$2"
  if ! test -f "$SUB_CONFIG"; then
    printf '%s' "$DEFAULT"
    return 0
  fi
  if test -x "$JQ"; then
    VAL=$("$JQ" -r --arg k "$KEY" 'if has($k) and .[$k] != null then .[$k] | tostring else empty end' "$SUB_CONFIG" 2>/dev/null)
    if test -n "$VAL"; then
      printf '%s' "$VAL"
      return 0
    fi
  fi
  # POSIX fallback for flat JSON objects
  VAL=$(sed -n "s/.*\"$KEY\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$SUB_CONFIG" | head -n 1)
  if test -z "$VAL"; then
    VAL=$(sed -n "s/.*\"$KEY\"[[:space:]]*:[[:space:]]*\([0-9a-zA-Z._-]*\).*/\1/p" "$SUB_CONFIG" | head -n 1)
  fi
  if test -n "$VAL"; then
    printf '%s' "$VAL"
  else
    printf '%s' "$DEFAULT"
  fi
}

extract_yaml_value() {
  KEY="$1"
  if test -f "$CONFIG"; then
    sed -n "s/^$KEY:[[:space:]]*['\"]*\([^'\"#[:space:]]*\)['\"]*.*/\1/p" "$CONFIG" | head -n 1
  fi
}

merge_runtime_yaml() {
  RAW_FILE="$1"
  OUT_FILE="$2"
  SECRET="$3"
  UI_URL="$4"
  awk \
    -v mixed_port="$MIXED_PORT" \
    -v tproxy_port="$TPROXY_PORT" \
    -v api_port="$API_PORT" \
    -v dns_port="$DNS_PORT" \
    -v dashboard_dir="$DASHBOARD_DIR" \
    -v ui_url="$UI_URL" \
    -v secret="$SECRET" '
  BEGIN {
    managed["port"] = 1
    managed["socks-port"] = 1
    managed["redir-port"] = 1
    managed["mixed-port"] = 1
    managed["tproxy-port"] = 1
    managed["allow-lan"] = 1
    managed["bind-address"] = 1
    managed["log-level"] = 1
    managed["ipv6"] = 1
    managed["find-process-mode"] = 1
    managed["tcp-concurrent"] = 1
    managed["unified-delay"] = 1
    managed["keep-alive-idle"] = 1
    managed["keep-alive-interval"] = 1
    managed["geodata-loader"] = 1
    managed["tun"] = 1
    managed["external-controller"] = 1
    managed["external-ui"] = 1
    managed["external-ui-url"] = 1
    managed["secret"] = 1

    print "# Managed by UFI Tools mihomo plugin"
    print "mixed-port: " mixed_port
    print "tproxy-port: " tproxy_port
    print "allow-lan: true"
    print "bind-address: '\''*'\''"
    print "log-level: error"
    print "ipv6: true"
    print "find-process-mode: off"
    print "tcp-concurrent: false"
    print "unified-delay: false"
    print "keep-alive-idle: 60"
    print "keep-alive-interval: 60"
    print "geodata-loader: memconservative"
    print "tun:"
    print "  enable: false"
    print "external-controller: 0.0.0.0:" api_port
    print "external-ui: " dashboard_dir
    print "external-ui-url: '\''" ui_url "'\''"
    print "secret: '\''" secret "'\''"
    print ""

    skip_block = 0
    in_dns = 0
    has_dns = 0
    dns_listen_set = 0
    dns_enable_set = 0
    dns_ipv6_set = 0
  }
  {
    sub(/\r$/, "")
    if ($0 ~ /^[A-Za-z0-9_-]+[[:space:]]*:/) {
      key = $0
      sub(/[[:space:]]*:.*$/, "", key)
      rest = $0
      sub(/^[A-Za-z0-9_-]+[[:space:]]*:/, "", rest)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", rest)

      if (in_dns) {
        if (!dns_enable_set) print "  enable: true"
        if (!dns_listen_set) print "  listen: 0.0.0.0:" dns_port
        if (!dns_ipv6_set) print "  ipv6: true"
        in_dns = 0
      }

      if (key in managed) {
        skip_block = (rest == "" ? 1 : 0)
        next
      }
      skip_block = 0

      if (key == "dns") {
        has_dns = 1
        in_dns = 1
        dns_listen_set = 0
        dns_enable_set = 0
        dns_ipv6_set = 0
        print "dns:"
        next
      }
      print $0
      next
    }

    if (skip_block) {
      if ($0 ~ /^[[:space:]]+/ || $0 ~ /^[[:space:]]*$/) next
      skip_block = 0
    }

    if (in_dns) {
      if ($0 ~ /^ {1,2}listen[[:space:]]*:/) {
        print "  listen: 0.0.0.0:" dns_port
        dns_listen_set = 1
        next
      }
      if ($0 ~ /^ {1,2}enable[[:space:]]*:/) {
        print "  enable: true"
        dns_enable_set = 1
        next
      }
      if ($0 ~ /^ {1,2}ipv6[[:space:]]*:/) {
        print "  ipv6: true"
        dns_ipv6_set = 1
        next
      }
    }

    print $0
  }
  END {
    if (in_dns) {
      if (!dns_enable_set) print "  enable: true"
      if (!dns_listen_set) print "  listen: 0.0.0.0:" dns_port
      if (!dns_ipv6_set) print "  ipv6: true"
    }
    if (!has_dns) {
      print ""
      print "dns:"
      print "  enable: true"
      print "  listen: 0.0.0.0:" dns_port
      print "  ipv6: true"
      print "  enhanced-mode: fake-ip"
      print "  fake-ip-range: 198.18.0.1/16"
      print "  fake-ip-range6: fc00::/18"
      print "  default-nameserver:"
      print "    - 223.5.5.5"
      print "    - 119.29.29.29"
      print "  nameserver:"
      print "    - 223.5.5.5"
      print "    - 119.29.29.29"
    }
  }' "$RAW_FILE" > "$OUT_FILE"
}

run_update() {
  mkdir -p "$SUB_DIR" "$CONFIG_DIR" "$ROOT/run" "$ROOT/logs"
  trim_log "$CORE_LOG"
  trim_log "$SUB_LOG"
  SUB_URL=$(read_json_field "url" "")
  SUB_UA=$(read_json_field "ua" "clash-verge/v1.7.7")
  AUTO_PATCH=$(read_json_field "autoPatch" "true")

  if test -z "$SUB_URL"; then
    log_msg "订阅地址为空，请先在订阅设置中填写地址"
    write_status "error" "订阅地址为空" 0
    return 1
  fi

  case "$SUB_URL" in
    http://*|https://*) ;;
    *)
      log_msg "订阅地址协议无效: $SUB_URL"
      write_status "error" "订阅地址必须为 HTTP/HTTPS" 0
      return 1
      ;;
  esac

  RAW_FILE="$SUB_DIR/sub.raw.yaml"
  CANDIDATE="$CONFIG_DIR/config.candidate.yaml"
  rm -f "$RAW_FILE" "$CANDIDATE"

  log_msg "开始下载订阅..."
  if ! "$CURL" -fsSL -A "$SUB_UA" --connect-timeout 15 --max-time 90 "$SUB_URL" -o "$RAW_FILE" 2>/dev/null; then
    log_msg "直连下载失败，尝试通过本地代理 127.0.0.1:$MIXED_PORT 下载..."
    if ! "$CURL" -fsSL -A "$SUB_UA" --connect-timeout 15 --max-time 90 -x "http://127.0.0.1:$MIXED_PORT" "$SUB_URL" -o "$RAW_FILE" 2>/dev/null; then
      log_msg "订阅下载失败，请检查网络或订阅地址"
      write_status "error" "订阅下载失败" 0
      return 1
    fi
  fi

  if ! test -s "$RAW_FILE"; then
    log_msg "订阅文件为空"
    write_status "error" "订阅文件为空" 0
    return 1
  fi

  if ! grep -Eq '^[[:space:]]*(proxies|proxy-providers)[[:space:]]*:' "$RAW_FILE"; then
    log_msg "下载内容缺少 proxies 或 proxy-providers，不是有效的 Clash/Mihomo YAML 配置"
    write_status "error" "非有效的 Clash/Mihomo YAML 配置" 0
    return 1
  fi

  if test "$AUTO_PATCH" = "false"; then
    cp "$RAW_FILE" "$CANDIDATE"
  else
    SECRET=$(extract_yaml_value "secret")
    UI_URL=$(extract_yaml_value "external-ui-url")
    if test -z "$UI_URL"; then
      UI_URL="$DEFAULT_UI_URL"
    fi
    merge_runtime_yaml "$RAW_FILE" "$CANDIDATE" "$SECRET" "$UI_URL"
  fi
  chmod 600 "$CANDIDATE"

  CHECK_OUT=$("$BIN" -t -d "$CONFIG_DIR" -f "$CANDIDATE" 2>&1)
  if test $? -ne 0; then
    rm -f "$CANDIDATE"
    log_msg "配置校验失败（旧配置未覆盖）: $CHECK_OUT"
    write_status "error" "mihomo -t 校验失败: $CHECK_OUT" 0
    return 1
  fi

  PROXY_COUNT=$(grep -Ec '^[[:space:]]*-[[:space:]]*\{?[[:space:]]*name[[:space:]]*:' "$CANDIDATE" 2>/dev/null || echo 0)
  if test -f "$CONFIG"; then
    cp "$CONFIG" "$CONFIG.bak" 2>/dev/null || true
  fi
  mv "$CANDIDATE" "$CONFIG"

  if test -x "$SERVICE"; then
    if ! sh "$SERVICE" restart >> "$SUB_LOG" 2>&1; then
      if test -f "$CONFIG.bak"; then
        cp "$CONFIG.bak" "$CONFIG"
        sh "$SERVICE" start >> "$SUB_LOG" 2>&1 || true
      fi
      log_msg "重启 mihomo 失败，已回滚至旧配置"
      write_status "error" "重启失败，已回滚旧配置" 0
      return 1
    fi
  fi

  log_msg "订阅更新成功并已生效（检测到约 $PROXY_COUNT 条节点/策略项）"
  write_status "ok" "订阅更新成功" "$PROXY_COUNT"
  return 0
}

run_daemon() {
  SLEEP_STEP=${SUB_SCHEDULER_TICK:-300}
  LAST_RUN=0
  if test -f "$STATUS_FILE"; then
    LAST_RUN=$(sed -n 's/.*"timestamp"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$STATUS_FILE" | head -n 1)
    test -n "$LAST_RUN" || LAST_RUN=0
  fi
  log_msg "定时订阅更新守护进程已启动"
  TICK=0
  while true; do
    if test $((TICK % 12)) -eq 0; then
      trim_log "$CORE_LOG"
      trim_log "$SUB_LOG"
    fi
    TICK=$((TICK + 1))
    AUTO_UPDATE=$(read_json_field "autoUpdate" "false")
    if test "$AUTO_UPDATE" != "true"; then
      log_msg "定时更新已关闭，守护进程退出"
      exit 0
    fi
    if test -n "${SUB_INTERVAL_SECONDS:-}"; then
      INTERVAL_SEC="$SUB_INTERVAL_SECONDS"
    else
      HOURS=$(read_json_field "intervalHours" "24")
      case "$HOURS" in
        ''|*[!0-9]*) HOURS=24 ;;
      esac
      if test "$HOURS" -lt 1; then HOURS=1; fi
      INTERVAL_SEC=$((HOURS * 3600))
    fi
    NOW=$(date +%s 2>/dev/null || echo 0)
    DIFF=$((NOW - LAST_RUN))
    if test "$DIFF" -ge "$INTERVAL_SEC"; then
      log_msg "触发定时订阅更新（间隔 ${INTERVAL_SEC}s）"
      run_update || true
      LAST_RUN=$(date +%s 2>/dev/null || echo "$NOW")
    fi
    sleep "$SLEEP_STEP"
  done
}

case "$1" in
  run) run_update ;;
  daemon) run_daemon ;;
  *) echo '用法: update-sub.sh {run|daemon}'; exit 1 ;;
esac
