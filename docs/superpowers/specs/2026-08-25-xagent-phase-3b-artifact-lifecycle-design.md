# XAgent Phase 3B：资料生命周期设计

## 1. 范围

Phase 3B 为 `xagent-business` 交付私人资料与项目资料的上传、安全扫描、不可变版本、右栏详情、预览和下载。该阶段建立人工资料管理入口和可由后续业务 Agent 复用的 Artifact Service，但不向模型装配资料工具。

本设计建立在 [Phase 3A 项目工作台](2026-08-25-xagent-phase-3a-project-workbench-design.md)之上，并细化[整体集成设计](2026-08-20-xagent-dsh-fork-integration-design.md)的文件处理流程。实现只进入 XxAgent；JiaxinAgent 仓库、通用 DSH Profile 和共享布局的默认行为保持不变。

### 1.1 目标

1. 用户可以在“我的工作台”上传仅本人可见的私人资料，也可以在有编辑权限的项目中上传项目资料。
2. 上传请求不等待病毒扫描；页面刷新和服务重启后仍能恢复扫描状态。
3. 每份资料拥有不可变版本历史，只有明确上传新版本才会追加版本。
4. 只有扫描明确通过的版本可以预览或下载。
5. 右栏承担资料列表、详情和版本历史，中栏始终保留 Agent 对话。
6. 人工入口与后续 Agent 工具复用同一权限、幂等、扫描、审计和对象访问实现。

### 1.2 不在本阶段交付

- OCR、Office 渲染、正文解析、切块、Embedding、资料检索和事实提取；
- 模型资料上传、检索、引用或下载工具；
- Session 的 Artifact 引用和模型可见资料正文；
- 资料删除、移动、改归属、公开链接或跨项目共享；
- 文档草稿、审批、导出和协作收件箱业务数据。

## 2. 架构

Phase 3B 新增独立的 `xagent-artifact` 能力族。FastAPI 是资料、版本、权限、任务和审计的权威来源；MinIO 保存私有对象；PostgreSQL 保存业务状态和持久任务；独立 Python worker 负责扫描、重试和对象晋级。TypeScript 插件只通过 FastAPI Provider 使用这些能力，不直接访问 MinIO 或数据库。

Phase 2 已建立 `artifacts`、`artifact_versions`、`staging_uploads` 和基础 FastAPI Artifact Service，本阶段通过后续迁移补齐版本号、上传者、扫描状态、暂存元数据、处理任务和权限策略，不重建表、不改变既有 ID，也不复制第二套资料服务。这里的 `xagent-artifact` 能力族是 DSH Service、Provider、Remote 和 UI 的组合边界，不是新的业务真相源。

```text
Artifact Service Definition
  ├─ FastAPI Provider
  ├─ Host Remote
  ├─ 右栏 UI Consumer
  └─ 后续 Model Tool Consumer（Phase 3B 不装配）

Browser ── Host Remote ── FastAPI ── PostgreSQL
   │                         │
   └──── 限时 PUT ───────── MinIO
                             ▲
                    Python worker ── ClamAV
```

`xagent-business` 装配 Artifact Provider、Remote 和 UI。Artifact 包不得依赖 `xagent-project` 的客户端实现；两者只通过 Project ID、Principal 和 FastAPI 授权结果协作。共享 `shell.details` Slot 继续保持通用默认值，XAgent 插件只为 Business Profile 注册“资料”页签。

## 3. 数据模型

### 3.1 Artifact

`Artifact` 表示一份逻辑资料，包含 ID、显示名称、创建者、创建时间以及互斥的 `owner_id` 或 `project_id`。相同文件名不构成同一资料；创建新资料始终生成新的 Artifact ID。

### 3.2 ArtifactVersion

`ArtifactVersion` 表示不可变版本，包含 Artifact ID、从 1 递增的版本号、原始文件名、上传者、声明大小、实际大小、识别后的 MIME、SHA-256、扫描状态、最终对象引用、暂存引用和时间字段。数据库以 `(artifact_id, version_number)` 唯一约束阻止并发重复版本。

扫描状态使用闭合集合：

```text
pending → scanning → clean
                   ↘ quarantined
                   ↘ failed
```

只有 `clean` 版本具有最终对象引用并能成为默认可用版本。`quarantined` 保留元数据和审计记录，但正文不得预览或下载。`failed` 默认拒绝正文访问，并可在暂存对象仍存在时重试。

### 3.3 StagingUpload

`StagingUpload` 保存上传者、资料范围、可选 Artifact ID、文件名、预期大小、客户端 SHA-256、暂存对象引用和过期时间。创建新版本时，服务端从 Artifact 推导资料范围；客户端不能改变资料归属。

### 3.4 ArtifactProcessingJob

`ArtifactProcessingJob` 是 PostgreSQL 持久任务，包含 Version ID、任务类型、运行状态、尝试次数、下次执行时间、租约令牌、租约过期时间和稳定失败码。一个版本只有一项病毒扫描任务。任务运行状态与产品扫描状态分离，UI 只读取 ArtifactVersion 的产品状态。

## 4. 上传与版本流程

### 4.1 新资料

1. Browser 经 Host Remote 请求暂存上传，并提交当前工作台或项目上下文、文件名、大小和幂等键。
2. FastAPI 从当前 Principal 推导私人范围，或验证当前用户具有项目 `edit` 权限；服务端拒绝超过 50 MiB 的请求。
3. FastAPI 返回十分钟有效、只允许写入一个 `staging/` 对象的 PUT 地址。
4. Browser 上传文件并计算 SHA-256，然后提交完成请求。
5. FastAPI 校验暂存对象存在、大小一致、上传未过期且上传者一致，并在一个事务中创建 Artifact、`pending` Version 和扫描任务。
6. worker 扫描通过后把对象晋级到 `artifacts/{artifact_id}/{version_id}`，写入实际大小、MIME、SHA-256 和 `clean`，再删除暂存记录与暂存对象。

### 4.2 新版本

上传新版本必须从资料详情发起并携带 Artifact ID。FastAPI 在分配版本号前锁定 Artifact，重新验证当前权限，并从 Artifact 复制私人或项目范围。新版本处于 `pending`、`scanning`、`failed` 或 `quarantined` 时，上一份最新 `clean` 版本继续作为默认预览和下载版本；只有新版本进入 `clean` 后才成为默认版本。

### 4.3 内容校验

worker 流式读取暂存对象，同时执行 ClamAV 扫描、SHA-256 复核和 MIME 内容识别。客户端声明、文件扩展名、MinIO Content-Type 和 ETag 均不能单独证明内容身份。扫描前后的对象 ETag、大小或内容摘要发生变化时，任务进入稳定失败状态，且不得创建最终对象。

## 5. 持久 worker

Phase 3B 使用 PostgreSQL 工作队列，不引入 Celery。worker 通过正式 `xagent-api worker` 命令启动，使用 `FOR UPDATE SKIP LOCKED` 原子领取到期任务，并在领取事务中写入随机租约令牌、租约过期时间和新的尝试次数。

worker 在长扫描期间续租。所有完成、失败和重试更新必须同时匹配 Job ID 与租约令牌；租约失效的旧 worker 不能覆盖新的处理结果。进程退出后，租约到期任务重新变为可领取状态。

可恢复的存储或扫描服务错误使用有限指数退避。超过最大尝试次数后，Version 进入 `failed`。用户可以在暂存对象未过期时手动重试；暂存对象过期后，服务要求重新上传。ClamAV 明确报告感染时直接进入 `quarantined`，不自动或手动重试为安全版本。

对象晋级失败时，数据库事务不得把 Version 标记为 `clean`。数据库提交失败时，worker 删除本次创建的不完整最终对象；删除失败由受限清理记录继续处理，不向用户暴露对象路径。

## 6. 权限与数据库角色

私人资料仅 `owner_id` 对应账号可读取、上传新版本、预览和下载。项目所有者、项目成员和管理者沿用 Phase 3A 的项目访问规则；临时 `read` 授权只允许列表、详情、预览和下载，临时 `edit` 授权还允许上传新资料和新版本。

资料、版本、项目不存在或不可见时统一返回 `not-found`。服务不得通过错误文本、时间差、文件名、版本数或对象状态泄露其他账号或项目的资料。

API 使用现有应用数据库角色和 Principal RLS。worker 使用独立 `xagent_worker` 角色及 `DATABASE_WORKER_URL`；该角色只获得任务领取、暂存读取、版本状态转换、受限审计和清理所需的表权限，不获得账号、Session、项目成员关系或其他业务表写权限。worker 密钥只进入 worker 进程，不进入 API、Browser、DSH Profile 或开发 Profile。

## 7. 文件与对象访问策略

单文件上限为 50 MiB。上传允许 PDF、Word、Excel、PowerPoint、纯文本、Markdown、CSV、JSON及常见图片；服务端根据内容识别 MIME，不信任扩展名或 Browser 声明。

Phase 3B 只内联预览 PDF、纯文本类和 PNG、JPEG、WebP 图片。Office 文件扫描通过后可以下载，但不生成网页预览。HTML、SVG、脚本和未知二进制只使用 `attachment` 下载，不能以内联内容进入 XAgent 页面。

MinIO Bucket 保持私有，默认名为 `xagent-private`。预览和下载每次都先经过 FastAPI 当前权限检查，再签发极短期读取地址并固定安全的 Content-Disposition。读取地址不返回给模型工具、不写入 Session 日志，也不作为可长期分享的链接。

## 8. Host API 与稳定错误

Artifact Service 提供列表、详情、创建上传、完成上传、上传新版本、重试扫描、创建预览读取和创建下载读取操作。所有写操作携带幂等键；相同键和相同请求返回原结果，相同键和不同请求返回 `idempotency-conflict`。

Browser 和 UI 只处理以下稳定错误：

| 错误 | 含义 |
|---|---|
| `unauthenticated` | 当前连接没有有效账号 |
| `forbidden` | 已确认资源可见，但当前授权不允许写入 |
| `not-found` | 资料、版本、项目不存在或不可见 |
| `upload-expired` | 暂存上传或可重试正文已经过期 |
| `upload-rejected` | 大小、哈希、MIME 或对象一致性校验失败 |
| `idempotency-conflict` | 幂等键用于不同请求 |
| `service-unavailable` | MinIO 或扫描能力暂不可用 |

原始数据库错误、ClamAV 响应、MinIO Key、失权项目 ID 和内部重试信息不得穿过 Host Remote。

## 9. 右栏 UI

中栏始终保留 Agent 对话。右栏使用 `概览 / 资料 / 协作收件箱` 页签；工作台上下文列出当前账号私人资料，项目上下文只列出当前项目资料。

“资料”页签先显示上传按钮、资料列表和扫描状态。选中资料后，右栏进入详情层，提供返回列表入口，并展示当前安全版本、文件元数据、上传者、时间、扫描状态和版本历史。用户主动点击预览后才打开完整预览；关闭预览必须恢复原对话滚动位置和右栏详情状态。

Browser 展示真实 PUT 进度。PUT 完成后只显示服务端权威状态：等待扫描、扫描中、可预览、已隔离或扫描失败。上传与扫描期间用户可以继续对话。窄屏复用 Phase 3A 的右栏抽屉，不增加新的移动端导航。

账号切换时，UI 立即清空内存中的资料、上传和详情状态，并从服务端重新加载新账号数据。项目切换时取消旧请求；晚到响应不得覆盖新项目。浏览器持久缓存不能成为资料、版本或扫描状态的来源。

## 10. 后续 Agent 扩展

Phase 3B 不注册模型可调用的资料工具。后续业务 Agent 工具必须通过同一 Artifact Service 和 FastAPI 授权链工作，不得直接访问 MinIO。对话资料卡片只保存 Artifact ID 与 Version ID，并打开本阶段已有的右栏详情和预览。

右栏展示不会把资料正文加入模型上下文。后续检索或引用工具产生模型可见结果时，必须单独执行授权、最小内容返回、Session 项目引用登记和事件持久化。

## 11. 审计

审计覆盖上传创建、上传完成、上传新版本、扫描开始、扫描通过、隔离、扫描失败、手动重试、预览和下载。`audit_events` 增加受约束的 `executor_kind`，取值为 `account` 或 `artifact_worker`；`actor_id` 继续保存发起上传或重试的责任账号。用户请求写入 `account`，worker 状态变化写入 `artifact_worker`，从而同时表达系统执行身份与可追溯的业务发起者，不能把 worker 行为表示为用户直接操作。

审计只保存资源 ID、动作、稳定结果、请求或 Job 关联和必要元数据，不保存正文、读取地址、对象 Key、ClamAV 原始输出或内部凭据。

## 12. 验证

### 12.1 数据库与 API

- RLS 覆盖私人资料、项目成员、管理者、临时 `read`/`edit` 授权和双账号隔离。
- API 覆盖新资料、新版本、列表、详情、重试、预览、下载、幂等及不可探测错误。
- 并发测试覆盖重复完成上传、同时追加版本和权限变化时的原子失败。

### 12.2 worker 与存储

- worker 测试覆盖并发领取、租约续期、租约失效、崩溃恢复、重复交付、退避重试和旧 worker 完成拒绝。
- 存储测试覆盖哈希变化、对象替换、感染文件、过期暂存、晋级失败和数据库回滚后的最终对象清理。
- Docker 端到端验证使用 PostgreSQL、MinIO、ClamAV 和正式 worker，完成安全文件与标准防病毒测试样本的状态转换。

### 12.3 TypeScript、UI 与组合

- Service、Provider 和 Remote 测试锁定类型、错误及取消语义。
- UI 测试覆盖右栏列表与详情、上传进度、五种扫描显示、版本历史、安全预览、键盘焦点和窄屏抽屉。
- 账号与项目切换测试证明旧缓存和晚到响应不能跨范围显示。
- `xagent-business` 组合测试证明资料插件已装配且危险开发工具仍不可见；JiaxinAgent 和普通 DSH 默认组合不加载 XAgent 资料 UI。
- 构建版浏览器 GIF 展示登录、项目资料上传、扫描、右栏详情、预览、新版本和账号切换隔离。没有模型密钥时明确记录未运行模型回合，不使用 fixture 替代。

## 13. 实施边界

Phase 3B 从 Phase 3A 最终提交建立独立分支。数据库迁移、worker、TypeScript Service、Host Remote、右栏 UI、组合配置和文档按可独立验证的提交拆分；每项行为先写失败测试，再完成最小实现。

本阶段完成后，人工资料管理具备生产所需的隔离、恢复和安全读取基础。资料检索、引用、正文处理和模型工具仍按后续 Phase 独立设计。

## 14. 备选方案

### 14.1 Celery 与 Redis

Celery 适合大量异构 OCR、解析和渲染任务，但 Phase 3B 需要同时引入 Transactional Outbox、发布器、Broker 运维和重复交付处理。PostgreSQL 持久队列先满足扫描恢复和原子创建需求，并保留可替换的 worker 领取层。

### 14.2 FastAPI 后台任务

API 进程内后台任务无法在进程重启后恢复，也不能可靠处理租约、重复领取和长期扫描，因此不满足已确认的可恢复要求。

### 14.3 中栏资料工作台

用资料列表替换中栏可以获得更大的管理区域，但会让文件管理取代 Agent 对话。右栏逐级详情保留对话主体，并为后续对话资料卡片提供同一入口。

### 14.4 按文件名自动合并版本

文件名不具备稳定身份，相同名称可能代表不同资料。显式“上传新版本”避免误合并，并使 Artifact ID 与 Version ID 始终具有确定语义。
