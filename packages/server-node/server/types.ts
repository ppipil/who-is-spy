/**
 * 领域类型定义
 *
 * 集中定义游戏角色/阶段、玩家、描述、投票、事件、公开视图与 Agent 上下文。
 * 其中 AgentContext 是隐私边界的关键契约：
 * 服务端只允许把“自己的身份 + 公开信息”放进上下文。
 */
export type Role = 'civilian' | 'undercover';
export type Phase = 'describing' | 'voting' | 'finished';
export type AgentStrategyId = 'cautious' | 'intuitive' | 'analytical' | 'contrarian';

/** 玩家：AI 玩家带 strategyId；role/word 属于服务器私有字段。 */
export interface Player {
  id: string;
  name: string;
  avatar: string;
  isHuman: boolean;
  strategyId?: AgentStrategyId;
  role: Role;
  word: string;
  alive: boolean;
}

/** 一条已提交的描述（公开后可被所有人看到）。 */
export interface Description {
  playerId: string;
  text: string;
  round: number;
}

/** 一张投票记录：投票人/目标/理由/轮次/票次。 */
export interface Vote {
  voterId: string;
  targetId: string;
  reason: string;
  round: number;
  ballot: number;
}

/** 对局公开事件：系统提示/描述/投票结果/淘汰。 */
export interface GameEvent {
  id: string;
  type: 'system' | 'description' | 'vote_result' | 'elimination';
  text: string;
  round: number;
  playerId?: string;
}

/** 终局复盘结果。 */
export interface GameReview {
  headline: string;
  summary: string;
  turningPoints: string[];
  playerInsights: Array<{ playerId: string; insight: string }>;
}

/** 服务器内部完整状态：包含所有身份与密词，绝不可直接对外返回。 */
export interface GameState {
  id: string;
  phase: Phase;
  round: number;
  ballot: number;
  players: Player[];
  descriptions: Description[];
  votes: Vote[];
  events: GameEvent[];
  eligibleTargetIds: string[] | null;
  winner: Role | null;
  review: GameReview | null;
  createdAt: number;
}

/** 公开玩家视图：终局前不含 role/word，终局后通过 revealedRole/revealedWord 揭晓。 */
export interface PublicPlayer {
  id: string;
  name: string;
  avatar: string;
  isHuman: boolean;
  alive: boolean;
  revealedRole?: Role;
  revealedWord?: string;
}

/** 对外公开对局视图：所有玩家身份都被隐藏，仅人类能看到自己的身份。 */
export interface PublicGameState {
  id: string;
  phase: Phase;
  round: number;
  ballot: number;
  players: PublicPlayer[];
  descriptions: Description[];
  votes: Vote[];
  events: GameEvent[];
  eligibleTargetIds: string[] | null;
  winner: Role | null;
  review: GameReview | null;
  human: { playerId: string; role: Role; word: string };
  model: string;
  descriptionResume?: {
    missingAgentId: string;
    manualResumeIndex: number;
    manualRetriesRemaining: number;
  };
}

/** 描述发布进度的 SSE 事件（前端用于展示逐步公开）。 */
export interface PublicDescriptionProgressEvent {
  type: 'description_published';
  gameId: string;
  description: Description & { playerName: string };
  event: GameEvent;
  phase: 'describing';
  progress: {
    completed: number;
    total: number;
    nextSpeaker: { playerId: string; playerName: string } | null;
  };
}

/** 阶段切换的 SSE 事件（进入投票/加票/新一轮）。 */
export interface PublicPhaseProgressEvent {
  type: 'phase_changed';
  gameId: string;
  phase: Phase;
  round: number;
  ballot: number;
  eligibleTargetIds: string[] | null;
  event: GameEvent;
}

/** 所有公开进度事件类型。 */
export type PublicProgressEvent = PublicDescriptionProgressEvent | PublicPhaseProgressEvent;

/**
 * Agent 上下文：单个 AI 决策所需的全部信息。
 * identity 只含自己的角色/密词；game 只含公开信息（存活名单、公开描述、公开淘汰）。
 * 禁止放入其他玩家的 role/word、未公开票型、候选目标等隐藏字段。
 */
export interface AgentContext {
  identity: {
    playerId: string;
    name: string;
    strategyId: AgentStrategyId;
    role: Role;
    word: string;
  };
  game: {
    gameId: string;
    round: number;
    phase: Phase;
    ballot: number;
    alivePlayers: Array<{ id: string; name: string }>;
    publicDescriptions: Array<{ playerId: string; playerName: string; text: string; round: number }>;
    publicEliminations: Array<{ text: string; round: number }>;
  };
}
