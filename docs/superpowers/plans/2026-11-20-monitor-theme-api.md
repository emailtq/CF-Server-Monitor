# 极简探针主题兼容 API 增量实施计划

**目标：**在 CF Worker 新增供极简主题原包使用的只读 API，不替换现有首页、后台或 CF 协议。基线为官方 Monitor v1.5.2（`2840c7b`）及默认主题 v1.4.3（`0236848`）。本期不安装主题、启用生产域名、改变 GitHub Pages、删除旧代码或部署。

**架构：**以显式配置的独立公开主机名区分两个 `/api/ws` 协议，不依据 UA、Cookie 或 `?gzip` 猜测。未配置时旧站完全不变；配置后，该主机只进入新只读路由，未知路径返回 404，不代理给后台、终端、Agent 或旧前台。共享现有 D1 节点与指标、缓存和实时源，不透传管理数据或未经筛选的 Agent 内容。

**执行门禁：**一次只派一位开发子代理；代理先写回归复现再实现，不能提交。主会话独立审阅、验证、只暂存明确列出的文件并本地提交，再派下一步。Node 22；本地测试用 Miniflare／D1 测试库，不连接生产。最终运行回归和构建。现有未跟踪文件不纳入提交。

## A. 主机隔离与站点能力

- [x] 新增 `src/handlers/monitorCompat.js`，在 `src/index.js` 旧分流前接入。`MONITOR_COMPAT_HOST` 只接受完整合法 DNS 主机名，按 URL hostname 精确匹配，不信任转发头；未匹配返回 `null`，匹配后不再落回旧路由。不设置生产变量。
- [x] 先实现 `GET /api/me` 原生 JSON，返回 `authed:false`、`github:false`、`public_page`、`site_name`、`history_days:1`，不读取或复用 CF 后台凭据。`public_page` 表达本期是否能匿名读取：站点须显式公开且未启用全局 Turnstile。后续数据接口统一复用同一个 gate：私有未集成只读会话时 401；启用全局 Turnstile 但尚未接入前台验证时 403；配置读取故障不得放行。管理登录与人机验证接入是启用原包供私有站使用前的下一阶段，不通过放宽权限规避。
- [x] 注册 `test/monitor-compat-route.test.js`。测试开关、精确主机、原主机继续走旧路由、未知／写操作拒绝、站点元数据、私有／Turnstile 和故障默认拒绝。

## B. 稳定节点 ID 与公开快照

- [x] 新增 `src/database/monitorCompatIds.js` 和 `src/services/monitorCompatSnapshot.js`，接 `GET /api/nodes`。在 D1 独立持久化 UUID → 正整数（唯一、并发幂等；下线保留映射，不复用历史分区编号）；按批补齐，不能每节点执行一次数据库查询，也不修改 Agent ID、历史分区或备份格式。
- [x] 复用现有最新 D1 指标与 DO 最新上报数据，按时间排序取新，使用公开字段白名单、隐藏节点筛选及 CF 的在线定义。对齐快照 `{nodes,admin:false}` 与 Default v1.4.3 的实际字段。时间戳用秒、容量用字节、速率和累计字节分别映射；可靠来源缺失时不填虚假指标，不泄露私有备注、凭据、终端状态、原始 Agent payload。未支持的流量、地址等信息按上游允许的缺省形态处理，并记录字段差异。
- [x] 注册 `test/monitor-compat-nodes.test.js`。真实 D1 测持久映射、重复／并发补齐、删除不可复用；测试成品快照、排序、隐藏排除、单位、过期及缺数。

## C. 历史与每主题只读配置

- [x] 新增历史数据转换，接 `GET /api/nodes/:id/metrics?hours=&points=&series=`，只走映射并再校验节点可见性；默认 6 小时，保持 CF 匿名 ≤24 小时，限制点数／并发和缓存，沿用 D1 现有采样。响应 `{metrics,ping,probes,loss,step}`，区分无样本和超时，不声称 CF 有精确窗口丢包、延迟中位数或 min–max。首期兼容已知 CF 采样窗口及延迟任务的公开标签，无权或查询异常不伪装成正常空数据。
- [x] 接 `GET /api/themes/:short/config`。只读已知公开主题的按 `short` 隔离配置，不把 CF 全局 `theme_options` 或任意配置暴露给主题；首期 Default 提供 `{}` 走原包默认值。主题安装、管理写入留待主题管理阶段。
- [x] 注册 `test/monitor-compat-history.test.js`。覆盖历史范围与预算、授权、节点删除、资源／探测输出、缺省配置及旧历史接口回归。

## D. 共享实时快照与最终集成

- [x] 在现有 MetricsBroadcaster 上增加独立的公开快照流入口，在新主机上接 `/api/ws`，原 `/api/ws` 不修改协议。复用 B 的快照投影；每个 hub 共享快照计算和数据读取，不按浏览器每两秒查 D1。首次有快照、周期发送、重连、可见性与站点权限变化时有界刷新；无订阅者停止新增工作。允许 `?gzip`，首版发送原版客户端也能消费的文本 JSON，不能发 CF `hello` 或增量。限制连接和有界的失败恢复；不能通过公开路径直接调内部 DO 接口。
- [x] 注册 `test/monitor-compat-live.test.js`；用真实 WebSocket 升级验证两种协议共存、快照、双订阅者不重复读源、关闭回收及拒绝未经允许的跨源／私有请求。收尾更新 API 文档；父会话验证四组兼容 API 与旧实时协议（68/68），`test:agent-config`、`test:history-query`（6/6）和 `build:frontend` 均通过。扩展全仓回归另有后台浏览器用例未过，不能视为全仓绿灯；详见任务测试记录。

**完成边界：**只读公开协议达到主题原包接入准备状态；官方主题与第三方包的浏览器验收、私有前台会话／Turnstile 接入、主题管理、默认切换及退役需在后续主题阶段完成。不能把协议回归通过写成已有主题上线。
