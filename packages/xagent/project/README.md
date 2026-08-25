# @xagent/dsh-project

`@xagent/dsh-project` 是 XAgent Business Profile 的 Host 工作台 Remote。浏览器只能调用 `bootstrap`、`select-context`、`create-project` 和 `project` 四个固定方法；actor、role、权限修订、用户令牌和连接标识都不属于 Remote 参数。

Authorizer 从物理连接建立一次 `AsyncLocalStorage` 请求作用域，服务只从该作用域读取用户令牌并调用 FastAPI。并发账号拥有独立作用域，嵌套 scope、无 scope、失效服务和响应账号不一致全部失败关闭。

## Model Experience

### Project authorization boundary（项目授权边界）

#### What the model sees

无直接内容。`xagentProject/*` 返回的项目能力、可见性、当前上下文和统计只决定浏览器可访问的数据与操作，不增加模型提示词或工具。

#### Token effect

本服务不增加提示词或工具 token；Remote 参数中也没有可伪造的身份或所有权字段。

#### KV Cache effect

无直接影响。账号与项目上下文选择发生在 Session 和模型请求装配之前，不读写模型 KV Cache。

## Known Limitations and Deferred Work

- 当前仅提供工作台读取、上下文选择、项目创建和项目详情；Session 创建范围由独立的远端 Persistence 在 FastAPI 事务内决定。
- 服务依赖 XAgent Authorizer 建立请求作用域，不能作为匿名 Remote 使用。
