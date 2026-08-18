# 过程与决策记录(候选人填写)

> 这份文档用来记录你「怎么用 Coding Agent、做了哪些判断」,是评分的重要依据之一。
> 请边做边写,不要事后补。下面的空模板保留,按你的实际情况填。

## 0. 我选择的技术栈

- [x] Node(`packages/server-node`)
- [ ] Go(`packages/server-go`)

选择理由:Node/TypeScript 与现有 React 客户端共享类型语境,现有 Vitest、FakeModel 和可注入随机源也适合为 AgentContext、策略、顺序编排、质量门禁、评测与故障恢复建立确定性证据。只修改 `packages/server-node`,Go 基线保持原样。

## 1. 我完成了哪些任务线

- [ ] 任务线① Agent 决策与编排(让四个 AI 有各自策略、会利用逐步公开的信息、说话不泄题)—— 必做
- [ ] 任务线② 效果评测(用一个命令批量跑多局,输出可对比的质量指标)
- [ ] 任务线③ 可观测性与故障恢复(出问题时能看清、能复现、能优雅降级)
- [ ] 选做加分:前端体验优化 / 后端工程优化(见任务书第 3 节)

> 任务线④是现场当场揭晓的题目,带回家不用准备,这里也不用写。

未完成的部分及原因:①②③均处于实现阶段,完成和验证前不勾选。当前只完成了源码一致性审计、`baseline-v1`、Windows 契约启动兼容和基线验证;前端加分项暂不投入。

## 2. Coding Agent 使用记录

- 我用的工具(Cursor / Claude Code / TraeCode 等):Codex Desktop(本仓库的主开发 Agent)。
- 哪些改动主要是 Agent 生成的(涉及哪些文件 / 大致范围):截至当前,Codex 创建 `AGENTS.md`、`PLAN.md`、`README_CANDIDATE.md`、`docs/BASELINE_AUDIT.md`,并修改 `contract/run.mjs` 的跨平台启动方式;后续代码范围将在对应里程碑追加。
- 我人工审查和改动了哪些地方:用户明确纠正了初始任务中的目录复制和 README 归属方案;因此正式目录直接初始化,三个官方文档保持受保护,候选人报告单列。所有测试结论均在初始化后重跑,未沿用旧日志。
- **Agent 有一处给错了或给得不够好,我是怎么发现并纠正的**:发现官方 `spawn('npx')` 在 Windows 报 `ENOENT` 后,初步候选方案是把命令替换为 `npx.cmd`;用独立 `child_process.spawn` 探针实际运行后得到 `spawn EINVAL`,证明该建议仍不可靠。最终改为 `process.execPath + 已安装的 tsx CLI`,并用 28/28 契约、6/6 域测试和 build 验证。该修正避免 shell 依赖并能直接管理后端子进程。

## 3. 关键设计取舍

> 每条尽量写清:遇到什么问题 → 我怎么做的 → 放弃了哪个方案 → 为什么。

- ① 怎么让后发言的 AI 看到本轮前面已公开的描述,同时又保证它看不到别人的身份和词:
- ① 怎么让四个角色(谨慎 / 直觉 / 逻辑 / 出其不意)在同样局面下说出不一样的话:
- ① 怎么判断一条描述"太雷同或快泄题了",判定之后怎么处理(重试还是降级):
- ② 每个质量指标是怎么算的,阈值为什么定这个数:
- ③ 一条日志 / trace 里记了哪些字段,怎么保证不把密词和 Key 写进去:

当前基线观察:四个 `style` 值只存在于 `AI_PROFILES`,创建玩家时即被丢弃;`generateDescriptions` 对同一快照使用 `Promise.all`,因此同轮 AI 上下文不会逐步增长。详细证据见 `docs/BASELINE_AUDIT.md`;上述各题在对应实现完成时填写,不预先宣称结果。

## 4. 验证证据

> 贴命令 + 关键输出(注意别带上密钥或完整密词)。

- 契约(所选栈):`npm run contract:node` 基线首次因 Windows `spawn npx ENOENT` 在断言前失败;提交最小跨平台启动修复后真实结果为 28 通过 / 0 失败。
- 域测试 / 构建结果:`npm run test:node` 为 3 个测试文件、6 个测试通过;`npm run build` 的 Web Vite build(1,797 modules)和 Node `tsc --noEmit` 均通过。Node `v22.22.0`,npm `10.9.4`。`npm install` 因 lockfile 的 `bnpm.byted.org` URL 两次 `ECONNRESET`,但 `npm ls --all --depth=0` 退出 0,现有依赖树完整。
- 批量评测脚本的输出(指标表):
- 故障注入 + 定位到具体一局 / 某一轮 / 某个 AI / 第几次尝试的示例:
- 用真实模型完整跑一局的记录:
