# XAgent Phase 3B 资料生命周期验证记录

本记录覆盖 XAgent Business 的资料上传、异步扫描、版本、详情、预览、下载、人工重试与账号隔离。产品实现截至提交 `a99e404e46d48d1cb6a7a04fd6c1369a2a94e2fc`；Task 11 只收口当前态文档、私有包与静态门禁政策、构建版测试基础设施和验证证据，没有修改产品 UI 或运行时行为。JiaxinAgent、Developer、普通 Web 与 Headless 组合没有修改。

## 已交付边界

- FastAPI 与 PostgreSQL 按认证账号和项目授权拥有资料范围、不可变版本、状态、审计与签名读取。上传完成事务只接受已经写入随机暂存 Key 的对象，持久保存服务端观察到的 ETag、声明大小和保留期限，并原子创建 Artifact、Version 与 ready Job。
- PostgreSQL 持久队列使用租约 token、截止时间、心跳、有限退避和失效 owner 拒绝。独立 `xagent_worker` 角色只拥有正文处理、精确对象版本清理和 worker 审计所需权限，不能读取账号凭据、认证记录、Session 或项目成员关系。
- worker 对单一正文流执行大小与 SHA-256 计算、有限 MIME 识别和 ClamAV 扫描。只有明确的 clean Version 可预览或下载；quarantined 与 failed 状态失败关闭，较新的非 clean Version 不会覆盖默认可读的最新 clean Version。
- MinIO 最终 bucket 启用对象版本化。发布记录精确 version ID；陈旧 worker 只能删除自己创建的对象版本。删除失败会把所有权交给持久 cleanup 队列，不会无版本地删除固定 Key。
- Business Profile 装配 Artifact Host Provider 与 Browser Consumer。浏览器通过 Remote 获取资料状态，通过 Host 固定同源路由流式读取签名正文；该路由不接受任意目标、不缓存正文、不记录签名，并在浏览器断开或插件释放时取消并等待已开始的上游工作。
- Browser 提供人工上传、详情、预览、下载、新版本与重试入口。Phase 3B 不注册模型可调用的资料工具，也不把资料正文或状态加入模型请求或 Session 事件。

## 自动化验证

| 检查 | 结果 |
|---|---|
| FastAPI Artifact 聚焦测试 | 通过：88 个测试；另有 1 个按条件跳过 |
| TypeScript XAgent 与 Business 聚焦测试 | 通过：12 个文件、357 个测试 |
| TypeScript 类型检查 | 通过 |
| Host、Client 与 Web production build | 通过：Web 转换 414 个模块 |
| 全仓 lint | 通过 |
| 全仓 hygiene | 通过：rescope 扫描 4,616 个 tracked 文件且无残留；publint 与源码／构建版 invariant 各检查 232 个包；Cordis 配置 124 个；NodeNext 声明 241 个；runtime closure 109 个；vendored links 9 个 |
| 文档同步门禁 | 通过：28/28 |
| 构建版完整 Web lane | 通过：77 个文件、255 个测试；另有 1 个文件、15 个测试按条件跳过，耗时 371.59 秒 |

最终 constraints 将 13 个 fork-owned 私有包逐一登记到 `privateXagentPackages`，其中包含 11 个 `packages/xagent/*` workspace 和 Business、Developer 两个 bundle；每个包继续使用 `private: true`，写入精确 XxAgent repository metadata，不添加 `publishConfig`，也不改变上游或非 XAgent 包。rescope 对 27 个协议、locale、preset 与 catalog 非 npm 语义命中使用逐文件、逐值精确跳过，并由负控证明真实包引用仍会失败。Knip 只逐项忽略 Cordis／YAML 动态装配依赖；Artifact 与 Project 的 `zod` 由 Host Typert 生成物实际导入，因此保留依赖并按项目精确登记静态分析例外。

## 真实服务与 GIF 证据

GIF 从隔离的 clean detached worktree 正式构建提交 `a99e404e46d48d1cb6a7a04fd6c1369a2a94e2fc`，没有使用 Task 11 的脏工作树或 Stage C 测试状态，也没有创建或复用源码 overlay。一次连续 fresh 运行启动新的 PostgreSQL、MinIO、ClamAV、迁移、角色初始化、FastAPI 与正式 worker，以及新的 `DSH_HOME`、`DSH_AGENTS_HOME`、XAgent Business Host 和隔离 BrowserContext。仓库声明的 Playwright 作为内置浏览器不可用时的 fallback 驱动真实页面；没有 fixture、mock transport、合成事件或 test-only hook。

同一次运行的 7 张 1440×900 源帧依次显示登录、项目创建、上传、clean 详情与 `安全版本 v1`、v1 正文预览、`安全版本 v2` 正文预览，以及切换到 Specialist 后「当前范围还没有资料」的隔离状态。编码结果位于忽略目录 `.playwright-mcp/task11-xagent-artifact/xagent-artifact-lifecycle.gif`：1200×750、152 帧、10 fps、15.2 秒、326,960 字节，SHA-256 为 `4231e8e692df07d68d92c0ceac8d59ad0f7e9c20703938ea18114ca8409d0334`。GIF 本体与 0.5、6.8、10.0、14.0 秒解码代表帧均经过视觉检查；没有密码、Cookie、令牌、服务身份或数据库内容。

环境没有 `DEEPSEEK_API_KEY`，因此没有运行或伪造模型回合。该限制与本阶段不装配模型资料工具的产品边界一致，不影响人工资料生命周期、真实扫描和账号隔离验收。录制退出后，精确 compose project 的容器、卷与网络查询均为空；帧、GIF、解码帧和 provenance 只存在于 gitignored 路径，未发布 assets、未更新 PR、未 push。

## 已知范围

Phase 3B 提供人工资料入口和安全异步处理基础，不提供模型资料工具、自动检索、协作审批详情、生产监控面板或统一视觉重构。PostgreSQL 队列适合当前单一资料流水线；只有在后续出现多类异构处理、跨服务路由或独立吞吐扩缩需求时，才重新评估 Celery、Redis 或事务 outbox。
