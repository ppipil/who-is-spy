import type { EvaluationReport } from './evaluationTypes';

export function EvaluationEvidence({ report }: { report: EvaluationReport }) {
  const cases = report.deterministic?.cases ?? [];
  if (cases.length === 0) return null;
  return (
    <section className="evaluation-evidence">
      <h3>固定用例证据 Case Evidence</h3>
      {cases.map((item) => (
        <details key={item.gameId}>
          <summary>{item.caseId} · {item.completed ? '已完成' : '未完成'}</summary>
          <p><strong>Human 输入:</strong> {item.humanDescription}</p>
          <h4>公开描述</h4>
          <ol>{item.descriptions.map((entry, index) => <li key={`${entry.playerId}-${entry.round}-${index}`}>{entry.playerName} / R{entry.round}: {entry.text}</li>)}</ol>
          <h4>公开投票</h4>
          <ol>{item.votes.map((entry, index) => <li key={`${entry.voterId}-${entry.round}-${index}`}>{entry.voterName} → {entry.targetId} / R{entry.round}: {entry.reason}</li>)}</ol>
        </details>
      ))}
    </section>
  );
}
