# @xagent/dsh-ui-artifact

`@xagent/dsh-ui-artifact` 为 XAgent Business Profile 提供右栏资料列表、逐级详情、不可变版本历史、直接 PUT 上传进度和安全预览。它占用 `xagent.workbench.artifacts` Slot；普通 `ui-project` 没有 occupant 时继续显示稳定空态。

控制器只把 `xagentArtifact` Remote 的列表、详情和扫描状态保存在内存。账号或项目变化会先清空列表、详情、上传和短期读取地址，取消旧范围请求，再从服务器加载当前范围；浏览器持久存储不参与恢复或授权。插件卸载会同步封闭后续发布并清空内存，再等待已取消的上传、读取和轮询任务完全停稳。

单文件在签发上传前限制为 50 MiB。普通“上传资料”始终创建新 Artifact，包括同名文件；只有资料详情内的“上传新版本”会追加不可变版本。PUT 完成后界面采用服务端返回的 `pending`、`scanning`、`clean`、`quarantined` 或 `failed`，并在处理中轮询服务器状态。

工作台上下文只列出当前账号的私人资料，项目上下文只列出当前项目资料；具体 read/edit 权限由 FastAPI 当前 Principal 与项目授权决定。不可见资料与不存在资料都显示同一未找到结果。新版本进入 clean 前，详情继续以先前最新 clean Version 作为默认预览与下载版本；隔离版本不提供读取，失败版本只在服务端允许时显示重试入口。

只有 `clean` 且 worker 识别 MIME 为 PDF、纯文本类、PNG、JPEG 或 WebP 的版本会请求预览地址。PDF 使用内联框架，图片使用图片元素，文本读取后作为纯文本渲染；Office、HTML、SVG 和未知二进制不请求预览，也不会进入 iframe。全屏预览会使应用背景不可达，把 Tab 顺序封闭在对话框内，并在关闭后恢复到实际触发按钮；父文档支持 Escape，始终显示的关闭按钮覆盖 PDF 内联框架可能自行消费按键的情况。关闭、范围切换或面板卸载都会丢弃短期读取地址与文本正文；它们和上传授权不会写入 Session、日志或持久缓存。

## Model Experience

### Artifact panel（资料右栏）

#### What the model sees

本包不注册模型工具，也不把 `xagentArtifact` Remote 的资料、版本、扫描状态、正文或读取地址添加到提示词、消息或 Session 事件。右栏操作只服务当前用户。

#### Token effect

本包不增加模型输入或输出 token。

#### KV Cache effect

本包不读写模型 KV Cache。上传、扫描轮询、详情和预览不会触发模型请求。

## Known Limitations and Deferred Work

- 本阶段不提供 OCR、Office 渲染、HTML 或 SVG 内联、资料删除、移动、跨项目共享和模型资料工具。
- 扫描状态通过短周期轮询更新；Browser 刷新后从服务器重新加载，不保留上传进度。
- 窄屏资料栏复用通用 layout 的上下文抽屉，不增加独立移动端导航。
