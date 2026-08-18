import type { AgentContext, GameReview, GameState, Player } from './types.js';
import type { GameModel } from './model.js';

export class FakeGameModel implements GameModel {
  readonly model = 'deepseek-v4-flash-test-double';
  readonly descriptionContexts: AgentContext[] = [];
  readonly voteContexts: AgentContext[] = [];

  isConfigured(): boolean {
    return true;
  }

  async describe(context: AgentContext): Promise<string> {
    this.descriptionContexts.push(structuredClone(context));
    return `它让我想到${context.identity.name}熟悉的日常场景`;
  }

  async vote(
    context: AgentContext,
    allowedTargets: Player[],
  ): Promise<{ targetId: string; reason: string }> {
    this.voteContexts.push(structuredClone(context));
    const human = allowedTargets.find((player) => player.isHuman);
    const target = human ?? allowedTargets[0];
    return {
      targetId: target.id,
      reason: human ? '真人的描述与我的理解有细微偏差' : '这位玩家的措辞最可疑',
    };
  }

  async review(game: GameState): Promise<GameReview> {
    return {
      headline: '细微的语义偏差决定了终局',
      summary: '玩家们围绕相近概念谨慎描述，最终通过公开措辞和集中票型找到了不同阵营。',
      turningPoints: ['首轮描述形成了清晰的判断分歧。', '多数票在终局集中到真正的卧底。'],
      playerInsights: game.players.map((player) => ({
        playerId: player.id,
        insight: `${player.name}围绕自己的词给出了独立判断。`,
      })),
    };
  }
}
