import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  Eye,
  Fingerprint,
  LoaderCircle,
  LockKeyhole,
  MessageCircleMore,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Target,
  Vote,
  X,
} from 'lucide-react';
import { api } from './api';
import type { PublicGameState, PublicPlayer, Role } from './types';

type Screen = 'home' | 'reveal' | 'game';

export function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [game, setGame] = useState<PublicGameState | null>(null);
  const [description, setDescription] = useState('');
  const [selectedTarget, setSelectedTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [model, setModel] = useState('deepseek-v4-flash');
  const feedEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .health()
      .then((health) => {
        setConfigured(health.configured);
        setModel(health.model);
      })
      .catch(() => setConfigured(false));
  }, []);

  useEffect(() => {
    if (screen === 'game') {
      feedEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [game?.events.length, screen]);

  const runAction = async (action: () => Promise<PublicGameState>) => {
    setBusy(true);
    setError('');
    try {
      const nextGame = await action();
      setGame(nextGame);
      setSelectedTarget('');
      setDescription('');
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : '发生未知错误');
    } finally {
      setBusy(false);
    }
  };

  const startGame = async () => {
    await runAction(async () => {
      const created = await api.createGame();
      setScreen('reveal');
      return created;
    });
  };

  const restart = () => {
    setGame(null);
    setDescription('');
    setSelectedTarget('');
    setError('');
    setScreen('home');
  };

  if (screen === 'home') {
    return (
      <HomeScreen
        configured={configured}
        model={model}
        busy={busy}
        error={error}
        onStart={startGame}
      />
    );
  }

  if (!game) return null;

  if (screen === 'reveal') {
    return <RevealScreen game={game} onContinue={() => setScreen('game')} />;
  }

  return (
    <GameScreen
      game={game}
      description={description}
      selectedTarget={selectedTarget}
      busy={busy}
      error={error}
      feedEndRef={feedEndRef}
      onDescriptionChange={setDescription}
      onTargetChange={setSelectedTarget}
      onDescribe={() => runAction(() => api.describe(game.id, description))}
      onVote={() => runAction(() => api.vote(game.id, selectedTarget))}
      onContinue={() => runAction(() => api.continue(game.id))}
      onRestart={restart}
    />
  );
}

function HomeScreen({
  configured,
  model,
  busy,
  error,
  onStart,
}: {
  configured: boolean | null;
  model: string;
  busy: boolean;
  error: string;
  onStart: () => void;
}) {
  return (
    <main className="home-shell">
      <div className="paper-noise" />
      <nav className="topbar">
        <div className="brand">
          <span className="brand-seal">潜</span>
          <span>潜词局</span>
        </div>
        <div className="model-chip">
          <span className={`status-dot ${configured ? 'online' : ''}`} />
          {configured === null ? '正在确认模型' : configured ? `${model} 已就席` : '等待模型密钥'}
        </div>
      </nav>

      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">
            <span>01</span>
            五人入局 · 一词之差
          </div>
          <h1>
            别说出答案。
            <br />
            <em>也别暴露自己。</em>
          </h1>
          <p className="hero-lede">
            你将与四位独立思考的 AI 玩家同桌。每个人只看得到自己的密词，
            真相藏在那些看似普通的描述里。
          </p>

          <div className="hero-actions">
            <button className="primary-button ink" onClick={onStart} disabled={busy}>
              {busy ? <LoaderCircle className="spin" size={18} /> : <Fingerprint size={18} />}
              抽取身份，进入牌局
              <ArrowRight size={18} />
            </button>
            <span className="duration">一局约 5–8 分钟</span>
          </div>

          {configured === false && (
            <div className="setup-warning">
              <CircleAlert size={18} />
              <span>
                尚未检测到 <code>DEEPSEEK_API_KEY</code>。可以抽取身份，但 AI 行动前需先配置
                <code>.env</code>。
              </span>
            </div>
          )}
          {error && <InlineError message={error} />}
        </div>

        <div className="hero-stage" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="table-disc">
            <span className="table-kicker">ROUND TABLE / 05</span>
            <strong>?</strong>
            <span>谁拿到了不同的词</span>
          </div>
          {['你', '序', '弥', '墨', '满'].map((label, index) => (
            <div className={`orbit-player player-${index + 1}`} key={label}>
              <span>{label}</span>
              {index > 0 && <i />}
            </div>
          ))}
          <div className="floating-card card-a">相似，不等于相同</div>
          <div className="floating-card card-b">四个 Agent · 独立视角</div>
        </div>
      </section>

      <section className="how-grid">
        <article>
          <MessageCircleMore />
          <span>01 / 描述</span>
          <h3>绕着密词说</h3>
          <p>说得太直白会帮到卧底，太含糊又会让自己成为目标。</p>
        </article>
        <article>
          <Vote />
          <span>02 / 投票</span>
          <h3>读懂弦外之音</h3>
          <p>每位 AI 根据自己的词与公开发言，独立做出判断。</p>
        </article>
        <article>
          <Eye />
          <span>03 / 复盘</span>
          <h3>真相全部翻开</h3>
          <p>终局揭晓身份与密词，AI 重走关键转折和票型。</p>
        </article>
      </section>
    </main>
  );
}

function RevealScreen({ game, onContinue }: { game: PublicGameState; onContinue: () => void }) {
  const [revealed, setRevealed] = useState(false);
  const isUndercover = game.human.role === 'undercover';

  return (
    <main className={`reveal-shell ${revealed ? 'is-revealed' : ''}`}>
      <div className="paper-noise" />
      <div className="reveal-header">
        <div className="brand light">
          <span className="brand-seal">潜</span>
          <span>潜词局</span>
        </div>
        <span>身份仅在你的设备上展示</span>
      </div>

      <section className="reveal-content">
        <p className="eyebrow light-eyebrow">PRIVATE BRIEFING / 私密简报</p>
        <h2>{revealed ? '记住它，然后藏好。' : '你的身份已经封入信笺。'}</h2>
        <p>身边有人拿到了相近、却不同的词。</p>

        <button
          className={`identity-envelope ${revealed ? 'open' : ''}`}
          onClick={() => !revealed && setRevealed(true)}
          aria-label={revealed ? '身份已揭晓' : '点击揭晓身份'}
        >
          <div className="envelope-front">
            <LockKeyhole size={24} />
            <span>点击拆封</span>
            <small>只看一眼，别让旁边的人发现</small>
          </div>
          <div className="identity-card">
            <span className="role-label">你的阵营</span>
            <strong>{isUndercover ? '卧底' : '平民'}</strong>
            <div className="word-block">
              <span>你的密词</span>
              <b>{game.human.word}</b>
            </div>
            <p>
              {isUndercover
                ? '你的词与多数人不同。听懂他们的暗示，伪装到最后。'
                : '找到那个描述总有一点偏差的人，并把票投给他。'}
            </p>
          </div>
        </button>

        <button className="primary-button paper" disabled={!revealed} onClick={onContinue}>
          我记住了，收起身份
          <ArrowRight size={18} />
        </button>
      </section>
    </main>
  );
}

function GameScreen({
  game,
  description,
  selectedTarget,
  busy,
  error,
  feedEndRef,
  onDescriptionChange,
  onTargetChange,
  onDescribe,
  onVote,
  onContinue,
  onRestart,
}: {
  game: PublicGameState;
  description: string;
  selectedTarget: string;
  busy: boolean;
  error: string;
  feedEndRef: React.RefObject<HTMLDivElement | null>;
  onDescriptionChange: (value: string) => void;
  onTargetChange: (value: string) => void;
  onDescribe: () => void;
  onVote: () => void;
  onContinue: () => void;
  onRestart: () => void;
}) {
  const human = game.players.find((player) => player.isHuman)!;

  if (game.phase === 'finished') {
    return <ReviewScreen game={game} onRestart={onRestart} />;
  }

  return (
    <main className="game-shell">
      <div className="paper-noise" />
      <header className="game-header">
        <div className="brand">
          <span className="brand-seal">潜</span>
          <span>潜词局</span>
        </div>
        <div className="round-track">
          <span>第 {game.round} 轮</span>
          <i />
          <span className={game.phase === 'describing' ? 'active' : ''}>描述</span>
          <i />
          <span className={game.phase === 'voting' ? 'active' : ''}>
            投票 {game.ballot > 1 ? '· 加票' : ''}
          </span>
        </div>
        <button className="quiet-button" onClick={onRestart}>
          <RotateCcw size={15} />
          退出牌局
        </button>
      </header>

      <div className="game-layout">
        <section className="table-panel">
          <div className="table-heading">
            <div>
              <span>THE ROUND TABLE</span>
              <h2>{phaseTitle(game)}</h2>
            </div>
            <div className="secret-reminder">
              <LockKeyhole size={15} />
              <span>你的密词</span>
              <b>{game.human.word}</b>
            </div>
          </div>

          <div className="player-grid">
            {game.players.map((player) => (
              <PlayerSeat
                key={player.id}
                player={player}
                game={game}
                selectable={
                  game.phase === 'voting' &&
                  human.alive &&
                  player.alive &&
                  !player.isHuman &&
                  (!game.eligibleTargetIds || game.eligibleTargetIds.includes(player.id))
                }
                selected={selectedTarget === player.id}
                onSelect={() => onTargetChange(player.id)}
              />
            ))}
            <div className="table-center">
              <span className="center-round">R{String(game.round).padStart(2, '0')}</span>
              <span className="center-mark">潜</span>
              <small>{game.players.filter((player) => player.alive).length} 人在场</small>
            </div>
          </div>

          <ActionDock
            game={game}
            humanAlive={human.alive}
            description={description}
            selectedTarget={selectedTarget}
            busy={busy}
            error={error}
            onDescriptionChange={onDescriptionChange}
            onDescribe={onDescribe}
            onVote={onVote}
            onContinue={onContinue}
          />
        </section>

        <aside className="feed-panel">
          <div className="feed-heading">
            <div>
              <span>PUBLIC RECORD</span>
              <h3>公开记录</h3>
            </div>
            <span className="live-badge">
              <i />
              LIVE
            </span>
          </div>

          <div className="event-feed">
            {game.events.map((event, index) => {
              const player = event.playerId
                ? game.players.find((item) => item.id === event.playerId)
                : undefined;
              return (
                <div className={`event-item ${event.type}`} key={event.id}>
                  <div className="event-line">
                    <span>{event.type === 'description' ? player?.avatar : index + 1}</span>
                  </div>
                  <div>
                    <small>
                      {event.type === 'description'
                        ? `${player?.name} · 第 ${event.round} 轮`
                        : event.type === 'elimination'
                          ? '淘汰结果'
                          : '主持人'}
                    </small>
                    <p>{event.text}</p>
                  </div>
                </div>
              );
            })}
            {busy && (
              <div className="thinking-row">
                <span className="thinking-dots">
                  <i />
                  <i />
                  <i />
                </span>
                {game.phase === 'describing' ? '四位玩家正在斟酌措辞…' : '所有人正在写下选票…'}
              </div>
            )}
            <div ref={feedEndRef} />
          </div>

          <div className="isolation-note">
            <ShieldCheck size={18} />
            <div>
              <strong>独立视角已开启</strong>
              <span>每位 AI 仅接收自己的密词与此处公开记录</span>
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}

function PlayerSeat({
  player,
  game,
  selectable,
  selected,
  onSelect,
}: {
  player: PublicPlayer;
  game: PublicGameState;
  selectable: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const latestDescription = [...game.descriptions]
    .reverse()
    .find((item) => item.playerId === player.id && item.round === game.round);

  return (
    <button
      className={`player-seat ${player.isHuman ? 'human' : ''} ${!player.alive ? 'eliminated' : ''} ${selectable ? 'selectable' : ''} ${selected ? 'selected' : ''}`}
      disabled={!selectable}
      onClick={onSelect}
    >
      <span className="avatar-ring">
        <span>{player.avatar}</span>
        {player.alive && !player.isHuman && <i />}
      </span>
      <span className="player-meta">
        <strong>{player.name}</strong>
        <small>
          {!player.alive ? '已出局' : player.isHuman ? '真人玩家' : 'AI 玩家'}
        </small>
      </span>
      {selected && (
        <span className="selected-check">
          <Check size={13} />
        </span>
      )}
      {latestDescription && <span className="seat-quote">“{latestDescription.text}”</span>}
      {!player.alive && <X className="eliminated-mark" />}
    </button>
  );
}

function ActionDock({
  game,
  humanAlive,
  description,
  selectedTarget,
  busy,
  error,
  onDescriptionChange,
  onDescribe,
  onVote,
  onContinue,
}: {
  game: PublicGameState;
  humanAlive: boolean;
  description: string;
  selectedTarget: string;
  busy: boolean;
  error: string;
  onDescriptionChange: (value: string) => void;
  onDescribe: () => void;
  onVote: () => void;
  onContinue: () => void;
}) {
  if (!humanAlive) {
    return (
      <div className="action-dock spectator">
        <div>
          <Eye size={20} />
          <span>
            <strong>你已离席，牌局仍在继续</strong>
            <small>以观战视角推进 AI 玩家的下一阶段</small>
          </span>
        </div>
        <button className="primary-button ink" onClick={onContinue} disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}
          推进牌局
        </button>
        {error && <InlineError message={error} />}
      </div>
    );
  }

  if (game.phase === 'describing') {
    return (
      <div className="action-dock">
        <div className="dock-title">
          <MessageCircleMore size={20} />
          <div>
            <strong>轮到你描述</strong>
            <span>不要出现密词原文 · 2–60 字</span>
          </div>
        </div>
        <div className="description-input">
          <textarea
            value={description}
            onChange={(event) => onDescriptionChange(event.target.value)}
            placeholder="例如：它通常会在安静的时候出现…"
            maxLength={60}
            disabled={busy}
          />
          <span>{description.trim().length}/60</span>
          <button
            className="send-button"
            onClick={onDescribe}
            disabled={busy || description.trim().length < 2}
          >
            {busy ? <LoaderCircle className="spin" size={18} /> : <ArrowRight size={18} />}
          </button>
        </div>
        {error && <InlineError message={error} />}
      </div>
    );
  }

  const selected = game.players.find((player) => player.id === selectedTarget);
  return (
    <div className="action-dock vote-dock">
      <div className="dock-title">
        <Target size={20} />
        <div>
          <strong>{game.ballot > 1 ? '同票加赛：重新选择' : '选出最可疑的人'}</strong>
          <span>
            {selected ? `当前选择：${selected.name}` : '点击上方玩家席位，再确认投票'}
          </span>
        </div>
      </div>
      <button className="primary-button ink" onClick={onVote} disabled={busy || !selectedTarget}>
        {busy ? <LoaderCircle className="spin" size={17} /> : <Vote size={17} />}
        确认投给 {selected?.name ?? '…'}
      </button>
      {error && <InlineError message={error} />}
    </div>
  );
}

function ReviewScreen({ game, onRestart }: { game: PublicGameState; onRestart: () => void }) {
  const [expandedRound, setExpandedRound] = useState<number | null>(1);
  const humanWon = game.winner === game.human.role;
  const rounds = useMemo(
    () => Array.from({ length: game.round }, (_, index) => index + 1),
    [game.round],
  );
  const civilianWord = game.players.find((item) => item.revealedRole === 'civilian')?.revealedWord;

  return (
    <main className="review-shell">
      <div className="paper-noise" />
      <header className="review-header">
        <div className="brand light">
          <span className="brand-seal">潜</span>
          <span>潜词局 · 终局档案</span>
        </div>
        <button className="quiet-button light-button" onClick={onRestart}>
          <RotateCcw size={15} />
          再开一局
        </button>
      </header>

      <section className="result-hero">
        <div className="result-stamp">{humanWon ? '胜' : '惜'}</div>
        <div>
          <span>CASE CLOSED / 对局结束</span>
          <h1>{humanWon ? '你读懂了那一点偏差。' : '真相，藏过了最后一票。'}</h1>
          <p>{game.review?.headline}</p>
        </div>
        <div className="winner-card">
          <small>获胜阵营</small>
          <strong>{roleName(game.winner)}</strong>
          <span>{game.round} 轮 · {game.players.length} 位玩家</span>
        </div>
      </section>

      <section className="identity-reveal">
        <div className="section-label">
          <span>01</span>
          身份揭晓
        </div>
        <div className="identity-grid">
          {game.players.map((player) => (
            <article
              key={player.id}
              className={player.revealedRole === 'undercover' ? 'undercover-card' : ''}
            >
              <span className="review-avatar">{player.avatar}</span>
              <div>
                <strong>{player.name}</strong>
                <span>{roleName(player.revealedRole)}</span>
              </div>
              <b>{player.revealedWord}</b>
              {player.revealedRole === 'undercover' && <span className="undercover-tag">卧底</span>}
            </article>
          ))}
        </div>
      </section>

      <section className="review-body">
        <div className="analysis-column">
          <div className="section-label">
            <span>02</span>
            AI 赛后复盘
          </div>
          <article className="summary-card">
            <Sparkles size={22} />
            <p>{game.review?.summary}</p>
          </article>
          <div className="turning-points">
            {game.review?.turningPoints.map((point, index) => (
              <div key={point}>
                <span>0{index + 1}</span>
                <p>{point}</p>
              </div>
            ))}
          </div>

          <div className="insight-list">
            {game.review?.playerInsights.map((insight) => {
              const player = game.players.find((item) => item.id === insight.playerId);
              return (
                <div key={insight.playerId}>
                  <span>{player?.avatar}</span>
                  <p>
                    <strong>{player?.name}</strong>
                    {insight.insight}
                  </p>
                </div>
              );
            })}
          </div>
        </div>

        <div className="timeline-column">
          <div className="section-label">
            <span>03</span>
            完整票局
          </div>
          <div className="round-accordions">
            {rounds.map((round) => {
              const descriptions = game.descriptions.filter((item) => item.round === round);
              const votes = game.votes.filter((item) => item.round === round);
              const open = expandedRound === round;
              return (
                <article className={open ? 'open' : ''} key={round}>
                  <button onClick={() => setExpandedRound(open ? null : round)}>
                    <span>ROUND {String(round).padStart(2, '0')}</span>
                    <strong>第 {round} 轮记录</strong>
                    <ChevronDown size={18} />
                  </button>
                  {open && (
                    <div className="round-details">
                      {descriptions.map((item) => (
                        <p key={`${round}-${item.playerId}`}>
                          <b>{playerName(game, item.playerId)}</b>
                          “{item.text}”
                        </p>
                      ))}
                      <div className="vote-lines">
                        {votes.map((vote, index) => (
                          <span key={`${round}-${vote.ballot}-${vote.voterId}-${index}`}>
                            {playerName(game, vote.voterId)} → {playerName(game, vote.targetId)}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
          <div className="fairness-card">
            <ShieldCheck size={20} />
            <div>
              <strong>这是一场信息隔离的牌局</strong>
              <p>
                {game.model} 的每个 Agent 请求只包含它自己的身份、密词和已公开记录。
                其他玩家的密词只在终局复盘阶段解封。
              </p>
            </div>
          </div>
        </div>
      </section>

      <footer className="review-footer">
        <span>平民词：{civilianWord ?? '—'}</span>
        <button className="primary-button paper" onClick={onRestart}>
          <RotateCcw size={17} />
          换一组词，再开一局
        </button>
      </footer>
    </main>
  );
}

function phaseTitle(game: PublicGameState): string {
  if (game.phase === 'describing') return '话要留白，意要够真。';
  if (game.ballot > 1) return '同票。最后一次判断。';
  return '谁的描述，偏了一点？';
}

function roleName(role?: Role | null): string {
  if (role === 'undercover') return '卧底';
  if (role === 'civilian') return '平民';
  return '未知';
}

function playerName(game: PublicGameState, id: string): string {
  return game.players.find((player) => player.id === id)?.name ?? '未知玩家';
}

function InlineError({ message }: { message: string }) {
  return (
    <div className="inline-error">
      <CircleAlert size={16} />
      {message}
    </div>
  );
}
