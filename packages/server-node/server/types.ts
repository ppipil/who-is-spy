export type Role = 'civilian' | 'undercover';
export type Phase = 'describing' | 'voting' | 'finished';

export interface Player {
  id: string;
  name: string;
  avatar: string;
  isHuman: boolean;
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
}

export interface AgentContext {
  identity: {
    playerId: string;
    name: string;
    role: Role;
    word: string;
  };
  game: {
    round: number;
    alivePlayers: Array<{ id: string; name: string }>;
    publicDescriptions: Array<{ playerId: string; playerName: string; text: string; round: number }>;
    publicEliminations: Array<{ text: string; round: number }>;
  };
}
