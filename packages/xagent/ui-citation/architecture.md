# XAgent 结构化 citation UI 架构

`ui-citation` 通过 keyed `tool.call.toolview` Slot 接管 `submit_cited_answer`，但不建立新的对话视觉系统。视图用 retrieval 的 Browser-safe validator 检查成功 Tool result 上的 `xagent-cited-answer` metadata，包括关闭字段集、完整大小与数量上限、所需 block、规范 citation ID、相邻去重和首次使用顺序。Markdown block 继续交给共享 `MarkdownText` 的 inert-link 模式，只有 citation block 能产生“已验证资料”按钮；Tool 参数、结果正文和普通 Markdown 都没有导航权限。失败 Tool result 只产生中性的未发布状态；畸形成功 metadata 产生关闭式 alert，终态 `CITATION_FAILED` 则由通用对话错误呈现。

`XAgentCitationController` 跟随 `xagentWorkbench` 的认证账号和 `sessions.list.current` 的顶层 Session。每次点击只调用 `resolve(sessionId, citationId, signal)`；替换点击、范围变化、视图卸载和 dispose 会取消旧请求，并用单调 epoch 拒绝迟到结果。成功结果只携带 Artifact、Version、Chunk 和行身份，不携带 URL。

Host `XAgentCitationRemoteService` 从 Typert Gateway 的认证 Session scope 读取 actor、用户 token、权限 revision 和物理连接。它只校验 Browser 提交的短 citation ID，在每次调用时签发新 delegation，再让 FastAPI 从独立持久 provenance 解析身份并按当前 actor 重新授权。该流程不读取 live Session 投影，且在 reload、resume、compaction 与保留前缀的 fork 后保持有效。未知方法、匿名或嵌套 scope、Session 不匹配、citation 缺失、取消与 dispose 都关闭式失败；服务不缓存 locator 或读取地址。

`XAgentArtifactCitationOpener` 是 citation UI 到资料面板的窄入口。入口先通过项目工作台的响应式页签状态打开第三栏“资料”，再由 Artifact 控制器清空旧 citation locator 和短期 URL、重新读取目标 Artifact 的详情，要求服务端返回相同 Artifact ID、相同 clean Version ID 和文本 MIME，之后才请求一次精确版本预览并逐行标记范围。PDF、图片及其他无法兑现逐行高亮的格式关闭式失败，但普通 Artifact 浏览仍可预览受支持的 PDF 与图片。Citation 自有 generation 使 Session 变化只撤销 citation 拥有的选择、详情与预览，不干扰普通浏览或轮询；账号、项目变化以及 dispose 仍取消整个资料范围。
