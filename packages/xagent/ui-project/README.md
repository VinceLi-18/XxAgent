# @xagent/dsh-ui-project

`@xagent/dsh-ui-project` 为 XAgent Business Profile 提供项目工作台界面。左栏展示“我的工作台”、当前账号可访问的项目和当前范围会话；中央区域显示服务器选择的工作上下文；第三栏展示工作台或项目概览，以及明确为空的协作收件箱。

项目、能力、上下文和会话范围全部来自 `xagentProject` Remote 的服务器 Bootstrap。浏览器不使用本地存储推断账号数据；账号退出或切换时，工作台会取消在途请求并清空项目、上下文和当前 Session 选择。

## Model Experience

### Project context（项目上下文）

#### What the model sees

本包不向模型添加提示词、消息、工具或项目字段。界面只用服务器 `sessionScopes` 决定展示和打开哪些已授权的 Session；Host 仍负责每项 Session 操作的权限检查。

#### Token effect

本包不增加模型输入或输出 token。

#### KV Cache effect

本包不读写模型 KV Cache。切换工作台或项目会清除当前 Session 选择，后续对话只从用户重新打开的服务器授权 Session 继续。

## Known Limitations and Deferred Work

- 协作收件箱当前只显示明确空状态，不展示未读数字、演示数据或虚构任务。
- 项目创建只对服务器 Bootstrap 返回 `project.create` 能力的账号开放；客户端隐藏入口不是授权边界。
- 项目和 Session 范围不写入 `localStorage`、`sessionStorage` 或 IndexedDB，页面刷新后从服务器重新装载。
