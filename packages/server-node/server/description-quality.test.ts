import { describe, expect, it } from 'vitest';
import {
  DescriptionQualityGate,
  descriptionSimilarity,
  type DescriptionQualityEvent,
} from './description-quality.js';
import { GameEngine } from './game-engine.js';
import { FakeGameModel } from './test-utils.js';
import type { AgentContext } from './types.js';

class ScriptedDescriptionModel extends FakeGameModel {
  readonly requests: Array<{ context: AgentContext; request: unknown }> = [];

  constructor(private readonly outputs: string[]) {
    super();
  }

  override async describe(context: AgentContext, request?: unknown): Promise<string> {
    this.requests.push({ context: structuredClone(context), request: structuredClone(request) });
    return this.outputs.shift() ?? super.describe(context);
  }
}

describe('DescriptionQualityGate', () => {
  const gate = new DescriptionQualityGate();
  const base = {
    allSecrets: ['秘密甲', '秘密乙'],
    acceptedSameRound: ['像是日常中常见的一种体验'],
    duplicateSimilarityThreshold: 0.72,
  };

  it('rejects empty, invalid-length, and either complete secret without exposing it in the violation', () => {
    expect(gate.check({ ...base, text: '   ' })?.type).toBe('empty');
    expect(gate.check({ ...base, text: '一' })?.type).toBe('invalid_length');
    const violation = gate.check({ ...base, text: '答案就是秘密乙' });
    expect(violation?.type).toBe('secret_leak');
    expect(JSON.stringify(violation)).not.toContain('秘密乙');
  });

  it('uses a fixed and explainable similarity threshold without rejecting distinct samples', () => {
    const nearDuplicate = descriptionSimilarity('像是日常中常见的一种体验', '像是日常里常见的一种体验');
    const distinct = descriptionSimilarity('像是日常中常见的一种体验', '用途边界十分清楚');
    expect(nearDuplicate).toBeGreaterThanOrEqual(0.72);
    expect(distinct).toBeLessThan(0.72);
    expect(gate.check({ ...base, text: '像是日常里常见的一种体验' })?.type).toBe(
      'duplicate_description',
    );
    expect(gate.check({ ...base, text: '用途边界十分清楚' })).toBeNull();
  });

  it('retries a leaked description with redacted targeted guidance and then commits', async () => {
    const events: DescriptionQualityEvent[] = [];
    const model = new ScriptedDescriptionModel([]);
    const engine = new GameEngine(model, () => 0, (event) => events.push(event));
    const game = engine.createGame();
    const internal = engine.getInternalGame(game.id);
    const firstAgent = internal.players.find((player) => player.id === 'ai-1')!;
    const otherSecret = internal.players.find((player) => player.word !== firstAgent.word)!.word;
    model['outputs'].push(`答案是${otherSecret}`, '一种不太张扬但很常见的体验');

    const result = await engine.submitHumanDescription(game.id, '它在日常里经常出现');

    expect(result.phase).toBe('voting');
    expect(result.descriptions).toHaveLength(5);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ violationType: 'secret_leak', attempt: 1, willRetry: true });
    expect(JSON.stringify(events)).not.toContain(otherSecret);
    expect(JSON.stringify(model.requests[0].context)).not.toContain(otherSecret);
    expect(JSON.stringify(model.requests[1].request)).not.toContain(otherSecret);
    expect(model.requests[1].request).toMatchObject({
      repair: { violationType: 'secret_leak' },
    });
  });

  it('rejects a duplicate, retries with a new angle, and accepts normal outputs', async () => {
    const events: DescriptionQualityEvent[] = [];
    const model = new ScriptedDescriptionModel([
      '一种不太张扬但很常见的体验',
      '一种不太张扬但很常见的体验',
      '它常在特定场合形成明显氛围',
    ]);
    const engine = new GameEngine(model, () => 0, (event) => events.push(event));
    const game = engine.createGame();

    const result = await engine.submitHumanDescription(game.id, '这是生活里熟悉的一种东西');

    expect(result.phase).toBe('voting');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ violationType: 'duplicate_description', willRetry: true });
  });

  it('keeps accepted prefix public and stays describing when quality retries are exhausted', async () => {
    const events: DescriptionQualityEvent[] = [];
    const model = new ScriptedDescriptionModel([
      '第一条清楚又不重复的生活线索',
      '第二条换了角度的公开线索',
      '第三条强调使用场景',
    ]);
    const engine = new GameEngine(model, () => 0, (event) => events.push(event));
    const game = engine.createGame();
    model['outputs'].push(game.human.word, game.human.word, game.human.word);

    await expect(engine.submitHumanDescription(game.id, '这是生活里熟悉的一种东西')).rejects.toThrow(
      '状态未推进',
    );
    const after = engine.getInternalGame(game.id);
    expect(after.phase).toBe('describing');
    expect(after.descriptions.map((description) => description.playerId)).toEqual(['human', 'ai-1', 'ai-2', 'ai-3']);
    expect(after.events.filter((event) => event.type === 'description').map((event) => event.playerId)).toEqual([
      'human',
      'ai-1',
      'ai-2',
      'ai-3',
    ]);
    expect(after.descriptions.some((description) => description.playerId === 'ai-4')).toBe(false);
    expect(JSON.stringify(after.descriptions)).not.toContain(game.human.word);
    expect(JSON.stringify(after.events)).not.toContain(game.human.word);
    expect(after.events.some((event) => event.text === '所有人描述完毕。观察措辞，投出你最怀疑的一票。')).toBe(false);
    expect(events.filter((event) => event.agentId === 'ai-4')).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ agentId: 'ai-4', violationType: 'secret_leak', willRetry: false });
  });

  it('rejects an AI2 duplicate, commits only the repair, and gives AI3 the accepted prefix', async () => {
    const events: DescriptionQualityEvent[] = [];
    const duplicate = '一种不太张扬但很常见的体验';
    const repaired = '它常在特定场合形成明显氛围';
    const model = new ScriptedDescriptionModel([
      duplicate,
      duplicate,
      repaired,
      '第三位换成用途边界角度',
      '第四位补充一个不显眼场景',
    ]);
    const engine = new GameEngine(model, () => 0, (event) => events.push(event));
    const game = engine.createGame();

    const result = await engine.submitHumanDescription(game.id, '这是生活里熟悉的一种东西');

    expect(result.phase).toBe('voting');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agentId: 'ai-2',
      violationType: 'duplicate_description',
      attempt: 1,
      willRetry: true,
    });
    expect(model.requests[2].request).toMatchObject({
      attempt: 2,
      repair: { violationType: 'duplicate_description' },
    });

    const internal = engine.getInternalGame(game.id);
    const roundDescriptions = internal.descriptions.filter((description) => description.round === 1);
    expect(roundDescriptions.map((description) => description.playerId)).toEqual([
      'human',
      'ai-1',
      'ai-2',
      'ai-3',
      'ai-4',
    ]);
    expect(roundDescriptions.find((description) => description.playerId === 'ai-2')?.text).toBe(repaired);
    expect(roundDescriptions.filter((description) => description.text === duplicate)).toHaveLength(1);

    const ai3Request = model.requests.find((request) => request.context.identity.playerId === 'ai-3');
    expect(ai3Request?.context.game.publicDescriptions.map((description) => description.playerId)).toEqual([
      'human',
      'ai-1',
      'ai-2',
    ]);
    expect(ai3Request?.context.game.publicDescriptions.find((description) => description.playerId === 'ai-2')?.text).toBe(
      repaired,
    );
  });
});
