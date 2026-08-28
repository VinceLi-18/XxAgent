# XAgent Retrieval Tool Architecture

该包是 `ctx.xagentRetrieval` 的模型 Consumer，只拥有两个固定工具的 schema、描述与公开结果投影。`list_accessible_projects` 只接受可选名称查询；`search_artifacts` 只接受查询、显式 Project UUID 列表和私人资料选择器。封闭参数对象拒绝 Principal、用户令牌、连接、Session、固定项目、委托和 receipt 字段。

执行时，工具从当前 Agent 读取 Session ID，从工具运行时读取 call ID 和取消信号，再调用 Host 检索服务。两个定义都声明 `nativeOnly`；工具 registry 在 Code SDK 投影、binding 枚举和嵌套执行解析中排除它们。服务返回的规范数据通过输出 schema 后，纯 render 函数生成模型正文，pure presentation metadata 只生成固定 kind、payload hash 和短引用标识。工具不缓存结果，也不读取 receipt registry。

Private Session 的项目名称不明确时，描述要求模型先调用项目发现并询问用户；没有显式项目或私人资料选择时服务失败关闭。Project Session 的固定项目完全来自认证 prompt 作用域，模型不能通过工具参数覆盖。
