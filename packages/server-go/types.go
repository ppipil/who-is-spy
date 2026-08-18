package main

// 与 server-node 对等的领域类型。字段的 JSON 名称必须与 Node 版一致,
// 否则前端与语言无关契约测试会失败。

type Role string
type Phase string

const (
	RoleCivilian   Role  = "civilian"
	RoleUndercover Role  = "undercover"
	PhaseDescribing Phase = "describing"
	PhaseVoting     Phase = "voting"
	PhaseFinished   Phase = "finished"
)

// Player 是服务端内部的完整玩家状态(含秘密字段),永不整体序列化给客户端。
type Player struct {
	ID      string
	Name    string
	Avatar  string
	IsHuman bool
	Role    Role
	Word    string
	Alive   bool
}

type Description struct {
	PlayerID string `json:"playerId"`
	Text     string `json:"text"`
	Round    int    `json:"round"`
}

type Vote struct {
	VoterID  string `json:"voterId"`
	TargetID string `json:"targetId"`
	Reason   string `json:"reason"`
	Round    int    `json:"round"`
	Ballot   int    `json:"ballot"`
}

type GameEvent struct {
	ID       string `json:"id"`
	Type     string `json:"type"` // system | description | vote_result | elimination
	Text     string `json:"text"`
	Round    int    `json:"round"`
	PlayerID string `json:"playerId,omitempty"`
}

type PlayerInsight struct {
	PlayerID string `json:"playerId"`
	Insight  string `json:"insight"`
}

type GameReview struct {
	Headline       string          `json:"headline"`
	Summary        string          `json:"summary"`
	TurningPoints  []string        `json:"turningPoints"`
	PlayerInsights []PlayerInsight `json:"playerInsights"`
}

// GameState 是权威内部状态,GameEngine 是唯一事实源。
type GameState struct {
	ID                string
	Phase             Phase
	Round             int
	Ballot            int
	Players           []*Player
	Descriptions      []Description
	Votes             []Vote
	Events            []GameEvent
	EligibleTargetIDs []string
	Winner            *Role
	Review            *GameReview
	CreatedAt         int64
}

// ---- 对外公开 DTO(终局前不得泄露他人身份/密词)----

type PublicPlayer struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Avatar       string `json:"avatar"`
	IsHuman      bool   `json:"isHuman"`
	Alive        bool   `json:"alive"`
	RevealedRole *Role  `json:"revealedRole,omitempty"`
	RevealedWord *string `json:"revealedWord,omitempty"`
}

type HumanView struct {
	PlayerID string `json:"playerId"`
	Role     Role   `json:"role"`
	Word     string `json:"word"`
}

type PublicGameState struct {
	ID                string         `json:"id"`
	Phase             Phase          `json:"phase"`
	Round             int            `json:"round"`
	Ballot            int            `json:"ballot"`
	Players           []PublicPlayer `json:"players"`
	Descriptions      []Description  `json:"descriptions"`
	Votes             []Vote         `json:"votes"`
	Events            []GameEvent    `json:"events"`
	EligibleTargetIDs []string       `json:"eligibleTargetIds"`
	Winner            *Role          `json:"winner"`
	Review            *GameReview    `json:"review"`
	Human             HumanView      `json:"human"`
	Model             string         `json:"model"`
}

// ---- Agent 隔离上下文(通过 allowlist 显式重建,不是从完整对象删字段)----

type ContextIdentity struct {
	PlayerID string `json:"playerId"`
	Name     string `json:"name"`
	Role     Role   `json:"role"`
	Word     string `json:"word"`
}

type ContextAlivePlayer struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type ContextDescription struct {
	PlayerID   string `json:"playerId"`
	PlayerName string `json:"playerName"`
	Text       string `json:"text"`
	Round      int    `json:"round"`
}

type ContextElimination struct {
	Text  string `json:"text"`
	Round int    `json:"round"`
}

type ContextGame struct {
	Round              int                  `json:"round"`
	AlivePlayers       []ContextAlivePlayer `json:"alivePlayers"`
	PublicDescriptions []ContextDescription `json:"publicDescriptions"`
	PublicEliminations []ContextElimination `json:"publicEliminations"`
}

type AgentContext struct {
	Identity ContextIdentity `json:"identity"`
	Game     ContextGame     `json:"game"`
}
