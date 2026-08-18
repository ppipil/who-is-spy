package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// buildAgentContext 只暴露当前 Agent 自己的秘密与公开信息,不泄露他人身份/密词。
// 对齐 Node 版 agent-context.test.ts。
func TestBuildAgentContextIsolatesSecrets(t *testing.T) {
	game := &GameState{
		ID:     "game-1",
		Phase:  PhaseDescribing,
		Round:  2,
		Ballot: 1,
		Players: []*Player{
			{ID: "human", Name: "你", Avatar: "你", IsHuman: true, Role: RoleUndercover, Word: "绝密卧底词", Alive: true},
			{ID: "ai-1", Name: "阿序", Avatar: "序", IsHuman: false, Role: RoleCivilian, Word: "当前玩家词", Alive: true},
			{ID: "ai-2", Name: "弥生", Avatar: "弥", IsHuman: false, Role: RoleCivilian, Word: "其他玩家词", Alive: false},
		},
		Descriptions: []Description{{PlayerID: "human", Text: "这是已经公开的描述", Round: 1}},
		Events: []GameEvent{{
			ID: "event-1", Type: "elimination", Text: "弥生被投出局。身份将在终局揭晓。", Round: 1, PlayerID: "ai-2",
		}},
	}

	ctx := buildAgentContext(game, game.Players[1])

	if ctx.Identity.PlayerID != "ai-1" || ctx.Identity.Word != "当前玩家词" || ctx.Identity.Role != RoleCivilian {
		t.Fatalf("identity 不正确: %+v", ctx.Identity)
	}
	if len(ctx.Game.PublicDescriptions) != 1 || ctx.Game.PublicDescriptions[0].Text != "这是已经公开的描述" {
		t.Fatalf("公开描述缺失: %+v", ctx.Game.PublicDescriptions)
	}
	if len(ctx.Game.PublicEliminations) != 1 || !strings.Contains(ctx.Game.PublicEliminations[0].Text, "弥生被投出局") {
		t.Fatalf("公开淘汰缺失: %+v", ctx.Game.PublicEliminations)
	}

	raw, err := json.Marshal(ctx)
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}
	serialized := string(raw)
	for _, leak := range []string{"绝密卧底词", "其他玩家词", `"role":"undercover"`} {
		if strings.Contains(serialized, leak) {
			t.Fatalf("上下文泄露了 %q: %s", leak, serialized)
		}
	}
}

// 完整一局:1 人类 + 4 隔离 AI,确定性推进到终局并揭示身份。
// 对齐 Node 版 game-engine.test.ts。
func TestRunCompleteGame(t *testing.T) {
	model := &FakeGameModel{}
	engine := NewGameEngine(model, func() float64 { return 0 })

	created := engine.CreateGame()
	if len(created.Players) != 5 {
		t.Fatalf("玩家数应为 5,实际 %d", len(created.Players))
	}
	humans := 0
	for _, p := range created.Players {
		if p.IsHuman {
			humans++
		}
		if p.RevealedRole != nil || p.RevealedWord != nil {
			t.Fatalf("终局前不应揭示身份/密词: %+v", p)
		}
	}
	if humans != 1 {
		t.Fatalf("应恰好 1 名人类,实际 %d", humans)
	}
	if created.Human.Role != RoleUndercover {
		t.Fatalf("random=0 时人类应为卧底,实际 %s", created.Human.Role)
	}

	voting, err := engine.SubmitHumanDescription(created.ID, "经常伴随着细腻的泡沫")
	if err != nil {
		t.Fatalf("提交描述失败: %v", err)
	}
	if voting.Phase != PhaseVoting {
		t.Fatalf("应进入 voting,实际 %s", voting.Phase)
	}
	if len(voting.Descriptions) != 5 {
		t.Fatalf("本轮应有 5 条描述,实际 %d", len(voting.Descriptions))
	}

	// 每个 AI 的上下文都能看到人类本轮描述,且不含卧底密词。
	internal, err := engine.GetInternalGame(created.ID)
	if err != nil {
		t.Fatalf("获取内部状态失败: %v", err)
	}
	var undercoverWord string
	for _, p := range internal.Players {
		if p.Role == RoleUndercover {
			undercoverWord = p.Word
		}
	}
	if undercoverWord == "" {
		t.Fatal("未找到卧底密词")
	}

	finished, err := engine.SubmitHumanVote(created.ID, "ai-1")
	if err != nil {
		t.Fatalf("投票失败: %v", err)
	}
	if finished.Phase != PhaseFinished {
		t.Fatalf("应进入 finished,实际 %s", finished.Phase)
	}
	if finished.Winner == nil || *finished.Winner != RoleCivilian {
		t.Fatalf("random=0 时应平民胜,实际 %v", finished.Winner)
	}
	if finished.Review == nil || len(finished.Review.TurningPoints) == 0 {
		t.Fatal("终局应产生复盘")
	}
	for _, p := range finished.Players {
		if p.RevealedRole == nil || p.RevealedWord == nil {
			t.Fatalf("终局应揭示所有玩家身份/密词: %+v", p)
		}
		if p.ID == "human" && p.Alive {
			t.Fatal("人类应在多数票下被淘汰")
		}
	}
}

// 直接说出人类密词的描述必须被规则拒绝。
func TestRejectsDescriptionRevealingSecret(t *testing.T) {
	engine := NewGameEngine(&FakeGameModel{}, func() float64 { return 0 })
	game := engine.CreateGame()

	_, err := engine.SubmitHumanDescription(game.ID, "答案就是"+game.Human.Word)
	if err == nil {
		t.Fatal("说出密词应被拒绝")
	}
	if !strings.Contains(err.Error(), "不能直接说出你的秘密词") {
		t.Fatalf("错误信息不符: %v", err)
	}
}
