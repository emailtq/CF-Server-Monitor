#Requires -Version 5.1
# Retired Agent: retain only existing uninstall/status/stop actions.
param(
    [Parameter(Position=0)]
    [ValidateSet('install','uninstall','run','tray','status','stop')]
    [string]$Action = 'run',
    [switch]$STA
)

# Fail before STA relaunch, filesystem changes or service creation. Cleanup remains available.
if ($Action -notin @("uninstall", "status", "stop")) {
    [Console]::Error.WriteLine("This legacy Agent is retired: node-token reporting requires reinstalling with the maintained Go Agent.")
    [Console]::Error.WriteLine("Use the verified download in /admin, or https://raw.githubusercontent.com/emailtq/cfsm-agent/terminal/install.ps1 after a token-capable release is published.")
    exit 1
}

$DebugPreference = "SilentlyContinue"

$ErrorActionPreference = "Stop"

$APP_NAME = "CF-Server-Monitor"
$AGENT_VERSION = "1.3.8"
$TASK_NAME = "CFProbe"
# 获取脚本所在目录
if ($MyInvocation.MyCommand.Path) {
    $SCRIPT_PATH = $MyInvocation.MyCommand.Path
} elseif ($PSCommandPath) {
    $SCRIPT_PATH = $PSCommandPath
} else {
    $SCRIPT_PATH = Join-Path (Get-Location).Path "cf-server-monitor.ps1"
}
$SCRIPT_DIR = Split-Path -Parent $SCRIPT_PATH
$CONFIG_DIR = $SCRIPT_DIR
$CONFIG_FILE = Join-Path $CONFIG_DIR "cf_probe_config.json"
$LOG_FILE = Join-Path $CONFIG_DIR "cf_probe.log"
$TRAFFIC_FILE = Join-Path $CONFIG_DIR "cf_probe_traffic.dat"

$MAX_TRAFFIC_CORRECTION_GB = 1000000

$MAX_LOG_SIZE = 1MB

# ============================================================
# 工具函数
# ============================================================

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$ts] [$Level] $Message"
    try {
        if (Test-Path $LOG_FILE) {
            $size = (Get-Item $LOG_FILE).Length
            if ($size -gt $MAX_LOG_SIZE) {
                $lines = [System.IO.File]::ReadAllLines($LOG_FILE, [System.Text.Encoding]::UTF8)
                if ($lines.Length -gt 0) {
                    $targetSize = 102400
                    $totalBytes = 0
                    $keepCount = 0
                    for ($i = $lines.Length - 1; $i -ge 0; $i--) {
                        $lineBytes = [System.Text.Encoding]::UTF8.GetByteCount($lines[$i] + "`r`n")
                        if ($totalBytes + $lineBytes -gt $targetSize) { break }
                        $totalBytes += $lineBytes
                        $keepCount++
                    }
                    if ($keepCount -eq 0) { $keepCount = 1 }
                    if ($keepCount -gt 0 -and $keepCount -lt $lines.Length) {
                        $startIdx = $lines.Length - $keepCount
                        $keepLines = New-Object string[] $keepCount
                        [Array]::Copy($lines, $startIdx, $keepLines, 0, $keepCount)
                        [System.IO.File]::WriteAllLines($LOG_FILE, $keepLines, [System.Text.Encoding]::UTF8)
                    }
                }
            }
        }
        [System.IO.File]::AppendAllText($LOG_FILE, $line + "`r`n", [System.Text.Encoding]::UTF8)
    } catch {
        # 日志写入失败，忽略
    }
    Write-Host $line
}

function Load-Config {
    Write-Log "尝试加载配置文件: $CONFIG_FILE" "DEBUG"
    if (Test-Path $CONFIG_FILE) {
        try {
            $content = Get-Content $CONFIG_FILE -Raw -Encoding UTF8
            $raw = $content | ConvertFrom-Json
            Write-Log "配置文件加载成功" "INFO"
            # 清理 URL
            if ($raw.worker_url) {
                $raw.worker_url = $raw.worker_url.Trim().Trim("'").Trim('"')
            }
            # 同时清理其他可能包含引号的字段
            if ($raw.server_id) {
                $raw.server_id = $raw.server_id.Trim().Trim("'").Trim('"')
            }
            return $raw
        } catch {
            Write-Log "配置文件加载失败: $_" "ERROR"
            Write-Log "错误详情: $($_.Exception.Message)" "ERROR"
            return $null
        }
    } else {
        Write-Log "配置文件不存在: $CONFIG_FILE" "WARN"
        return $null
    }
}

function ConvertTo-BinaryFlag {
    param(
        [object]$Value,
        [string]$Default = "0",
        [switch]$Strict
    )

    if ($Default -ne "1") { $Default = "0" }
    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) {
        return $Default
    }

    $text = ([string]$Value).Trim()
    if ($text -eq "0" -or $text -eq "1") {
        return $text
    }
    if ($Strict) {
        throw "AutoUpdate 参数非法，仅支持 0 或 1"
    }
    return $Default
}

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-AsAdmin {
    if ($MyInvocation.MyCommand.Path) {
        $scriptPath = $MyInvocation.MyCommand.Path
    } elseif ($PSCommandPath) {
        $scriptPath = $PSCommandPath
    } else {
        $scriptPath = Join-Path (Get-Location).Path "cf-server-monitor.ps1"
    }
    $argList = "-NoProfile -ExecutionPolicy Bypass -STA -File `"$scriptPath`" $Action -STA"
    Start-Process powershell.exe -Verb RunAs -ArgumentList $argList -WindowStyle Hidden -Wait
}

function Uninstall-Service {
    if (-not (Test-Admin)) {
        Write-Host "需要管理员权限，正在提升..." -ForegroundColor Yellow
        Invoke-AsAdmin
        return
    }

    # 删除计划任务
    $task = Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
    if ($task) {
        Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false
        Write-Host "已删除计划任务: $TASK_NAME" -ForegroundColor Green
    }

    # 终止进程
    try {
        $procs = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction Stop
        foreach ($p in $procs) {
            if ($p.CommandLine -like "*cf-server-monitor*run*") {
                Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
            }
        }
    } catch {}

    # 清理文件
    if (Test-Path $CONFIG_FILE) { Remove-Item $CONFIG_FILE -Force }
    if (Test-Path $TRAFFIC_FILE) { Remove-Item $TRAFFIC_FILE -Force }
    if (Test-Path $LOG_FILE) { Remove-Item $LOG_FILE -Force }

    Write-Host "卸载完成。" -ForegroundColor Green
}

function Get-ServiceStatus {
    $task = Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
    if ($task) {
        Write-Host "计划任务: $($task.State)" -ForegroundColor Green
    } else {
        Write-Host "计划任务: 未注册" -ForegroundColor Yellow
    }
    $running = @()
    try {
        $processes = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction Stop
        foreach ($proc in $processes) {
            if ($proc.CommandLine -like "*cf-server-monitor*run*") {
                $running += Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue
            }
        }
    } catch {
        $running = Get-Process powershell -ErrorAction SilentlyContinue | Where-Object {
            $_.CommandLine -like "*cf-server-monitor*run*"
        }
    }
    if ($running) {
        Write-Host "探针进程: 运行中 (PID: $($running.Id -join ', '))" -ForegroundColor Green
    } else {
        Write-Host "探针进程: 未运行" -ForegroundColor Yellow
    }
    $config = Load-Config
    if ($config) {
        $effectiveStatusReportInterval = [math]::Max([int]$config.report_interval, 60)
        $statusAutoUpdate = ConvertTo-BinaryFlag -Value $config.auto_update -Default "0"
        Write-Host "配置文件: $CONFIG_FILE" -ForegroundColor Cyan
        Write-Host "  Server ID  : $($config.server_id)"
        Write-Host "  Worker URL : $($config.worker_url)"
        Write-Host "  上报间隔   : $($config.report_interval)秒"
        Write-Host "  实际间隔   : $effectiveStatusReportInterval秒"
        Write-Host "  自动更新   : $statusAutoUpdate"
    }
}

function Stop-Service {
    $running = @()
    try {
        $processes = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction Stop
        foreach ($proc in $processes) {
            if ($proc.CommandLine -like "*cf-server-monitor*run*") {
                $running += Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue
            }
        }
    } catch {
        $running = Get-Process powershell -ErrorAction SilentlyContinue | Where-Object {
            $_.CommandLine -like "*cf-server-monitor*run*"
        }
    }
    if ($running) {
        $running | Stop-Process -Force -ErrorAction SilentlyContinue
        Write-Host "探针已停止 (PID: $($running.Id -join ', '))。" -ForegroundColor Green
    } else {
        Write-Host "探针未运行。" -ForegroundColor Yellow
    }
}

try {
    switch ($Action) {
        "uninstall" { Uninstall-Service }
        "status"    { Get-ServiceStatus }
        "stop"      { Stop-Service }
    }
} catch {
    Write-Host "=============================================" -ForegroundColor Red
    Write-Host "错误: $_" -ForegroundColor Red
    Write-Host "错误详情: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "错误行: $($_.InvocationInfo.ScriptLineNumber)" -ForegroundColor Red
    Write-Host "=============================================" -ForegroundColor Red
}
