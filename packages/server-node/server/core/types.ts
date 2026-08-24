export type Role = 'civilian' | 'undercover';
export type Phase = 'describing' | 'voting' | 'finished';
export type AgentStrategyId = 'cautious' | 'intuitive' | 'analytical' | 'contrarian';

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

export interface Description {
  playerId: string;
  text: string;
  round: number;
}

export interface Vote {
  voterId: string;
  targetId: string;
  reason: string;
  round: number;
  ballot: number;
}

export interface GameEvent {
  id: string;
  type: 'system' | 'description' | 'vote_result' | 'elimination';
  text: string;
  round: number;
  playerId?: string;
}

export interface GameReview {
  headline: string;
  summary: string;
  turningPoints: string[];
  playerInsights: Array<{ playerId: string; insight: string }>;
}

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

export interface PublicPlayer {
  id: string;
  name: string;
  avatar: string;
  isHuman: boolean;
  alive: boolean;
  revealedRole?: Role;
  revealedWord?: string;
}

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

export interface PublicPhaseProgressEvent {
  type: 'phase_changed';
  gameId: string;
  phase: Phase;
  round: number;
  ballot: number;
  eligibleTargetIds: string[] | null;
  event: GameEvent;
}

export type PublicProgressEvent = PublicDescriptionProgressEvent | PublicPhaseProgressEvent;

export interface AgentContext {
  // 当前 Agent 的私有视图；role/word 不得从这里扩展成其他玩家列表。
  identity: {
    playerId: string;
    name: string;
    strategyId: AgentStrategyId;
    role: Role;
    word: string;
  };
  // 对局公开视图。这里故意不接受 Player[]，以便在类型层阻止其他玩家密词和身份下沉到模型层。
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
