# XAgent Account UI Architecture

该包拥有浏览器认证状态机和两个 XAgent 专属 Slot occupant，不拥有账号、权限或项目业务数据。`AccountController` 使用同源 Cookie 调用 `/auth/session`、`/auth/login` 和 `/auth/logout`，并把服务端响应归一为固定中文状态；响应正文中的错误细节不进入界面。

`xagentWorkbench` 是账号界面与项目工作台之间的最小接口。认证成功后，账号界面请求工作台执行唯一的服务器 Bootstrap，并从工作台快照读取账号摘要。退出、重新登录和认证失效会递增账号 epoch、取消当前请求并重置工作台；旧 epoch 的异步结果不能发布状态。

登录遮罩通过 `shell.overlay` 覆盖产品壳，账号页脚通过 `sidebar.footer.action` 显示邮箱、中文角色名和退出入口。通用 `ui-layout` 只声明和渲染 Slot，不包含 XAgent 文案、认证请求或账号状态。
