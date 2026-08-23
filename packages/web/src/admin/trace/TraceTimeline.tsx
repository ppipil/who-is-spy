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
      <div className="trace-panel-title"><span>Round Timeline</span></div>
      {nodes.length === 0 ? <p className="admin-empty">No events for this run.</p> : nodes.map((node) => (
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
        <span className="timeline-kind">{node.kind}</span>
        <strong>{node.title}</strong>
        {node.meta.slice(0, 2).map((item) => <small key={item.label}>{item.label}: {item.value}</small>)}
      </button>
      {hasChildren && open && node.children.map((child) => (
        <TimelineBranch key={child.id} node={child} depth={depth + 1} selectedId={selectedId} expanded={expanded} onToggle={onToggle} onSelect={onSelect} />
      ))}
    </div>
  );
}
