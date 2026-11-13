#!/bin/bash
# ==============================================================================
# CF-Server-Monitor 安装/卸载脚本 (企业级安全加固版)
# 支持: Ubuntu/Debian/CentOS/RHEL/Fedora/Rocky/AlmaLinux
# Fixes: 1. 独立协程无 wait 阻塞 2. 原子化原子覆盖 3. 兼容全版本 Systemd 4. 严格 set -u 闭环
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

set -euo pipefail

AGENT_VERSION="1.3.8"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# 路径定义
SERVICE_NAME="cf-probe"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
SCRIPT_FILE="/usr/local/bin/${SERVICE_NAME}.sh"
CONFIG_DIR="/etc/config/cf-probe"
CONFIG_FILE="${CONFIG_DIR}/config.conf"
TRAFFIC_DATA_FILE="${CONFIG_DIR}/traffic.dat"
OLD_TRAFFIC_DATA_FILE="/var/lib/cf-probe/traffic.dat"
MAX_TRAFFIC_CORRECTION_GB=1000000
AUTO_UPDATE_DELAY_SECONDS=60
CONTAINER_PID_FILE="/run/cf-probe.pid"
CONTAINER_LOG_FILE="/var/log/cf-probe.log"
DEBUG_ENV_FILE="/run/cf-probe-debug.env"

# 全局运行模式: systemd | container
RUNTIME_MODE="systemd"

print_banner() {
    echo -e "${CYAN}╔═══════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║     CF-Server-Monitor (Enterprise)    ║${NC}"
    echo -e "${CYAN}╚═══════════════════════════════════════╝${NC}"
}

info() { echo -e "${GREEN}[✓]${NC} $1"; }

warn() { echo -e "${YELLOW}[!]${NC} $1"; }

error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }

step() { echo -e "${BLUE}[→]${NC} $1"; }

check_root() {
    if [ "$(id -u)" != "0" ]; then
        error "请使用 root 权限运行此脚本: sudo bash $0"
    fi
}

uninstall_probe() {
    print_banner
    echo -e "${YELLOW}[!] 开始执行无残留深度卸载清理方案...${NC}\n"
    check_root

    detect_runtime_mode

    step "停用并撤销系统守护进程..."
    if command -v systemctl >/dev/null 2>&1; then
        if systemctl is-active --quiet "${SERVICE_NAME}.service" 2>/dev/null; then
            systemctl stop "${SERVICE_NAME}.service" 2>/dev/null || true
        fi
        if systemctl is-enabled --quiet "${SERVICE_NAME}.service" 2>/dev/null; then
            systemctl disable "${SERVICE_NAME}.service" 2>/dev/null || true
        fi
    fi

    step "清理服务描述性系统文件..."
    rm -f "${SERVICE_FILE}"
    if command -v systemctl >/dev/null 2>&1; then
        systemctl daemon-reload 2>/dev/null || true
        systemctl reset-failed "${SERVICE_NAME}" 2>/dev/null || true
    fi

    step "销毁探针物理可执行代码文件..."
    rm -f "${SCRIPT_FILE}"

    step "抹除共享内存高速缓存区..."
    rm -f /dev/shm/.cf_ipv4 /dev/shm/.cf_ipv6 /dev/shm/.cf_probe_*

    step "抹除流量追踪数据..."
    rm -rf /var/lib/${SERVICE_NAME}
    rm -rf "${CONFIG_DIR}"

    step "清理容器模式运行痕迹..."
    if [ -f "${CONTAINER_PID_FILE}" ]; then
        local old_pid
        old_pid=$(cat "${CONTAINER_PID_FILE}" 2>/dev/null || echo "")
        if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
            kill "$old_pid" 2>/dev/null || true
        fi
        rm -f "${CONTAINER_PID_FILE}"
    fi
    rm -f "${CONTAINER_LOG_FILE}"

    step "根除孤儿或僵尸状态的探测残留进程..."
    if pgrep -f "${SERVICE_NAME}.sh" >/dev/null 2>&1; then
        pkill -9 -f "${SERVICE_NAME}.sh" 2>/dev/null || true
    fi

    echo -e "\n${GREEN}╔══════════════════════════════════════════╗"
    echo -e "║     ✓ 卸载完毕！系统环境无任何残留。     ║"
    echo -e "╚══════════════════════════════════════════╝${NC}\n"
}

detect_runtime_mode() {
    if [ "$(cat /proc/1/comm 2>/dev/null)" = "systemd" ] && [ -d /run/systemd/system ]; then
        RUNTIME_MODE="systemd"
        info "Runtime mode: systemd"
    else
        RUNTIME_MODE="container"
        warn "Runtime mode: container"
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
