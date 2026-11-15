# 添加超过八个 Ping 目标

后台「采集设置」可以继续添加目标；超过八个时仅显示资源提示，不禁用添加按钮。目标越多，Agent 的 CPU、网络请求、顺序探测耗时和每条历史记录的存储量越大。

## 先更新 Worker，再更新 Agent

1. 更新 Worker。启动时在 `metrics_history` 和存在的 `metrics_history_old` 中各增加一个 `extra_probes TEXT DEFAULT '{}'` 列；不轮换、清空或重排旧历史。
2. 安装支持配置 **schema 8** 的 Go Agent，再启用额外目标。以 Agent 的 `X-Agent-Config-Schema: 8` / `config_schema: "8"` 判断能力；旧 Agent 继续接收自己支持的 schema 3–7 配置和原八槽数据。
3. 在采集设置添加、命名并保存目标。在节点详情中查看对应延迟、丢包、历史与实时图表。首页延迟面板保留原有三个优先目标的布局。

本次源码包含 schema 8 实现，未发布 Agent 二进制或改变现有安装 ref。现有发布包须另行确认能力，不能仅凭面板已保存额外目标判断 Agent 已开始采集。

## 八个旧身份不变，额外身份不复用

原 `custom_ct/custom_cu/custom_cm/custom_bd/node_1…node_4` 及对应 `ping_*` / `loss_*` 列保持不变。原服务器覆盖、空值继承和 `0` 显式禁用仍适用。

额外目标是全局 `extra_ping_nodes` 集合，每项为 `{ id, name, target }`。添加时产生稳定 `p_<UUID>`；改名保持 ID，删除后新目标取得新 ID。额外目标由支持 schema 8 的节点继承，不增加逐目标 D1 列。

后台设置和管理员备份包含地址；公开配置只包含 `{ id, name }`。Agent 配置仅接收 `{ id, target }`，报告只含 ID 和数值，不含地址或名称。

```text
schema 8 query:
extra_ping_nodes=<URL-encoded JSON [{"id":"p_example","target":"127.0.0.1:80"}]>

report metrics:
extra_probes: { "p_example": { "ping": "31", "loss": "0" } }

public/history derived fields:
ping_extra_p_example: 31
loss_extra_p_example: 0
```

HTTP 配置串、WSS 配置串和结构化 WSS 配置均支持该集合。Agent 私有配置文件中的 `EXTRA_PING_NODES` 保存 URL 编码 JSON，仍使用原有私有文件和父目录验证。

## 测量和历史含义

额外目标复用现有 TCP/ICMP 测量和两分钟滚动窗口，由现有网络 worker 顺序执行，每个目标不新建 goroutine。报告保存当前窗口结果，与原 `node_1…node_4` 自定义节点一致；不会把高频 CPU/内存样本伪装成新的 Ping 测量。

- 禁用：`ping: false, loss: false`，前台隐藏。
- 已测量超时：`ping: null`（Agent 可序列化为 `"null"`），`loss: 100`，保留失败点。
- 尚无测量：两个值均为 `null`，不沿用之前目标的读数。
- 改名只改变标签；删除不把旧 ID 的历史分配给新目标。

完整历史和首页窗口仍按原时间桶选取真实记录。额外 JSON 值使用所选记录的当前窗口结果；原八槽的短时丢包窗口聚合与长时抽样规则不变。

保存或导入新的额外目标集合时，会使原历史缓存失效，避免旧 ID 的缓存遮住新采集的数据。新目标尚无历史平均值时，详情读数使用当前报告值。

配置限制按字节而非目标数量：额外设置 JSON 最多 64 KiB，单个名称最多 128 UTF-8 字节，地址沿用原 60 字符校验；额外报告数据最多 128 KiB，原报告总尺寸 512 KiB 和 300 个轻量样本限制不变。缩短名称可以在同一字节预算内保存更多目标。
