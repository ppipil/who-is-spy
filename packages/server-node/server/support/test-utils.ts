import type { AgentContext, GameReview, GameState, Player } from '../core/types.js';
import type { GameModel } from '../core/model.js';

export class FakeGameModel implements GameModel {
  readonly model = 'deepseek-v4-flash-test-double';
  readonly descriptionContexts: AgentContext[] = [];
  readonly voteContexts: AgentContext[] = [];

  isConfigured(): boolean {
    return true;
  }

  async describe(context: AgentContext): Promise<string> {
    this.descriptionContexts.push(structuredClone(context));
    const descriptions = {
      cautious: '平常不太显眼，却经常出现在熟悉场所',
      intuitive: '第一感觉带着鲜明氛围，让人很快产生联想',
      analytical: '从用途和类别看，它有一组清楚的边界',
      contrarian: '大家常说的特点之外，反而有个冷门场景',
    };
    return descriptions[context.identity.strategyId];
  }

  async vote(
    context: AgentContext,
    allowedTargets: Player[],
  ): Promise<{ targetId: string; reason: string }> {
    this.voteContexts.push(structuredClone(context));
    const human = allowedTargets.find((player) => player.isHuman);
    const targetIndex = {
      cautious: 0,
      intuitive: allowedTargets.length - 1,
      analytical: Math.min(1, allowedTargets.length - 1),
      contrarian: Math.max(0, allowedTargets.length - 2),
    }[context.identity.strategyId];
    const target = human ?? allowedTargets[targetIndex];
    const reasons = {
      cautious: '现有证据有限，但这位玩家的细节偏差最稳定',
      intuitive: '这段表达的自然感与其他人有明显落差',
      analytical: '其用途和类别线索与公开特征存在矛盾',
      contrarian: '这段话过度贴合共识，像是在安全跟随',
    };
    return {
      targetId: target.id,
      reason: reasons[context.identity.strategyId],
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
