# 极简 Agent 标准合同与 CF v1 扩展

本文件冻结 Task1/S1 的线协议、权限和能力保留输入，并记录 S2 的存储实测与决定。标准来自固定源码；`cf.*` 是已批准设计的**拟实现 v1 合同**。S2 选择 D1 节点时间桶原子接收，依据和预算见第8节；产品接入和统计实现仍在 Task2–4，不更改现有默认入口。

## 1. 固定来源和三条独立边界

| 代号 | 来源 | 固定身份 |
|---|---|---|
| H | monitor-probe/monitor 完整公开源码 | hub 1.5.2，`04a6fa1ef77e4d2208b4543018c2073d9bcc8095` |
| O | 只读 sibling `../agent` | Agent 1.2.3，`81c63b9730143080cea9ef465a1f46a4a1aeedb8` |
| W | 本 Worker | `c8afbdece469c4f09e35d8692b1d3b275d7eca49` |
| C | 只读 sibling `../cfsm-agent` | schema10，`374c8c28a67094c9afaa217fd2e5d235e5f20e01` |

H 全源码位于 `.planning/2026-11-20-monitor-theme-api/protocol-migration-stage1-20261123/evidence/upstream/monitor-04a6fa1/`，同目录保留固定 commit 的下载 ZIP、provenance 和文件清单。原 sibling `../monitor` 保持 1.5.1 `b41249ca72e69cd4c1844a1babf7530ae257bfbe`；先前三份摘录不代替完整参考。

机器输入是 `test/fixtures/monitor-protocol/standard.json`、`extensions.json`、`permissions.json`。每个方法列发送/接收角色、报文种类、字节上限、schema、示例原文和源码位置。标准 `paramsSchema` 是正常可互通发送形状，`receiverParamsSchema` 是实际解析形状；`trafficReading/ingestionSchema/afterParse` 分别描述入账、接收有效结果和任务裁剪/间隔钳制。`definitions` 使用 JSON Schema 的基本类型/对象/数组/$ref；`unit`、`meaning`、`maximumDecimal` 是语义注释，状态性约束仍须实现者按本文验证。大整数示例是 JSON **原文字符串**，不要普通 `JSON.parse` 后重新序列化它们。

三条边界独立：

1. **Agent WSS**：`/api/agent/ws`、Bearer 节点 token、JSON-RPC 2.0。
2. **浏览器 REST/WS**：公共状态、history、后台管理保持 HTTP/浏览器合同，不改成 Agent RPC。
3. **主题包/资源**：manifest、原包、revision、preview、资源 URL/CAS，继续复用 D1 installer。

UUID、`history_partition_id` 和稳定 public numeric node ID 各保留原义。`monitor_compat_ids` 已持久保留删除 ID；task numeric ID 后续映射到不可变 `metric_id`，不能把现有 hash 映射升级成永久主键。

## 2. 四个标准方法按原义接收

所有标准报文是 UTF-8 文本通知：`{"jsonrpc":"2.0","method":"…","params":…}`；无 `id`、无 `result`、无逐帧 ACK，也无 CF 必需字段。H 的 Rust `Rpc` 实际只反序列化 `method:String` 和 `params:Value`（缺省 null），不检查 `jsonrpc/id`，未知通知被忽略。目标 codec 校验 2.0 envelope；不把上游这种宽松解析描述成严格 schema，也不让它扩大权限。见 H `agent_ws.rs:324–353,568–620`、O `main.rs:127–145`。

| 方法 | 方向/形状 | 原版行为 |
|---|---|---|
| `hello` | Agent→hub，对象 | 连接后立即发送；事实变化时再发送。首 hello 附带三项容量兼容旧 hub，后续事实 hello 不附带。H 最快每30秒写事实，过密的最新 hello 暂存到心跳。 |
| `report` | Agent→hub，对象 | 当前数值和可比较的内核计数器；无采样时间/seq/ACK。H 用接收时间、单调间隔、会话形成分钟历史。距上个 report <500ms 丢弃。 |
| `ping.result` | Agent→hub，对象 | `task_id`、`latency_ms`，一次真实完成结果；无时间/ACK。负延迟表示失败，原 Agent 发 `-1`。缺少/null 延迟不计为丢包。 |
| `ping.tasks` | hub→Agent，**整个数组** | `{id,target,interval}` 列表替换；不是 `{tasks:[]}`。原 Agent 最大64任务，interval 5–3600秒；CF 超64另走扩展。 |

握手不等旧 `type:hello/protocol:update`；hub 可以先发 `ping.tasks`。H 30秒 WebSocket ping、120秒静默断开；O 文本帧中的未知方法只更新存活时间，不执行 CF 功能。可选 `/api/agent/echo` 只记录另一地址族出口，不替换监控会话。见 H `main.rs:714–716`、`agent_ws.rs:25–43,397–498`；O `main.rs:337–410`。

O CLI 的 report 默认1秒、钳制1–3600秒；显式`--insecure`可允许原hub plain WS。CF目标继续HTTPS/WSS，记录该上游选择不代表迁移获准弱化鉴权/自动降TLS。fixtures另列实际Rust emitter类型（u32/u64/f32/i64/i32）及完整整数范围；目标可用counter限定到hub非负i64。

### hello：完整发送字段和接收宽容性不同

O 每次发 `hostname, os, kernel, arch, virt, cpu_name, cpu_cores, agent_version, ipv4, ipv6`。除 `cpu_cores` 为整数核数外均为字符串；无地址/未知事实为空字符串，不是伪造地址。首包还可有 `mem_total, swap_total, disk_total`（字节）。

H `db.rs:1377–1414` 对文本缺失/非字符串读为空，经 `reported_text` 去控制字符并截到128字符，`cpu_cores` 读 i64，缺失读0；**1.5.2 不从 hello 持久化三项容量**，容量来自 report/touch_seen。机器 schema 给出正常发送形状，不声称上游拒绝每种不正常 hello。O `collect.rs:101–115`、`main.rs:341–345,374–375`。

### report：字段、单位与未知值

| 字段 | 正常发送类型/单位 | 缺失/null 的实际接收 |
|---|---|---|
| `boot_id` | 非空字符串，kernel boot + 计入网卡集合 epoch | 缺失/空/非字符串不能形成可比较 traffic reading；上游不因它单独拒绝整帧 |
| `iface` | 字符串，实际过滤配置，空为默认 | 非公共指标验证字段；旧 Agent 可缺失 |
| `uptime` | 整数秒 | 缺失容忍；0不能证明重启时刻 |
| `cpu` | 非负数，百分比 | 缺失容忍；有值必须非负有限数，null拒绝 |
| `load` | 三个非负数，1/5/15分钟 load | 缺失容忍；null/非三项数组拒绝 |
| `mem_total,mem_used,swap_total,swap_used,disk_total,disk_used` | 整数字节 | 缺失容忍；正常 emitter 不发 null；有值按非负数验证 |
| `net_rx_total,net_tx_total` | 非负整数**数值词元**，内核累计字节 | 缺失不重置基线；null/string/negative 拒绝；浮点或超过 signed i64 不能记流量 |
| `net_rx,net_tx` | 整数字节/秒 | 实时单调间隔速率；缺失容忍，null拒绝 |
| `tcp,udp,procs` | 整数连接/套接字/进程数 | 缺失容忍，null拒绝 |

O 正常发所有上述字段（`collect.rs:117–149`）。H 允许旧 report 缺少任意已知字段、首 report 仅告警；已出现字段的数值验证见 `agent_ws.rs:740–777,861–894`。除 counter 外上游接收端也允许非负小数，即使 emitter 通常发整数；fixtures 的 integer 描述正常跨端形状，`upstreamReceive` 描述实际宽容性。公共 `total_rx,total_tx,month_rx,month_tx` 是 hub 注入的账本值，不是 Agent 必需字段；GPU/diskIO 也不属于标准 report。

### counter 与上游统计的细节不能丢

- 目标内部保留十进制原词元→BigInt/i64，范围 `[0,9223372036854775807]`；对外仍 JSON number。`9007199254740993` 示例不得经 JS Number 截断。复用已验证 Workers `context.source`/`JSON.rawJSON` 与 D1 `CAST` 路线，S1 不重跑精度探针。
- H 接收无 epoch/不成对/不可读 counter 不触动基线；常规初次/epoch变化/下降重新定基线。**上游另有未观测重启例外**：kernel 部分变化、booted（接收时间−正 uptime）晚于该 token 的 last_seen 时，记入新 boot 的 counter 全量，旧 boot 最后未观测字节仍丢失。不要把“任何 epoch 变化都加全量”或“上游任何变化都只归零”写成原义。见 H `db.rs:1595–1638`。
- H 按节点而非每会话持有最新 reading，约分钟提交；断段两端和关机/结束 flush；跨分钟提交 held reading 按其自己的接收日归属，避免午夜前字节全记到新日。calendar day/reset-day 是 hub 本地时区；总/月/日加法饱和到 i64 MAX。见 `agent_ws.rs:778–859`、`db.rs:1639–1691`。新 CF 样本使用可信采样时间；标准-only 使用接收时间，不借此伪称 exact-once。
- H 分钟保留 CPU/内存/swap/disk/tcp/udp/procs 的样本均值；CPU/net速率另有 max。网络均值从同 epoch counter差÷单调间隔导出；load仅实时。分钟跨界到达的 report 也进入结束窗口，之后清空；新会话不覆盖打开会话所在分钟。见 `agent_ws.rs:153–233,910–947`。
- H `ping.result` 接收 task_id>0 和整数延迟，任何负数记loss，DB只写真实分配任务。每5秒最多128结果；同次接收秒内同任务结果向前错开至少1秒，避免 `(node,ts,task)` 覆盖。标准没有采样时间；CF扩展不采用这种人为错开。见 `agent_ws.rs:298–318,607–616`、`db.rs:2312–2325`。
- O TCP探测最多试3个解析地址、单次握手900ms。DNS解析超时返回None、不发送样本；确定解析失败/连接未答发-1。CF当前1500ms单IP算法不能代替它后仍称相同口径。见 O `main.rs:622–686`。

## 3. CF v1 方法、结果与限额

`params.version=1` 是新合同版本，与 legacy schema10 无关。所有 CF 对象默认拒绝未知字段。RPC 请求必须有非null字符串/安全整数 id，响应只能含同 id 的 result 或 error；通知无响应。监控通道未知有 id 方法 `-32601`，无 id 未知通知忽略；私有终端未知/错角色/畸形控制仍按现有validator/broker关闭相应control/session，不向通知返回RPC错误。错误只返回安全 code/message，不回显原 payload/凭据。

| 方法 | 发→收 / 种类 | params / 成功 result |
|---|---|---|
| `cf.capabilities` | Agent→hub，请求 | `{version,supports:[{method,version}]}`；result `{version,accepted,limits,fallbackPath}`。只能精确交集、无通配，3秒未答继续标准。 |
| `cf.report.batch` | Agent→hub，请求 | `{version,stream,sequence,samples,probes,clock}`；result `{version,stream,accepted:{from,to},durableThrough}`，只在持久接收后。 |
| `cf.reporting.configure` | hub→Agent，请求 | `{version,revision,persistent,transient?,trafficCorrection?}`；result `{version,revision,persisted,correctionApplied}`。validated persistent 写盘后才报true。 |
| `cf.ping.tasks` | hub→Agent，请求 | `{version,revision,tasks:[{taskId,metricId,target,intervalSeconds,mode}]}`；result `{version,revision,persisted,taskCount}`。整表替换，不静默截断。 |
| `cf.ssh.events` | Agent→hub，请求 | 保持 `{version,stream,events,state,source}`；result `{version,stream,sequence}` 是独立 SSH durable高水位。 |
| `cf.terminal.*` | 私有角色，通知 | 下一节具体14种操作；ready/disabled/credit是业务状态，不是标准 report 或通用 RPC耐久 ACK。 |

上限按整个 UTF-8 JSON 文本（含 envelope）计算：标准/capabilities/SSH64KiB，CF batch512KiB且最多300资源样本，配置/任务64KiB，SSH32事件，terminal control4KiB、binary16KiB、每方向credit256KiB。probe数量不硬砍64，而受512KiB总报文约束。taskCount不得越过现有配置字节边界。过大报文显式失败，不丢尾部或成功 ACK未接收数据。

**旧配置实际边界差异**：C `extra_ping.go:16–17` 中任务原始 JSON 为65536字节，而 `maxRemoteConfigBytes=4*65536+2048=264192`；后者容纳 URL percent encoding 和外围 legacy字段。W `utils/agentConfig.js` 未声明所有旧响应只有64KiB。新 JSON 扩展请求各限64KiB，任务与reporting分开；旧接口保留原限制，不能把新限制强加给旧响应。显式变化由 Task3/6 测64KiB任务、编码膨胀和新增numeric mapping大小；不再能容纳的实际配置须返回具体大小，不静默删任务。

### reporting、样本和额外采集值

`persistent` 完整字段：`collectIntervalSeconds`（0/1/2/5/10）、`batchIntervalSeconds`（30/60/120/180）、`activeReportIntervalSeconds`（1–5）、`resetDay`（0–31）、`interface`、`connectionMode`（auto/http）、`sshLoginEnabled`、`userAgent`（沿现有安全验证，100字符上限）。revision沿现有config MD5身份，非授权凭据。`transient` 可含 active/reportAfterMs/idleBatchIntervalSeconds/expiresAt；到期恢复持久策略，不写本地持久值；空闲批至少60秒。新默认采样2秒、batch60秒；显式 collect0 保留“关闭历史样本”的旧用户选择，不能作为省钱默认。

`trafficCorrection` 只执行现有 rxGB/txGB 有界修正（最多1000000GB），确认实际成功；Task4 将该行为接到同一权威账本。本地 `TerminalEnabled/AutoUpdate/UpdateProxy/token` 不进入远程配置。现有 `update` 标志不扩成任意命令；自动更新继续使用本地策略和经过校验的官方发行渠道。

资源 `sample={sampledAt,elapsedMs,report,extra}`：sampledAt Unix ms；elapsedMs是真实单调采样间隔，>0；report 为标准数值字段的可用子集，采集失败省略该字段，不能伪0。extra可含：

- `diskIO={read_bps,write_bps,read_iops,write_iops,await_ms,util}`：B/s、ops/s、ms、0–100%。无法测量为 null，而不是零磁盘活动。
- `gpu=[{name,info,id,mem_used?,mem_total?,sm_clock?,power?}]`：利用率%、MiB、MHz、W；缺测字段 null/省略，整个未可用GPU为null。GPU的原MiB口径不冒充精确字节。

probe保留每次实际结果 `{taskId,metricId,sampledAt,latencyMs}`，整数ms或-1；不是rolling median/loss摘要。taskId持久numeric映射，metricId使用当前 `p_*` 不可变generation；接收者验证该节点、任务generation和采样时的分配，不凭字符串任意写入。CF协商的任务列表只执行一次，标准列表不得再执行同任务。

clock保留当前六字段 `local_ts,accurate_ts,offset_ms,source,round_trip_ms,sample_age_ms`；后五项未校时可null，source目前只有date。时间校正及boot metadata在冻结前做，重试不改时间。无可信校时的范围保持明确来源；不能用接收时间覆盖后伪称真实采样时间。

### 一批的 ACK 有严格范围；fallback不是第二次采样

1. 新stream的sequence从1开始，是**整批编号**，不是样本/探测编号。scope是 `(serverId,tokenVersion,stream)`；同stream递增，重连不重置。所有params（包括clock/timestamps）第一次尝试前冻结为字节相同内容。
2. 只接受 `durableThrough+1` 或已耐久的字节相同重放；跳号返回expectedSequence，已有sequence但内容不同报冲突。不得last-write-wins。当前节点写lease拥有者提交新stream的seq1构成显式admission，必须耐久保存stream切换及旧receipt的重放范围；Agent不得在旧冻结批尚未durable ACK时换stream，重启需加载原stream/待发送队列，不能从1重编号。旧已耐久重放只返回该scope ACK，不夺回新会话所有权；token变化仍拒旧token。
3. result `accepted.from=accepted.to=此次请求sequence`；`durableThrough=N` 证明1..N整批均耐久，不是“本次最大看到的seq”。Agent只清理匹配scope、<=durableThrough且已实际offered的冻结批。每次真实采样/探测仅分配给一个批次，接收保留原批内顺序；重复投递不会制造新sample身份。
4. receipt、样本/probe/流量作用及高水位须原子或可恢复；先内存/先WS发送/部分落盘都不能成功 ACK。第8节选择 D1 同一事务保存时间桶和节点状态；已ACK重建不重记和原probe分布可查是共同验收，产品由 Task4 实现。
5. WSS不确定送达后，HTTP `POST /api/agent/cf-report` 携带同batch params、同Bearer/节点所有权，仅RPC id可随新请求关联改变。只在明确CF origin及协商/配置允许时启用；HTTPS同origin、禁止跨origin重定向，不回旧`/update`、不弱化鉴权。
6. CF标准实时report约2秒只更新latest/从已提交流量基线投影，不再叠加同批历史、probe分母、流量。约60秒冻结批是历史输入；标准-only Agent仍按上游会话/接收时间聚合。这是一个核心的两个入口，不是两套账本。

没有上游CF能力时：正常监控与标准TCP任务继续；ICMP、>64配置、SSH、PTY、HTTPfallback/远程降频显示不可用，本地配置保留。能力缺失不能静默切弱鉴权或把ICMP称作TCP。

## 4. 终端是原控制模型迁移，不是任意命令框架

TerminalBroker仍拥有私有数据和credit。params只把原 `type` 替换为method，并加 `version:1`；保留原 camelCase字段及 `protocol:1`。private session attachment给出session/role，不接受另传sessionId来路由输入。fixtures记录 `legacyTerminalType`，小回归将每个示例转换后交给**现有真实** `parseTerminalControl` 校验。

私有 `cf.terminal.hello(version1,protocol1,本地capabilities)` → `cf.terminal.bound(version1,当前绑定)` 自行完成终端v1协商；这两条bootstrap不要求此前有监控WSS或`cf.capabilities`成功。当前HTTP上报/监控WSS时段关闭时，独立终端控制仍应可用。PTY能力组对应open/close/start/ready/resize/credit/exit/error/ping/pong；可选`terminal.disable.v1`再允许disable/disabled。监控capability表是能力元数据，不授权限，也不成为旧HTTP/独立终端的新增前置条件。

| 方法 | 发送角色→接收角色 | 除version外的精确字段 |
|---|---|---|
| `cf.terminal.hello` | agent-control→broker-control | protocol,platform=`linux`,capabilities（PTY第一项、可选disable第二项） |
| `cf.terminal.bound` | broker-control→agent-control | serverId,connectionId,generation,credentialVersion |
| `cf.terminal.open` | broker-control→agent-control | protocol,sessionId,ticket,cols,rows |
| `cf.terminal.close` | broker-control→agent-control | sessionId,reason |
| `cf.terminal.disable` | broker-control→agent-control | operationId,serverId,connectionId,generation,credentialVersion |
| `cf.terminal.disabled` | agent-control→broker-control | 同disable；仅在本地配置写false、所有factory和PTY清理后 |
| `cf.terminal.start` | broker→agent | cols,rows；双端到齐并通过admission后才创建PTY |
| `cf.terminal.ready` | agent→broker→browser | 无其它字段 |
| `cf.terminal.resize` | browser→broker→agent | cols,rows（各1–500） |
| `cf.terminal.credit` | browser/agent→broker→另一端 | bytes（累计已消费，0..MAX_SAFE_INTEGER），映射旧ack |
| `cf.terminal.exit` | agent→broker→browser | code（-1..255） |
| `cf.terminal.error` | agent→broker→browser | code（安全错误码正则） |
| `cf.terminal.ping/pong` | 相应私有控制/会话双端 | 无其它字段 |

ready/resize/exit等多接收角色是上述定向链路，**不是发送/接收集合的任意笛卡尔积**。控制通道与会话通道不能串用。同一frame携带任意`command/exec/env/path`或extra property都拒绝。

保留：最多4会话、start/credit stall30秒、用户idle30分钟、admin auth lease60秒及JWT到期截断、disable等待5秒。credit累计值必须单调、<=实际forwarded，差额<=262144，分方向校验；不允许“信用ACK=数据已永久保存”。

管理员仍通过既有REST action（read/enable/prepare install、revoke、status、open、renew、close）发起，由业务服务产生broker通知；Agent不能调用admin入口。浏览器要求HTTPS精确Origin、Cookie、禁用Authorization Bearer，owner jti/撤销表、站点权限、匹配credential_version、本地consent和单次Agent ticket。票据只在私有控制/Agent session header，存hash、单次使用；节点token仅header。Node token_version、credential_version、generation、本地A-B-A重装、站点关闭/退出/超时各能关闭旧PTY或禁止新admission。

disable期间服务端已撤销credentials，但captured旧控制仍可返回**精确匹配pending operation及绑定**的disabled确认；不能用“必须当前enabled”规则误拒该确认，也不能让它重开session。未完成清理/超时必须localConfirmed=false。见 W `TerminalBroker.js:421–479`、C `terminal_control.go:229–286`。

## 5. CF保留清单：当前实现 → 目标位置 → 后续验收

下表的“当前”全部依据实际源码；“目标”是后续任务工作区，不意味着已实现。`Tn` 对应批准计划Task n。

| 能力 | 当前实现/证据 | 目标保留位置 | 后续决定性验收 |
|---|---|---|---|
| Linux CPU/内存/磁盘/OS/连接数 | C `metrics_linux.go:21–104,284–429`，common:64–124；/proc、statfs、挂载/overlay去重；容量先截MiB | 同平台collector + T3 NativeSample；标准facts/report | 与原始bytes实测，不能MiB乘回；保留overlay/block dedup |
| Windows采集/OS版本/架构 | C `metrics_windows.go:16–104,124–242`、arch_windows；swap和load当前为0 | 平台collector保持原数据，新字段区分unsupported | T3三平台测试；Windows不把无load/swap读数称可测0 |
| macOS/FreeBSD采集 | C `metrics_darwin.go:23–65,308–451`、freebsd:20–93；top/PS/sysctl/gopsutil | 同collector及标准facts/report | T3三平台/已支持目标；未知字段保持来源/状态 |
| GPU详细值和fallback | C `metrics_common.go:19–25,199–265` nvidia/ROCm；darwin:150–168 IOReg；windows_gpu DXGI/engine；freebsd:228–250 pciconf | `cf.report.batch.sample.extra.gpu`，CF后台 | T3/6保留name/id/util/MiB/clock/power；ROCm/名称fallback当前info=0须标为缺测而非真idle |
| Linux磁盘IO | C `metrics_linux.go:428–490`目标设备Fingerprint；common:299–349差量/await/util | extra.diskIO，单调间隔/设备epoch仍在collector | T3设备变化/下降/首次不造峰；diskIO按既有totalOps和设备平均util口径 |
| 非Linux磁盘IO缺口 | C Windows:99、Darwin:347、FreeBSD:89均返回空counter→legacy全0 | extra.diskIO=null，保留unsupported语义 | T3/6界面不称0活动或新增未实现平台采集 |
| NIC计数和过滤 | C Linux:104–144/common:130–157：先排除虚拟前缀，再名单/glob；Windows:66–97默认所有adapter；Darwin:308–345默认排lo0/utun/awdl；FreeBSD:67–87 | T3原始counter+所计入接口集合；旧配置解释保留 | 显式接口、无匹配、采集失败、加入/离开集合、重启、counter下降；O显式接口可覆默认排除，不能静默改旧CF接口语义 |
| 网络epoch/速率缺口 | C `agent.go:652–675`仅保存数值和prevTime；接口字符串变时reset，当前无可信boot+集合epoch | NativeSample标准boot_id+单调采样间隔，T4统一流量 | 接口集不变配置却变化不加历史总量；失败当前缓存counter/速率0不得继续伪测 |
| 月流量与修正 | C `traffic.go:11–179` RX/TX_PERIOD、本地reset0/1–31、接口字符串分段、修正文件 | T4同节点权威账本；known legacy month baseline+来源；configure/管理修正接同核心 | 重启/跨reset/时区/断网/修正后晚批次；旧本地月值不称原hub lifetime/day |
| fixed slots和额外探测 | C `agent.go:90–97,1079–1166` 8slots20s、extra；`extra_ping.go`；每次measureProbe count1 | cf.ping.tasks原metric generation；CF展示legacy来源 | T3/4迁移slots/自定义targets，不重复执行/计数 |
| TCP/ICMP及不同探测口径 | C `probe.go:19–25,108–131,235–295` CF TCP timeout1500ms/default80、ICMP；另measurePingWithRetries含HTTP但当前report网络worker不调用 | cfTask mode tcp/icmp保留CF；标准-only按O TCP（<=900ms deadline/多地址） | T3/6各模式实测；不能把两个TCP算法假称相同，HTTP helper不作为已在报表提供的功能 |
| 超64任务/每任务间隔 | C `latency_tasks.go:12–79` 5–3600秒单网络worker；JSON64KiB无count cap | cf.ping.tasks byte界限无64全局cap | T3/6 65+真实任务、busy worker、overflow明确反馈；标准Agent仍64 |
| 任务CAS、generation、auto_join、排序/归档 | W `database/latencyTasks.js:112–189`编辑target新metric_id、CAS合并、归档；shared/latencyTasks | 原文档保持；T2持久numeric task map；T4历史查generation | 同名改target不串历史；删除重建/并发ID、不复用已删除ID |
| probe摘要不能逆变原始 | C `agent.go:152–198`最近6个的median/loss、2分钟筛RTT；latency_tasks:65–70重复snapshot | T3每个真实结果先保存/冻结；T4原分母分布 | 同摘要重复传不增长count；legacy区间保留原摘要，不假造原始结果或平均loss百分比 |
| sample/send/full频率独立 | C `agent.go:313–354,539–619`GCD调度、full stats到ReportInterval刷新、轻量刷新及sample缓存 | 同loop/collector拆NativeSample，batch60/live2 | T3采样继续独立，峰值/均值输入完整；重型GPU/diskIO当前低频口径须如实注明 |
| legacy失败丢样是实际差异 | C `agent.go:678–704`每次attempt清样、300样本尾部覆盖；熔断539–547停止采样并清缓冲 | 新冻结批retain/retry，标准实时无需durable ACK | T3/4失败/重连/fallback不改批；容量耗尽显式gap，不永久假称无损；legacy区间仍可能有缺口 |
| active/idle/schedule降频 | W `MetricsBroadcaster.js:1387–1458`访客hint、settings时段；C `report_transport.go:154–186`hint | cf.reporting.configure transient；T7可休眠会话 | idle仍采样且batch>=60s；hint不误当ACK清队列；legacy混跑休眠受限 |
| WSS/HTTPfallback、重试/熔断 | C `report_transport.go:253–401,668–807`旧hello、协议delay；`agent.go:817–861,439–479`同bodyPOST，4xx退避2/3/5/7/10min | T3标准握手和同cf batch fallback；旧/update不改 | 原hub不等hello、3秒cap超时；401/403/404不弱化鉴权；新批次双通道去重 |
| clock校准和boot时间 | C `clock.go:11–140`Date+RTT/2/单调anchor/24h有效；agent:989–1033校正，开机未校时null | batch.clock和T3冻结前边界转换；T4区分采样/接收 | 断网重试、clock step、过期校准、未校准不造accurate时间 |
| dynamic config/UA | W `utils/agentConfig.js`schema3..10、MD5、UA独立；C `agent.go:1042–1070,1198–1400`allowed键/私有写盘 | configure v1及cf task拆分；local-only字段原样 | T3/6持久配置、hint到期、MD5同值不乱写；旧URL编码总界限保留 |
| SSH来源/队列状态 | C `ssh_events.go:23–279,501–597`1024私有队列、offer≤32、状态/游标/gap；linux journal/auth.log/secure，非Linuxunsupported | cf.ssh.events原version1/stream/seq，独立私有入口 | T6rotate/truncate/queue_full/state_error，保存失败不消队列，未支持平台显示真实状态 |
| SSH耐久ACK/通知policy | W `services/loginEvents.js:114–139`cursor+outbox DB batch；flush140+ policy invalidations/uncertain不重发 | 同service和D1现有表、cf SSH response | T6重复/eviction/撤销、recipient policy变化；ACK不称通知已送达 |
| PTY本地consent/能力 | C `terminal_control.go:36–56,143–286`本地TerminalEnabled、A-B-A阻断；terminal_capability_linux安全pidfd/poller前置检查 | TerminalBroker私有通道及具体cf通知 | T6无本地开关不启动；不支持platform/kernel不冒capability；site开关不远程授本地同意 |
| PTY创建/清理/环境隔离 | C `terminal_linux.go:34–90,233+`bash --noprofile/--norc或sh、HOME/用户、固定安全环境、pidfd清理；session.go限流/timeout | 原factory/manager/私有binary，不能新exec框架 | T6admission取消、child/factory清理、token不进shell env/output；credit/resize/exit正确 |
| terminal revoke/ticket/lease/Origin | W `handlers/terminal.js:70–188`；Broker231–613；sharedProtocol；C terminal_control247–286 | 同权限服务、Broker和私有control；cf.disabled精确绑定 | T6logout/site-off/token rotate/credential disable、旧close不伤新control、单次ticket、owner renew拒绝 |
| 节点凭据/认证lease | W `nodeCredentials.js:9–116`绑定ciphertext/hash、token_version/credential_version分离；nodeAuth全文件；DO847–989独立lease | T2标准和legacy共用nodeAuth/会话写所有权，不重新颁发 | 正确token无需CF字段，匿名/错误token拒绝，旧lease/old close不能覆盖新owner |
| public node ID和history分区 | W monitorCompatIds全文件 AUTOINCREMENT/no cascade；indexOptimization分区 | 同ID表/UUID/partition；numeric task map另建 | T2并发稳定、删除ID不复用，不用partition当node ID |
| 历史聚合/缓存消费者 | W update:238–339；historyFields:51–67；DO1461–1551当前max速率等并非标准mean；CompatSnapshot:95–147用CFMiB/raw totals | T4一套统计/历史、T5投影；旧来源覆盖单独保留 | 加权小时/mean+max、真实覆盖、缓存latest/告警读同核心；旧max不改称mean |
| traffic/resource/offline告警与续费 | W notification:683–766、1082/1131/1348+；serverBilling自动续费/CAS；规则路由/policy去重 | 同notification services，T4换权威月流量/online输入 | T4/6 rollover/correction阈值、恢复/周期新通知、auto-renew CAS、不多发 |
| 注册/自动发现 | W handlers/agentRegistration；C node_registration和Run201+ token-only入口、自动发现测试 | T2/3 Content-Type明确分派plain-text标准与旧JSON；同UUID/token | 幂等/TTL/单次register key、无共享secret回退，不猜body或失败换鉴权 |
| 安装/服务/私有配置 | C install.go:12–104,393–742：stageConfig先于停止服务、user/system/systemd/OpenRC/procd/launchd/Windows任务、旧traffic迁移；install.sh umask077 | T3加显式monitor参数，旧WorkerURL/CLI不换义；沿原installer | 多平台旧参数/安全权限/重装保本地字段；单实例锁；标准--server/token/interval/iface入口 |
| 旧站点installer现状 | W public/install.sh:1–16已retired reporting、保留清理；Go sibling installer和后台下载是维护入口 | §9推荐独立新标准installer；保留旧安装/清理用途 | T3/5不把retired脚本宣称可monitor；不静默覆盖旧/install.sh |
| 自动更新/发行可信性 | C update.go:60–103,375–406及scheduler：版本选择、checksums必需、平台/user-mode；Agent loop仅AutoUpdate开启才启动 | 原updater/本地AutoUpdate/UpdateProxy，T3新模式配置兼容 | T3/8 SHA校验失败不安装、旧模式不强切、macOS支持边界、Worker/Agent各自恢复；S1不发布 |
| 备份和导入 | W admin:1490–1650/backup.js：服务器/可导入settings、latency来源、主题registry；默认不带notification secrets，显式敏感导出可带；不带terminal credentials/local观察 | 同CF管理备份+D1运维恢复；T4备份需覆盖新持久ID/账本接续事实 | T4/6默认排secret、不revive已撤销token、同ID/history语义；不是SQLite文件互导或已备份原始历史 |
| 主题包/preview/图标/已接受UI | W monitorThemePackages/Repository/Themes；monitorCompat:23–39保留路由；monitorViewerAccess和前端已接受UI | T5同D1原包/CAS/preview/权限，无第二生态/新installer | 原包配置/资源/分片上传/删除更新实测；保留旗帜OS/group/手机单行，别借协议改整个页面 |
| 站点隐私/Turnstile/后台session | W middleware/auth:108–166七天JWT和terminal撤销；admin login/monitorViewerAccess | 原CF安全权限服务，T5REST映射 | 不改成原hub14天session；public/preview不读私有完整地址/hidden/SSH/terminal |

## 6. 不能还原的数据保留原含义

旧内存/磁盘整数MiB无法还原丢掉的字节；旧rolling probe摘要无法还原每轮分母/顺序/分布；旧CF总流量是kernel以来counter或本地月周期值，不是跨boot lifetime账本；未上报的boot/NIC集合不能补造可信epoch；失败丢样/熔断期间实际无资源采样；非LinuxdiskIO/部分GPU fallback的0不能证明idle。

迁移每节点写账本激活时间、来源、实际历史覆盖。保留可证实月baseline及旧历史语义，从新NativeSample建立准确日/月/total、mean/max和真实probe分母。旧数据不改写成虚构精确窗口。当前CompatSnapshot把原始kernel counter投为total、MiB乘回bytes，T4/5须替换对应输入而非把旧输出当标准同义证据。

## 7. 平台差异和后续消费接口

按已批准§9推荐默认：保留CF登录/Turnstile/访问权、CF管理备份和D1运维恢复、实际历史覆盖、独立新installer。原SQLite文件backup/restore/vacuum互导、原密码登录重做及14天session、匿名365天容量权限、原安装同路径终态只阻止其对应操作，不阻止codec/标准Agent。不要返回“成功的空vacuum”或把JSON备份称SQLite文件。

- **S2** 已完成同输入真实 D1/DO SQL 比较、原子失败/同库重启/重放和 raw 分布回归；选择 D1 节点时间桶，具体接收单位、参数和消费边界见第8节。
- **T2** `parseAgentRpc(raw)`、node-auth upgrade、MonitorAgentSession、getMonitorProbeIds；标准报文缺CF字段仍可用，精确counter词元/稳定ID和单owner代际。
- **T3** NativeSample/monitor encoder、采样发送拆分、能力超时、冻结batch与fallback；旧CLI/config默认legacy。按清单处理平台未知/数据精度，不能直接重包legacyMetrics。
- **T4** 一套权威资源/流量/probe核心、旧baseline接续/coverage和cache消费者；存储使用S2决定，不另建第二账本。
- **T5/6** REST/主题原包链路与显式CF控制；TerminalBroker仍为私有数据所有者。权限fixture的role来自可信连接上下文；capability不授予任何admin/terminal权限。

合同小回归验证fixtures的一致性、正常/反例schema、角色、原terminal/SSH真实验证器与冻结重放原词元；S2另有真实隔离存储和预算回归。产品codec/网络互通、UI、Go三平台、云端CPU/duration/账单分别属于后续任务的验收。

## 8. S2 决定：D1 节点时间桶是唯一耐久权威

选择 **D1 节点时间桶＋节点状态的同一原子 batch**；现有 global DO 继续协调连接和唯一写入所有者，不另外维护权威指标 journal。对比候选是本地 SQLite-backed DO SQL journal＋D1 查询物化，不是第二个统计账本。

源码核对发现：W `MetricsBroadcaster.js:289–319,1461–1551` 目前在内存维护历史聚合、周期调用 D1；resource-alert 和 panel-login 使用 DO KV，**尚无指标 SQL journal**。`wrangler.toml` 已有 `new_sqlite_classes=["MetricsBroadcaster"]`。S2 在临时 Worker/DO 内实现该 SQL 候选，不改真实 class、namespace、migration、生产路由或现有历史。`scripts/probe-monitor-storage.mjs` 是实验入口，不是 Task4 产品存储模块。

### 8.1 同输入与恢复证据

每条路径使用同一组冻结 `cf.report.batch` params 原文：20节点和100节点各10分钟虚拟采样时间轴，2秒采样、每分钟30资源样本和4个模拟探测结果。运行真实数据库操作，不等待10分钟或冒充真实硬件采集。探测包含变化的整数延迟和-1；每次保存 taskId、metricId generation、采样ms和原始顺序。没有空 BLOB、假 SQL 结果或 rolling 摘要代替原始结果。

| 有限运行 | 20节点 × 10分钟 | 100节点 × 10分钟 |
|---|---:|---:|
| 冻结批次数 | 200 | 1000 |
| 资源样本 / probe结果 | 6000 / 800 | 30000 / 4000 |
| 未压缩 params 总字节 | 2,997,133 | 14,996,662 |
| 单批最大字节 | 15,032 | 15,060 |
| D1桶＋节点状态逻辑字节 | 327,207 | 1,636,032 |
| D1-only ingest 读 / 写行 | 800 / 400 | 4000 / 2000 |
| journal路径 D1 ingest 读 / 写行 | 120 / 80 | 600 / 400 |
| journal路径 DO SQL ingest cursor读 / 写 | 996 / 640 | 4996 / 3200 |
| D1过期桶清理读 / 写行 | 59 / 40 | 299 / 200 |
| journal原始行清理 cursor读 / 写 | 219 / 200 | 1099 / 1000 |

实际保存的是非空 gzip BLOB：五分钟内的整批原文有界打包，仍能逐字恢复 params、资源和完整 probe 分布；D1 节点状态保存流量基线、累计增量、样本count/sum/max/覆盖时间、probe分母/失败数/延迟sum/max和连续高水位。每分钟仍有两行写入，不把 gzip 或 batch API 当成免写行。D1 时间桶和状态都是 `INTEGER PRIMARY KEY`，无需额外二级索引；实际 `EXPLAIN QUERY PLAN` 证实范围查找使用 INTEGER PRIMARY KEY。DO journal 的 `(node,seq)` 索引及 checkpoint marker 成本由真实 cursor 记录。

两种路径都实际验证：提交前失败无ACK；原子事务中约束失败全部回滚；提交成功但响应丢失后 dispose/recreate Miniflare，使用相同 `resourcePersistencePath` 的原数据库重建；重放已ACK stream/seq不再增加流量、资源或probe；不同原文冲突和跳号失败；同一数据可恢复全部raw probe。20节点中node1的独立核对值为300样本、600000ms覆盖、RX增量299299字节、TX149799字节、40 probe和4超时。

直接D1路径另覆盖**已经观察到成功ACK之后**的恢复：全部共同输入提交并观察到最后批的匹配stream/range/through ACK后，先累加当前实例计量，再dispose并从相同持久目录重建；完整节点状态（每节点through=10）和完整raw snapshot逐项相等。随后重放该已ACK最后批，ACK相同、完整snapshot仍相同，额外重放D1写为0。报告字段为 `acknowledgedRecovery` 和 `checks.acknowledgedRestartReplayNoSecondBooking`；恢复查询/重放分别归 `acknowledgedResume` / `acknowledgedReplay`，不混入共同ingest/空间或日预算投影。

journal还实际验证：journal已提交、D1尚无该批时可重放；另加node1五分钟尾部单独制造“D1 checkpoint已提交、DO marker尚未提交”的崩溃，再重建同库重放。绝对状态快照和同批身份的物化upsert避免第二次加法。该尾部计量归 `recoveryBoundary`，不混进共同10分钟输入的 ingest/空间/日预算。

计量JSON完整列出 D1 `meta.rows_read/rows_written`、SQL cursor `rowsRead/rowsWritten`、schema/replay/resume/query/range/index/cleanup及失败类别。D1失败 batch 不返回 meta，报告不把其不可观察的云计费记成0；DO回滚内部的 cursor 计数是失败尝试，单列而不当成已提交事实。跨重启保留每个实例的计量后相加，不丢掉第一次耐久写入。

### 8.2 单一原子接收单位与下游约束

Task4 的 D1 接收单位必须包含：

1. 已认证 `(serverId,tokenVersion,stream,sequence)` 的完整 receipt/原文定位及桶内容。
2. 同一批产生的资源/probe事实、流量基线和累计作用、连续 high-water；两行由同一 `db.batch` 原子提交，成功后才产生 ACK。
3. 所有状态恢复从这份 D1 权威读取。重放只验证原文并返回现有高水位，不重新 reduce、不夺回当前会话写lease；HTTPfallback和WSS进入同一单位。

节点时间桶是查询容器，不是“最大seq就是已接收”。本地有界场景用独立实验整数node ordinal和固定分钟/seq关系构造五分钟时间键；Task2/4须使用真实稳定身份、持久scope/receipt定位、任意延迟批和多个stream的定位，不能把实验ordinal替换现有UUID/publicID/history分区，或假定一般报文的seq能推算采样时间。Blob尺寸需检查；本次约15KiB批不代表所有允许512KiB/300样本报文都能无条件打包五分钟。

本次7天是容量计算参数，不是修改已冻结线协议。清理探针删除历史桶但保留节点高水位，然后验证旧seq找不到原文时**拒绝而不重记/伪造ACK**。探针内部 `receipt_expired` 不新增公开RPC方法/错误合同。产品Task3/4须让receipt保存范围覆盖Agent待确认重试队列，并明确历史retention和receipt回收条件；不能直接按历史7天清理仍可能待确认的receipt。尚未能证明可回收时保留receipt，并把其增长纳入容量。本阶段不靠删除receipt或改变旧ACK含义宣称长期免费。

标准-only Agent没有冻结CF批/seq，继续按原hub的会话和接收时间形成分钟输入；标准通知不获durable ACK。S2预算针对CF默认20节点场景，不测试或承诺原Agent默认1秒无限连续通知的免费性。Task4同一核心处理两类输入；CF实时report只更新latest/已提交基线投影，不能再增加这批历史、流量或probe分母。

### 8.3 消息、读写、容量和余量分别计算

| 20节点/day，CF默认 | 活跃实时2秒＋耐久批60秒 | 空闲耐久批60秒 |
|---|---:|---:|
| 本地2秒样本 | 864,000 | 864,000 |
| 原始probe结果 | 115,200 | 115,200 |
| 实时report通知 | 864,000 | 0 |
| 冻结耐久批 | 28,800 | 28,800 |
| 额外应用心跳 | 28,800 | 28,800 |
| native入站文本帧（含hello/config） | 921,720 | 57,720 |
| DO WS计费请求单位（20:1） | 46,086 | 2,886 |
| Worker upgrade/HTTP及页面请求 | 1,768 | 1,768 |
| DO WS＋HTTP/upgrade/页面请求单位 | 47,854 | 4,654 |

明确假设：每节点每天2次重连/hello、4次config回复；1%的批不确定送达后追加相同HTTP重试；站点每天1440次浏览器/admin Worker→DO请求。普通WSS数据帧不是Worker HTTP请求，native帧数也不是DO analytics中的20:1计费单位。出站ACK/config/广播不计入入站WS单位；协议ping不计，表中应用心跳按入站保守计。缓存/配置/身份/终端/SSH和其他站点流量仍消耗共享余量。

| 按真实meta/cursor外推一天 | D1桶，20节点 | journal＋D1，20节点 | D1桶，100节点 |
|---|---:|---:|---:|
| D1 ingest写 | 57,600 | 11,520 | 288,000 |
| D1过期桶清理写 | 5,760 | 5,760 | 28,800 |
| D1合计写 | **63,360** | 17,280 | **316,800** |
| D1读（含重试、恢复、24h范围） | 132,952 | 34,456 | 665,336 |
| DO SQL写（ingest/索引/marker/清理） | 0指标写 | **120,960** | 0指标写 |
| 7天逻辑增长估算 | **329,824,656 B** | 同等D1物化＋额外DO journal | **1,649,120,256 B** |

20节点D1方案对设计目标余量：写16,640行/day；读3,867,048行/day；逻辑容量70,175,344字节。Worker/DO请求各距80000/day约78,232 / 32,146（活跃）或75,346（空闲）。这些是本工作负载的计算余量，现站点既有库/写入/资源用量尚未从中扣除。

读范围参数：本预算按每节点每天一次24h查询，用本次每节点两个五分钟桶实际3读行作保守比例外推，计8640读行/day；清理也按本次索引端点成本保守比例外推。若每分钟重新扫描所有20节点24h窗口，仅该范围项就约12,441,600读行/day，超过4000000。当前保守系数下留余量最多约448次全站24h读/day（约193秒一次）；实时DO广播不能每2秒触发这类历史全扫。Task4/5实现缓存、按需窗口/分页和真实weighted rollup，raw probe含义保持不变。

容量是实测有限数据的外推，不是假设压缩一定有效。以20节点47,117,808逻辑字节/day为基线，允许历史天数满足 `R <= (400000000 - 既有库字节 - 保留receipt及其他空间) / 47117808`。7天示例保留全部原始资源/probe；365天全量约17.20GB，不能当400MB库能力。额外receipt的长期保存/rollup物化费用须在Task4纳入；高熵、更大任务数/GPU payload需重新计量，不能只乘当前gzip比例。小时层必须按count/覆盖合并；不通过降低每分钟probe次数或把原probe换rolling摘要通过预算。

100节点仅通过本地耐久/分布回归，**全天预算不通过**：D1写超目标236800/day、7天逻辑空间超约1.249GB、活跃DO请求233510/day超153510。空闲DO请求17510/day仍不修复相同D1写差额。当前60秒批＋五分钟桶的D1成本为约3168写行/node/day，写预算理论上限约25节点，尚未扣其他业务。100节点要保留该采样/探测含义，需后续明确资源/策略决定；不在S2静默降频、拆库或开通计费。

### 8.4 本地证据不能替代云验收

Miniflare使用已安装v5 API的 `resourcePersistencePath`；原子失败/已提交ACK/同库恢复均实际运行。SQLite主文件、WAL、SHM、cache/metadata以及DO `sql.databaseSize` 分开记录在JSON的 `filesBefore/filesAfter/groups` 中。两种候选使用各自独立的临时目录，文件stat取共同10分钟工作负载前/后，不混入额外恢复尾部。直接路径20节点逻辑payload约319.5KiB，但运行时本地WAL/分配数MB；WAL复用、空库元数据、SQLite页/空闲空间不会按逻辑payload线性增长。D1禁止本探针的 `PRAGMA page_count/page_size`，未把该失败伪装成测得页容量；改用实际文件stat清单。**本地physical SQLite字节不是云billed capacity**。

官方DO SQL定价（2026-11-24读取，证据 `S2-durable-objects-pricing.md`）列Free写100000行/day、读5000000/day、SQL存储总5GB，删除计写；SQL不是旧KV按字节request-unit价格。当前journal候选仅可计算的SQL写已经超官方写额度20960/day，不能称journal免费。D1桶在本地可算的写/读/有限逻辑增长目标内，更少跨存储恢复耦合，因此作为唯一策略。

设计目标仍为Worker/DO请求80000/day、D1写80000/read4000000/day、DO duration10400GB-s/day、单库400MB。一个global DO若128MiB整天常驻，计算为10800GB-s/day，超10400目标400GB-s；需至少3200秒/day可休眠才能到该目标。20个socket不应乘成20个常驻DO，但旧standard socket/timer会妨碍休眠。实际cloud duration、Worker/DO CPU、压缩CPU/大帧、真实剩余D1容量/存储计费和混跑休眠收益由Task7测量；本地wall time、3项GREEN或消息模型均不代替这道云验收。

运行：指定Node22执行 `node --test test/monitor-protocol-budget.test.js` 和 `node scripts/probe-monitor-storage.mjs`。探针仅创建自身临时本地D1/DO，finally dispose，校验绝对temp路径后清理；不读取生产env、凭据或部署。详细机器报告和RED/GREEN日志在本阶段 `evidence/S2-*`。
