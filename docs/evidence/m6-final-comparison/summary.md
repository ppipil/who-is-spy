# M6 Final Baseline vs Improved Evaluation

## 1. Methodology

M6 用同一套 Evaluation Harness、同一模型配置、同一组 frozen seeds，对
**official baseline**（`baseline` 分支，commit `7d98e19`）与 **final main**
（commit `49eb39d`，含 M2–M5 全部改进）做 paired A/B。

实现方式（本次新增的最小评测层改动，不影响 M2–M5 产品代码）：

- `evaluation.ts` 升级为 schema v5：同一 `runEvaluation` 通过
  `engineFactory` 参数驱动任意兼容引擎（默认仍是 main 的 `GameEngine`，
  行为不变）；baseline 引擎接口与 main 公共方法一致
  （`createGame`/`submitHumanDescription`/`submitHumanVote`/`continueAsSpectator`/`getInternalGame`），
  因此无需改 baseline 产品代码即可用同一 harness 驱动。
- baseline 代码取自临时 `git worktree`（`git worktree add <dir> baseline`），
  未写入 baseline 分支；仅在评测用副本里加了 usage recorder 插桩
  （解析 provider `usage` 字段用于 tokens/cost/retry 指标），不改变任何
  baseline 产品行为。
- word-setup 配对校验：每个 seed 用同一 `mulberry32(seed)` 在两侧引擎各
  建一局，比较每个玩家的词/角色/卧底位置（`m6-compare.ts inspectWordSetup`），
  5/5 全部匹配（hash 见 `config.json`，不落盘密词）。
- 运行顺序：每个 seed 内交替执行两侧，奇偶 seed 互换顺序
  （baseline→final / final→baseline），降低时间段/provider load 偏差。

执行命令：

```text
# Fake deterministic regression（不用于真实质量结论）
npm.cmd run m6:compare --workspace packages/server-node -- --mode fake --baseline-src <baseline worktree>

# 真实 DeepSeek paired 实验
npm.cmd run m6:compare --workspace packages/server-node -- --mode real --baseline-src <baseline worktree> \
  --final-commit 49eb39da8be4f7f959a8afd642272046ca8637e9 \
  --baseline-commit 7d98e194ee57bb078ed45e9831ad42ff68a57b56 \
  --cost-currency USD --input-token-price-per-1m 0.27 --output-token-price-per-1m 1.10 \
  --cost-source "DeepSeek deepseek-chat public pricing snapshot (estimate)" --cost-source-date 2026-08-19
```

## 2. Frozen seeds / config

| 项 | 值 |
| --- | --- |
| Seeds（固定，不因结果更换） | 101, 102, 103, 104, 105 |
| Games | 每 seed 每侧 1 局（Baseline × 5 + Final × 5） |
| 模型 | `deepseek-v4-flash`，`https://api.deepseek.com` |
| temperature | describe 0.8 / vote 0.8 / review 0.45（两侧相同） |
| 词表 | 同一 `WORD_PAIRS`（12 组），word setup 逐 seed 校验 matched |
| 人类脚本 | `driveGame`：固定描述文案 + 固定投 `allowed[0]` |
| Harness | `packages/server-node/server/evaluation.ts`（schema v5），两侧同一套 |
| 成本估算 | USD；输入 $0.27/1M、输出 $1.10/1M（DeepSeek deepseek-chat 公开价快照，仅估算） |

Fake sanity 结果：两侧 10/10 局 gate PASS、word setup 5/5 匹配，证明同一
harness 能确定性驱动两个版本（Fake 结果不作为真实 AI 质量证据）。

## 3. Baseline vs Final（aggregate）

| Metric | Baseline | Final | Delta |
| --- | ---: | ---: | ---: |
| Completion Rate | 1.0000 | 0.8000 | -0.2000 |
| Valid Vote Rate | 1.0000 | 1.0000 | 0.0000 |
| Invalid Output Rate | 0.0000 | 0.0182 | +0.0182 |
| Public Exact Secret Leak（合计） | 0 | 0 | 0 |
| Lexical Description Homogeneity | 0.0640 | 0.0107 | -0.0533 |
| Latency p50 (ms) | 6079.0 | 10236.2 | +4157.2 |
| Latency p95 (ms) | 36629.7 | 58343.0 | +21713.2 |
| Tokens / Game | 21765.6 | 27251.2 | +5485.6 |
| Estimated Cost / Game (USD) | 0.0162 | 0.0215 | +0.0053 |
| Provider Retry Count（合计） | 6 | 11 | +5 |
| Quality Repair Count（Final 辅助） | 0（无质量门禁） | 1 | +1 |

> `Lexical Description Homogeneity` 是字符 bigram + Dice 的词面重复 proxy
> （值越低词面重复越少），**不是 semantic diversity 的证明**。

## 4. Paired results（per seed）

| seed | Baseline | Final | Baseline tokens/cost/homo | Final tokens/cost/homo |
| --- | --- | --- | ---: | ---: |
| 101 | PASS (1/1) | FAIL (0/1) | 23160 / $0.0175 / 0.0636 | 13746 / $0.0108 / 0.0000 |
| 102 | PASS (1/1) | PASS (1/1) | 9679 / $0.0070 / 0.0558 | 15763 / $0.0122 / 0.0128 |
| 103 | PASS (1/1) | PASS (1/1) | 35110 / $0.0268 / 0.0636 | 18927 / $0.0143 / 0.0088 |
| 104 | PASS (1/1) | PASS (1/1) | 22937 / $0.0173 / 0.0603 | 26588 / $0.0198 / 0.0139 |
| 105 | PASS (1/1) | PASS (1/1) | 17942 / $0.0122 / 0.0769 | 61232 / $0.0502 / 0.0178 |

完整 per-seed 明细见 `aggregate/comparison.json` 与 `raw/`。

### Final seed 101 失败说明（诚实记录，不换 seed）

- 第 2 轮描述阶段，ai-3（老墨）`describe` 真实 provider 超时
  （`errorType: timeout`，含重试共 60.6s），随后操作失败、引擎安全中止。
- 中止前该轮已公开 human / ai-1 / ai-2 三条描述，未发生半提交或泄漏。
- Eval harness 不会在安全中止后自动重试该行动（M5 已知限制），因此该局记为
  incomplete，gate FAIL：`completionRate must equal 1.0`、
  `evaluation games must not enter illegal or incomplete state`。
- 这是真实 provider 行为（超时），不是注入故障，也不代表 Final 产品 bug。

## 5. Reliability / quality gains

- 泄漏：两侧均为 0 次 Public Exact Secret Leak；Final 的发布前质量门禁把
  密词泄漏拦截在提交前（本样本 0 泄漏），Baseline 没有任何门禁。
- 词面重复：Final 的 Lexical Homogeneity 从 0.0640 降到 0.0107
  （词面 proxy，非语义指标），与 M2 策略差异 + M3 同轮顺序上下文一致。
- 有效投票率：两侧均为 100%；Final 本样本出现 1 次 provider 超时导致
  Invalid Output Rate 0.0182（Baseline 0）。
- Quality Repair：Final 出现 1 次门禁修复后成功（seed 102）；Baseline 无门禁、
  repair 恒为 0。
- 可靠性语义：M5 的注入故障与回放证据不受本实验影响，此处不重新评分。

## 6. Latency / token / cost trade-offs

- Final 平均每局多 ~25% tokens（27251 vs 21766），多 ~33% 成本
  （$0.0215 vs $0.0162/局）。来源：策略指导 + 顺序上下文 + 门禁修复提示
  使 prompt 变长；provider retry 次数也更高（11 vs 6）。
- 延迟：Final p50 10.2s vs Baseline 6.1s，p95 58.3s vs 36.6s
  （含内部重试/退避；当日 provider 整体偏慢，Baseline p95 也达 36.6s）。
- 结论：Final 用更高的 tokens/latency/cost 换来了更低词面重复、泄漏防线和
  修复能力；本小样本下完成率反而低 0.2（由 1 次真实超时造成），需按 M6
  结果如实报告，不做有利美化。

## 7. M2–M5 trajectory evidence（只引用，不重新评分）

| Milestone | 结论 | 既有 evidence |
| --- | --- | --- |
| M2 Persona Strategy | PASS | `eval/m2-persona` 分支 + 该分支 `DECISIONS.md` |
| M3 Same-round Sequential Observation | PASS | `eval/m3-sequential` 分支 + 该分支 `DECISIONS.md` |
| M4 Pre-publication Quality Gate | PASS | `eval/m4-quality-gate` 分支 + 该分支 `DECISIONS.md` |
| M5 Fault Recovery & Replay | PASS | `eval/m5-reliability` 分支 `docs/evidence/m5-reliability/summary.md` + 该分支 `DECISIONS.md` |

> 各 milestone evidence 保留在原 milestone 分支上，M6 只引用、不重新评分、
> 不复制其 trajectory score。

## 8. Limitations

- n=5/侧、每 seed 1 局，属于小样本 paired 观测；本实验是最终 A/B，不是
  更大规模的统计显著性检验。
- 完成率差异（Final 4/5 vs Baseline 5/5）由 1 次真实 provider 超时造成；
  单次 provider 波动不应被解读为产品可靠性差异。
- Cost 是估算值（deepseek-chat 公开价快照 $0.27/$1.10 per 1M），实际账单
  以供应商为准；两侧使用同一价格，相对比较仍有效。
- Provider Retry Count = 对“带 usage 的成功/失败响应”累计
  `providerAttempt - 1`；无 usage 的失败重试不计入该指标（trace 中仍可见）。
- Lexical Homogeneity 是 bigram+Dice 词面 proxy，禁止表述为语义多样性。
- Eval harness 对 AI 行动失败只做安全中止、不自动重试人类行动（M5 已知限制）。
- Baseline 的 quality repair 恒为 0 是因为其引擎没有质量门禁，属于能力缺失，
  不是“表现更好”。
- 未做 semantic embedding / LLM-as-Judge / M6 统计显著性 / OpenTelemetry /
  Dashboard / Web Replay。

## File layout

```text
docs/evidence/m6-final-comparison/
  config.json                     # frozen seeds/config/commits/word-setup hash
  summary.md                      # 本文档
  raw/baseline/seed-{101..105}.json   # baseline raw reports（脱敏）
  raw/final/seed-{101..105}.json      # final raw reports（脱敏）
  raw/fake-sanity/…                   # Fake regression raw reports
  aggregate/baseline.json         # baseline aggregate
  aggregate/final.json            # final aggregate
  aggregate/comparison.json       # paired deltas + aggregate comparison
```

Raw reports 中的文本经过 harness 内置脱敏（`[SELF_SECRET]`/`[OTHER_SECRET]`/
`[SECRET]`/`[SECRET_ALIAS]`），不含 API key、完整密词或未脱敏 prompt。
