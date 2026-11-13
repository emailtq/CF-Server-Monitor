#!/bin/sh
# ==============================================================================
# CF-Server-Monitor 安装/卸载脚本 (OpenWrt 专用版)
# 支持: OpenWrt / LEDE / ImmortalWrt (procd + opkg)
# 纯 POSIX sh 实现，无 bash 依赖
# Fixes: 1. 独立协程无 wait 阻塞 2. 原子化原子覆盖 3. 兼容 procd 服务框架
#        4. 严格 set -u 闭环 5. 使用 /tmp 替代 /dev/shm（OpenWrt 无 /dev/shm）
#        6. 配置文件化管理 7. Worker 健康检查自动重启 8. IPv6 路由检测优化
# ==============================================================================

# Retain cleanup for existing installations; this retired Agent cannot report with node tokens.
case "${1:-}" in
    uninstall|remove|delete|purge|status|stop) ;;
    *)
        printf "%s\n" "This legacy Agent is retired: node-token reporting requires reinstalling with the maintained Go Agent." >&2
        printf "%s\n" "Use the verified download in /admin (all existing platforms), or https://raw.githubusercontent.com/emailtq/cfsm-agent/terminal/install.sh after a token-capable release is published." >&2
        exit 1
        ;;
esac

set -eu

AGENT_VERSION="1.3.8"

# 路径定义（配置文件系统）
CONFIG_DIR="/etc/config/cf-probe"
CONFIG_FILE="${CONFIG_DIR}/config.conf"
TRAFFIC_DATA_FILE="${CONFIG_DIR}/traffic.dat"
OLD_TRAFFIC_DATA_FILE="/var/lib/cf-probe/traffic.dat"
MAX_TRAFFIC_CORRECTION_GB=1000000
AUTO_UPDATE_DELAY_SECONDS=60

# 颜色定义（busybox sh 下仅 printf '%b' 可用）
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# 路径定义
SERVICE_NAME="cf-probe"
PROCD_FILE="/etc/init.d/${SERVICE_NAME}"
SCRIPT_FILE="/usr/local/bin/${SERVICE_NAME}.sh"
PID_FILE="/var/run/${SERVICE_NAME}.pid"
LOG_FILE="/var/log/${SERVICE_NAME}.log"
SHM_DIR="/tmp"


# ---------------------------------------------------------------
# 统一输出工具（纯 POSIX sh）
# ---------------------------------------------------------------
print_banner() {
    printf '%b╔═════════════════════════════════════╗%b\n' "${CYAN}" "${NC}"
    printf '%b║     CF-Server-Monitor (OpenWrt)     ║%b\n' "${CYAN}" "${NC}"
    printf '%b╚═════════════════════════════════════╝%b\n' "${CYAN}" "${NC}"
}

info()  { printf '%b[✓]%b %s\n' "${GREEN}" "${NC}" "$1"; }

warn()  { printf '%b[!]%b %s\n' "${YELLOW}" "${NC}" "$1"; }

error() { printf '%b[✗]%b %s\n' "${RED}"   "${NC}" "$1"; exit 1; }

step()  { printf '%b[→]%b %s\n' "${BLUE}"  "${NC}" "$1"; }

check_root() {
    if [ "$(id -u)" != "0" ]; then
        error "请使用 root 权限运行此脚本: sudo sh $0"
    fi
}

uninstall_probe() {
    print_banner
    printf '%b[!] 开始执行无残留深度卸载清理方案...%b\n\n' "${YELLOW}" "${NC}"
    check_root
    detect_os

    step "停用并撤销系统守护进程..."
    stop_old_service

    step "清理服务脚本文件..."
    rm -f "${PROCD_FILE}"

    step "销毁探针物理可执行代码文件..."
    rm -f "${SCRIPT_FILE}"
    rm -f "${SCRIPT_FILE}.ctl"

    step "抹除共享内存高速缓存区..."
    rm -f /tmp/.cf_ipv4 /tmp/.cf_ipv6 /tmp/.cf_probe_* 2>/dev/null || true

    step "抹除流量追踪数据..."
    rm -rf /var/lib/${SERVICE_NAME}
    rm -rf "${CONFIG_DIR}"

    step "清理日志与 PID 文件..."
    rm -f "${PID_FILE}" "${LOG_FILE}" 2>/dev/null || true

    printf '\n%b╔══════════════════════════════════════════╗%b\n' "${GREEN}" "${NC}"
    printf  '║     ✓ 卸载完毕！系统环境无任何残留。     ║\n'
    printf  '%b╚══════════════════════════════════════════╝%b\n\n' "${GREEN}" "${NC}"
}

detect_os() {
    if [ -f /etc/os-release ]; then
        OS_ID=$(grep -E '^ID=' /etc/os-release | cut -d= -f2 | tr -d '"' | tr -d "'")
    elif [ -f /etc/openwrt_release ]; then
        OS_ID="openwrt"
    else
        OS_ID=$(uname -s | tr '[:upper:]' '[:lower:]')
    fi
    OS_ID=${OS_ID:-"unknown"}

    case "$OS_ID" in
        immortalwrt|openwrt|lede)
            if command -v apk >/dev/null 2>&1; then
                PKG_MGR="apk"
            elif command -v opkg >/dev/null 2>&1; then
                PKG_MGR="opkg"
            else
                error "未找到可用的包管理器 (apk/opkg)，当前系统: $OS_ID"
            fi
            ;;
        *)
            warn "检测到非 OpenWrt 系统: $OS_ID，仍将尝试使用 opkg"
            PKG_MGR="opkg"
            ;;
    esac

    if command -v procd >/dev/null 2>&1 || [ -f /sbin/procd ]; then
        INIT_SYSTEM="procd"
    elif command -v rc-service >/dev/null 2>&1 && [ -d /etc/runlevels ]; then
        INIT_SYSTEM="openrc"
    elif [ -d /run/systemd/system ]; then
        INIT_SYSTEM="systemd"
    else
        INIT_SYSTEM="manual"
    fi
}

stop_old_service() {
    step "清理可能存在的旧服务进程..."

    if [ "$INIT_SYSTEM" = "procd" ] && [ -f "$PROCD_FILE" ]; then
        "$PROCD_FILE" stop >/dev/null 2>&1 || true
        "$PROCD_FILE" disable >/dev/null 2>&1 || true
        rm -f "$PROCD_FILE"
    elif [ "$INIT_SYSTEM" = "openrc" ] && [ -f "$PROCD_FILE" ]; then
        rc-service "$SERVICE_NAME" stop >/dev/null 2>&1 || true
        rc-update del "$SERVICE_NAME" default >/dev/null 2>&1 || true
        rm -f "$PROCD_FILE"
    fi

    if [ -f "$PID_FILE" ]; then
        old_pid=$(cat "$PID_FILE" 2>/dev/null || echo "")
        if [ -n "$old_pid" ] && kill -0 "$old_pid" >/dev/null 2>&1; then
            kill -TERM "$old_pid" >/dev/null 2>&1 || true
            sleep 1
            kill -9 "$old_pid" >/dev/null 2>&1 || true
        fi
        rm -f "$PID_FILE"
    fi

    if pgrep -f "${SERVICE_NAME}.sh" >/dev/null 2>&1; then
        pkill -9 -f "${SERVICE_NAME}.sh" >/dev/null 2>&1 || true
    fi
}

case "${1:-install}" in
    uninstall|remove|delete|purge)
        uninstall_probe
        ;;
    *)
        echo "未知指令. 可选命令: uninstall"
        exit 1
        ;;
esac
