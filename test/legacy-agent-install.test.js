import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const bash = process.platform === 'win32' ? 'D:/Extra_Downloads/APPs/Git/bin/bash.exe' : 'bash';
test('retired scripts retain cleanup but remove the unreachable shared-secret Agent', () => {
  for (const name of ['install.sh','install-alpine.sh','install-openwrt.sh','install-synology.sh','install-mac.sh','cf-server-monitor.ps1']) {
    const source = fs.readFileSync(`public/${name}`, 'utf8');
    assert.doesNotMatch(source, /\bSECRET\b|\bSecret\b|\.secret\b|-secret=|function Install-Service|function Invoke-TrayCollectLoop|\binstall_probe\(\)|\bcreate_script\(\)/, name);
    assert.match(source, /uninstall_probe\(\)|function Uninstall-Service/, name);
  }
});
for (const name of ['install.sh','install-alpine.sh','install-openwrt.sh','install-synology.sh','install-mac.sh']) {
  test(`${name} retired installer fails before mutation and directs every platform to the maintained installer`, () => {
    const result=spawnSync(bash,[`public/${name}`,'--help'],{encoding:'utf8',windowsHide:true});
    assert.equal(result.status,1,result.stdout+result.stderr);
    assert.match(result.stderr,/retired.*node.token/i);
    assert.match(result.stderr,/emailtq\/cfsm-agent\/terminal\/install.sh/);
  });
}

test('PowerShell retired run/install/tray fails before files or background processes', {skip:process.platform !== 'win32'}, () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cfsm-retired-'));
  try {
    for (const action of ['run','install','tray']) {
      const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve('public/cf-server-monitor.ps1'),action],{
        encoding:'utf8',windowsHide:true,cwd:dir,env:{...process.env,LOCALAPPDATA:dir,APPDATA:dir,ProgramData:dir}
      });
      assert.equal(result.status,1,result.stdout+result.stderr);
      assert.match(result.stderr,/retired.*node.token/i);
      assert.match(result.stderr,/emailtq\/cfsm-agent\/terminal\/install.ps1/);
      assert.deepEqual(fs.readdirSync(dir),[]);
    }
  } finally { fs.rmdirSync(dir); }
});

test('shell cleanup plans preserve Agent targets without touching user files or host services', () => {
  for (const name of ['install.sh','install-alpine.sh','install-openwrt.sh','install-synology.sh','install-mac.sh']) {
    const source = fs.readFileSync(`public/${name}`, 'utf8');
    const cleanup = source.match(/^uninstall_probe\(\) \{[^]*?^\}/m)?.[0];
    assert.ok(cleanup, name);
    const script = `
set -eu
SERVICE_NAME=cf-probe
CONFIG_DIR=/synthetic/agent/config
SCRIPT_FILE=/synthetic/agent/cf-probe.sh
SERVICE_FILE=/synthetic/agent/systemd.service
OPENRC_FILE=/synthetic/agent/openrc
PROCD_FILE=/synthetic/agent/procd
RC_FILE=/synthetic/agent/rc
LAUNCHD_FILE=/synthetic/agent/launchd.plist
LAUNCHD_LABEL=system/com.cf.probe
CONTAINER_PID_FILE=/synthetic/agent/pid
CONTAINER_LOG_FILE=/synthetic/agent/log
DEBUG_ENV_FILE=/synthetic/agent/debug
PID_FILE=/synthetic/agent/pid
LOG_FILE=/synthetic/agent/log
TEMP_DIR=/synthetic/agent/cache
RED= GREEN= YELLOW= NC=
print_banner() { :; }
step() { :; }
check_root() { :; }
detect_os() { :; }
detect_runtime_mode() { :; }
stop_old_service() { printf 'CLEANUP_STOP\\n'; }
systemctl() { printf 'SERVICE %s\\n' "$*"; }
launchctl() { printf 'SERVICE %s\\n' "$*"; }
pgrep() { return 1; }
pkill() { printf 'PROCESS %s\\n' "$*"; }
rm() { printf 'REMOVE %s\\n' "$*"; }
${cleanup}
uninstall_probe
`;
    const result = spawnSync(bash, ['-s'], {input:script, encoding:'utf8', windowsHide:true});
    assert.equal(result.status, 0, name + result.stderr);
    assert.match(result.stdout, /REMOVE -f \/synthetic\/agent\/cf-probe.sh/, name);
    assert.match(result.stdout, /REMOVE -rf \/synthetic\/agent\/config/, name);
    assert.doesNotMatch(result.stdout, /REMOVE .*\/synthetic\/user|REMOVE -rf \/synthetic\/agent\s*$/m, name);
  }
});

test('PowerShell cleanup/status/stop retain dispatch and targets with all host operations stubbed', {skip:process.platform !== 'win32'}, () => {
  const file = path.resolve('public/cf-server-monitor.ps1').replaceAll("'", "''");
  const script = `
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'parse error' }
$names=@('Uninstall-Service','Get-ServiceStatus','Stop-Service')
$ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in $names},$false) | ForEach-Object { Invoke-Expression $_.Extent.Text }
$TASK_NAME='CFProbe'; $CONFIG_FILE='/synthetic/agent/config'; $TRAFFIC_FILE='/synthetic/agent/traffic'; $LOG_FILE='/synthetic/agent/log'
function Test-Admin { $true }
function Get-ScheduledTask { param($TaskName,$ErrorAction) @{State='Ready'} }
function Unregister-ScheduledTask { param($TaskName,[switch]$Confirm) Write-Output "TASK $TaskName" }
function Get-CimInstance { param($ClassName,$Filter,$ErrorAction) @{CommandLine='cf-server-monitor run';ProcessId=123} }
function Get-Process { param($Id,$ErrorAction) @{Id=123} }
function Stop-Process { param($Id,[switch]$Force,$ErrorAction) Write-Output 'STOP synthetic process' }
function Test-Path { param($Path) $true }
function Remove-Item { param($Path,[switch]$Force) Write-Output "REMOVE $Path" }
function Load-Config { @{server_id='synthetic-node';worker_url='https://example.com';report_interval=60;auto_update=0;secret='must-not-print'} }
function ConvertTo-BinaryFlag { param($Value,$Default) '0' }
Uninstall-Service
Get-ServiceStatus
Stop-Service
`;
  const result = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',script], {encoding:'utf8', windowsHide:true});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /TASK CFProbe/);
  for (const name of ['config','traffic','log']) assert.match(result.stdout, new RegExp(`REMOVE /synthetic/agent/${name}`));
  assert.match(result.stdout, /synthetic-node/);
  assert.match(result.stdout, /STOP synthetic process/);
  assert.doesNotMatch(result.stdout, /must-not-print|REMOVE \/synthetic\/user/);
});
