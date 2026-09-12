# XAgent Phase 6 受治理 Business Skill 验收记录

[English](2026-09-11-xagent-phase-6.md) | 中文

Phase 6 为 XAgent Business 增加受治理、可复用的项目 Business Skill。FastAPI 与 PostgreSQL 拥有项目生命周期，Host 则复用通用 Skill 注册表与真实 Agent loop，不向业务用户授予文件系统访问或可执行插件部署能力。Developer、普通 Web、Headless、JiaxinAgent、Private Session、Code Mode 及未绑定的项目对话不会获得 Business Skill 治理界面或运行时提供方。

## 已交付能力

后端保存稳定的项目内 slug、一个采用乐观并发的可变草稿、不可变发布版本、隔离测试记录、稳定 Skill 授权、终止退役、幂等变更结果及脱敏审计事件。Specialist 与 Manager 可创建、编辑、测试、查看测试记录并录入人工判定；只有 Manager 能发布经过精确测试的修订、授权或撤销生产使用、选择历史版本或退役 Skill。PostgreSQL 约束、触发器、行级策略、最小权限应用角色及显式锁顺序在 FastAPI 检查之下落实相同关系。

每次草稿测试使用持久化 `business_skill_test` 项目 Session，并且不会进入普通 Session 列表和恢复路径。Host 在唯一执行器取得所有权前，原子挂载真实 Agent factory Header 与启动事件。测试执行使用正常 Skill 接纳及模型循环，但只暴露选中的读取工具及其必要的只读配套；`propose_fact` 会作为未执行的生产写权限出现在报告中，而不会被模拟。当前项目成员在测试结算或 Skill 退役后仍可读取不可变记录与终态。

## 运行时与模型行为

经过认证的普通项目 Session 只能发现当前已发布且已授权的条目。显式 `/slug` 调用与模型 `skill` 调用均通过共享注册表加载精确不可变版本。一个轮次固定一个版本及其完整工具集合，同时过滤继承和 Agent 本地 schema，并在每次工具即将执行时通过 FastAPI 重新授权。发布或回滚只改变后续轮次；撤权、退役、账号或成员关系撤销、取消及后端不可用都会在不执行工具正文的情况下拒绝下一次调用。

可忽略的 `business-skill/activated` 事件只记录 slug、公开版本、调用形式、轮次及策略摘要。原始指令保留在仅追加日志中以支持精确重放；轮次完成后，模型历史会把已接纳正文替换为不含指令的使用标记。重启修复会保留原事件序列、测试记录、不可变版本、激活记录和历史标记，不会让旧指令与后续版本同时恢复。

## 产品界面

项目详情面板提供 Business Skill 页签，包含 Draft → Test → Publish → Authorize 档案、不可变版本历史、测试记录入口、审计摘要、回滚、撤权及带确认的终止退役操作。控件依据当前项目角色显示，并在冲突变更进行期间禁用。账号、项目、Session、角色或连接变化会使内存状态失效并拒绝旧命令。可见的测试状态、终止原因、人工判定及审计操作／结果均已本地化，不会暴露协议值。Browser 不会收到凭据、内部记录身份、不透明版本键、策略摘要或测试 Session 身份。

## 验收证据

真实 FastAPI/PostgreSQL 验收贯通 Specialist 测试／通过和 Manager 发布／授权流程，随后覆盖运行时目录、加载及工具授权、对项目索引证据的真实检索、仍需独立人工审批的生产 Fact 提案、第二个通过测试的发布、历史固定版本授权、回滚、立即撤权拒绝、隐藏测试 Session、持久化测试记录读取、不可变版本重放及终止退役。并发验收证明乐观草稿只有一个写入获胜、完全相同的发布请求精确重放，且退役后不会残留授权。聚焦真实循环测试覆盖两种调用形式、同轮次版本固定、后续轮次版本变化、检索工具执行、持久化激活、崩溃修复及不含指令的历史投影。TypeScript 与 Python SDK fixture 均接纳并保留激活事件。

仓库内的无密钥 Headless 快照使用真实 Agent loop 组装 Business Profile，并通过现有 Retrieval 与 Fact 能力接缝执行已发布 Skill。修复后的必要 Browser/GIF 验证尚未完成：本地固定 BGE-M3 缓存不完整，导致构建后的 XAgent Business Profile 无法进入登录界面；当次补全缓存也未能访问 Hugging Face。因此没有生成修复后的真实模型请求、Browser 帧或 GIF。后续运行必须使用真实 FastAPI/PostgreSQL 状态、两个已认证项目角色、已配置的真实模型及全新浏览器上下文；仍不得使用测试 transport、合成界面状态或采集凭据。

## 尚余发布工作

实现、确定性验收、当前态双语文档及 implemented 决策记录已在本地完成。产品可见验收仍未完成；必须先提供经过完整校验的 BGE-M3 缓存，让精确构建提交完成真实模型 Browser 流程，生成不含秘密的 GIF 并通过视觉检查。此后才能推送最终提交、把 GIF 发布到专用 assets 分支、将其附加到 Pull Request，并等待远端 required checks。本地 Task 11 刻意不执行这些远端变更。

## Agent Note 结果

项目 Business Skill 治理 Agent Note 已进入 implemented，并因项目治理、隔离测试归属、不可变版本固定、逐次授权、取消、重放及私有运行时身份决策仍具未来设计价值而保持 active。通用 Skill 注册表／目录 note 与 XAgent Profile、认证、Retrieval 及 Fact note 继续作为各自独立的权威；它们均未被取代，也不属于冗余、被拒绝或可归档记录。
