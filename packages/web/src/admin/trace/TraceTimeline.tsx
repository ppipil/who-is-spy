import { ChevronDown, ChevronRight } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { TimelineNode } from './traceTypes';

interface Props {
  nodes: TimelineNode[];
  selectedId: string | null;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onSelect: (node: TimelineNode) => void;
}

export function TraceTimeline({ nodes, selectedId, expanded, onToggle, onSelect }: Props) {
  return (
    <section className="trace-timeline">
      <div className="trace-panel-title"><span>轮次时间线</span></div>
      {nodes.length === 0 ? <p className="admin-empty">本次运行暂无事件。</p> : nodes.map((node) => (
        <TimelineBranch key={node.id} node={node} depth={0} selectedId={selectedId} expanded={expanded} onToggle={onToggle} onSelect={onSelect} />
      ))}
    </section>
  );
}

type BranchProps = Omit<Props, 'nodes'> & { node: TimelineNode; depth: number };

function TimelineBranch({ node, depth, selectedId, expanded, onToggle, onSelect }: BranchProps) {
  const open = expanded.has(node.id);
  const hasChildren = node.children.length > 0;
  return (
    <div className="timeline-branch" style={{ '--depth': depth } as CSSProperties}>
      <button className={`timeline-node ${node.status} ${selectedId === node.id ? 'is-selected' : ''}`} onClick={() => { onSelect(node); if (hasChildren) onToggle(node.id); }}>
        {hasChildren ? open ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : <span className="timeline-leaf" />}
        <span className="timeline-kind">{kindLabel(node.kind)}</span>
        {nodeTime(node) && <time className="timeline-time" dateTime={nodeTime(node)}>{formatTraceTime(nodeTime(node))}</time>}
        <strong>{node.title}</strong>
        {node.meta.slice(0, 2).map((item) => <small key={item.label}>{item.label}: {item.value}</small>)}
      </button>
      {hasChildren && open && node.children.map((child) => (
        <TimelineBranch key={child.id} node={child} depth={depth + 1} selectedId={selectedId} expanded={expanded} onToggle={onToggle} onSelect={onSelect} />
      ))}
    </div>
  );
}

function nodeTime(node: TimelineNode): string {
  return node.occurredAt ?? (typeof node.events[0]?.timestamp === 'string' ? node.events[0].timestamp : '');
}

function formatTraceTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function kindLabel(kind: TimelineNode['kind']): string {
  const labels: Record<TimelineNode['kind'], string> = {
    run: '运行',
    round: '轮次',
    action: '动作',
    model: '模型',
    prompt: '提示词',
    public: '公开',
    vote: '投票',
    quality: '质量',
    recovery: '恢复',
    retry: '重试',
    continue: '继续',
  };
  return labels[kind];
}