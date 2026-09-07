# XAgent 资料右栏架构

`ui-project` 拥有 root-scope 单 occupant Slot `xagent.workbench.artifacts` 和响应式第三栏页签状态，并且只有第三栏“资料”页签渲染该 Slot。`ui-artifact` 通过 Slot 注入占用它，不导入 `WorkbenchDetails` 或其他项目展示组件。Citation handoff 只调用工作台服务选择“资料”并打开通用详情栏。中栏 Agent 对话与通用 layout 的宽屏第三栏、窄屏抽屉保持原有所有权。

`XAgentArtifactController` 是资料 UI 唯一异步操作所有者。它订阅 `xagentWorkbench` 服务的账号和服务器上下文，把工作台映射为 `workbench`，把项目映射为 `project:<id>`，并用 account ID、context key 与单调 epoch 拒绝迟到响应。列表、详情、上传、读取和轮询分别拥有取消控制器；账号重置、项目切换和 dispose 会取消全部操作、删除短期预览并清空内存 Store。

`XAgentArtifactStore` 只发布当前范围的列表、所选详情、上传进度和预览层。它不访问 `localStorage`、`sessionStorage` 或 IndexedDB。Remote 结果和 Store 都不携带用户令牌；读取地址只在预览打开期间保留，关闭预览或切换范围后立即丢弃。

上传先执行 50 MiB 预检，再向 Host 请求单对象 PUT 授权。Browser 通过 `XMLHttpRequest.upload` 发布真实字节进度，PUT 成功后计算 SHA-256 并提交完成请求。完成响应的扫描状态是可见权威；`pending` 和 `scanning` 触发范围内轮询。普通上传调用 `create-upload`，详情内的新版本入口调用 `create-version-upload`，文件名不参与版本归并。

预览许可同时要求版本状态为 `clean`，且详情中的服务端识别 MIME 属于 PDF、纯文本类、PNG、JPEG 或 WebP 白名单。控制器在许可成立后才调用 `preview`。PDF、图片和纯文本分别使用固定渲染分支；Office、HTML、SVG 和未知二进制只有下载路径，因此不能借助伪造扩展名进入 iframe。

控制器不解释权限或推导扫描状态。FastAPI 返回的私人／项目范围、`canEdit`、五态 Version 与 latest clean Version 是界面唯一权威；Host Remote 只转发固定操作。该浏览器链不注册模型工具，不写 Session 事件，也不触发模型请求。

Citation 导航只通过 `XAgentArtifactCitationOpener.openCitation` 进入控制器。控制器用独立 selection generation 拥有这条链，以服务端重新读取的详情核对 Artifact ID、不可变 Version ID、`clean` 状态与文本 MIME；核对成功后才请求该版本的短期 URL 并逐行高亮。PDF、图片及其他无法逐行高亮的 citation 关闭式失败，普通预览能力不变。Session 变化只取消仍由 citation generation 拥有的选择、详情与预览；普通 Artifact 选择和扫描轮询继续运行。账号或项目变化会撤销整个范围，并与 dispose 一样阻止任何迟到 locator 或预览发布。
