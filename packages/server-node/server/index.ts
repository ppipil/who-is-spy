import 'dotenv/config';
import { createApp } from './app.js';
import { DeepSeekClient, type GameModel } from './model.js';
import { FakeGameModel } from './test-utils.js';

// GAME_MODEL 选择运行时模型来源:
//   real(默认)  真实 DeepSeek / OpenAI-compatible 调用,需要 DEEPSEEK_API_KEY
//   fake          确定性测试替身,无需密钥,用于契约测试和本地冒烟
function resolveModel(): GameModel {
  if ((process.env.GAME_MODEL ?? 'real').toLowerCase() === 'fake') {
    return new FakeGameModel();
  }
  return new DeepSeekClient();
}

const port = Number(process.env.PORT ?? 8787);
const { app } = createApp(resolveModel());

app.listen(port, () => {
  console.log(`潜词局 server listening on http://localhost:${port}`);
});
