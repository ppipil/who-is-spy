package main

import "fmt"

// FakeGameModel 是确定性测试替身,行为对齐 Node 版 test-utils.ts:
//   - 描述:围绕自己名字的固定句式
//   - 投票:优先投人类,否则投第一个候选
//   - 复盘:固定结构,覆盖每名玩家
// 用于契约测试与本地冒烟(GAME_MODEL=fake),不消耗真实额度。
type FakeGameModel struct{}

func (m *FakeGameModel) Model() string      { return "deepseek-v4-flash-test-double" }
func (m *FakeGameModel) IsConfigured() bool { return true }

func (m *FakeGameModel) Describe(ctx AgentContext) (string, error) {
	return fmt.Sprintf("它让我想到%s熟悉的日常场景", ctx.Identity.Name), nil
}

func (m *FakeGameModel) Vote(ctx AgentContext, allowed []*Player) (VoteResult, error) {
	target := allowed[0]
	human := false
	for _, p := range allowed {
		if p.IsHuman {
			target = p
			human = true
			break
		}
	}
	reason := "这位玩家的措辞最可疑"
	if human {
		reason = "真人的描述与我的理解有细微偏差"
	}
	return VoteResult{TargetID: target.ID, Reason: reason}, nil
}

func (m *FakeGameModel) Review(game *GameState) (GameReview, error) {
	insights := make([]PlayerInsight, 0, len(game.Players))
	for _, p := range game.Players {
		insights = append(insights, PlayerInsight{
			PlayerID: p.ID,
			Insight:  fmt.Sprintf("%s围绕自己的词给出了独立判断。", p.Name),
		})
	}
	return GameReview{
		Headline: "细微的语义偏差决定了终局",
		Summary:  "玩家们围绕相近概念谨慎描述,最终通过公开措辞和集中票型找到了不同阵营。",
		TurningPoints: []string{
			"首轮描述形成了清晰的判断分歧。",
			"多数票在终局集中到真正的卧底。",
		},
		PlayerInsights: insights,
	}, nil
}
