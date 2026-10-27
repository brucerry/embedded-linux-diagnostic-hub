import { ChevronDown, ChevronUp } from 'lucide-react';
import { useRef } from 'react';
import type { EvidenceNode } from '../../../shared/diagnostics/evidence';

function Nodes({ nodes }: { nodes: EvidenceNode[] }) {
    return (
        <ul>
            {nodes.map((node) => (
                <li key={node.key}>
                    {node.children?.length ? (
                        <details>
                            <summary>
                                <span className="tree-key">{node.label}</span>
                                {node.value && <span className="tree-value">{node.value}</span>}
                                <span className="tree-count">{node.children.length}</span>
                            </summary>
                            <Nodes nodes={node.children} />
                        </details>
                    ) : (
                        <div className="tree-leaf">
                            <span className="tree-key">{node.label}</span>
                            {node.value !== undefined && (
                                <span className="tree-value">{node.value}</span>
                            )}
                        </div>
                    )}
                </li>
            ))}
        </ul>
    );
}

export function EvidenceTree({ nodes }: { nodes: EvidenceNode[] }) {
    const ref = useRef<HTMLElement>(null);
    const expand = (open: boolean) => {
        ref.current?.querySelectorAll('details').forEach((details) => {
            details.open = open;
        });
    };
    return (
        <section className="evidence-tree" aria-label="Structured evidence" ref={ref}>
            <div className="tree-tools">
                <button className="text-button" onClick={() => expand(true)}>
                    <ChevronDown size={15} />
                    Expand all
                </button>
                <button className="text-button" onClick={() => expand(false)}>
                    <ChevronUp size={15} />
                    Collapse all
                </button>
            </div>
            <div className="tree-content">
                <Nodes nodes={nodes} />
            </div>
        </section>
    );
}
