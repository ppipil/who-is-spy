export type Role = 'civilian' | 'undercover';
export type Phase = 'describing' | 'voting' | 'finished';

export interface PublicPlayer {
  id: string;
  name: string;
  avatar: string;
  isHuman: boolean;
  alive: boolean;
  revealedRole?: Role;
  revealedWord?: string;
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

export interface PublicGameState {
  id: string;
  phase: Phase;
  round: number;
  ballot: number;
  players: PublicPlayer[];
  descriptions: Array<{ playerId: string; text: string; round: number }>;
  votes: Array<{
    voterId: string;
    targetId: string;
    reason: string;
    round: number;
    ballot: number;
  }>;
  events: GameEvent[];
  eligibleTargetIds: string[] | null;
  winner: Role | null;
  review: GameReview | null;
  human: { playerId: string; role: Role; word: string };
  model: string;
}

export interface DescriptionPublishedProgressEvent {
  type: 'description_published';
  gameId: string;
  description: { playerId: string; playerName: string; text: string; round: number };
  event: GameEvent;
  phase: 'describing';
  progress: { completed: number; total: number; nextSpeaker: { playerId: string; playerName: string } | null };
}

export interface PhaseChangedProgressEvent {
  type: 'phase_changed';
  gameId: string;
  phase: Phase;
  round: number;
  ballot: number;
  eligibleTargetIds: string[] | null;
  event: GameEvent;
}

export type GameProgressEvent = DescriptionPublishedProgressEvent | PhaseChangedProgressEvent;
