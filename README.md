# 适配中兴随身 WiFi 的 mihomo 插件（UFI Tools）

这是一个面向 **UFI Tools** 的第三方 **mihomo (Clash.Meta)** 管理与 **TProxy 透明代理**插件，目前基于**中兴 V50** 开发与实测，理论上同样兼容中兴 F50 / U30 Air 等支持 UFI Tools 的 Android 随身 WiFi 设备。

## 核心功能

- **GitHub 镜像源下载与自动回退**：
  - 安装/在线更新弹窗内置多个常用 GitHub 镜像源（`gh-proxy.org`、`ghfast.top`、`ghproxy.net`、`mirror.ghproxy.com`、直连 GitHub）以及**自定义镜像前缀 / 指定版本号 / 自定义直链**；
  - 版本探测优先通过镜像源重定向获取最新 Release Tag（不强依赖直连 `api.github.com`），下载失败时按序自动回退备用镜像、直连与本地 `7890` 代理；
  - 自动识别设备 Android ABI（`arm64-v8` / `armv7` / `amd64` / `386`），下载 `mihomo-android-{arch}-{tag}.gz` 并校验版本与配置，启动失败自动回滚旧内核。
- **手动上传内核（支持离线首次安装 & 升级）**：
  - 已核实 UFI Tools 后端 `/api/upload_img` 为无格式限制的流式上传，插件直接支持手动上传 **ELF 裸二进制** 或 **官方 `.gz` 压缩包**（设备端自动 `gzip -dc` 解压）；
  - 即使设备尚未安装 mihomo（完全离线环境），也可直接通过“上传内核”完成首次初始化安装；升级替换前执行 `mihomo -v` 和 `mihomo -t` 校验，启动失败自动回滚。
- **导入订阅 + 定时自动更新**：
  - 支持导入标准 Clash / Mihomo YAML 订阅链接、自定义 `User-Agent`，可选自动注入/保留 UFI TProxy（`7893`）、Mixed（`7890`）、DNS（`1053`）与 Web 面板（`9090`）配置，自动清理冲突的 `port` / `socks-port` / `redir-port` 与 `tun` 配置块（避免桌面端订阅的 TUN 与 TProxy 双重劫持），并自动注入适合随身 WiFi 的低功耗运行时参数；
  - 内置轻量级设备端定时更新守护进程（`update-sub.sh daemon`），默认 `300s` 低频唤醒、按小时裁剪日志，支持按 `6 / 12 / 24 / 72 / 168` 小时或自定义小时数自动拉取并生效，随 `mihomo.service` 和开机自启自动运行；
  - 每次更新均先通过 `mihomo -t` 校验并备份旧配置，失败不覆盖，重启失败自动回滚。
- **IPv4 / IPv6 双栈 TProxy 透明代理 + DNS 劫持**：
  - 通过 `mihomo.service` 对热点 LAN 口（默认 `br0`）配置 IPv4 `iptables -t mangle` TProxy（TCP/UDP）、`iptables -t nat` 53 端口 DNS 重定向，并在内核支持时自动启用 IPv6 `ip6tables -t mangle` TProxy 与策略路由；
  - 自动探测内核 `xt_socket` 支持，启用 `MIHOMO_DIVERT` / `MIHOMO6_DIVERT`（`-m socket --transparent`）快速路径，已建立连接的流量不再逐条遍历防火墙规则；
  - IPv6 TProxy 自动读取 `config.yaml` 中的 `fake-ip-range6`（缺省 `fc00::/18`）并在放行其余内网 ULA（`fc00::/7`）前优先送入 TProxy，既支持纯 IPv6 网站访问又避免杂散 ULA 地址触发超时风暴；
  - 仅代理下游热点客户端，不劫持随身 WiFi 本机流量，停止或安装规则失败时自动清理防火墙和策略路由。
- **Web 面板与三标签日志查看器**：
  - 默认通过所选镜像源配置 `external-ui-url` 拉取 [Zashboard](https://github.com/Zephyruso/zashboard)，默认不生成密码（免密登录）；提供「面板密码」入口随时设置、随机生成或清空密码；点击「打开面板」在新窗口打开并自动携带当前配置的 `secret`；
  - 操作按钮按使用频率与安全等级分组排布（高频控制 -> 订阅/配置 -> 日志/密码 -> 内核更新/卸载），展开或收起面板自动刷新运行状态；
  - 日志弹窗支持一键切换 **内核日志**、**订阅日志** 与 **安装日志**，支持实时刷新、暂停滚动、清空与下载。

## 环境要求

- 已获取 root 权限并开启 UFI Tools **高级功能**；
- UFI Tools 页面提供 `runShellWithRoot`、`createToast`、`createFixedToast`、`collapseGen` 等全局 API；
- 系统具备 `gzip`、`nohup`、`iptables`、`ip rule`、`pgrep`、`base64`、`awk`、`sed` 等基础命令；
- UFI Tools 内置 `curl` 位于 `/data/data/com.minikano.f50_sms/files/curl`。

> 当前服务脚本默认使用 `br0` 作为热点 LAN 接口，如果目标固件的接口名不同，请修改 `mihomo.service` 顶部的 `LAN_IF` 变量。

## 安装与使用

1. 下载 [`mihomo-plugin.js`](./mihomo-plugin.js)。
2. 打开 UFI Tools 后台 -> **插件设置**，导入 `mihomo-plugin.js` 并保存刷新页面。
3. 展开页面中的 **mihomo** 折叠面板，点击 **安装/在线更新内核**，在弹窗中任选一种方式安装内核：
   - **在线镜像安装**：选择或自定义 GitHub 镜像源（默认 `gh-proxy.org`），点击 **开始下载安装**；
   - **离线手动上传**：点击弹窗内的 **手动上传内核**，选择已下载好的 `mihomo` ELF 二进制或官方 `mihomo-android-*.gz` 压缩包。
4. 导入订阅与配置：
   - 点击 **导入/订阅设置**，填写 Clash/Mihomo YAML 订阅链接，按需开启 **定时自动更新** 并设置间隔，点击 **保存并立即导入**；
   - 或直接点击 **上传配置** / **编辑配置** 使用自己的完整 `config.yaml`。
5. 点击 **打开面板** 即可在 Zashboard 中切换节点，按需点击 **开机自启**。

## 性能与省电优化说明

随身 WiFi 属于被动散热且内存偏小的嵌入式设备，项目已针对发热与功耗做了多层内置优化：

- **禁用 `tun` 防止双重劫持**：合并订阅时强制移除订阅中的 `tun:` 块并写入 `tun.enable: false`，避免与 TProxy 冲突、避免 gVisor 用户态协议栈高 CPU 占用以及本机 Android/基带流量回环。
- **自适应能效小核绑定**：`mihomo.service` 默认以 `MIHOMO_CPU_MASK=auto` 启动，自动读取 `/sys/devices/system/cpu/cpu*/cpufreq/cpuinfo_max_freq`；在大小核异构 SoC（如中兴 V50 / F50）上自动计算能效小核掩码并用 `taskset` 绑定，避免唤醒高功耗大核；在同构芯片或无 `taskset` 的设备上自动跳过不绑核。
- **Go 运行时限核限内存**：默认注入 `GOMAXPROCS=2`、`GOMEMLIMIT=128MiB`、`GOGC=50`，配合 `geodata-loader: memconservative`，控制内存占用并减少 Android ZRAM 压缩换页带来的 CPU 发热。
- **屏蔽 QUIC（UDP 443）回退 TCP**：默认在 `FORWARD` 链对 LAN 口发出的 IPv4/IPv6 UDP 443 返回 `REJECT`（`MIHOMO_BLOCK_QUIC=1`），让客户端自动回退到 CPU 开销更低的 TCP/HTTP2。
- **降低空闲唤醒与闪存写入**：合并订阅与默认配置统一写入 `find-process-mode: off`、`tcp-concurrent: false`、`unified-delay: false`、`keep-alive-idle: 60`、`keep-alive-interval: 60`、`log-level: error`，默认配置关闭 `sniffer` 与 `store-fake-ip`。

### `mihomo.service` 可选环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LAN_IF` | `br0` | 热点 LAN 接口名 |
| `MIHOMO_CPU_MASK` | `auto` | CPU 亲和性掩码：`auto` 自动绑定异构小核；可指定十六进制掩码（如 `0f`）或 `off` 关闭 |
| `MIHOMO_GOMAXPROCS` | `2` | Go 最大并发逻辑核数 |
| `MIHOMO_GOMEMLIMIT` | `128MiB` | Go 软内存上限 |
| `MIHOMO_GOGC` | `50` | Go GC 触发阈值百分比 |
| `MIHOMO_BLOCK_QUIC` | `1` | 设为 `1` 拦截 LAN 转发的 UDP 443 使 QUIC 回退 TCP；设为 `0` 关闭 |
| `MIHOMO_IPV6` | `1` | 设为 `1` 启用 IPv6 TProxy（内核不支持时自动回退）；设为 `0` 仅启用 IPv4 |

### 常见问题与进一步省电建议

- **关闭 `tun` 后，随身 WiFi 本机自身还能走代理吗？**
  可以。本机不再被透明劫持，但 `127.0.0.1:7890`（HTTP/SOCKS5 Mixed 端口）始终可用，在 SSH / 脚本中通过 `-x http://127.0.0.1:7890` 或 `http_proxy` 即可正常走代理（插件的订阅更新与内核下载失败回退即采用此方式）。
- **能否访问纯 IPv6 网站？**
  可以。双栈及国内直连纯 IPv6 均可正常访问；若纯 IPv6 网站命中代理规则，则要求所选远程代理节点服务器本身具备 IPv6 出口。
- **订阅源本身如何进一步省电？**
  建议在自己的订阅模板中为 `proxy-providers` / `url-test` 的 `health-check` 增加 `lazy: true` 并将 `interval` 调大至 `1800`~`3600` 秒，避免无人上网时后台高频唤醒测速。

## 设备端路径说明

```text
/data/mihomo/bin/mihomo                 # mihomo Android 内核
/data/mihomo/config/config.yaml         # 主配置文件
/data/mihomo/config/subscriptions.json  # 订阅与定时更新设置
/data/mihomo/config/install.json        # GitHub 镜像源与安装设置
/data/mihomo/config/ui                  # Web 面板目录（Zashboard，位于配置目录内以满足 SAFE_PATHS）
/data/mihomo/scripts/mihomo.service     # TProxy 与定时任务管理脚本
/data/mihomo/scripts/update-sub.sh      # 订阅更新与后台守护脚本
/data/mihomo/run/mihomo.pid             # mihomo 进程 PID
/data/mihomo/run/mihomo-sub.pid         # 定时订阅守护进程 PID
/data/mihomo/run/sub_status.json        # 最近一次订阅更新状态
/data/mihomo/logs/mihomo.log             # 内核运行日志
/data/mihomo/logs/sub.log                # 订阅更新日志
/data/mihomo/logs/install.log            # 在线安装日志
/sdcard/ufi_tools_boot.sh                # UFI Tools 开机自启脚本
```

## 默认端口

| 端口 | 用途 |
| --- | --- |
| `7890` | Mixed (HTTP + SOCKS5) 代理端口 |
| `7893` | TProxy 透明代理入站端口 |
| `1053` | Mihomo DNS 监听端口（LAN 53 端口重定向至此） |
| `9090` | External Controller & Web 面板端口 (`/ui/`) |

## 开发与测试

```bash
# 修改 mihomo.service 或 update-sub.sh 后，同步内嵌脚本到 mihomo-plugin.js
node scripts/sync-embedded.mjs

# 运行完整自动化测试套件（语法、TProxy 生命周期、订阅合并/回滚/定时守护、镜像回退安装、手动上传内核）
node tests/run_tests.mjs
```

## 安全提示

- 切勿将包含订阅链接、节点密钥、面板 `secret` 的配置或日志提交到公开仓库。
- `7890` 与 `9090` 默认监听 `0.0.0.0`（仅对 `br0` 局域网放行 `INPUT`），请勿暴露到公网，并妥善保管自动生成的随机 API 密钥。
- TProxy 会修改 `iptables` 与策略路由，首次使用前请确保保留 UFI Tools / ADB 等本地管理通道。
