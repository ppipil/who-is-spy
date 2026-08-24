import { execFileSync } from 'node:child_process';

const ENV_VERSION_KEYS = ['CODE_VERSION', 'GIT_COMMIT_SHA', 'VERCEL_GIT_COMMIT_SHA', 'RENDER_GIT_COMMIT'] as const;

export function resolveCodeVersion(environment: NodeJS.ProcessEnv = process.env): string {
  for (const key of ENV_VERSION_KEYS) {
    const value = environment[key]?.trim();
    if (value) return value.slice(0, 12);
  }

  try {
    const revision = git(['rev-parse', '--short=12', 'HEAD']);
    const dirty = git(['status', '--porcelain', '--untracked-files=no', '--', 'packages/server-node', 'packages/web', 'package.json', 'package-lock.json']);
    return dirty ? revision + '+dirty' : revision;
  } catch {
    return 'development';
  }
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', timeout: 1_000, windowsHide: true }).trim();
}
