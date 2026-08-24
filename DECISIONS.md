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
### Admin Evaluation MVP(分支 `feat/admin-lite`)

- 目的:按 `docs/PRD.md` 的短版 Evaluation MVP 增加 `/admin` Evaluation 页面,保留 Run Evaluation / Report Detail / Report History,不建设 Dataset/Case/Experiment 平台。
- 复用结论:新增后端前已审计 `server/evaluation/evaluation.ts` 与 `server/evaluation/eval-cli.ts`;现有 `runEvaluation()` 已覆盖 game runner、completion、valid vote、homogeneity、latency、retry 和 safety gate,因此 Admin 后端只新增 thin adapter `server/admin/evaluation-routes.ts` 调用现有 harness。未新增第二套 evaluation engine。
- 范围:前端新增 `admin/evaluation/` 模块和 Admin nav;后端新增 `/api/admin/evaluation/cases`、`/api/admin/evaluations`、`POST /api/admin/evaluations`;AI Judge 结构按 PRD 保留为 `Unavailable` adapter,不自动调用真实 DeepSeek,不影响 engineering gate。
- 限制:现有 GameEngine/harness 暂不支持精确指定固定词对和 Human role,因此两个 canonical cases 第一版通过 `humanDescriptions` 薄参数扩展传入 Normal/Nonsense Human 输入;词对/角色仍由现有 deterministic harness 决定,不重写 GameEngine 来强塞评测场景。
- 验证:`packages/server-node` 下 `npm run build` 通过;`npx vitest run server/admin-lite.test.ts server/evaluation/evaluation.test.ts` 为 2 文件 / 6 测试通过;`packages/server-node` 下 `npm test` 为 14 文件 / 54 测试通过;仓库根目录 `npm run contract:node` 为 28 通过 / 0 失败;`packages/web` 下 `npm run build` 通过。未运行真实 DeepSeek。
### 禁止题目字发言 + Trace 时间显示小修复(分支 `feat/admin-lite`)

- 目的:真人和 AI 描述都不能提到题目词本身或题目词里的任一中文单字,例如 `雨伞`/`雨衣` 场景下描述中出现 `雨`、`伞`、`衣` 都会被拒绝;Admin Trace Timeline 与 Inspector 显示每条 trace 的发生时间。
- 方法:复用 `DescriptionQualityGate` 新增 `secretLeakTerms()` 生成完整词 + 中文单字禁用片段;`GameEngine.submitHumanDescription()` 对所有题目词使用同一禁词集;Describe prompt 升级到 `describe-v5` 并明确禁止使用词语中的任一汉字。Trace 前端从事件/prompt timestamp 汇总 `occurredAt`,Timeline 显示本地时分秒,Inspector 显示完整本地时间。
- 验证:`npm test --workspace packages/server-node -- server/core/description-quality.test.ts server/core/game-engine.test.ts server/core/prompt-policy.test.ts` 为 3 文件 / 17 测试通过;`npm run build --workspace packages/web` 通过;`npm run test:node` 为 14 文件 / 54 测试通过;`npm run build --workspace packages/server-node` 通过;`npm run contract:node` 为 28 通过 / 0 失败。未运行真实 DeepSeek。

### Admin Evaluation report 持久化与两栏历史(分支 `feat/admin-lite`)

- 目的:解决 Admin Evaluation 新跑报告刷新后容易丢失/只显示 Latest Run、以及本地运行报告挤压 Baseline/M1-M6 存档占位的问题;同时给长耗时运行增加前端 in-flight 进度反馈。
- 方法:后端 `/api/admin/evaluations` 拆成 `reports`(本地 Admin runs)和 `archivedReports`(Baseline/M1-M6 存档占位),本地报告默认写入 `packages/server-node/traces/admin-evaluation-reports.json`;前端 Report History 拆成 Local Admin Runs / Archived Milestones 两栏,运行时显示模型、case 数、elapsed 和当前阶段。AI Judge 仍保持 `Unavailable` adapter,未自动调用真实 DeepSeek。
- 验证:`packages/server-node` 下 `npm run build` 通过;`npx vitest run server/admin-lite.test.ts server/evaluation/evaluation.test.ts` 为 2 文件 / 6 测试通过;`packages/web` 下 `npm run build` 通过;仓库根目录 `npm run contract:node` 为 28 通过 / 0 失败。未运行真实 DeepSeek。
- 补充:本轮同时修正 canonical Normal/Nonsense `humanDescription` 已传入但未被 `driveGame()` 使用的问题;重新验证结果同上:server build、Admin/Evaluation 定向测试、web build、contract:node 均通过。
- 补充:AI Judge adapter 已接入用户触发的 Admin Evaluation run:有 `DEEPSEEK_API_KEY` 时最多调用一次并失败 retry 1 次,成功后代码按 25/20/20/20/15 权重计算 AI Behavior Score;无 key/失败时标记 `unavailable`,不影响 engineering gate。Judge evidence 仅包含公开描述、公开投票理由与 deterministic metrics,不包含密词、角色或完整 prompt。验证:server build、Admin/Evaluation 定向测试、web build、contract:node 均通过。
- 补充:AI Judge 不再在 Admin route 中手写 raw fetch;改为通过 `DeepSeekClient.completeJson('judge', ...)` 复用模型层 baseUrl/model/JSON parsing/错误分类。至少一个已完成且含公开描述/投票证据的 canonical case 即可调用 Judge;只有 Human Input Responsiveness 仍要求 Normal+Nonsense 都完成。评测固定使用 `雨伞`/`雨衣`,评测描述只禁止完整词,真人对局继续禁止完整词及其汉字。
- 调试与验证:`EVALUATION_DEBUG=1` 时仅输出阶段、case 完成布尔值和模型 `task/attempt/errorType/httpStatus/causeCode/willRetry`,不输出 key、Prompt、题目词或模型内容;同时修正 Evaluation 包装层未转发 `DescriptionRequest` 的问题。定向测试为 7 文件 / 35 测试通过;`npm run test:node` 为 14 文件 / 59 测试通过;server build、web build 通过;`npm run contract:node` 为 28 通过 / 0 失败。本次验证未调用真实 DeepSeek。

### Admin Trace 筛选与状态语义修复(分支 `feat/admin-lite`)

- 目的:把 Trace 运行列表从 runId/gameId/round/agent 等内部字段筛选收敛为统一 ID + 来源 source 筛选;旧 trace 如果只有 running lifecycle 且最后事件已经超过 10 分钟,前端显示为“未关闭旧记录 stale”,避免误导成正在运行。
- 验证:`npm run build --workspace packages/server-node` 通过;`npm run build --workspace packages/web` 通过;`npm test --workspace packages/server-node -- server/admin-lite.test.ts` 为 1 文件 / 6 测试通过。

### Admin Trace 文案收敛与来源归类修复(分支 `feat/admin-lite`)

- 目的:Trace 时间线与提示词检查器不再把同义中文/英文标签同时显示,减少提示词面板和时间线节点溢出;缺少来源的历史 trace 不再默认显示成网页对局,GameEngine 统一给同一局所有 trace 事件盖上真实来源。
- 范围:网页端显式标记为 `USER_GAME/web`;未显式传来源的测试型 GameEngine 默认为 `TEST/test`;故障注入 CLI 标记为 `FAULT_RUN/cli`;前端增加未知来源显示和 prompt 文本换行/框内滚动约束。
- 验证:`npm run build --workspace packages/server-node` 通过;`npm run build --workspace packages/web` 通过;`npm test --workspace packages/server-node -- server/core/game-engine.test.ts server/fault/fault-injection.test.ts server/trace/trace-lite.test.ts server/admin-lite.test.ts server/evaluation/evaluation.test.ts` 为 5 文件 / 22 测试通过;`npm test --workspace packages/server-node` 为 14 文件 / 58 测试通过;`npm run contract:node` 为 28 通过 / 0 失败。


### Admin Evaluation 五维独立 Judge 与 Trace 可观测性(分支 `feat/admin-lite`)

- 目的:Persona Adherence、Semantic Diversity、Context Utilization、Human Input Responsiveness、Exposure Control 改为五次互相隔离的 Judge 维度；任一维失败只把该维标成 `Unavailable`，其余维度与 Engineering Gate 保持有效。只有 5/5 可用时为 Full AI Behavior Score，否则按当前可用维度权重归一化计算 Partial Score。
- 方法:五个 definition 各自声明 prompt version、schema 实例、0–10 rubric、25/20/20/20/15 权重和最小 evidence selector，共用一个 dimension runner；底层仍调用 `GameModel.completeJson('judge', ...)`，复用 `DeepSeekClient` 的 transport、JSON parser、错误分类和 retry。每维 schema 单独要求非空 `reason/evidence/summary` 且包含中文，system prompt 强制简体中文。Persona 只收 strategy + descriptions，Semantic 只收 descriptions + lexical proxy，Context 只收 Human input + 有序 descriptions，Human Responsiveness 只在 Normal/Nonsense 都完成时收配对摘要，Exposure 只收 safety/quality metrics + descriptions；不向 Judge 传 vote reasons、角色或密词，固定题目词在模型上下文前脱敏。
- Trace:每维使用独立 `promptTemplateVersion` 和 `ai-judge-<dimension>` agentId，Prompt Inspector 只保存安全计数/字段摘要，真实 evidence 仅参与模型请求与 prompt hash；每维 schema retry、成功/失败与输出单独记录。
- 验证:`npm.cmd run build` 前后端通过；`npm.cmd test --workspace packages/server-node -- --run server/admin-lite.test.ts` 为 1 文件 / 8 测试通过；`npm.cmd run test:node` 为 15 文件 / 65 测试通过（含 provider、quality-gate、fault mock/FakeModel 覆盖）；`npm.cmd run contract:node` 为 28 通过 / 0 失败。FakeModel 覆盖单 Case 4/5 Partial、双 Case 5/5 Full、Semantic 英文/schema 连续失败但另外四维成功，以及五维独立 prompt/trace/evidence keys/题目词脱敏。本轮未调用 DeepSeek，未执行真实 Evaluation，未 commit。

### Admin Evaluation 最终收尾：Judge 评级一致性与本地记录折叠(分支 `feat/admin-lite`)

- Judge:五个独立 prompt 共用同一评分表：9–10 Excellent/优秀、7–8 Good/良好、5–6 Average/一般、3–4 Weak/较弱、0–2 Poor/很差；维度 score 限定为 0–10 整数，reason/summary 必须分别显式包含与 score 对应的唯一“评级：…”中文标签。schema 会拒绝缺失或冲突标签并仅重试/停用该维度，现有五维权重、Partial 归一化和仅 5/5 为 Full 的逻辑未改。
- History:Local Admin Runs 继续使用后端最新优先排序，默认只渲染前 5 条；存在更多记录时显示 `Show more` 并一次展开剩余本地记录。Archived Milestones 数据、顺序和渲染未改。
- Trace 展示收尾:删除 Evaluation run 顶部“评测固定关键词 Evaluation fixture”横幅及其专用样式；底层 `fixtureWords` trace 数据保留，不改变追踪、评测默认词或可编辑题目能力。删除后 `npm.cmd run build --workspace packages/web` 通过。
- 轮次布局收尾:Evaluation rounds 的标题与 72px select 使用明确两列，说明文字跨越整行；720px 以下改为单列堆叠，避免通用 label 的第二列规则把说明或标题挤进选择框区域。`npm.cmd run build --workspace packages/web` 通过，`git diff --check -- packages/web/src/admin/evaluation/evaluation.css` 无 whitespace error。
- 验证:`npm.cmd test --workspace packages/server-node -- --run server/admin-lite.test.ts` 为 1 文件 / 9 测试通过，新增 score=5 但文字为“优秀”时 Persona 单维两次 schema 失败、其余四维保持可用的覆盖；provider/quality-gate/prompt/fault/Admin 定向测试为 5 文件 / 35 测试通过；`npm.cmd run build` 前后端通过；`npm.cmd run test:node` 为 15 文件 / 66 测试通过；`npm.cmd run contract:node` 为 28 通过 / 0 失败。未调用 DeepSeek，未执行真实 Evaluation，未 commit。
### Admin Evaluation 可编辑配置与 DeepSeek 前端入口(分支 `feat/admin-lite`)

- 目的:Evaluation runner 不再把题目和 Human 输入锁死；默认保留 `雨伞/雨衣`、Normal/Nonsense 文案，但 Admin 用户可编辑平民词、卧底词、每个 Case 的 Human 输入，并选择每个已选 Case 重复 1–5 轮。页面显示 DeepSeek 实际 model 与 configured/Ready 状态。
- 后端:`POST /api/admin/evaluations` 接收 `wordPair`、`caseInputs`、`rounds`，校验两词非空且不同、Human 输入长度和轮次边界；Fake 始终使用 `FakeGameModel`，Real 始终创建环境配置的 `DeepSeekClient`。自定义词对同时传给 `runEvaluation` 和 Judge 脱敏，不写入公开报告或 trace。`GET /api/admin/evaluation/cases` 仅返回无密钥的 provider model/configured 状态。
- 前端:保持 Evaluation 三栏与 Report History 结构，只在 Run Evaluation 卡片加入词对 input、Case textarea、轮次 select 和 DeepSeek Ready 提示；运行期间显示实际 games=`selected cases × rounds`，刷新 History 不覆盖用户当前编辑值。
- Fake 冒烟:通过前端 Vite proxy 向 `http://localhost:5173/api/admin/evaluations` 提交 `model=fake`、单 Normal Case、`rounds=1`、`judgeEnabled=false`；报告 `eval-62b69340-8194-45bd-b148-cc932e3ade2b` 为 1/1 completed、Gate PASS、Judge disabled。同一配置接口只读确认 `deepseek-chat` configured=true，未调用 DeepSeek。
- DeepSeek 网络诊断:用户前端报告 `eval-7152ceeb-621f-4f79-a8f1-aa7c7610b8ad` 的两个 game 都在 `ai-1 describe` 失败，脱敏 trace 为每局 4 次 `errorType=network`、无 HTTP status、80–260ms 内失败；case error 为“AI 描述失败：网络不可用”。`Resolve-DnsName` 成功，TCP 443 成功，PowerShell 无鉴权 HEAD 返回 401；同机 Node 22 原生 fetch 无代理时报 `ECONNRESET`，`node --use-env-proxy` 无鉴权 HEAD 返回 401，确认根因为 Node 未使用现有 HTTP(S) proxy。
- 代理修复:`packages/server-node` 的 dev/start 改为 Node 22 官方 `--use-env-proxy` 启动；运行中的前端配置接口返回 `deepseek-chat / configured=true / envProxyEnabled=true`，页面区分 Configured 与 Proxy on/off。修复后只重启并验证无鉴权连通性，未再次提交 DeepSeek Evaluation。
- 验证:`npm.cmd run build` 前后端通过；Admin Lite 定向测试 1 文件 / 8 测试通过，并覆盖自定义 `风筝/气球`、自定义 Human 输入和每 Case 两轮；`npm.cmd run test:node` 为 15 文件 / 65 测试通过；`npm.cmd run contract:node` 为 28 通过 / 0 失败。未执行真实模型评测，未 commit。

### Evaluation Provider Token / Cost(分支 `feat/admin-lite`)

- 目的:补齐任务书要求的 Token 与成本指标；不把 FakeModel 的本地调用显示成 0 成本，也不对未知模型猜价。
- 方法:`DeepSeekClient` 从成功 HTTP 响应的 `usage` 读取 prompt/completion/total 和 cache hit/miss tokens，通过独立 telemetry sink 上报，不改变 `describe/vote/review` 的业务返回；Evaluation accumulator 覆盖游戏调用及可选 Judge 调用。成本优先使用三个环境变量覆盖，否则只对 provider 实际返回的官方 `deepseek-v4-flash` / `deepseek-v4-pro` 家族按 UTC 峰谷价格计算，未知模型只报告 Token、Cost 保持 unavailable。价格于 2026-08-24 对照 DeepSeek 官方 Models & Pricing 页面确认。
- 真实验证:先用最小官方请求确认响应包含 usage(34 input / 5 output / 39 total，实际模型 `deepseek-v4-flash`)；随后通过 Admin API 跑 1 个真实 canonical Case、关闭 Judge，报告 `eval-bb30f669-bda3-4587-90c7-2bbec59a4ff0` PASS，13 次计费响应，10,724 input / 845 output / 11,569 total，官方 peak 成本 `$0.00343473`，每局同值。首次完整 Case 因四次 network failure 明确 FAIL，未错误生成 Token/Cost。
- 验证:`packages/server-node` build 通过；`packages/web` build 通过；provider/quality/prompt/fault/evaluation/pricing/admin 定向测试 7 文件 / 41 测试通过；`npm run test:node` 15 文件 / 65 测试通过；`npm run contract:node` 28 通过 / 0 失败。

### Admin Evaluation M1–M6 真实归档证据(分支 `feat/admin-lite`)

- 来源：通过 `git show <branch>:<path>` 实际读取 `eval/m1-real-smoke:docs/evidence/m1-baseline/summary.md`、`eval/m2-persona:docs/evidence/m2-persona/summary.md`、`eval/m3-sequential:docs/evidence/m3-sequential/summary.md`、`eval/m4-quality-gate:docs/evidence/m4-quality-gate/summary.md`、`eval/m5-reliability:docs/evidence/m5-reliability/summary.md`、`eval/m6-final-comparison:docs/evidence/m6-final-comparison/summary.md`。M1–M6 的 version/stage、evaluated commit、model、games/seeds、completion、valid vote、homogeneity、latency、token/cost、gate/result 和阶段结论来自这些 summary，未重新运行历史版本。
- 展示：归档报告使用独立 `archivedEvidence`，不再构造 FakeModel、0% 或 gate FAIL 的占位 `EvaluationResult`；M4 summary 未报告的 homogeneity，以及 M5 未汇总的 homogeneity、latency、provider token/cost 显示 `Not measured`。M1 的 3-game smoke token/cost 与单独 1-game usage smoke 明确分开。M0 不生成独立 Evaluation Report，official baseline 通过 M1 的 `7d98e19` 来源和 M6 paired baseline 展示。当前 Canonical Eval 本地报告保持不变。
- 链接：六条记录均使用 `https://github.com/ppipil/who-is-spy/blob/<branch>/<path>/summary.md`，在 History 和 Detail 提供 `View Evidence / GitHub`。
- 验证：仓库根目录 `npm.cmd run build` 通过（Web `tsc --noEmit` + Vite、Node `tsc --noEmit`）；`npm.cmd test --workspace packages/server-node -- --run server/admin-lite.test.ts` 为 1 文件 / 8 测试通过；`npm.cmd run contract:node` 为 28 通过 / 0 失败；`git diff --check` 无 whitespace error。未调用真实 DeepSeek，未重跑 M1–M6。
- 默认开关：Admin Console 现在默认开启，只有显式设置 `ENABLE_ADMIN_CONSOLE=0` 才关闭；根 `.env` 与 `.env.example` 记录 `ENABLE_ADMIN_CONSOLE=1`。运行中的 `/api/admin/evaluations` 返回 M1–M6 共 6 条归档记录；`npm.cmd run build --workspace packages/server-node` 通过，Admin Lite 定向测试仍为 1 文件 / 8 测试通过。

### Admin Lite Fault Demo 两阶段恢复与 Trace（分支 `feat/admin-lite`）

- 复用：继续使用 `FaultInjectingModel` / `FaultSpec`、`GameEngine.resumeDescription()`、description pending state、`recovery_action`、local review fallback、`TraceEventStore` 与 `replayTrace()`；未新增第二套 fault engine，未调用 DeepSeek。
- 后端：三个固定 deterministic fake 场景由 thin `FaultDemoService` 驱动；Timeout 两次自动尝试均注入 timeout 后保持 `describing` 和已提交描述，通过 `POST /api/admin/fault-demos/:runId/recover` 才触发现有 manual resume；活动 session 仅保存在内存并限制 30 分钟 / 20 条，不建设 Fault History。Bad JSON 保留 invalid_json 后自动 retry；Review 两次 provider_5xx 后使用 local fallback。
- Trace/UI：注入事件使用现有 `injectedFault` 字段；Fault run lifecycle 写入 scenario/faultType/targetAgent/scenarioOutcome。新增 `FAULT_RUN` 来源筛选、完整 run-summary API、Review 时间线、真实 retryable 展示、自动展开、故障来源 Inspector 和 redacted Replay；移除未记录却硬编码的 600ms。Fault 页面拆分 `FAULT TRIGGERED` 与 outcome，并显示 Attempt Timeline、State Protection、Restore Provider & Resume。
- 实际 API：Timeout 为 `FAILED → retry scheduled → FAILED → retry exhausted`，状态 `PAUSED SAFELY/describing`；恢复后为 `manual resume → SUCCESS → RECOVERED`，进入 `voting`。Bad JSON 为 `FAILED → retry scheduled → SUCCESS / RECOVERED BY RETRY`。Review 为 `FAILED → retry → FAILED → exhausted → fallback / RECOVERED BY FALLBACK`。对应 Trace run 均为 `FAULT_RUN`，Replay 可还原失败、重试、恢复和公开状态推进。
- Tab 持久化：Admin Trace / Evaluation / Fault 三个页面改为始终挂载并仅通过 `hidden` 切换可见性，避免切换 Tab 时销毁表单、报告、Fault 结果与 Trace 选择；Trace 同步响应持久挂载后的 runId prop 更新，保留 View Trace 定位。`npm.cmd run build --workspace packages/web` 通过。
- 验证：`npm.cmd run build` 前后端通过；provider/quality/prompt/fault/trace/Admin 定向测试 7 文件 / 41 测试通过；`npm.cmd run test:node` 16 文件 / 70 测试通过；`npm.cmd run contract:node` 28 通过 / 0 失败。未 commit。

### Agent / Evaluation / Trace 当前实现审计与中文注释（未 commit）

- 范围：仅审计 `packages/server-node`；新增 `docs/AGENT_DESIGN_AUDIT.md`，列出三条任务线的文件/函数、问题→做法→放弃方案→原因、指标公式/阈值、故障恢复和 trace 字段。函数级中文 TSDoc 覆盖 AgentContext、GameEngine 编排/恢复/投票、Persona、质量门禁、Prompt/Model 重试、Evaluation、Trace 与 Fault Demo，可直接用于面试讲解；未修改 `packages/server-go`。
- 边界结论：Runtime model trace 不写 API Key、完整 Prompt、原始响应或评测固定词；Prompt Debug 对字符串做敏感词子串替换。`prompt_provenance.role` 仍保存当前 Agent 身份，报告明确标为仅限管理员的私有诊断数据和可进一步收紧项。
- 定向验证：`npm.cmd test --workspace packages/server-node -- --run server/core/agent-context.test.ts server/core/game-engine.test.ts server/core/agent-strategy.test.ts server/persona/persona-distinguishability.test.ts server/core/description-quality.test.ts server/core/prompt-policy.test.ts server/core/model.test.ts server/fault/fault-injection.test.ts server/core/description-resume.test.ts server/evaluation/evaluation.test.ts server/evaluation/usage-metrics.test.ts` 为 11 文件 / 48 测试通过。
- 完整验证：`npm.cmd run build --workspace packages/server-node` 通过；`npm.cmd run test:node` 为 16 文件 / 70 测试通过；`npm.cmd run contract:node` 为 28 通过 / 0 失败。未调用真实 DeepSeek，未 commit。


### Evaluation 配置与 Trace 脱敏边界收口（未 commit）

- 边界：Evaluation 表单/API 继续显示可编辑题目配置，便于明确评测输入；观测链路不再保存 `trace_run.fixtureWords`，从 `EvaluationOptions → GameEngine → TraceRunMetadata/API → Trace UI` 删除该字段，未改变评测运行所需的 `wordPair`。
- 源头脱敏：Prompt Debug 对所有字符串执行敏感词子串替换，不再只处理字段值完全相等的情况；AI Judge 的 `inputSummary` 与 `output` 在写入 runtime trace 前使用同一 sensitive terms redactor 二次脱敏。
- 历史清理与运行验证：只把 `packages/server-node/traces/*.jsonl` 内已知评测词替换为 `[REDACTED]`，保留 Trace 结构与事件；随后重启 Node 后端并运行一次 deterministic fake Evaluation（未调用 DeepSeek），报告 PASS，`admin-runtime.jsonl` / `prompt-trace.jsonl` / `runtime-trace.jsonl` 的完整评测词命中和 `fixtureWords` 字段数均为 0。
- 验证：Prompt/Admin 定向回归为 2 文件 / 16 测试通过；`npm.cmd run build` 前后端通过；`npm.cmd run test:node` 为 16 文件 / 71 测试通过；`npm.cmd run contract:node` 为 28 通过 / 0 失败。
