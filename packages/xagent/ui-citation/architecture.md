# XAgent 结构化 citation UI 架构

`ui-citation` 通过 keyed `tool.call.toolview` Slot 接管 `submit_cited_answer`，但不建立新的对话视觉系统。视图只接受成功 Tool result 上字段集精确匹配的 `xagent-cited-answer` metadata；Markdown block 继续交给共享 `MarkdownText`，citation block 才能产生“已验证资料”按钮。来源条从同一封闭 block 列表按首次出现顺序去重，因此 Tool 参数、结果正文和普通 Markdown 都没有导航权限。

`XAgentCitationController` 跟随 `xagentWorkbench` 的认证账号和 `sessions.list.current` 的顶层 Session。每次点击只调用 `resolve(sessionId, citationId, signal)`；替换点击、范围变化、视图卸载和 dispose 会取消旧请求，并用单调 epoch 拒绝迟到结果。成功结果只携带 Artifact、Version、Chunk 和行身份，不携带 URL。

Host `XAgentCitationRemoteService` 从 Typert Gateway 的认证 Session scope 读取 actor、用户 token、权限 revision 和物理连接。它从当前 live Session 重建 Task 8 固定的持久 citation 身份，在每次调用时签发新 delegation，再请求后端解析。未知方法、匿名或嵌套 scope、Session 不匹配、citation 缺失、取消与 dispose 都关闭式失败；服务不缓存 locator 或读取地址。

`XAgentArtifactCitationOpener` 是 citation UI 到资料面板的窄入口。Artifact 控制器先清空旧 locator 和短期 URL，再重新读取目标 Artifact 的详情，要求服务端返回相同 Artifact ID、相同 clean Version ID 和可预览 MIME，之后才请求一次精确版本预览。行范围随短期面板状态显示；文本预览逐行标记该范围。账号、项目或 Session 变化以及 dispose 会取消详情和预览读取并阻止迟到发布。
