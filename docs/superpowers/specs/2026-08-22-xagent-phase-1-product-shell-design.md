# XAgent Phase 1：产品壳与 Profile 组合设计

**状态：已确认并实施**

**日期：2026-08-22**

## 1. 范围

Phase 1 将 DeepSeek Harness 的 Web 表面包装为 XAgent 产品壳，并提供 `xagent-business` 与 `xagent-developer` 两个可启动 Profile。运行命令仍为 `dsh`；包命名空间、环境变量和内部协议名称保留 DSH 名称，统一迁移另行设计。

本阶段交付本地 Profile 级的能力与数据目录分离，不交付多用户认证、项目授权、业务 API 接入或生产数据访问。Profile 目录不是多用户安全边界。

## 2. Profile 组合与数据目录

启动器提供两个内置模板：

| Profile | Bundle 顺序 | 用途 |
| --- | --- | --- |
| `xagent-business` | `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@xagent/dsh-business` | 受限业务 Agent Web 表面 |
| `xagent-developer` | `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@xagent/dsh-developer` | 开发与系统维护 Agent Web 表面 |

用户通过 `dsh --profile xagent-business` 或 `dsh --profile xagent-developer` 启动一个 Profile。一个 Web 服务进程只运行一个 Profile；网页内不提供 Profile 切换器。

每个 XAgent Profile 都在 `$DSH_HOME/profiles/<profile>/data` 下持有自己的会话、凭据、设置和短期存储。启动器从已解析的 Profile 目录派生这个根目录，并将状态化 Provider 指向该目录；调用者不通过 Profile 补丁指定另一 Profile 的数据根目录。Profile 自身的 `package.json`、`cordis.patch.yml` 和 `node_modules` 继续放在 `$DSH_HOME/profiles/<profile>`。

业务 Bundle 保持 Phase 0 已验证的拒绝组合：不加载 Shell、任意文件系统、网页访问、动态工作流、Subagent 和文件型 Skill。开发 Bundle 保留 Coding Agent 能力，但不配置业务 API、生产凭据或生产会话存储。

## 3. 多用户演进边界

Profile 数据目录仅避免业务模式和开发模式在同一台机器上误用同一份本地状态。它不识别用户、不会验证浏览器请求的身份，也不阻止同一主机账户读取其他目录。

Phase 2 在此启动入口上增加经服务端验证的 Principal，并使 Session、远程 API、订阅和业务工具统一接受授权服务约束。用户和项目级会话数据由服务端存储与 PostgreSQL RLS 复核；本阶段的本地目录不会成为业务数据权威来源。

## 4. 产品壳

Web 保留 DSH 的三栏框架、详情区插槽和列宽控制能力。Phase 1 的 Business 界面只常驻侧栏与对话区；右侧详情区仍用于 DSH 会话详情，并可在没有适用内容时保持 0 宽度。本阶段不实现 JiaxinAgent 的常驻项目右栏。

产品可见名称统一为“XAgent”，包括浏览器标题、PWA 清单、侧栏文字标和新增的初始文案。新增或替换的用户界面文字使用中文；现有客户端语言机制仍负责其余界面语言。

视觉方向是面向项目协作的克制工作台：

| 令牌 | 色值 | 用途 |
| --- | --- | --- |
| 深墨蓝 | `#14213D` | 主品牌色与重点操作 |
| 青蓝 | `#1F9DCC` | 交互强调与焦点状态 |
| 雾白 | `#F6F8FB` | 页面底色 |
| 石墨 | `#1D2939` | 正文与高对比图标 |
| 松绿 | `#15803D` | 成功与完成状态 |

侧栏使用由 CSS/SVG 组成的简洁几何 `X` 标记和 “XAgent” 文字标，不引入位图 Logo。深墨蓝仅用于关键操作和品牌锚点，内容区域保持低干扰，以便后续承载项目、资料、事实和审批信息。

配色维持 Phase 1 已实现的主题令牌，不在本阶段恢复为原 DSH 浅色主题。统一视觉体系不属于 Phase 1；后续改色必须同步更新深浅主题令牌、用户界面断言和浏览器证据。

## 5. 变更边界

实现限定在 Profile 启动与路径解析、XAgent Bundle 组合、Web 静态元数据、主题令牌、侧栏品牌组件和相应测试。保留 DSH Agent Loop、Client Connection 协议、Session 授权模型和既有 `web`、`headless` 模板的行为。

不在本阶段实现登录页、用户菜单、项目导航、常驻项目右栏、协作收件箱、网页内 Profile 切换、FastAPI 调用、PostgreSQL Session Provider、业务工具或业务审批。项目目录与协作收件箱右栏随 Phase 3 的项目、登录和 Artifact UI 一并实现。

## 6. 验收条件

- 两个 XAgent Profile 可由 `dsh --profile` 自动初始化，并解析到各自的 Bundle 顺序。
- 业务 Profile 的危险能力闭包测试继续通过，开发 Profile 保留既有 Coding Agent 组合。
- 会话、凭据、设置和存储 Provider 的实际路径均位于当前 Profile 的 `data` 目录，两个 Profile 不共享这些路径。
- Web 标题、PWA 清单和侧栏显示 XAgent；新增可见文案为中文；DSH 三栏框架与详情区插槽保持可用。
- 既有 `web` 与 `headless` 模板的启动和路径行为保持不变。
