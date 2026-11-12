import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const bash = process.platform === 'win32' ? 'D:/Extra_Downloads/APPs/Git/bin/bash.exe' : 'bash';
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
