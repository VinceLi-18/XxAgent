# @xagent/dsh-ui-citation

[English](README.md) | 中文

`@xagent/dsh-ui-citation` 在现有 Business 对话中渲染 `submit_cited_answer` 的封闭 `xagent-cited-answer` 结果 metadata。Markdown block 使用共享安全 Markdown 组件，并使模型创作的链接保持不可交互。Citation block 变为键盘可访问的“已验证资料” chip，安静的来源条按首次使用顺序各列一次 citation。只有这些 block 会创建导航操作；Markdown 链接、自动链接、URL 形态的行内代码和 citation 近似文本都保持为文字。

选择 chip 时，Browser 只向 `xagentCitation/resolve` 发送当前 Session ID 和 citation ID。Host 从认证请求恢复 actor、账号和权限 revision，再由 FastAPI 解析该 Session 的持久 cited-answer provenance，并为该 actor 重新授权精确的不可变 Artifact Version 与 Chunk。响应只包含不带 URL 的 Artifact、Version、Chunk 和行身份。Browser 只把 Artifact、Version 与行范围交给 `xagentArtifactCitationOpener`；handoff 先打开工作台的“资料”页签，再由 Artifact 控制器重新读取详情和该精确 clean 版本的预览。

一个控制器只拥有一个账号和 Session 范围，并且最多拥有一次 resolution。请求被替换、账号或 Session 变化、ToolView 卸载、Remote 失败以及插件 dispose 都会取消请求并阻止迟到 Artifact 发布。UI 绝不把 Tool 参数、结果文本或 Markdown 当作 citation 权威。失败 Tool result 显示中性状态“引用验证未通过，回答未发布”，且不泄露参数或内容；终态 `CITATION_FAILED` 回合保留对话的通用失败状态。畸形的成功 metadata 显示关闭式 alert“已验证回答不可用”。

## Model Experience

### 已验证引用回答

#### What the model sees

本包不增加模型输入。终止型 `submit_cited_answer` Tool 及其规范持久结果由 `@xagent/dsh-retrieval` 拥有；本包只渲染该 durable 结果。

#### Token effect

本包不增加提示词或输出 token。

#### KV Cache effect

本包不读写模型 KV Cache。Citation 导航只是面向用户的 Browser 与 Host 操作。

## Known Limitations and Deferred Work

- Citation 导航只支持当前已认证顶层 Session 中持久化的 citation。
- 来源条有意显示稳定短 citation ID，而不是文件名、URL、snippet 或模型创作的标签。
- 非文本、非 clean、已撤销或不匹配的 Artifact 版本会关闭式失败，因为 citation 导航必须精确高亮行范围。
