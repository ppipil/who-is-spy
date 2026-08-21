/**
 * 回放 CLI：从 JSONL trace 文件重放指定对局的人类可读事件流。
 */
import path from 'node:path';
import { readJsonlTrace, replayTrace } from './trace.js';

interface Options {
  gameId: string;
  traceFile: string;
  groupVotes: boolean;
}

/** 入口：解析参数 → 读取 trace → 重放输出。 */
function main(): void {
  const options = parseArguments(process.argv.slice(2));
  const events = readJsonlTrace(options.traceFile);
  console.log([
    '## 单局 Replay',
    '',
    `gameId：${options.gameId}`,
    `trace：${options.traceFile}`,
    '',
    replayTrace(events, options.gameId, { groupVoteBatches: options.groupVotes }),
  ].join('\n'));
}

function parseArguments(args: string[]): Options {
  const options: Partial<Options> = { traceFile: path.resolve('traces/m5-runtime.jsonl'), groupVotes: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === '--group-votes') {
      options.groupVotes = true;
    } else if ((argument === '--game' || argument === '--game-id') && value) {
      options.gameId = value;
      index += 1;
    } else if (argument === '--trace-file' && value) {
      options.traceFile = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`unknown or incomplete argument: ${argument}`);
    }
  }
  if (!options.gameId) throw new Error('missing required --game <gameId>');
  return options as Options;
}

main();
