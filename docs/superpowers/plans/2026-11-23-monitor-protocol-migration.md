# 极简主协议迁移 Implementation Plan

> **For agentic workers:** 用户已批准开发，并于2026-11-24明确要求项目主会话→独立阶段主会话→顺序新建开发子会话（Codex侧栏真实聊天，不是内部子代理）。阶段主会话逐项验收后再分发下一项，项目主会话负责阶段验收和显式文件提交；不自动授权推送、部署、Agent发布或旧系统删除。

**持续执行规则（用户2026-11-24在第一阶段主会话明确授权）：** 每个阶段完成后主动通知项目主会话；项目主会话亲自读取产物、核对要求与检查结果，验收通过并显式文件提交后，继续创建下一个真实侧栏阶段主会话。该阶段再按顺序创建开发子会话、校验和修复，直到批准的开发完成，不等用户逐次催办。开发子会话不自行再分发；同一时间一个开发写入者。阶段/项目通知及原范围修复消息在这条授权链内，推送、部署、Agent发布、真实云资源及旧系统退役门禁不变。

**恢复索引：** 项目记录`.planning/2026-11-20-monitor-theme-api/task_plan.md`与`progress.md`；每阶段RESULT、FILES、brief在对应阶段目录；阶段threadId/hostId/cursor在`.superpowers/sdd/2026-11-23-monitor-protocol-migration/stageN-ledger.md`。交付、项目消费、验收、提交和下一阶段派工分别记录，不将派工记成完成。

**Goal:** 当前CF Agent迁移到极简标准协议，CF已有能力以版本化扩展保留；一个后端统计核心完整服务极简主题，未来其他主题生态按需接入。

**Architecture:** 标准Agent codec与CF扩展共享现有身份/连接协调和一套统计账本。原极简HTTP API及WS输出该核心；旧`/update`只在节点迁移期间接入归一化，不另建转发服务、不双写统计。保留现有D1、DO和主题分块存储，先完成纵向验证，再灰度默认切换和退役。

**Tech Stack:** Worker ES modules、Node22、D1、现有SQLite-backed Durable Objects、Vue3、当前Go Agent（go.mod要求Go1.27.3）、原版极简Rust参考fixture。

**Spec:** `docs/superpowers/specs/2026-11-23-monitor-protocol-migration-design.md`。

## Global Constraints

- 审计与设计已批准，开发在Worker和CF Agent的`codex/monitor-protocol-migration`分支推进。初始阶段执行Task1，项目验收后继续Task2及后续开发；发布和退役仍遵守各自门禁。
- 固定Worker c8afbde、CF Agent374c8c2、参考hub04a6fa1（1.5.2）、参考Agent81c63b9（1.2.3）；执行前检查新提交/当前diff，保护既有修改。
- 无R2、新账号计划或未经批准的新数据库；不直接改`dist/`；bindings/cron变动同步`wrangler.toml`和部署workflow。
- 不推main；父只提交显式文件。推送目标遵守已确认的`origin/terminal`，不得`git add -A`。
- 保留终端本地授权、Origin、管理员会话/lease、credential_version、SSH持久ACK、token撤销、私有站/Turnstile、节点隐藏和原CF扩展。
- 旧Agent入口保持原契约到迁移门槛；新用法的前置条件不得强加给既有调用者。
- 极简标准报文不夹带CF必需字段；HTTP REST不改成JSON-RPC。扩展首版按设计表，不扩成任意命令执行框架。
- 帧界限：标准JSON通知64KiB；协商CF batch最多512KiB/300资源样本；SSH仍32事件/批；新配置/任务分别64KiB。旧任务原JSON64KiB、旧编码配置响应264192字节的既有合同保持，不反向强加新帧上限。
- 秒/ms、字节/MiB转换只发生在边界；counter内部无精度损失，0–2^63−1；未知值不伪装零。
- 一位执行者拥有会话/统计写状态，TerminalBroker保留私有数据通道；不同阶段不同时争写同一状态机。
- UI只改本计划的协议/主题必要入口；按真实参考验证指定部分，保留旗帜、OS版本、分组、单行手机分组/添加和已接受的CF差异。

## 工作区与运行入口

```powershell
$worker = 'D:/Program_code/cloudflare_worker/CF-ssh/CF-Server-Monitor'
$agent = 'D:/Program_code/cloudflare_worker/CF-ssh/cfsm-agent'
$nodeDir = "$worker/.planning/2026-11-05-agent-terminal-proposal/tools/node-v22.23.4-win-x64"
$env:PATH = "$nodeDir;$env:PATH"
Set-Location -LiteralPath $worker
node --version # v22.23.4或项目已验证的Node22
```

Agent测试复用`.github/workflows/test.yml`三平台Go工具链；本机已有`.planning/2026-11-05-agent-terminal-proposal/tools/go/bin/go.exe`（Go1.27.3 windows/amd64），不在PATH时使用绝对路径。旧Agent17项定向基线通过不等于新协议或三平台通过。每次任务均遵循：具体反例RED → 最小实现 → 相关GREEN → 父审查 → 显式文件提交；只重新验证实际变化/此前失败的检查。

## 执行顺序和估算

| 任务 | 可验收交付 | 依赖 | 人日粗估 |
|---|---|---|---:|
|1|冻结标准/扩展/权限矩阵，确定存储预算|设计批准|2–4|
|2|原生Agent入口、身份和会话可运行|1|5–8|
|3|当前Go Agent标准模式与CF batch/fallback|1、2|5–8|
|4|权威流量、资源、probe统计及迁移接续|2、3|8–12|
|5|极简公共/主题管理REST与原包完整链路|4|5–8|
|6|CF配置/SSH/通知/终端扩展完整保留|2–5|6–10|
|7|休眠、状态恢复和免费预算验证|4–6|4–7|
|8|backend先行、Agent灰度、回滚和默认切换|5–7|4–7|
|9|达到用户门槛后退役旧系统|8＋用户批准|2–4|

合计约41–68人日，按40–70人日预算。不是承诺交付日期；原SQLite互导/完整原登录等选择另一范围时重估。第二主题生态不计入这次实现，只保留输出边界。

---

### Task 1: 冻结合同与最小存储预算

**Files:**
- Create: `docs/monitor-protocol.md`、`test/fixtures/monitor-protocol/{standard,extensions,permissions}.json`。
- Audit: `src/handlers/update.js`、`src/durable/MetricsBroadcaster.js`、`src/services/monitorCompat*.js`、`src/database/{nodeCredentials,latencyTasks}.js`；Agent `internal/cfprobe/{agent,report_transport,types,traffic,probe,latency_tasks}.go`。
- Create/test: `scripts/probe-monitor-storage.mjs`、`test/monitor-protocol-budget.test.js`；隔离计量脚本归本任务，产品不开放计量fixture路由。

**Interfaces:**
- Consumes: 固定上游hello/report/ping.result/ping.tasks；既有CF schema10、lease和事件合同。
- Produces: 标准fixture、扩展method/role/schema表；后续模块接口见任务2–4。字段与数值词元必须按原标准记录，不把缺失元数据补成假值。

- [x] 将完整固定hub1.5.2参考置于隔离目录，只读取公开源码/发行包；保留原checkout不改。记录与本地1.5.1的相关差异。
- [x] 将标准与扩展分开列method、角色、请求/通知/响应、边界和版本；逐项覆盖设计表，不使用`cf.*`全权限通配。
- [x] 准确列出所有CF能力的保留位置：采集/探测模式、无限任务、dynamic config、HTTP fallback、告警、SSH事件、PTY/local revoke、安装/自动更新、校时、备份等。
- [x] 做一个隔离存储probe，用20节点×4探测×60秒、2秒本机采样的输入比较：D1按节点桶打包；现有DO SQL journal＋D1 checkpoint。记录`meta.rows_read/rows_written`和占用，不预设DO存储免费或无损。
- [x] 最小选择规则：无第二权威账本、已ACK恢复正确、能查原始probe分布、达到free预算目标；满足者中优先保留现有D1路径。若两者都不满足，报告实际差额并调整发送/保留策略或请求资源决策，不降低统计含义。
- [x] 确认设计第9节平台差异的选择；数据库互导/登录权限/保留期决策仅阻止对应后续任务，不阻止标准codec和Agent实现。
- [x] 父核对矩阵与预算，将本任务资料作为后续输入，产品仍不改默认入口。

**首个预算测试示例：**

```js
test('native message count is separate from D1 write count', () => {
  const nodes = 20, intervalSeconds = 60;
  const frames = nodes * 86400 / intervalSeconds;
  assert.equal(frames, 28800);
  assert.equal(frames / 20, 1440);
  // 分表probe与traffic每分钟更新的风险模型，不代表实际实现。
  assert.equal(nodes * 1440 * (1 + 4 + 1), 172800);
});
```

**Acceptance:** 所有标准/扩展有具体角色与fixture；选定一种耐久状态策略及真实读写预算；不以模型替代云账单。没有批准的范围差异留在对应操作旁，不宣称全部原API已同义。

**Run:** `node --test test/monitor-protocol-budget.test.js`，`node scripts/probe-monitor-storage.mjs`。前者明确验证计算，后者只连接临时Miniflare，不使用生产env或凭据。

### Task 2: 原生接入、codec、数值ID和单节点会话

**项目验收通过（2026-11-24）：** 最终Node22 codec/ID/真实WS组合55/55通过；共同owner覆盖legacy WS/POST实际写入，capabilities仅空交集，未实现durable batch不广告。证据与接口见stage2/PROJECT-ACCEPTANCE及RESULT；Task3开始，Task4/6/7保留其实际依赖。

**Files:**
- Create: `src/shared/monitorAgentProtocol.js`、`src/handlers/monitorAgent.js`、`src/durable/MonitorAgentSession.js`、`src/database/monitorProbeIds.js`。
- Modify: `src/index.js`、`src/durable/MetricsBroadcaster.js`、`src/database/monitorCompatIds.js`；只把新增接入需要的会话职责抽离，不全面拆原DO。
- Create fixture/test: `test/fixtures/monitor-runtime.mjs`、`test/monitor-agent-protocol.test.js`、`test/monitor-agent-session.test.js`、`test/monitor-probe-ids.test.js`；复用`test/node-report-auth.test.js`。

**Interfaces（本计划中的拟新增接口）:**
- `parseAgentRpc(raw: string) -> {method, params, id?}`：验证JSON-RPC envelope，保留counter十进制词元，标准与CF扩展各自验证。
- `handleMonitorAgentUpgrade(request, env, url) -> Promise<Response|null>`：只处理标准WSS入口，现有Worker转发同一DO。
- `MonitorAgentSession`：持有认证principal `{serverId,tokenVersion,credentialVersion}`、session generation和协商能力，产生标准facts/report/probe输入；不开放public/admin方法。
- `getMonitorProbeIds(db, metricIds) -> Promise<Map<string,number>>`：持久、唯一、不复用删除ID。
- `createMonitorRuntimeFixture(t, options) -> Promise<fixture>`：从现有Miniflare/auth/terminal测试搭建临时DB/DO，后续逐任务增加`rpcAsAgent(request)`、`countStartedPtys()`、`sendBatch(batch)`、`readLedger()`、`reconstructSessionFromDurableState()`。不连接生产，`reconstruct`仅重建内存而保留同一耐久DB。

- [x] 先写真实握手RED：匿名/错误token拒绝；正确token升级后可直接发hello，不需要旧server hello；同token新连接取代旧会话后旧close不能标记新连接离线。
- [x] 写counter词元RED与numeric ID并发稳定测试，包含删除/重建task generation；旧hash ID不覆盖新映射。
- [x] 使用已验证Workers `JSON.parse` reviver `context.source`读取counter，有限schema检查非负i64；通过公开输出serializer保留标准数值，不把counter改成对外字符串。
- [x] 将新入口放在`handleMonitorCompat`之前精确分派；保留旧`/update`和当前公开API不变；处理接口不是新增外部中转服务。
- [x] 会话认证和撤销复用`nodeAuth/nodeCredentials`；attachment不保存bearer。native/legacy共用按节点写入所有权，旧数据不得晚到覆盖新session。
- [x] 实现std task map；原标准Agent64任务边界与CF扩展大配置分开。能力限制在管理员操作前准确反馈，不静默删任务。
- [x] GREEN后复跑节点凭据/lease/旧WS测试；父验收原版Agent客户端或固定原报文真实WS连接，不只直接调用JS handler。

```js
test('report preserves an integer counter above the JS safe range', () => {
  const rpc = parseAgentRpc('{"jsonrpc":"2.0","method":"report","params":{"boot_id":"a","net_rx_total":9007199254740993,"net_tx_total":0}}');
  assert.equal(rpc.params.net_rx_total, '9007199254740993');
});
```

**Acceptance:** 新标准入口可用、旧入口不退化、敏感凭据不进报文/日志/attachment；node/task IDs稳定；受控新旧双连接测试通过。

**Run:** `node --test --test-concurrency=1 test/monitor-agent-protocol.test.js test/monitor-agent-session.test.js test/monitor-probe-ids.test.js test/node-report-auth.test.js`；新文件纳入package.json显式测试命令。

### Task 3: 当前Go Agent原生模式、精确采集与CF批量

**项目接受本地候选（2026-11-24），运行门禁未关闭：** 项目实际Go定向99顶层PASS/4consumerSKIP、Node真实Execute/Run→Worker两入口1/1且0skip；candidate可提交并供Task4消费。固定hub1.5.2完整互通、Linux/macOS实采/tests/race、Windowsrace缺执行资源，项目持有，Task3不得标全部完成/发布。详见stage3/PROJECT-ACCEPTANCE与runtime-dependencies。Task4独立D1开发继续，不用编译替代运行。

**Files (Agent repo):**
- Create: `internal/cfprobe/monitor_protocol.go`、`monitor_metrics.go`、`monitor_protocol_test.go`、`monitor_metrics_test.go`。
- Modify: `types.go`、`config.go`、`cli.go`、`node_registration.go`、`agent.go`、`metrics_common.go`与各平台采集文件、`report_transport.go`、`report_context_test.go`、`report_transport_test.go`、安装脚本及README。
- Reuse: `websocket_client.go`、校时、retry、采样缓冲；不新增一套通用transport框架。
- Worker必要配套: `src/handlers/monitorAgent.js`和任务2codec的CF batch接收边界。

**Interfaces:**
- `Config.ReportProtocol`：`legacy|monitor`；旧配置缺省legacy。`Config.MonitorServerURL`为无凭据HTTPS站点入口，旧`WorkerURL`使用合同不变；升级过程中不得把旧`/update`字段静默改含义。
- 新采集内部`NativeSample`使用数值CPU/load/bytes/counters及epoch，旧`Metrics`仍可通过边界输出供未迁移用法使用。
- `encodeMonitorNotification(method string, params any) ([]byte,error)`：标准报文；CF batch使用设计的明确stream/sequence结构。

- [x] 写RED：原hub没有type:hello/ack也能开始report；3秒capability超时仍标准运行；其他rpc.method文本不误当CF配置或ACK。
- [x] 写RED：显式网卡、过滤集合变化、重启、计数下降、采集失败不发送伪0；保留原字节精度。Linux对照原采集规则，Windows/macOS等公开说明不存在字段的实际状态。
- [x] 在原采集器中增加bytes/epoch/facts，而非MiB乘回；采样和发送时间分离，空闲批量仍保留均值/峰值必需输入。
- [x] 标准peer只收standard report/ping.result；新CF peer协商后，标准report发送活跃实时最新值，cf.report.batch约60秒提交冻结历史/probe批次。空闲只需低频批次及心跳；保留dynamic interval、HTTPfallback、退避、校时和配置持久化，不对每个实时帧要求落盘ACK。
- [x] CF fallback使用新JSON-RPC batch endpoint，同stream/sequence重试；失败不自动切弱鉴权、跨origin或旧协议。原hub不提供fallback时明确禁用该扩展。
- [x] 修订安装器让新模式使用明确参数、同一节点token和安全文件权限；增加标准`--server/--token/--interval/--iface`调用到新模式的兼容入口并测试，不改旧`-url=/update`含义；CLI旧用法/自动更新不得被强迫切协议。
- [ ] Go1.27.3三平台test/vet/race和原安装/终端/SSH测试GREEN；受控Linux比较新Go Agent→固定原hub和新backend两条真实链路。

```go
func TestMonitorNotificationUsesStandardEnvelope(t *testing.T) {
    raw, err := encodeMonitorNotification("hello", map[string]any{"agent_version": "audit"})
    if err != nil { t.Fatal(err) }
    var message map[string]json.RawMessage
    if err := json.Unmarshal(raw, &message); err != nil { t.Fatal(err) }
    if string(message["jsonrpc"]) != `"2.0"` || string(message["method"]) != `"hello"` { t.Fatalf("wrong envelope: %s", raw) }
    if _, exists := message["type"]; exists { t.Fatal("legacy envelope leaked") }
}
```

**Acceptance:** 不丢CF采集/网络能力；标准报文真实互通；同一新Agent不是同时向两后端上报；无CF能力的peer不会被错误启用SSH/终端。

**Run (Agent目录):** `go test ./internal/cfprobe -run 'TestMonitor|TestBuildReport|TestReportTransport|TestLatency|TestMonthly' -count=1`；再按现有三平台CI执行`go vet ./...`和`go test -race ./...`。

### Task 4: 权威统计、durable接续及旧数据迁移

**项目接受本地候选（2026-11-25），额度及运行差分门禁未关闭：** 项目亲验core/continuity64/64、receiver freshness/CF20/20、真实Go三入口aggregate1/1均0fail/skip；发现hourly指标维护异常阻断原terminal/login清理，回原S3修复后项目实际scheduled/D1故障及20chunk边界4/4通过。唯一D1原子receipt＋桶＋节点状态、重放原ACK不重复reduce、legacy接续及现消费者已本地验收。证据见stage4/PROJECT-ACCEPTANCE。20节点60秒批仅ingest86400写/天，cleanup后115680–118080另加其他业务；永久receipt模型day7为535796460B、day30为1539266220B，keys/pages/现库另加。100节点有维护backlog。当前免费预算不通过，不修改默认采样/retention/ACK来声称达标；资源合同选择和真实云计量由项目/Task7关闭。固定原hub运行差分及Task3多平台/race仍待运行资源。代码候选可提交并供Task5消费，不能据此发布。

**Files:**
- Create: `src/services/monitorStatistics.js`、`src/database/monitorTelemetry.js`、`src/shared/monitorTelemetry.js`。
- Modify: `src/durable/MonitorAgentSession.js`、`src/durable/MetricsBroadcaster.js`、`src/handlers/update.js`、`src/handlers/dashboard.js`、`src/database/schema.js`、`src/utils/historyFields.js`、`src/services/notification.js`中消费权威流量/在线状态的边界；包括latest timestamps、历史查询和server-detail缓存消费者。
- Test: `test/monitor-statistics.test.js`、`test/monitor-telemetry-d1.test.js`、`test/monitor-telemetry-recovery.test.js`、原traffic-alert/latency-task/backup tests。

**Interfaces:**
- `reduceTrafficLedger(previous, reading) -> ledger`，reading含`epoch,rx,tx,observedAt,dayStart,monthStart`，counter和累计值内部decimal string，计算用BigInt；首次/变epoch只建基线。
- `aggregateMinuteSamples(samples) -> resourceBucket`：count、覆盖时间、mean/max、rate/counter。
- `recordMonitorBatch(env, principal, session, batch) -> Promise<{stream,sequence,persisted}>`：一个写入所有者，只有耐久保存后ACK。
- `readMonitorTelemetry(db, serverId, window) -> Promise<coreWindow>`：公开API与CF后台读同一coreWindow，不内部HTTP调用。

- [x] 写RED：9007199254740993−9007199254740992=1；第一次/下降/epoch变化不虚增；跨日、月末29–31日、timezone、恢复和late样本按固定上游规则。
- [x] 写RED：一秒CPU100%和59秒0%分钟mean约1.67%、max100%；不同覆盖小时按权重合并；无数据不变成0。
- [x] 写RED：2次成功＋1次超时窗口loss=1/3×100；同摘要重复上报不增加分母；同CF客户端实时report和durable batch不重复计入mean/分母；重试同batch和双通道不增加流量/样本次数；原标准无seq按其session规则。
- [x] 用任务1选定的持久策略实现耐久输入/批checkpoint；本地从重建、数据库失败和ACK丢失恢复，不以Map作为已ACK高水位唯一存储。真实云驱逐归Task7。
- [x] 按节点添加migration state，保留UUID、公开ID、旧历史、已知月值和激活时刻；新核心接续时禁止Agent本地month再覆盖hub账本。rollback跨模式重新基线，不重复补差额。
- [x] 实现分钟/小时rollup、真实retention和覆盖信息，旧区间来源与精度可查；不去填造缺失old loss/day。
- [x] 原告警/自动续费、任务generation与备份调用统一边界；节点切原生后，旧后台latest timestamp、server detail、历史查询改读同一核心的兼容输出，不能继续只读旧metrics_history而误报离线。测试已有用户设置和节点权限未被新模型改变。
- [x] GREEN并运行隔离恢复测试；父核完整数值系列及固定hub源码规则，不只字段存在。真实Go→当前Worker/D1丢ACK、同私有queue/同D1重启、原文重放无二次作用已通过。
- [ ] 完成原验收要求的固定原hub binary与新后端同输入运行差分；项目与Task3运行资源门禁共同持有，不以源码规则对照替代运行。
- [ ] 免费额度及真实云CPU/duration/billed capacity/headroom/完整访客组合通过；当前产品实测预算失败，由项目/Task7处理，不阻断独立Task5开发。

```js
test('a counter reset establishes a new baseline without adding lifetime bytes', () => {
  const previous = { epoch: 'a', rx: '100', tx: '0', totalRx: '900', totalTx: '0', dayRx: '50', dayTx: '0', monthRx: '200', monthTx: '0', dayStart: '2026-11-23', monthStart: '2026-11-01' };
  const next = reduceTrafficLedger(previous, { epoch: 'b', rx: '10', tx: '0', observedAt: Date.UTC(2026,10,23,12), dayStart: previous.dayStart, monthStart: previous.monthStart });
  assert.equal(next.totalRx, '900');
  assert.equal(next.rx, '10');
});
```

**Acceptance:** 单账本/单统计、旧值不被伪造升级、已ACK恢复正确、epoch/跨日/probe/weighted rollup对照通过。原历史保留，并列清不具备等价精度的旧区间。

**Run:** `node --test --test-concurrency=1 test/monitor-statistics.test.js test/monitor-telemetry-d1.test.js test/monitor-telemetry-recovery.test.js test/traffic-alert.test.js test/latest-timestamps.test.js test/latency-tasks.test.js test/server-backup-format.test.js`。

### Task 5: 极简公共API和主题管理完整纵向链路

**Files:**
- Create: `src/handlers/monitorApi.js`、`src/services/monitorThemeUploads.js`（原REST分片接入，不重写原包parser）。
- Modify: `src/handlers/monitorCompat.js`、`src/services/monitorCompatSnapshot.js`、`monitorCompatHistory.js`、`monitorThemes.js`、`monitorThemePackages.js`、`src/handlers/monitorThemeAdmin.js`、`monitorThemePreview.js`、`src/frontend/utils/api.js`、`MonitorThemeManager.vue`。
- Test: `test/monitor-api.test.js`、`test/monitor-theme-upload-chunks.test.js`、`test/monitor-theme-ecosystem.test.js`、原native/default/UI tests。

**Interfaces:**
- `projectMonitorNode(coreNode, viewerPolicy, now) -> upstreamNode`，`projectMonitorHistory(coreWindow) -> {metrics,ping,probes,loss,step}`。
- 标准theme REST转现有`loadMonitorThemes/selectMonitorTheme/saveMonitorThemeConfig/installMonitorTheme/removeMonitorTheme`等业务函数，不调用旧action endpoint作网络中转。
- `receiveMonitorThemeChunk(request, env, owner, {offset,total}) -> Promise<{received}|{theme}>`：按owner隔离、串行CAS，末片完整验证再发布。

- [ ] 将前轮static/manifest资源冲突探针转正式RED；新public facts/day/loss/history覆盖和图表统计写真实消费者RED。
- [ ] `/api/me/nodes/metrics/ws`直接读核心；补public_remark、expires_in、virt/day/month_start；保留public allowlist、show*开关、Turnstile与隐藏节点。
- [ ] 提供标准主题列表、分片上传、config、update/delete、PNG和settings.theme选择；按Content-Type处理native/legacy注册协议，标准held-token再注册不新建节点。
- [ ] static/manifest资源使用已验证主题/revision上下文服务，CF后台和真实internal/Agent/install路径维持所有权；preview不使用全站selection cookie。
- [ ] 让配置打开读取最新覆盖，反馈带主题/version，删除说明按当前/非当前/default区分；加站点图标覆盖，不重做整页样式。
- [ ] 其他管理REST按原方法和权限映射现有业务；先列完整路由表，原登录/SQLite操作按已批准第9节范围开发或明确平台接口，禁止假成功。
- [ ] 本地原包生命周期、全资源、首页/详情/刷新/断线重连、配置恢复和新旧revision；明暗桌面/手机实际render验证，不重新改已接受差异。
- [ ] 父验收第一里程碑：新CF Agent→权威核心→Default及四原包数据功能完整；原标准Agent也通过同样公共API。

```js
test('probe window loss is not an empty fallback with actual timeouts', () => {
  const body = projectMonitorHistory({ resourceBuckets: [], probeSeries: [{ id: 1, name: 'A', samples: [{ ts: 1, latency: 10 }, { ts: 2, latency: 20 }, { ts: 3, latency: null }], attempts: 3, timeouts: 1 }], step: 60 });
  assert.ok(Math.abs(body.loss['1'] - 100 / 3) < 1e-9);
});
```

**Acceptance:** 不再存在安装成功但普通资源不可用反例；当前新数据不被主题读成缺失0；全部标准主题管理方法实际消费同业务。平台差异已被明确批准或对应操作真实实现。

**Run:** `node --test --test-concurrency=1 test/monitor-api.test.js test/monitor-theme-upload-chunks.test.js test/monitor-theme-ecosystem.test.js test/monitor-theme-management.test.js test/monitor-default-frontend.test.js`；`npm run build:frontend`后使用现有preview harness和Ego验证实际原包，不编辑dist。

### Task 6: CF已有能力迁为扩展，完成通知/终端安全闭环

**Files:**
- Modify: `src/services/loginEvents.js`、`src/handlers/terminal.js`、`src/durable/TerminalBroker.js`、`src/shared/terminalProtocol.js`、`src/frontend/composables/useTerminal.js`、`src/utils/agentConfig.js`、`src/utils/agentConfigNotify.js`。
- Agent: `internal/cfprobe/{ssh_events,terminal_protocol,terminal_control,terminal_session,report_transport,config}.go`及对应tests。
- Test: `test/monitor-cf-extensions.test.js`、`test/terminal-protocol.test.js`、`terminal-disable/lease/flow.test.js`、`login-events.test.js`、Go原SSH/terminal matrix。

**Interfaces:** 设计第5节冻结的cf methods；既有SSH事件version1/stream/sequence、TerminalBroker ticket/generation/credentialVersion/credit保持含义；binary frame保留16KiB数据边界。

- [ ] 写RED：不协商或权限不足不能触发cf methods；capabilities不授权；Agent不能调用admin方法，public/preview不能订阅SSH或拿PTYticket。
- [ ] 配置下发转`cf.reporting.configure`/`cf.ping.tasks`，保留ICMP/TCP、超64任务、WSS时段、UA/校时和自动更新等现有使用合同，标准peer只收到标准任务。
- [ ] SSH转`cf.ssh.events`，ACK只确认持久sequence；报告ACK/心跳不能清事件队列。断网/ACK丢失/重启/策略撤销仍不重复发通知。
- [ ] 终端控制双方和前端同时改JSON-RPC envelope，角色白名单/参数/credit/票据校验复用；私有binary data走现有Broker，不经过public monitoring socket。
- [ ] `terminalIdentityEqual`及本地持久身份增加新protocol/server字段，terminal URL helper按当前协议选base，新用法不强制填写旧WorkerURL；标准注册只返回token时，从已认证CF capability响应取得自己的节点身份。旧连接/旧ticket/本地禁用/重装ABA不能重开PTY；不得通过配置远程开启本地授权。
- [ ] 通知/终端/数据可见性/备份的UI仍消费CF服务，只替换必要接口；失败必须显示实际state，不吞为成功。
- [ ] 全部原扩展关键路径GREEN，真实受控LinuxPTY/SSH一次验证；父接收终端shutdown/lease和事件持久ACK证据。

```js
test('extension capability alone never authorizes a terminal', async t => {
  const fixture = await createMonitorRuntimeFixture(t, { terminal: false });
  const result = await fixture.rpcAsAgent({ jsonrpc: '2.0', id: 1, method: 'cf.terminal.open', params: { serverId: fixture.otherNode } });
  assert.ok(result.error);
  assert.equal(await fixture.countStartedPtys(), 0);
});
```

此处`fixture.rpcAsAgent/countStartedPtys`由本任务在任务2临时fixture上增加，`otherNode`为另一临时节点身份，不创建真实production PTY；真正端到端另使用已授权非生产主机。

**Acceptance:** CF功能清单逐项保留，不因统一格式取消现有权限/容错；标准peer正确缺省；没有把SSH/PTY敏感数据泄漏到主题。

**Run:** `node --test --test-concurrency=1 test/monitor-cf-extensions.test.js test/terminal-protocol.test.js test/terminal-disable.test.js test/terminal-lease.test.js test/terminal-flow.test.js test/login-events.test.js`；Agent三平台运行对应原SSH/terminal测试及新monitor扩展测试。

### Task 7: 可休眠会话、状态恢复和实际额度门禁

**Files:**
- Modify: `src/durable/MonitorAgentSession.js`、`MetricsBroadcaster.js`、`src/services/monitorStatistics.js`、相关storage/refresh helpers。
- Test: `test/monitor-agent-hibernation.test.js`、`test/monitor-telemetry-recovery.test.js`、`test/monitor-compat-live.test.js`。
- Evidence/scripts: 独立`.planning`负载与Cloudflare验收目录；不把测试路由发布到生产。

**Interfaces:** 序列化attachment仅非秘密principal/version/session metadata；已ACK高水位及bucket状态来自任务4耐久层。现有alarm统一协调auth lease、checkpoint与heartbeat，不抢占原alarm。

- [ ] 写RED：驱逐后还原连接/协商/高水位/桶；旧connection cleanup不影响新session；token撤销与私有站变更在既有时限内生效。
- [ ] 新standard/cf socket使用可休眠API；原标准Agent心跳与CF客户端心跳分别验证，不要求原Agent会发送CF autoresponse文本。无空闲setInterval维持对象常驻。
- [ ] latest状态从核心复用；可见性/权限有可靠失效或有界再查。减少每10秒查latest history，不取消安全复核。
- [ ] 测新旧混跑与全部新协议两种状态；旧standard socket还在时，不能认定global DO已经能休眠。
- [ ] 在已批准的隔离Cloudflare资源验收free预算场景；按相同节点/探测/采样/访客时段取得24h计量和CPU分布，包含D1/DO storage/journal/索引/重试/cron，不只模型估算。
- [ ] 结果超过设计留余量预算时，定位具体读写/消息/常驻原因，优化同一实现；若需求与免费限额冲突，给出参数和容量决策，不默默降低统计准确性或开付费。

```js
test('durable receipt survives reconstruction without duplicate booking', async t => {
  const fixture = await createMonitorRuntimeFixture(t, { durable: true });
  await fixture.sendBatch({ stream: 's', sequence: 1, samples: fixture.samples });
  const before = await fixture.readLedger();
  await fixture.reconstructSessionFromDurableState();
  await fixture.sendBatch({ stream: 's', sequence: 1, samples: fixture.samples });
  assert.deepEqual(await fixture.readLedger(), before);
});
```

本地reconstruct只能证明持久恢复逻辑；真实hibernation/duration必须使用隔离云验收。只有本地通过时不得宣称云休眠已通过。

**Acceptance:** 可靠性和免费预算证据同时满足；不新增永久常驻转发DO；没有把潜在节省写成实际结果。

**Run:** `node --test --test-concurrency=1 test/monitor-agent-hibernation.test.js test/monitor-telemetry-recovery.test.js test/monitor-compat-live.test.js`；隔离Cloudflare计量使用任务1脚本的明确云验收模式，并通过既有授权消费者操作，不读取token文件。

### Task 8: 兼收发布、节点灰度、回滚与默认协议切换

**Files:**
- Modify: `src/shared/agentSource.js`、`src/frontend/utils/agentInstallRelease.js`、`public/install*.sh`、CF Agent安装/更新和release workflows、`src/index.js`、必要`wrangler.toml`/deploy workflow。
- Test: 原Agent-install/download/token tests；`test/monitor-agent-migration.test.js`。
- Evidence: 每批的版本、节点清单、协议/能力、数据激活点、回滚操作，不包含token或SSH原始日志。

**Interfaces:** 任务3显式protocol配置；任务4按节点ownership/migration state；不靠Agent版本号猜协议。旧caller继续用旧URL和报文直到其迁移。

- [ ] 写RED：同一节点协议切换与回切，保留ID/账单/权限且不双记流量；新CFbatch的HTTP重试和legacy连接并发仍只有一个统计所有者。
- [ ] 构建/定向测试/端到端通过后，先部署新backend兼收版本，原Agent配置不变；记录新版本和具备新入口的回滚backend。需要原`/agent/{arch}`分发时复用受验证发行包下载链，提供已测试的标准CLI兼容binary，不伪装上游签名、不转发节点token到GitHub。
- [ ] 在非生产Linux/多平台CI验收后发布新Agent版本；初期显式启用monitor，不让自动更新擅自切协议或开启终端。
- [ ] 选择一台已授权测试节点切换，验收实时、日/月、probe、通知、SSH、PTY、fallback、重启；再小批扩展，节点库存逐项记录真实消费情况。
- [ ] 每批准备独立Agent旧binary/config恢复；若backend只能回到旧版，先切回这些节点旧协议，再回滚Worker。回滚不能删除新D1表、重置账本或删除DO迁移历史。
- [ ] 全部CF内部WS/管理caller有明确入口后，才把默认公共`/api/ws`改成极简；仍有外部旧caller时提供可用迁移路径，不直接改它们的response含义。
- [ ] 默认安装模板转新protocol，保留手动legacy恢复入口；记录最近24h实际quota/健康，再判定灰度完成。
- [ ] 父验收、显式文件提交；重新核远端和部署授权，按约定terminal推送，不触发main部署。

**Acceptance:** backend先行、Agent后行；真实节点已消费新协议；所有CF功能可用；回滚可在新协议失联时独立执行。

**Run:** `node --test --test-concurrency=1 test/monitor-agent-migration.test.js test/agent-install-release.test.js test/agent-download-source.test.js test/node-token-flow.test.js`；发布前按资源允许串行运行`npm run test:all`及Worker构建。正式`npm run deploy`只在新鲜授权/配置/恢复检查通过后执行。

### Task 9: 条件满足后退役旧主题与旧主协议

**Files:**
- Audit/remove slice: `ThemeStorePanel.vue`、旧public Dashboard/ServerDetail专属代码、`src/handlers/theme.js`、`frontend.js`中旧theme_url分支、Mikus、旧preview、过渡`/update`分支与专属tests/docs。
- Preserve: Admin shell/dashboard.html、shared静态资源、Agent/终端/通知/备份、现有D1历史、DO migrations。
- Test: `test/monitor-retirement.test.js`；更新原入口测试为明确退役合同，不因测试失败静默更改保留入口。

**Interfaces:** 一个默认主题系统/主Agent协议；legacy历史读取可保留数据兼容，不保留第二套统计所有者。第二生态输出只保留明确扩展点，不预实现。

- [ ] 开始前门禁：所有在用节点/客户端迁移库存完成，新核心/主题/CF扩展真实验收，恢复包可用，用户明确批准退役。未满足时停在本任务，不撤旧入口。
- [ ] 单独确认Pages是否迁移/停用；共享模块有实际consumer时保留，不整目录删除。
- [ ] 先移除旧可达安装/选择/preview入口，再删除已证明无consumer的主题专属源码；旧配置/历史非破坏性保留，不做DROP/全库清空。
- [ ] 完整读取受影响调用链，注册/安装/后台/terminal/通知/备份回归与Worker/Pages构建按实际保留范围验证。
- [ ] 父检查最终diff和对外入口，报告唯一系统、历史数据来源及已退役路径；独立用户授权下才推送部署。

**Acceptance:** 没有第二套可达旧主题管理/旧主统计；保留CF功能和数据恢复；不能只隐藏UI就称退役完成。

**Run:** `node --test test/monitor-retirement.test.js`及实际受影响原功能回归；`npm run build:frontend`，Pages若保留则独立`npm run build:github-page`后恢复Worker生成构建。父比较最终diff与保留库存。

## 实施门禁与停止点

| 门禁 | 判定证据 | 不满足时下一行动 |
|---|---|---|
|G0合同与预算|任务1资料及已批准平台差异|对应范围确认或存储probe，不进入默认切换|
|G1原生纵向|任务2–5，新Agent/原Agent与主题真实消费|由会话/核心所有者修正，不逐主题补丁|
|G2CF功能完整|任务6的权限、副作用和真实终端/事件|保留旧扩展入口，不让节点默认切换|
|G3云端可靠性/额度|任务7的驱逐恢复和同负载计量|修复热状态/读写/节流，或资源决策|
|G4灰度与回滚|任务8节点库存、实际消费、独立恢复|停止扩批，保留兼收版本|
|G5旧系统退役|用户批准＋Pages/共享依赖核定|继续保留旧系统，不强行删除|

**第一阶段实际开工点：Task1合同和预算，随后Task2原生接入。** 不先改所有Agent的默认URL，不先删除CF老系统，不先把全部handler套JSON-RPC外壳。
