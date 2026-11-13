#!/bin/bash
# ==============================================================================
# CF-Server-Monitor 安装/卸载脚本 (macOS 适配版)
# 支持: macOS Intel / macOS Apple Silicon (M1/M2/M3/M4)
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

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

SERVICE_NAME="cf-probe"
LAUNCHD_FILE="/Library/LaunchDaemons/com.cf.probe.plist"
LAUNCHD_LABEL="system/com.cf.probe"
SCRIPT_FILE="/usr/local/bin/${SERVICE_NAME}.sh"
CONFIG_DIR="/Library/Application Support/cf-probe"
CONFIG_FILE="${CONFIG_DIR}/config.conf"
TRAFFIC_DATA_FILE="${CONFIG_DIR}/traffic.dat"
LOG_FILE="/var/log/cf-probe.log"
TEMP_DIR="/tmp/cf-probe"
MAX_TRAFFIC_CORRECTION_GB=1000000
AUTO_UPDATE_DELAY_SECONDS=60

print_banner() {
    echo -e "${CYAN}╔═════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║   CF-Server-Monitor (macOS Edition) ║${NC}"
    echo -e "${CYAN}╚═════════════════════════════════════╝${NC}"
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

    step "停用并撤销 launchd 守护进程..."
    launchctl bootout system "${LAUNCHD_FILE}" 2>/dev/null || \
        launchctl bootout "${LAUNCHD_LABEL}" 2>/dev/null || true

    step "清理服务描述性系统文件..."
    rm -f "${LAUNCHD_FILE}" 2>/dev/null || true

    step "销毁探针物理可执行代码文件..."
    rm -f "${SCRIPT_FILE}" 2>/dev/null || true

    step "抹除临时缓存区..."
    rm -rf "${TEMP_DIR}" 2>/dev/null || true

    step "抹除流量追踪数据..."
    rm -rf "${CONFIG_DIR}" 2>/dev/null || true

    step "清理日志文件..."
    rm -f "${LOG_FILE}" 2>/dev/null || true

    step "根除孤儿或僵尸状态的探测残留进程..."
    if pgrep -f "${SERVICE_NAME}.sh" >/dev/null 2>&1; then
        pkill -9 -f "${SERVICE_NAME}.sh" 2>/dev/null || true
    fi

    echo -e "\n${GREEN}╔══════════════════════════════════════════╗"
    echo -e "║     ✓ 卸载完毕！系统环境无任何残留。     ║"
    echo -e "╚══════════════════════════════════════════╝${NC}\n"
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
