import { describe, expect, it } from 'vitest';
import { flagLowInformationClue } from './persona-diagnostics.js';

describe('low-information generic clue diagnostic', () => {
  it('flags generic placeholder sentences that carry no judgment value', () => {
    expect(flagLowInformationClue('它很常见，和生活有关，大家可能接触过').length).toBeGreaterThanOrEqual(2);
    expect(flagLowInformationClue('平时会遇到的一种东西')).not.toHaveLength(0);
    expect(flagLowInformationClue('是一种很普遍的东西')).not.toHaveLength(0);
  });

  it('does not flag weak but concrete clues', () => {
    expect(flagLowInformationClue('赶时间的时候会特别有存在感')).toHaveLength(0);
    expect(flagLowInformationClue('它和人的关系通常不只是远远观察')).toHaveLength(0);
    expect(flagLowInformationClue('我注意到它有时会发出特定的声音')).toHaveLength(0);
  });
});
