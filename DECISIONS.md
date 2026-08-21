# 过程与决策记录(候选人填写)

> 这份文档用来记录你「怎么用 Coding Agent、做了哪些判断」,是评分的重要依据之一。
> 请边做边写,不要事后补。下面的空模板保留,按你的实际情况填。

## 0. 我选择的技术栈

- [x] Node(`packages/server-node`)
- [ ] Go(`packages/server-go`)

选择理由:Go 的优势主要是高并发、性能和部署比较轻，但这个项目真正的瓶颈是模型调用，不是后端算力，所以 Node 已经够用了。我又比较熟 TypeScript，而且前端也是 TS，前后端类型可以统一。Agent 这类应用本身又有很多结构化状态、Prompt 输入和模型输出，TypeScript 的类型约束会比较方便。这次我还大量用了 Codex，清晰的类型和接口也更方便它做跨文件修改，所以综合开发效率我选了 Node。只修改 `packages/server-node`,Go 基线保持原样。

## 1. 我完成了哪些任务线

- [ ] 任务线① Agent 决策与编排(让四个 AI 有各自策略、会利用逐步公开的信息、说话不泄题)—— 必做
- [x] 任务线② 效果评测(用一个命令批量跑多局,输出可对比的质量指标)
- [ ] 任务线③ 可观测性与故障恢复(出问题时能看清、能复现、能优雅降级)
- [ ] 选做加分:前端体验优化 / 后端工程优化(见任务书第 3 节)

> 任务线④是现场当场揭晓的题目,带回家不用准备,这里也不用写。

未完成的部分及原因:任务线②已在当前分支完成实现并通过验证(命令、指标表、回归用例、门禁、Admin 批量评测界面,证据见 §4);①③仍处于实现/验证阶段,完成和验证前不勾选;前端加分项暂不投入。

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

② 评测 Harness 使用 seed 驱动引擎随机源,通过正常 `GameEngine` API 自动完成 N 局;同轮 AI 描述做规范化字符 bigram Dice 两两比较,并统计完局、泄漏、公开 DTO、有效票、延迟、Token 可用性和策略分组。Fake 硬门禁只设确定性正确性:完局率和有效投票率必须 100%,泄漏/非法状态必须为 0;理由是固定 seed + FakeModel 下任何放宽都会掩盖回归。真实模型波动指标暂不设拍脑袋阈值。非法投票注入测试证明门禁会失败,CLI 因此非 0 退出。

② Admin 控制台把同一 Harness 变成一键批量评测:`POST /api/admin/evaluation/run`(参数校验、单飞 409、real 未配置 400),`GET /evaluation/runs` 与 `/runs/:id` 提供历史、进度和完整结果;页面展示门禁 PASS/FAIL 及失败项、与官方基线的 delta 表、策略分组、Token 分任务用量与估算成本(provider usage 实测,deepseek-chat 公开价快照 $0.27/$1.10 per 1M,仅估算)、同 seed fake 运行的可复现性校验。放弃“静态数字页”方案,因为它无法体现可复现/可回归闭环。

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

Admin 评测控制台验证(任务线②收口):`npm run test:node` 为 12 文件/57 测试通过(新增评测运行 API 单测:参数校验、409 单飞、gate FAIL 记录、real 未配置 400、provider usage/cost 采集与 onProgress 进度);`npm run contract:node` 为 28/28;`npm run build`(web tsc+vite、node tsc)通过。API 实测(`ENABLE_ADMIN_CONSOLE=1`):`POST /api/admin/evaluation/run` `{games:3, seed:42, model:"fake"}` → 202 `{runId}`;轮询 `GET /api/admin/evaluation/runs/:runId` → `completed`、gate PASS、3/3 完局、同质化 0、latencyP50 0.0315ms。CLI `npm run eval:node -- --games 4 --seed 42 --model fake` 指标表新增 qualityRepairCount、providerRetryCount、每局 token 与成本行(fake 下 token/cost 为 unavailable,真实模型返回 usage 时自动实测)。涉及文件:`server/evaluation.ts`、`server/model.ts`、`server/eval-cli.ts`、`server/admin/evaluation-runs.ts`、`server/app.ts`、`server/admin-api.test.ts`、`server/evaluation.test.ts`、`web/src/admin/adminApi.ts`、`web/src/admin/AdminConsole.tsx`、`web/src/admin/definitions.ts`、`web/src/admin/admin.css`。

评测与 Trace 关联验证:`npm run test:node` 12 文件/58 测试、`npm run contract:node` 28/28、`npm run build` 通过。实现:`runEvaluation` 新增 `runId`/`traceSink` 选项,评测局发布 `evaluation_game_start/completed/failed` 生命周期事件并给所有 trace 事件打 `runId` + `source:'evaluation'` 标记;`/api/admin/traces` 支持 `runId` 筛选;页面 Evaluation → Trace 带 runId 跳转。API 实测:fake 1 局运行后 `GET /api/admin/traces?runId=<id>` 返回 2 条事件(start/completed),全部带正确 runId/source 标记。

Admin「Task ① 验收」证据汇总页:`npm run test:node` 12 文件/59 测试、`npm run contract:node` 28/28、`npm run build` 通过。仅新增证据聚合,不改 GameEngine/Persona/Quality Gate。A 同轮上下文:实时从 prompt provenance(sanitized 输入)提取 ai-3 实际收到的同轮 publicDescriptions,实测 real 1 局后 `GET /api/admin/task1` 返回 老墨/ai-3/Round 2、sameRound=3(human/ai-1/ai-2 三条真实文本)、describe-v3 + hash。B Persona 可区分:运行现有 `npm run persona-probe`(真实 deepseek-chat,2026-08-20 10:21 +08)得到四组真实描述/投票/理由,存 `server/admin/task1-evidence.ts`,同一局面(undercover/高铁/相同 3 条公开描述)仅切换 persona 时输出不同。C Quality Gate:复用 `description-quality.test.ts` 确定性用例(attempt #1 LEXICAL_DUPLICATE similarity 1.0 ≥ 0.72 → REJECTED → repair → attempt #2 PASSED → COMMITTED;GameState 仅含修复后文本)。页面新增 Tab「Task ① 验收」+ `GET /api/admin/task1` 接口,沿用 Admin Console 现有样式。未 commit/push。

Task ① 验收台升级为可交互:`npm run test:node` 12 文件/63 测试、`npm run contract:node` 28/28、`npm run build` 通过。A/B/C 各模块均支持自定义输入并保留默认值:`POST /api/admin/task1/context` 用真实 `buildDescribePrompt` 重算(编辑任一文本 → promptHash 变化,实测 b4737ed7fe0e → ec88d1fab419);`POST /api/admin/task1/persona/run` 复用 persona-probe 逻辑以自定义局面跑真实模型(实测 civilian/地铁 四套描述与理由均不同);`POST /api/admin/task1/quality` 用真实 `DescriptionQualityGate` 实时检查候选(实测 REJECTED→PASSED、committed=修复后文本、notCommitted=被拒候选)。A 默认载入最近真实 prompt provenance 记录并支持跳转 Prompt Trace。未 commit/push。

Task② Evaluation 页重构:`npm run test:node` 12 文件/63 测试、`npm run contract:node` 28/28、`npm run build` 通过。页面拆为两模块:①Baseline vs Final(顶部,展示 M6 canonical 数据:commit 7d98e19 vs 49eb39d、seeds 101–105、5 vs 5、同一套 deepseek-v4-flash 设置;指标表含完成率 100% vs 80%(不美化)、雷同度 0.0640 vs 0.0107(标注 lexical homogeneity 非语义)、P50/P95、token/cost、retry/repair;收益 vs 代价/Bad Case 双区结论;GitHub 报告链接实测 200:baseline=`blob/2d3ee69/docs/evidence/m1-baseline/summary.md`,final=`blob/9d1a285/docs/evidence/m6-final-comparison/summary.md`);②可重复评测工具(固定配置→批量运行→采集→计算→Report pipeline;10 项指标 checklist;Runbook 真实命令 `npm run eval:node -- --games N --seed S --model fake|real`、门禁非 0 退出、JSON 落盘、test/contract/build 门禁;保留在线运行同一 Harness 的演示区)。未 commit/push、未重跑 M6、未改评测逻辑。

Task① 页面重构为三 Tab 验证实验台:`npm run test:node` 12 文件/65 测试、`npm run contract:node` 28/28、`npm run build` 通过。Tab1 顺序上下文验证:新增 `POST /api/admin/task1/sequential/run`,用真实 GameEngine 跑一轮(仅注入随机源选中用户词对 地铁/高铁,角色分配走引擎正常逻辑),Human→ai-1→ai-4 顺序生成;实测同轮计数 0→1→2→3→4、每个 Agent 的 receivedSameRound 与计数一致、真实 describe-v3 prompt(含 version/hash)与模型输出;点击时间线可看该次调用收到的同轮先发描述 + sanitized prompt + [查看 Prompt Trace] 跳转;记录复用现有 prompt provenance(describe 记录 sameRound 1–4,vote 记录 sameRound=5 属正常投票上下文)。Tab2 Persona 对照:固定 ai-3/老墨 席位只切 strategyId(严格 Same Seat/Only Persona Changes),运行结果含四份 describe/vote rendered prompt(version/hash/guidance),卡片可展开查看;Prompt Trace 标题显示 Persona 前缀(如 谨慎观察 · task1-probe · R2 · ai-3)。Tab3 Quality Gate:保留真实 gate 检查 + 预设(泄题/雷同)+ 状态证明(Before N → Rejected N → Accepted N+1),similarity 标注为 Lexical。真实模型不可用时 Tab1/Tab2 明确显示 Real model unavailable。未 commit/push、未重跑 M6、未改 GameEngine 核心规则。

Task① 状态保持修复:`npm run build` 通过。原实现 `{tab === 'task1' && <Task1AcceptancePanel/>}` 在切到 Prompt Trace 时卸载面板,切回后实验进度(时间线/persona 结果/输入)全部丢失;改为保持挂载 + `display:none` 隐藏,切换 Tab 不销毁实验状态。其余 Tab 仍为条件挂载,如需同样保持可统一处理。

Task① Tab1 支持多轮(Round 2+):`npm run test:node` 12 文件/66 测试、`npm run build` 通过。原实现对 round≠1 直接抛错导致前端显示"服务暂时出错";改为真实驱动引擎多轮:每轮 Human 描述(Human 首句仅第 1 轮,后续轮次用占位句)→ AI 顺序描述 → 人类确定性投票(平票加票循环推进,上限 4 次 ballot)进入下一轮;人类被淘汰或终局提前结束时返回 endedNote 并保留已完成轮次。实测真实模型 Round 2:第 1 轮 ai-1 被淘汰后,第 2 轮 Human→ai-2→ai-3→ai-4,same-round 计数每轮从 0 重新递增(0,1,2,3),describe prompt 记录两轮齐全;前端时间线按 Round 分组、选中键改为 round-agentId。卧底席位固定 ai-4(远离人类确定性投票目标 ai-1),提高演示时进入第 2 轮的概率。未 commit/push。

Trace 页重构为 Langfuse 式三栏(Session/Trace/Observation):`npm run test:node` 12 文件/66 测试、`npm run contract:node` 28/28、`npm run build` 通过。纯前端映射,未改底层 trace 采集/GameEngine。新增 `web/src/admin/traceTree.ts`(平铺 runtime event + prompt provenance → Session(gameId) → Trace(R{n}·Description / R{n}·Vote / Description Resume / Final Review) → Observation 树(AGENT/GENERATION/QUALITY_GATE/RETRY/COMMIT/ATOMIC_COMMIT/RESUME/FALLBACK));新 `web/src/admin/TraceView.tsx` 三栏 UI:左栏 Session+Trace 列表(round/task/status 筛选)、中栏树(默认展开到 Agent 层)、右栏节点详情(Generation 展示 sanitized Input(Public Context/Persona Policy/Output Schema)+ Output + Usage(不伪造)+ [打开 Prompt Trace];Gate 显示 violation/Lexical Similarity/threshold/REPAIR;Retry 显示 attempt/errorType/backoff 600ms;Vote 树体现并发 Generation + Atomic Commit ✓/✕;Review fallback 单独节点)。Task① 顺序实验的 [查看本次完整 Trace] 跳到 Trace 页并自动选中 Session→Trace→Agent/Generation。实测真实数据:R1/R2 Description(存活 Agent 数随淘汰变化)、Vote 的 Atomic Commit 如实显示"未结算"。旧平铺渲染器保留为 LegacyTraceView 未使用。未 commit/push。

Trace 页关键词搜索 + 投票理由(脱敏)展示:`npm run test:node` 12 文件/67 测试、`npm run contract:node` 28/28、`npm run build` 通过。关键词搜索:Trace 页左栏新增关键词输入,命中 title/detail/output/事件 JSON/sanitized prompt 内容(如"电影"可搜到含该词的公开描述),按节点子树过滤并隐藏不命中的 Trace。投票理由:按题目要求(trace/回放产物不得含明文 Key 或完整密词,README.md:123;不记录完整未脱敏 prompt/隐藏推理,README_CANDIDATE.md:33)实现服务端脱敏——新增 `GET /api/admin/games/:id/votes`,用内部 GameState 的 votes 把密词替换为 [SECRET] 后返回,Trace 页按 session 拉取并合并进 Vote 树的 Generation 节点 Output(标注"投票理由 · 密词已脱敏");实测真实对局 5 条投票理由密词均被替换。说明:Task① 实验台的独立引擎局不在服务器引擎内,votes 接口查不到(实验台游戏投票理由暂不展示);普通游玩对局可用。未 commit/push。

内部审计搜索 + 全 Tab 状态保持:`npm run test:node` 12 文件/68 测试、`npm run build` 通过。内部审计搜索:脱敏与"直接搜密词"冲突,新增 `POST /api/admin/traces/search`——服务端扫描内部 GameState(描述/投票理由/事件),只返回命中位置 + 脱敏片段(密词→[SECRET]),明文密词不出服务器;Trace 页关键词框下加"搜索内部内容(含密词 · 服务端脱敏显示)"勾选,命中可点击跳转对应 gameId。实测:搜"上下班"命中公开描述;搜密词"雨伞"命中 2 条 vote_reason,返回均为 [SECRET] 脱敏文本。全 Tab 状态保持:把 Overview/Trace/Fault/Evaluation/Prompt Trace 全部改为保持挂载 + display:none 隐藏(与 Task① 一致),切换 Tab 不再重新加载、不丢筛选/选中/滚动状态。未 commit/push。

Admin 本地 JSONL 历史持久化(Runtime Trace / Prompt Trace / Evaluation Run History):`npm run test:node` 14 文件/74 测试、`npm run contract:node` 28/28、`npm run build` 通过。Runtime Trace:复用 `M5_TRACE_JSONL`/`JsonlTraceSink`/`readJsonlTrace`,admin 启动时读取最近 5000 条恢复 `runtimeTrace`,新事件 sequence 从历史最大值继续(实测 44→62),`InMemoryTraceSink` 支持预填+回调把完整事件转发写 JSONL(避免双写);`readJsonlTrace` 改为跳过损坏行。Prompt Trace:新增 `readPromptTraceJsonl`/`writePromptTraceJsonl`,收集器统一做内存+JSONL 双写(recordPromptDebug 在收集器存在时不再重复写调试文件),记录保持 sanitize 边界(密词/API Key/raw response/private reasoning 不落盘)。Evaluation Run History:`EvaluationRunStore` 新增 filePath 选项,运行结束后把 summary(不含 result)写 JSON,启动时恢复,保持 20 条上限。默认文件:server/traces/runtime-trace.jsonl、prompt-trace.jsonl、eval-runs.json(admin 且 NODE_ENV!=test 时启用;可用 M5_TRACE_JSONL/PROMPT_TRACE_JSONL/ADMIN_EVAL_RUNS_JSON 覆盖)。损坏/缺失文件安全降级并打印 warning。实测:两次重启后 traces=44/prompts=8/runs=1 全部恢复,新事件 sequence 从 44 继续到 62。未持久化 GameState、未改 GameEngine、未改前端、未跑 M6、未 commit/push。

运行来源统一标记(sourceType/entrypoint/modelKind):`npm run test:node` 15 文件/76 测试、`npm run contract:node` 28/28、`npm run build` 通过。新增 `TraceOrigin{sourceType: USER_GAME|ADMIN_PROBE|EVAL_RUN|CLI_DEMO|TEST, entrypoint: web|admin|cli|test, modelKind: real|fake|none}`。Runtime Trace:在 TraceSink 包装层统一 stamp(`stampTraceOrigin`),USER_GAME 引擎/quality_violation 回调、Task① 顺序实验、persona 探针(新接入 runtimeTrace)、eval(扩展 stampEvaluationTrace,保留 runId+source)、fault-demo CLI 各自打标;quality_violation 走同一包装不再例外。Prompt Trace:`DeepSeekClient` 增加 `setOrigin`,PromptDebugRecord 与 prompt_provenance 事件带三字段。实测:USER_GAME/web/real 22 事件、ADMIN_PROBE/admin/real 38 事件(含 persona 的 task1-probe)、EVAL_RUN/admin/fake 20 事件,prompt 记录同样三来源齐全。说明:标记前的旧持久化历史无法追溯补标(保持原样);persona 与顺序实验同为 ADMIN_PROBE/admin,靠 gameId(task1-probe 固定 vs 随机)区分;eval-cli 仍不接 runtime trace(无 sink),prompt 记录在收集器存在时带 EVAL_RUN/cli。未改 UI/评测指标/GameEngine;测试全程 fake/mock,但实机验证时为了确认 USER_GAME 路径真实跑了一局 DeepSeek(4 次 describe + persona 探针若干调用),属于验证动作,已在汇报中说明;未 commit/push。

运行来源区分 UI 基础版:`npm run test:node` 15 文件/76 测试、`npm run contract:node` 28/28、`npm run build` 通过。Trace 页:Session 列表与选中 Session 头部显示中文来源(真人对局/管理员实验/自动评测/控制台演示/工程测试)+ Real/Fake;左栏顶部新增"来源 + 模型"筛选(客户端过滤 Session);`traceTree.ts` 新增 `sessionOrigin`(按事件统计 Session 主要来源)与 `SOURCE_LABELS/MODEL_LABELS`。Evaluation 页:运行历史每行标注 `EVAL_RUN · 自动评测` 并注明参与指标统计;新增"其他运行样本(不计入正式 Evaluation aggregate)"区,列出 USER_GAME/ADMIN_PROBE/CLI_DEMO 等 Session(来源/模型/时间/Trace 数),点击跳转对应 Trace,并明确说明不参与评测指标。顺带把 admin-api 内部搜索测试改为确定性断言(原先因随机角色分配可能 0 命中而偶发失败)。未改数据层/GameEngine/UI 其他页面、未跑真实模型、未跑 M6、未 commit/push。
