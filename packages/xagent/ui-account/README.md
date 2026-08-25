# @xagent/dsh-ui-account

`@xagent/dsh-ui-account` 为 XAgent Business Profile 提供正式账号界面。客户端先检查同源 `/auth/session`；只有响应携带 `x-xagent-auth: 1` 时才接管登录流程，普通 DSH Profile 不显示账号界面，也不请求 XAgent 工作台数据。

登录遮罩注册到 `shell.overlay`，账号摘要和退出入口注册到 `sidebar.footer.action`。成功认证后，插件通过 `xagentWorkbench` 执行服务器 Bootstrap；退出或账号变化会先清空项目、上下文和 Session 选择状态，迟到响应不能恢复旧账号数据。

## Model Experience

### Account isolation（账号隔离）

#### What the model sees

账号界面不向模型添加提示词、消息、工具或账号字段。`xagentWorkbench` 的认证状态只决定浏览器是否可以进入工作台。

#### Token effect

本包不增加模型输入或输出 token。

#### KV Cache effect

本包不读写模型 KV Cache。账号变化会清空浏览器工作台状态，避免旧账号的项目或 Session 选择参与后续请求。

## Known Limitations and Deferred Work

- 只支持管理员预分配的邮箱和密码，不提供注册、密码找回、记住登录或 OIDC。
- 认证接口不可用时保持失败关闭；登录页不展示服务器响应正文。
- 账号和角色摘要来自服务器 Bootstrap，不从浏览器缓存推断。
