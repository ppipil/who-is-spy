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
  上一版把差异主要做在“措辞”(core / speechStyle 不同),但每个 Persona 的 describe 里都写了“只给宽泛、低信息量 weak clue”,分析型还专门写“逻辑派不代表描述得更具体”,等于在 Prompt 层给四个人统一压低了信息预算;真实试玩里模型默认取最安全模板(“和生活有关”“很常见”),看起来只是换说法。
  本轮把“信息风险偏好”从安全规则里拆出来:Global Safety / EXPOSURE_POLICY / M4 Gate 完全不动,给四个 Persona 增加显式 `riskTolerance` 梯度(LOW / MEDIUM_LOW / MEDIUM_HIGH / HIGH),并为逻辑派、出其不意写清“允许更直接但必须给出可推理关系、不能越线”;同时加 `personalityAnchor`(ISTJ-like / INFP-like / INTP-like / ENTP-like)只作为内部稳定锚点,不替换题目 Persona 名,不进 README / UI。
  放弃“给每个人单独放宽安全规则”的做法——那会制造不同的安全上限,与“同一安全上限内不同信息预算”的目标相反。
- ① 怎么判断一条描述"太雷同或快泄题了",判定之后怎么处理(重试还是降级):
- ② 每个质量指标是怎么算的,阈值为什么定这个数:
- ③ 一条日志 / trace 里记了哪些字段,怎么保证不把密词和 Key 写进去:

当前基线观察:四个 `style` 值只存在于 `AI_PROFILES`,创建玩家时即被丢弃;`generateDescriptions` 对同一快照使用 `Promise.all`,因此同轮 AI 上下文不会逐步增长。详细证据见 `docs/BASELINE_AUDIT.md`;上述各题在对应实现完成时填写,不预先宣称结果。

② 评测 Harness 使用 seed 驱动引擎随机源,通过正常 `GameEngine` API 自动完成 N 局;同轮 AI 描述做规范化字符 bigram Dice 两两比较,并统计完局、泄漏、公开 DTO、有效票、延迟、Token 可用性和策略分组。Fake 硬门禁只设确定性正确性:完局率和有效投票率必须 100%,泄漏/非法状态必须为 0;理由是固定 seed + FakeModel 下任何放宽都会掩盖回归。真实模型波动指标暂不设拍脑袋阈值。非法投票注入测试证明门禁会失败,CLI 因此非 0 退出。

① 策略差异:新增注册表式 `AgentStrategy`,集中 description guidance、vote guidance 和 quality policy;四个 profile 只保存稳定 `strategyId`,不在 `GameEngine` 按名字分支。ID 经 allowlist 进入 AgentContext,DeepSeek 的描述/投票都解析策略指导,FakeModel 也按同一 ID 产生实际差异。同角色、同词、同公开局面的测试得到四种描述、四种理由和多个目标倾向;20 局 Fake 评测从单一 `baseline-unassigned` 分裂为四个策略聚合,同质化代理值由 0.7692 降到 0。放弃“只把 style 字符串拼 Prompt”的方案,因为它没有行为参数/质量政策边界,也无法可靠评测或现场扩展。Real 行为差异仍待真实模型验收,不以 Fake 结果冒充。

① 顺序与隔离:`generateDescriptions` 按稳定座位顺序循环,只在方法局部维护 staged descriptions;下一位上下文用“正式历史 + 已成功 staged 前缀”交给原 allowlist builder,不传完整状态后删字段。调用者只在整批返回后提交 descriptions/events/phase。测试观察到同轮 AI 前缀 `0→1→2→3`,并继续断言其他人的词不在序列化 Context;第四位故障时对完整内部状态做前后相等比较。投票保留同一公开快照上的 `Promise.all`,避免当前票型互相可见。放弃逐条直接 push 正式状态,因为最后一个 Agent 失败会留下半轮。

## 4. 验证证据

> 贴命令 + 关键输出(注意别带上密钥或完整密词)。

- 契约(所选栈):`npm run contract:node` 基线首次因 Windows `spawn npx ENOENT` 在断言前失败;提交最小跨平台启动修复后真实结果为 28 通过 / 0 失败。
- 域测试 / 构建结果:`npm run test:node` 为 3 个测试文件、6 个测试通过;`npm run build` 的 Web Vite build(1,797 modules)和 Node `tsc --noEmit` 均通过。Node `v22.22.0`,npm `10.9.4`。`npm install` 因 lockfile 的 `bnpm.byted.org` URL 两次 `ECONNRESET`,但 `npm ls --all --depth=0` 退出 0,现有依赖树完整。
- 批量评测脚本的输出(指标表):`npm run eval:node -- --games 20 --seed 42 --model fake` 退出 0:20/20 完局,完局率 100%,描述逻辑调用 174 次,有效投票 100%,非法输出/泄漏/重试 0,同质化代理指标 0.7692;全部 Agent 归入 `baseline-unassigned`。详见 `docs/EVALUATION.md`。
- 故障注入 + 定位到具体一局 / 某一轮 / 某个 AI / 第几次尝试的示例:
- 用真实模型完整跑一局的记录:

策略里程碑验证:`npm run test:node` 为 5 文件/10 测试通过;`npm run contract:node` 为 28/28;`npm run build` 通过;相同 seed 的 Fake eval 为 20/20 完局、四策略独立聚合、同质化 0。真实模型记录保持空白,直到实际调用成功。

顺序编排验证:`npm run test:node` 为 5 文件/11 测试通过(含 `0→1→2→3` 与第四 Agent 故障原子性);契约 28/28、Fake eval 20/20、build 通过。

### Persona 风险梯度打磨(独立 worktree,分支 `feat/persona-risk-tolerance`)

环境隔离:主目录 `D:\pp\code\project\who-is-spy` 存在另一个 Codex 窗口的未提交 Admin Console 改动;本轮在独立 worktree `D:\pp\code\project\who-is-spy-persona-polish`(基于提交 `0953d8c`)完成,未修改主目录任何文件;未 commit / push,未运行 M6 评测。

- `npm run test:node` → 12 测试文件 / 48 测试通过(新增 `persona-diagnostics` 2 个;原有 M3 同轮上下文、M4 重复/泄词门禁、隔离、model 等全部通过)。
- `npm run build` → web Vite build(1804 modules)+ server-node `tsc --noEmit` 通过。
- `npm run contract:node` → 28 通过 / 0 失败。
- `npm run persona-probe`(真实 DeepSeek,3 组固定 Case × 4 Persona × describe+vote = 24 次调用)→ 全部成功;`flagLowInformationClue` 诊断 3 组均 0 命中(该诊断只用于 probe 输出,不接入线上门禁)。

固定 Case 真实结果(每组 Case 内 same role / word / round / publicDescriptions / model / temperature,只切 Persona;私有词不在此列出):

Case 1(卧底 · 第2轮 · 后手位):

| Persona | Risk | Description | Vote | Reason |
| --- | --- | --- | --- | --- |
| 谨慎观察 | LOW | 我注意到它通常有固定的起点和终点。 | ai-1 | 阿序描述固定地点等待,与高铁常见但非唯一特征,且较模糊,略有偏差。 |
| 直觉敏锐 | MEDIUM_LOW | 长途出行时,它能帮你快速到达另一个城市。 | ai-1 | 描述过于泛化,像是临时编的,且没有具体场景支撑。 |
| 逻辑派 | MEDIUM_HIGH | 从这个角度看,它更多是一种连接方式。 | ai-1 | 阿序的“固定地方等它”与高铁站台候车更贴切,而我的词可能更强调移动过程,逻辑不够兼容。 |
| 出其不意 | HIGH | 它有时候反而会因为天气原因不太靠谱。 | ai-1 | 描述固定地点等待,更像固定线路,与高铁不符。 |

Case 2(平民 · 第2轮 · 后手位,公开描述均为泛化安全句):

| Persona | Risk | Description | Vote | Reason |
| --- | --- | --- | --- | --- |
| 谨慎观察 | LOW | 我注意到它通常在地下运行。 | ai-1 | 描述过于笼统,与多数人强调的常见性相比,缺乏具体细节。 |
| 直觉敏锐 | MEDIUM_LOW | 赶时间的时候,它总是在那里等着。 | ai-1 | 描述最空泛,未提供具体特征,疑似隐藏信息。 |
| 逻辑派 | MEDIUM_HIGH | 从一个点到另一个点的连接,往往在地下。 | ai-1 | 阿序发言过于宽泛,未提供具体特征,与其他描述兼容性存疑。 |
| 出其不意 | HIGH | 有时候人太多,挤得不行。 | ai-1 | 描述最泛化,无细节,疑似隐藏身份。 |

Case 3(卧底 · 第3轮 · 后手位,公开描述偏狐狸特征):

| Persona | Risk | Description | Vote | Reason |
| --- | --- | --- | --- | --- |
| 谨慎观察 | LOW | 通常和人很亲近。 | ai-1 | 阿序说聪明狡猾,但猫更常被描述为灵巧而非狡猾,略偏狐狸特性。 |
| 直觉敏锐 | MEDIUM_LOW | 有时候会懒洋洋地待着,让人想靠近。 | ai-2 | 弥生强调尾巴细节,可能偏离猫常见特征,更像狐狸。 |
| 逻辑派 | MEDIUM_HIGH | 从这个角度看,更像是一种会让人想靠近的动物。 | ai-1 | 阿序的描述笼统,未提到具体特征,与其他玩家具体描述不符。 |
| 出其不意 | HIGH | 但也不一定,有时候它们还挺粘人的。 | ai-1 | 阿序的描述过于抽象,与常见词语关联弱,疑似回避暴露。 |

观察:四个 Persona 在描述的信息量、切入角度与投票关注点上都出现明显梯度;Case 2 中后手位在公开局面已很泛化时,四个人都给出了各自风格下的具体化方向(地下 / 赶时间场景 / 点对点连接 / 拥挤),没有继续堆“很常见、和生活有关”类空话;逻辑派与出其不意明显更直接。

### Server 目录重组(分支 `preview/reliability-polish`)

- 目的:`packages/server-node/server/` 顶层 31 个文件全部平铺,按依赖方向分组为 `core/`(游戏核心)、`evaluation/`、`fault/`、`persona/`、`trace/`、`support/`;`app.ts` / `index.ts` / `app.test.ts` 保留顶层。
- 方法:`git mv` 移动 28 个文件(保留历史)+ 一次性 Node 脚本按文件新位置重写 82 处相对导入(保持 `.js` ESM 后缀约定),同步修正 `prompt.ts` 的 `traces/` 相对路径与 `package.json` 4 个 CLI 脚本路径(`eval` / `persona-probe` / `fault-demo` / `replay`)。
- 验证:`npm run build`(web Vite + server-node `tsc --noEmit`)通过;`npm run test:node` 12 文件 / 48 测试通过;`npm run contract:node` 28 通过 / 0 失败。未改任何运行逻辑,仅目录与导入路径。

### Admin Lite 采纳 Server 目录重组(分支 `feat/admin-lite`)

- 目的:在 Trace Lite 基础上吸收 `preview/reliability-polish` 的 server 文件编排,避免继续把核心、trace、evaluation、fault、persona、support 文件平铺在 `server/` 根目录。
- 方法:合入 `origin/preview/reliability-polish` 的目录重组;保留 Trace Lite 的 run lifecycle / vote / prompt debug / runtime trace 接线;新增 `server/admin/trace-routes.ts`,让 `app.ts` 只挂载 Admin API router。
- 验证:`packages/server-node` 下 `npm run build` 通过;`packages/server-node` 下 `npm test` 为 14 文件 / 52 测试通过;仓库根目录 `npm run contract:node` 为 28 通过 / 0 失败;`packages/web` 下 `npm run build` 通过。未运行真实 DeepSeek。
### Admin Trace 本地持久化(分支 `feat/admin-lite`)

- 目的:解决刷新 / 后端 watch reload 后 Admin Trace 只存在内存导致记录消失的问题。
- 方法:新增 Admin runtime JSONL store,默认写入并回读 `packages/server-node/traces/admin-runtime.jsonl`;`ADMIN_TRACE_JSONL` 可覆盖路径,设置为 `0` / `off` / `memory` 时退回纯内存。Admin API 继续从统一 `runtimeTrace.events` 读取,避免文件与内存重复显示。
- 验证:`packages/server-node` 下 `npm run build` 通过;`npx vitest run server/admin-lite.test.ts server/trace/trace-lite.test.ts` 为 2 文件 / 5 测试通过;`packages/server-node` 下 `npm test` 为 14 文件 / 53 测试通过;仓库根目录 `npm run contract:node` 为 28 通过 / 0 失败;`packages/web` 下 `npm run build` 通过。未运行真实 DeepSeek。