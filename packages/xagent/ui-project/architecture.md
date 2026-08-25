# XAgent 项目工作台架构

该包拥有浏览器侧 `xagentWorkbench` 服务和三个 XAgent 专属 Slot occupant，不拥有账号、权限、项目或 Session 业务数据。`XAgentWorkbenchController` 通过生成式 `xagentProject` Remote 读取 Bootstrap、选择上下文、创建项目和读取项目详情；所有可见集合都使用服务器返回值，不根据标题、目录或浏览器缓存猜测归属。

`xagentWorkbench` 的 Bootstrap 是账号界面的唯一首屏项目请求。每次账号重置、上下文切换或项目操作都会递增 epoch 并取消旧请求；响应账号与当前账号不一致或请求已经过期时，结果不会进入 store。上下文切换或项目创建只有在服务器成功后才替换状态并清除当前 Session，失败则保留原上下文。

`ProjectBrowser` 注册到 `sidebar.workspaces`，使用 Bootstrap 的 `sessionScopes` 过滤既有 Session 列表；折叠栏只保留工作台和当前项目入口。`ContextMarker` 注册到 `conversation.context`。`WorkbenchDetails` 注册到 `shell.details`，宽屏第三栏与窄屏抽屉由通用 layout 渲染同一个组件和 store。提交上下文或创建项目期间，`WorkbenchOperationShield` 通过 `shell.overlay` 暂停产品壳交互，防止从旧范围启动新 Session。四个组件只接收 Slot 标准 props 与 inject callbacks，不访问 Cordis Context。

项目创建权限来自 Bootstrap 的 `project.create` 能力，最终授权仍由 Host 与 FastAPI 执行。第三栏的协作收件箱在服务端尚无协作数据契约时只显示明确空状态，避免用本地计数或演示项伪造业务事实。
