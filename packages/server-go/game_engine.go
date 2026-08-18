package main

import (
	"fmt"
	"strings"
	"sync"
	"time"
)

// GameRuleError 携带 HTTP 状态码,映射到确定性的规则违规响应。
type GameRuleError struct {
	Msg    string
	Status int
}

func (e *GameRuleError) Error() string { return e.Msg }

func ruleError(msg string) *GameRuleError        { return &GameRuleError{Msg: msg, Status: 400} }
func ruleErrorStatus(msg string, s int) *GameRuleError { return &GameRuleError{Msg: msg, Status: s} }

type aiProfile struct {
	Name   string
	Avatar string
	Style  string
}

// 与 Node 基线一致:四个角色带有 style,但当前并未进入决策(任务线① 待解决)。
var aiProfiles = []aiProfile{
	{Name: "阿序", Avatar: "序", Style: "谨慎观察"},
	{Name: "弥生", Avatar: "弥", Style: "直觉敏锐"},
	{Name: "老墨", Avatar: "墨", Style: "逻辑派"},
	{Name: "小满", Avatar: "满", Style: "出其不意"},
}

// GameEngine 是权威状态机。规则、状态与判胜都在这里,模型只做开放性决策。
type GameEngine struct {
	model  GameModel
	random func() float64
	mu     sync.Mutex
	games  map[string]*GameState
}

func NewGameEngine(model GameModel, random func() float64) *GameEngine {
	return &GameEngine{
		model:  model,
		random: random,
		games:  make(map[string]*GameState),
	}
}

func (e *GameEngine) CreateGame() *PublicGameState {
	e.mu.Lock()
	defer e.mu.Unlock()

	pair := chooseWordPair(e.random)
	undercoverIndex := int(e.random() * 5)
	if undercoverIndex > 4 {
		undercoverIndex = 4
	}
	swap := e.random() > 0.5
	civilianWord := pair[0]
	undercoverWord := pair[1]
	if swap {
		civilianWord = pair[1]
		undercoverWord = pair[0]
	}

	type raw struct {
		name, avatar string
		isHuman      bool
	}
	rawPlayers := []raw{{name: "你", avatar: "你", isHuman: true}}
	for _, p := range aiProfiles {
		rawPlayers = append(rawPlayers, raw{name: p.Name, avatar: p.Avatar, isHuman: false})
	}

	players := make([]*Player, 0, len(rawPlayers))
	for i, rp := range rawPlayers {
		role := RoleCivilian
		if i == undercoverIndex {
			role = RoleUndercover
		}
		word := civilianWord
		if role == RoleUndercover {
			word = undercoverWord
		}
		id := "human"
		if i != 0 {
			id = fmt.Sprintf("ai-%d", i)
		}
		players = append(players, &Player{
			ID: id, Name: rp.name, Avatar: rp.avatar,
			IsHuman: rp.isHuman, Role: role, Word: word, Alive: true,
		})
	}

	id := newID()
	game := &GameState{
		ID:           id,
		Phase:        PhaseDescribing,
		Round:        1,
		Ballot:       1,
		Players:      players,
		Descriptions: []Description{},
		Votes:        []Vote{},
		Events: []GameEvent{{
			ID:    newID(),
			Type:  "system",
			Text:  "密词已发放。请用一句话描述它,但不要直接说出答案。",
			Round: 1,
		}},
		EligibleTargetIDs: nil,
		Winner:            nil,
		Review:            nil,
		CreatedAt:         time.Now().UnixMilli(),
	}
	e.games[id] = game
	return e.toPublic(game)
}

func (e *GameEngine) GetGame(id string) (*PublicGameState, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	game, err := e.requireGame(id)
	if err != nil {
		return nil, err
	}
	return e.toPublic(game), nil
}

// GetInternalGame 返回权威内部状态(含秘密字段),仅供测试与本地评测使用,
// 对齐 Node 版 getInternalGame。不经由此方法的路径永远拿不到他人身份/密词。
func (e *GameEngine) GetInternalGame(id string) (*GameState, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.requireGame(id)
}

func (e *GameEngine) SubmitHumanDescription(id, text string) (*PublicGameState, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	game, err := e.requireGame(id)
	if err != nil {
		return nil, err
	}
	if err := assertPhase(game, PhaseDescribing); err != nil {
		return nil, err
	}
	human := humanOf(game)
	if !human.Alive {
		return nil, ruleError("你已出局,请继续观战")
	}
	description := normalizeText(text)
	if n := len([]rune(description)); n < 2 || n > 60 {
		return nil, ruleError("描述需为 2–60 个字符")
	}
	if strings.Contains(description, human.Word) {
		return nil, ruleError("不能直接说出你的秘密词")
	}
	for _, d := range game.Descriptions {
		if d.Round == game.Round && d.PlayerID == human.ID {
			return nil, ruleError("本轮已经描述过了")
		}
	}

	humanDescription := Description{PlayerID: human.ID, Text: description, Round: game.Round}
	// 构造包含人类本轮描述的临时视图供 AI 生成(与 Node 基线一致)。
	contextGame := *game
	contextGame.Descriptions = append(append([]Description{}, game.Descriptions...), humanDescription)

	aiDescriptions, err := e.generateDescriptions(&contextGame)
	if err != nil {
		return nil, err
	}

	roundDescriptions := append([]Description{humanDescription}, aiDescriptions...)
	game.Descriptions = append(game.Descriptions, roundDescriptions...)
	for _, d := range roundDescriptions {
		game.Events = append(game.Events, GameEvent{
			ID: newID(), Type: "description", Text: d.Text, Round: game.Round, PlayerID: d.PlayerID,
		})
	}
	game.Phase = PhaseVoting
	game.Ballot = 1
	game.EligibleTargetIDs = nil
	game.Events = append(game.Events, GameEvent{
		ID: newID(), Type: "system", Text: "所有人描述完毕。观察措辞,投出你最怀疑的一票。", Round: game.Round,
	})
	return e.toPublic(game), nil
}

func (e *GameEngine) SubmitHumanVote(id, targetID string) (*PublicGameState, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	game, err := e.requireGame(id)
	if err != nil {
		return nil, err
	}
	if err := assertPhase(game, PhaseVoting); err != nil {
		return nil, err
	}
	human := humanOf(game)
	if !human.Alive {
		return nil, ruleError("你已出局,请继续观战")
	}
	if err := e.validateVoteTarget(game, human, targetID); err != nil {
		return nil, err
	}

	aiVotes, err := e.generateVotes(game)
	if err != nil {
		return nil, err
	}
	target := findPlayer(game, targetID)
	roundVotes := append([]Vote{{
		VoterID:  human.ID,
		TargetID: targetID,
		Reason:   fmt.Sprintf("我认为 %s 的描述最可疑", target.Name),
		Round:    game.Round,
		Ballot:   game.Ballot,
	}}, aiVotes...)
	game.Votes = append(game.Votes, roundVotes...)
	if err := e.resolveBallot(game, roundVotes); err != nil {
		return nil, err
	}
	return e.toPublic(game), nil
}

func (e *GameEngine) ContinueAsSpectator(id string) (*PublicGameState, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	game, err := e.requireGame(id)
	if err != nil {
		return nil, err
	}
	if humanOf(game).Alive {
		return nil, ruleError("你仍在场上,请亲自完成行动")
	}
	if game.Phase == PhaseFinished {
		return e.toPublic(game), nil
	}

	safety := 0
	for game.Phase != PhaseFinished && safety < 12 {
		safety++
		if game.Phase == PhaseDescribing {
			descriptions, err := e.generateDescriptions(game)
			if err != nil {
				return nil, err
			}
			game.Descriptions = append(game.Descriptions, descriptions...)
			for _, d := range descriptions {
				game.Events = append(game.Events, GameEvent{
					ID: newID(), Type: "description", Text: d.Text, Round: game.Round, PlayerID: d.PlayerID,
				})
			}
			game.Phase = PhaseVoting
			game.Ballot = 1
			game.EligibleTargetIDs = nil
		} else {
			votes, err := e.generateVotes(game)
			if err != nil {
				return nil, err
			}
			game.Votes = append(game.Votes, votes...)
			if err := e.resolveBallot(game, votes); err != nil {
				return nil, err
			}
		}
	}
	if safety >= 12 && game.Phase != PhaseFinished {
		return nil, ruleErrorStatus("自动对局轮次异常,请重新开局", 500)
	}
	return e.toPublic(game), nil
}

func (e *GameEngine) generateDescriptions(game *GameState) ([]Description, error) {
	agents := aliveAgents(game)
	// 与 Node 基线一致:同轮 AI **并发**生成(Node 用 Promise.all,这里用 goroutine)。
	// 每个 Agent 只看到进入本函数时已有的 descriptions——因此后发者读不到同轮先发者的
	// 描述。这是任务线① A1 要解决的已知弱点,请勿误以为已经是顺序发言。
	out := make([]Description, len(agents))
	errs := make([]error, len(agents))
	var wg sync.WaitGroup
	for i, agent := range agents {
		wg.Add(1)
		go func(i int, agent *Player) {
			defer wg.Done()
			text, err := e.model.Describe(buildAgentContext(game, agent))
			if err != nil {
				errs[i] = err
				return
			}
			out[i] = Description{PlayerID: agent.ID, Text: text, Round: game.Round}
		}(i, agent)
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (e *GameEngine) generateVotes(game *GameState) ([]Vote, error) {
	voters := aliveAgents(game)
	out := make([]Vote, 0, len(voters))
	for _, voter := range voters {
		allowed, err := e.allowedTargets(game, voter)
		if err != nil {
			return nil, err
		}
		result, err := e.model.Vote(buildAgentContext(game, voter), allowed)
		if err != nil {
			return nil, err
		}
		out = append(out, Vote{
			VoterID: voter.ID, TargetID: result.TargetID, Reason: result.Reason,
			Round: game.Round, Ballot: game.Ballot,
		})
	}
	return out, nil
}

func (e *GameEngine) resolveBallot(game *GameState, votes []Vote) error {
	counts := map[string]int{}
	for _, v := range votes {
		counts[v.TargetID]++
	}
	maxVotes := 0
	for _, c := range counts {
		if c > maxVotes {
			maxVotes = c
		}
	}
	leaders := []string{}
	for id, c := range counts {
		if c == maxVotes {
			leaders = append(leaders, id)
		}
	}

	if len(leaders) > 1 && game.Ballot < 2 {
		game.Ballot++
		game.EligibleTargetIDs = leaders
		names := make([]string, 0, len(leaders))
		for _, id := range leaders {
			if p := findPlayer(game, id); p != nil {
				names = append(names, p.Name)
			}
		}
		game.Events = append(game.Events, GameEvent{
			ID: newID(), Type: "vote_result",
			Text: fmt.Sprintf("%s 同票,进入最终加票。", strings.Join(names, "、")), Round: game.Round,
		})
		return nil
	}

	var eliminatedID string
	if len(leaders) == 1 {
		eliminatedID = leaders[0]
	} else {
		idx := int(e.random() * float64(len(leaders)))
		if idx >= len(leaders) {
			idx = len(leaders) - 1
		}
		eliminatedID = leaders[idx]
	}
	eliminated := findPlayer(game, eliminatedID)
	if eliminated == nil {
		return ruleErrorStatus("投票结果无效", 500)
	}
	eliminated.Alive = false
	game.EligibleTargetIDs = nil
	game.Events = append(game.Events, GameEvent{
		ID: newID(), Type: "elimination",
		Text: fmt.Sprintf("%s 被投出局。身份将在终局揭晓。", eliminated.Name), Round: game.Round, PlayerID: eliminated.ID,
	})

	if winner := checkWinner(game); winner != nil {
		game.Winner = winner
		game.Phase = PhaseFinished
		review := e.createReview(game)
		game.Review = &review
		return nil
	}

	game.Round++
	game.Ballot = 1
	game.Phase = PhaseDescribing
	game.Events = append(game.Events, GameEvent{
		ID: newID(), Type: "system",
		Text: fmt.Sprintf("第 %d 轮开始。换个角度描述,别让身份暴露。", game.Round), Round: game.Round,
	})
	return nil
}

func checkWinner(game *GameState) *Role {
	aliveCount := 0
	undercoverAlive := 0
	for _, p := range game.Players {
		if p.Alive {
			aliveCount++
			if p.Role == RoleUndercover {
				undercoverAlive++
			}
		}
	}
	if undercoverAlive == 0 {
		r := RoleCivilian
		return &r
	}
	if undercoverAlive >= aliveCount-undercoverAlive {
		r := RoleUndercover
		return &r
	}
	return nil
}

// createReview 调用模型复盘,失败时使用确定性兜底,保证已结束对局不卡死。
func (e *GameEngine) createReview(game *GameState) GameReview {
	review, err := e.model.Review(game)
	if err == nil {
		return review
	}

	var undercover, civilian *Player
	for _, p := range game.Players {
		if p.Role == RoleUndercover && undercover == nil {
			undercover = p
		}
		if p.Role == RoleCivilian && civilian == nil {
			civilian = p
		}
	}
	headline := "卧底把相似性利用到了最后"
	if game.Winner != nil && *game.Winner == RoleCivilian {
		headline = "平民锁定了那处微妙偏差"
	}
	insights := make([]PlayerInsight, 0, len(game.Players))
	for _, p := range game.Players {
		insights = append(insights, PlayerInsight{
			PlayerID: p.ID,
			Insight:  fmt.Sprintf("%s 以“%s”为出发点完成了本局表达与判断。", p.Name, p.Word),
		})
	}
	return GameReview{
		Headline: headline,
		Summary: fmt.Sprintf("%s 拿到的是“%s”,其余玩家拿到“%s”。本局共进行了 %d 轮,胜负来自描述细节与投票联盟的共同变化。",
			undercover.Name, undercover.Word, civilian.Word, game.Round),
		TurningPoints:  []string{"终局票型决定了阵营胜负;可展开每轮记录回看判断依据。"},
		PlayerInsights: insights,
	}
}

func (e *GameEngine) allowedTargets(game *GameState, voter *Player) ([]*Player, error) {
	var eligible map[string]bool
	if game.EligibleTargetIDs != nil {
		eligible = map[string]bool{}
		for _, id := range game.EligibleTargetIDs {
			eligible[id] = true
		}
	}
	targets := []*Player{}
	for _, p := range game.Players {
		if p.Alive && p.ID != voter.ID && (eligible == nil || eligible[p.ID]) {
			targets = append(targets, p)
		}
	}
	if len(targets) == 0 {
		return nil, ruleErrorStatus(fmt.Sprintf("%s 没有可投票目标", voter.Name), 500)
	}
	return targets, nil
}

func (e *GameEngine) validateVoteTarget(game *GameState, voter *Player, targetID string) error {
	targets, err := e.allowedTargets(game, voter)
	if err != nil {
		return err
	}
	for _, p := range targets {
		if p.ID == targetID {
			return nil
		}
	}
	return ruleError("请选择一名有效的存活玩家")
}

func (e *GameEngine) toPublic(game *GameState) *PublicGameState {
	finished := game.Phase == PhaseFinished
	human := humanOf(game)

	players := make([]PublicPlayer, 0, len(game.Players))
	for _, p := range game.Players {
		pub := PublicPlayer{ID: p.ID, Name: p.Name, Avatar: p.Avatar, IsHuman: p.IsHuman, Alive: p.Alive}
		if finished {
			role := p.Role
			word := p.Word
			pub.RevealedRole = &role
			pub.RevealedWord = &word
		}
		players = append(players, pub)
	}

	// 保证 JSON 序列化为 [] 而非 null,与 Node 版一致。
	descriptions := game.Descriptions
	if descriptions == nil {
		descriptions = []Description{}
	}
	votes := game.Votes
	if votes == nil {
		votes = []Vote{}
	}
	events := game.Events
	if events == nil {
		events = []GameEvent{}
	}

	return &PublicGameState{
		ID: game.ID, Phase: game.Phase, Round: game.Round, Ballot: game.Ballot,
		Players: players, Descriptions: descriptions, Votes: votes, Events: events,
		EligibleTargetIDs: game.EligibleTargetIDs, Winner: game.Winner, Review: game.Review,
		Human: HumanView{PlayerID: human.ID, Role: human.Role, Word: human.Word},
		Model: e.model.Model(),
	}
}

func (e *GameEngine) requireGame(id string) (*GameState, error) {
	game, ok := e.games[id]
	if !ok {
		return nil, ruleErrorStatus("对局不存在或已过期", 404)
	}
	return game, nil
}

func humanOf(game *GameState) *Player {
	for _, p := range game.Players {
		if p.IsHuman {
			return p
		}
	}
	return nil
}

func aliveAgents(game *GameState) []*Player {
	out := []*Player{}
	for _, p := range game.Players {
		if !p.IsHuman && p.Alive {
			out = append(out, p)
		}
	}
	return out
}

func findPlayer(game *GameState, id string) *Player {
	for _, p := range game.Players {
		if p.ID == id {
			return p
		}
	}
	return nil
}

func assertPhase(game *GameState, phase Phase) error {
	if game.Phase != phase {
		label := "投票"
		if phase == PhaseDescribing {
			label = "描述"
		}
		return ruleError(fmt.Sprintf("当前不在%s阶段", label))
	}
	return nil
}

func normalizeText(text string) string {
	return strings.Join(strings.Fields(strings.TrimSpace(text)), " ")
}

