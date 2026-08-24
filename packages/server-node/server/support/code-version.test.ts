import { describe, expect, it } from 'vitest';
import { resolveCodeVersion } from './code-version.js';

describe('code version', () => {
  it('prefers an explicit deployment version and truncates a full commit SHA', () => {
    expect(resolveCodeVersion({ CODE_VERSION: 'abcdef1234567890' } as NodeJS.ProcessEnv)).toBe('abcdef123456');
  });

  it('accepts common deployment commit environment variables', () => {
    expect(resolveCodeVersion({ GIT_COMMIT_SHA: '1234567890abcdef' } as NodeJS.ProcessEnv)).toBe('1234567890ab');
  });
});
