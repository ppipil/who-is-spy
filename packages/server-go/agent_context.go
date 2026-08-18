package main

// buildAgentContext 通过 allowlist **显式重建**给某个 Agent 的最小上下文。
// 关键点:新增服务端字段不会被意外透传给模型——这里只放白名单内的字段。
//
// 注意(与 Node 基线一致的已知弱点,面试保留):
//   - publicDescriptions 直接来自 game.Descriptions,当前编排下同轮 AI 并行生成,
//     后发 AI 看不到同轮其他 AI 的先发描述(任务线① 需要候选人解决)。
func buildAgentContext(game *GameState, agent *Player) AgentContext {
	if agent.IsHuman {
		panic("human players do not receive an AI agent context")
	}

	names := make(map[string]string, len(game.Players))
	for _, p := range game.Players {
		names[p.ID] = p.Name
	}

	alive := make([]ContextAlivePlayer, 0, len(game.Players))
	for _, p := range game.Players {
		if p.Alive {
			alive = append(alive, ContextAlivePlayer{ID: p.ID, Name: p.Name})
		}
	}

	descriptions := make([]ContextDescription, 0, len(game.Descriptions))
	for _, d := range game.Descriptions {
		name, ok := names[d.PlayerID]
		if !ok {
			name = "未知玩家"
		}
		descriptions = append(descriptions, ContextDescription{
			PlayerID:   d.PlayerID,
			PlayerName: name,
			Text:       d.Text,
			Round:      d.Round,
		})
	}

	eliminations := make([]ContextElimination, 0)
	for _, e := range game.Events {
		if e.Type == "elimination" {
			eliminations = append(eliminations, ContextElimination{Text: e.Text, Round: e.Round})
		}
	}

	return AgentContext{
		Identity: ContextIdentity{
			PlayerID: agent.ID,
			Name:     agent.Name,
			Role:     agent.Role,
			Word:     agent.Word,
		},
		Game: ContextGame{
			Round:              game.Round,
			AlivePlayers:       alive,
			PublicDescriptions: descriptions,
			PublicEliminations: eliminations,
		},
	}
}
