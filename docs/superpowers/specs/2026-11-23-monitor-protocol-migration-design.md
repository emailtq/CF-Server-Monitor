# 极简主协议＋CF 扩展：架构审计后的设计建议

**状态：用户批准设计和分支开发；2026-11-24明确采用独立阶段主会话→顺序新建开发子会话，不使用内部子代理代替。项目主会话进行阶段验收及提交，推送、部署、Agent发布和旧系统退役按独立门禁执行。**

## 1. 终态与完成条件

以当前Go Agent为基础，监控主协议使用极简标准，CF已有功能使用明确扩展。后端只维护一套节点身份、授权、指标、流量和探测事实；极简公共与主题管理API直接消费该核心。其他主题生态只在用户指定后增加输出适配，不增加第二个采集Agent或第二套统计账本。

完成须同时具备：

1. 新CF Agent→新CF后端：标准监控与CF已有能力都工作。
2. 原版极简Agent→新CF后端：无CF扩展也能监控与接收标准探测任务。
3. 新CF Agent→固定版本原版极简hub：标准监控能工作；CF专属能力显示不可用，不向原hub发送必须识别的扩展，不自动回退到旧CF endpoint。
4. 极简原主题无需逐主题改代码；资源、数据、history、WS、配置、安装更新删除都正确。
5. 老CF Agent在迁移期间继续可用，逐节点切换不重编号、不丢权限、不重复流量/事件；最后退役有明确条件。
6. 真实Cloudflare验收产生消息、读写行、duration、CPU和存储证据。不能承诺任意规模/365天全量历史始终免费。

## 2. 依据与范围

- Worker `c8afbdece469c4f09e35d8692b1d3b275d7eca49`。
- CF Agent `374c8c28a67094c9afaa217fd2e5d235e5f20e01`，schema10。
- 标准Agent `81c63b9730143080cea9ef465a1f46a4a1aeedb8`，1.2.3。
- 参考hub官方固定 `04a6fa1ef77e4d2208b4543018c2073d9bcc8095`，1.5.2；本地完整Rust源码b41249c用于相关机制对照。开始执行前固定完整1.5.2参考checkout，校验具体合同差异后使用；不以漂移的main作为自动更新规范。
- 详细当前审计：`.planning/2026-11-20-monitor-theme-api/protocol-migration-plan-20261123/AUDIT.md`。

本次范围包含Agent/核心/API/CF扩展/主题/迁移。第二生态的实现、任意远程脚本执行、重做已经接受的后台全页面样式、R2、自动开通付费、主分支推送均不在本计划内。

## 3. 三种合同不能混为一谈

1. **Agent线协议**：WSS上的JSON-RPC通知/请求/响应。标准方法名称和params保持上游。
2. **HTTP/浏览器协议**：原主题和后台所需的REST、WS快照、配置、上传，不因Agent改JSON-RPC而改成另一种接口。
3. **包与资源协议**：manifest、dist、preview、SPA、资源URL和更新生命周期。原发行包代码不改。

标准方法不修改含义；CF行为使用独立命名空间和版本。内部存储可以是D1/DO，不需要仿造本地SQLite文件系统。

## 4. 分层与所有权

```text
Go Agent现有采集器／本地授权／事件队列
   ├─ 标准hello/report/ping.result
   └─ 协商后的cf.*批量／配置／SSH／终端控制
                ↓
当前Worker入口和同一global DO会话所有者
   标准codec／legacy入口归一化／扩展白名单
                ↓
单一权威核心：身份＋facts＋指标＋账本＋probe事实
                ↓
   极简REST/WS输出     CF后台扩展输出
                ↓
     极简原始主题；以后按需接第二生态
```

- `MetricsBroadcaster.js`保留现有DO类/namespace/migration，不直接大重写；新增codec、聚合和会话辅助模块按职责抽离，避免把新系统继续堆进2560行DO和1689行admin handler。
- 协议→会话→统计这一紧耦合链同一时间只有一位执行者写入；独立阶段主会话顺序创建开发子会话与验收，项目主会话进行阶段验收和显式文件提交。
- 用户2026-11-24授权持续流程：阶段完成主动通知项目；项目亲自验收通过、提交后主动创建下一个阶段主会话，顺序推进批准的开发，不等逐次催办。开发子会话不再分发；发布/云资源/退役门禁独立保留。
- `TerminalBroker`继续拥有PTY/data/credit/lease；控制报文改JSON-RPC但不把终端字节混进公共指标广播。

## 5. 标准协议与扩展

### 标准部分

- `/api/agent/ws`＋`Authorization: Bearer <node token>`。
- `hello`、`report`、`ping.result`；下行`ping.tasks`。
- 单条标准通知不得要求逐条ACK，不向unknown notification返回RPC错误。
- 新CF Agent连接后先发标准hello/report，不等待旧type:hello，也不以CF capability超时阻断标准监控。
- 上游标准Agent无CF能力协商时仅走标准任务和参数。

### 首版CF扩展合同（正式实现前写入机器fixture并冻结）

| 扩展 | 职责 | 安全/兼容要求 |
|---|---|---|
| `cf.capabilities` | 协商版本/能力，3秒未答按标准peer继续 | 能力不是权限；有id响应配对 |
| `cf.report.batch` | 有界、低频、带时间的历史资源/probe样本批次 | 最大300资源样本、512KiB；冻结批次stream/sequence防重复；ACK只声明实际持久范围 |
| `cf.reporting.configure` | 采样/发送/持久化策略及临时降频 | 新CF Agent保留1–5秒活跃/至少60秒空闲；采样与发送分离 |
| `cf.ping.tasks` | CF ICMP和超标准任务数量 | 独立任务mode、原metric generation、配置字节界限；不把ICMP冒充标准TCP |
| `cf.ssh.events` | 沿用version1/stream/sequence事件 | 32事件/批、持久化高水位ACK；不进入公开metrics/WS/config |
| `cf.terminal.*` | 原控制流open/close/disable/ready/resize/credit等 | 本地授权＋节点版本＋ticket＋管理员lease；数据仍走私有binary通道 |

监控扩展只在双方确认能力后使用。私有终端沿自身`cf.terminal.hello/bound`完成v1协商，不把监控capability成功或监控WSS在线强加为HTTP/独立终端的新前置条件。原hub不支持扩展时保留本地配置，标准监控可用；不能声称原hub支持CF终端。新Agent协议版本独立于legacy schema10，不能复用schema10含义发布新报文。Task1冻结的具体19方法/23权限条目、schema及原义见`docs/monitor-protocol.md`与三份机器fixture，后续实现消费该合同。

现有磁盘IO/GPU等额外采集值继续保留，放在`cf.report.batch`明确声明的额外指标字段中，由CF后台消费；不改变标准`report`字段或将私有元数据塞入主题公共snapshot。

CF客户端把**实时最新值**与**需要持久化的历史批次**分开：有访客时标准`report`继续约2秒更新实时状态，历史/probe约60秒通过`cf.report.batch`提交；空闲时只需低频批次和心跳。标准report不承诺durable ACK，批次冻结后重试不得修改同stream/sequence的内容。后端只把CF batch计入资源历史/探测分母，实时report不再重复计入同一窗口；流量实时显示从已提交基线投影，批次落盘后更新同一账本。原标准Agent没有CF batch能力，仍由其report按上游规则形成分钟聚合。这是同一核心的两种接入方式，不是两套账本。

扩展HTTPfallback使用`POST /api/agent/cf-report`接收同一个`cf.report.batch`合同，只对协商/配置为CF endpoint的节点启用；不另回到type/metrics旧报文。旧`POST/GET /update`仅服务尚未迁移的Agent。

## 6. 单一事实模型与统计

### 身份与精度

- UUID是内部节点主身份；公开numeric ID复用`monitor_compat_ids`，不重用删除ID，不用history_partition代替。
- task公共numeric ID建立持久映射到原`metric_id`；不得继续把无碰撞保证的hash当永久可写主键。
- 内部时间统一ms；标准输出时间按上游秒。采样时间、接收时间分开保存。
- 新采集器保留字节精度；旧MiB值标记来源，不乘回后冒充原始精度。
- 大整数counter用十进制原始数值词元和BigInt/SQLite i64运算，范围0–2^63−1；超范围明确拒绝。隔离Workers探针已验证JSON.parse reviver context.source及D1精确CAST，9007199254740993减9007199254740992为1。

### 流量

- 原始计数器＋可信boot/interface epoch；同epoch上升才加差值，第一次样本、epoch变化或下降重新建基线。
- 固定hub另有未观测重启例外：kernel部分变化且推算boot时刻晚于token last_seen时计新boot全量；Task4标准-only输入按Task1源码合同对照，不泛化为任意epoch变化都加全量。CF可信采样及迁移重基线保持各自条件。
- 同一账本维护total/month/day/reset-day；核对上游跨日和重启规则，不简单把跨日整段差额一律记到接收日。
- CF batch保留采样时间；原标准Agent按上游接收时间记样本。延迟/断网补发两类合同显式区分。
- 迁移时保留已知CF月度值和来源；无法还原的旧daily/生命周期值不补造。新账本激活时间写入每节点状态。
- 所有重复批次和双通道重试不得重复增加流量；已ACK批次在DO驱逐后继续去重。标准通知无seq时采用上游counter和session规则，不发明exactly-once承诺。

### 资源历史与探测

- 分钟资源层保留count、sum、mean、max、实际覆盖时间；网络平均速率与counter/单调采样间隔一致。
- 小时层合并必须按样本权重，不能平均“均值的均值”；开放retention1–365的能力必须先实现真实rollup、晚到窗口与容量预算。现有7天旧历史不改写成新统计。
- probe每次实际结果保留latency或timeout；摘要重复传送不增加分母；建立window loss与band。
- free预算允许将一节点一时间桶的多个probe样本有界打包，查询按索引定位节点/桶再解析。不能为省行把原始分布抹掉后仍称可重现极简统计。
- 原标准Agent64任务限制仅约束该客户端；现有CF Agent的超64/ICMP通过扩展保留，不能全局砍掉。

## 7. 状态、持久化与免费预算

- 使用现有D1和DO；不新建R2。Task1实测选择D1节点时间桶＋节点状态同一原子batch作为唯一耐久权威；连接由现有DO协调，不新增指标SQL journal或第二账本。一般receipt定位/保留/rollup由Task3/4落实并重新纳入成本，不能复制实验固定seq→时间键或当成本恒为两行。
- 内存聚合未落盘不能ACK为已持久；休眠前或durable接收阶段保留足够恢复状态。ACK、journal、批checkpoint和查询物化不是两个账本；只有一个写入所有者。不得为了给每2秒实时report发耐久ACK而每帧写D1/DO存储，破坏免费预算。
- 初始性能场景：20节点、每节点4探测/60秒、采样2秒、空闲批发送60秒、活跃发送2秒；另测100节点压力，不承诺100节点全天2秒发送免费。
- 输出真实Worker请求、DO消息与duration、D1 meta读写行及DB增长；按同一数据/时段与现状比较。
- free发布预算建议目标≤80%日限：Worker80000、DO请求单位80000、D1写80000、读4000000、DO duration10400GB-s，单库400MB。此为留余量的设计验收目标，不是Cloudflare更低的实际限额。
- 标准Agent连接原hub的默认1秒不等于新CF站点必须默认1秒。新CF扩展保留降频，但本机采样不能随发送一起降为分钟瞬时值而损失均值/峰值。
- 在一个global DO中先验证，不机械拆成每节点常驻DO。可休眠API、无空闲timer及状态恢复一起做；混跑旧标准socket时明确记录休眠收益受限。

## 8. API、主题与保留边界

- 极简公共REST和WS全量合同直接投影新核心；后台REST调用同一业务服务，不用HTTP自调用中转。
- 标准监控/主题管理API对齐；CF Turnstile、隐私/公开字段控制、本地终端授权继续生效。原后台管理员完整地址/隐藏节点读取，若要开放给原主题，必须单列用户确认；默认不因协议迁移扩大权限。
- 原`/api/ws`默认改标准前，先将CF内部后台/旧客户端迁到明确入口。正式与preview context不得串主题、串生态或改变授权。
- 图标、static/manifest等主题资源冲突按上下文解决；真实Agent/admin/internal路由保持独占，路径安全检查不放宽。
- 接通`/api/themes`列表、原分片上传、select/settings/config/update/delete/PNG；复用D1原包installer和CAS，不重开发主题安装器。
- CF后台仍可使用当前Vue组件；先接新业务服务，不要求搬整个React后台或重新做已经接受的布局。
- 主题revision保留期与引用保护在正式回收前确定；不能无限累积，也不能删除仍被有效preview引用的版本。回收不随协议迁移自动触发。

## 9. 需要明确批准的上游/平台差异

这些不会阻止标准监控第一阶段，但必须在“全部API等价”验收前由用户选择：

| 项目 | 推荐默认 | 另一选择及影响 |
|---|---|---|
| 原SQLite backup/restore/vacuum | 保留CF备份和D1恢复，以CF平台管理接口提供，明确不冒充原SQLite接口 | 原SQLite文件互导需要真正export/import转换及故障恢复，是新增完整子项目 |
| 原hub密码登录、14天session | 先保留CF登录、Turnstile和现有会话；只映射必要身份/退出接口 | 若要原后台登录完全原生，再开发对应登录/会话合同，不能套用Wrangler OAuth或静默延长授权 |
| 历史保留与匿名访问 | 展示实际可用覆盖范围；CF既有权限先保留 | 开放原极简1–365天全访客范围须实现rollup并批准权限/容量策略，不仅修改history_days |
| 原Agent安装脚本与`/agent/{arch}` | 新标准入口独立，老`/install.sh`继续兼容CF参数 | 最终同路径完全原生要先迁移所有安装入口及现有脚本调用 |

推荐默认意味着“核心标准合同＋明确CF平台差异”，不是字节级复制所有上游API。如用户要求另一选择，先调整计划范围和验收，不在交付时才解释差异。

## 10. 迁移与退役

1. 新backend先上线兼收，现有节点不被自动升级；新原生入口验证后才发布Agent。
2. 新Agent初期显式`REPORT_PROTOCOL=monitor`选择；旧配置仍legacy，不按版本字符串猜协议。仅网络异常不触发协议降级；授权错误不改用更弱入口。
3. 每节点一个活跃监控写入lease；同token双连接、WS/HTTP重试和旧连接teardown不能覆盖新会话。
4. 先非生产与自愿测试节点，再小批生产；为Agent准备独立可用的旧版本binary/config恢复，不只记录Worker版本号。
5. 旧系统删除沿用户既定门槛延期：新链路/CF特有能力验收、迁移库存和回滚准备完成后再启动。未迁移节点的旧协议仍保持使用；不永久把legacy当主协议。
6. Pages独立发布与共享静态资源单列，未经范围确认不删；不推main，只有执行阶段用户授权才推terminal/部署。

## 11. 后续第二生态

本轮只固定边界：输出适配读取同一核心、使用可信registry生态身份、不扩大权限。实际选中第二生态后检查其manifest/包、REST/WS、config/auth/history及同路径冲突，再写小范围计划。

不预实现Komari/Nezha等全部功能；公开theme适配不要求Agent同时切换其他探针协议。第二生态自己的缺失能力必须明示，不通过假指标/假成功响应掩盖。
