import { Component, lazy, Suspense, useState, type ReactNode } from 'react';
import type { FlowInput } from './types';

const Viewer = lazy(() => import('./FlowViewer'));
class ViewerBoundary extends Component<
    { children: ReactNode; close(): void },
    { failed: boolean }
> {
    state = { failed: false };
    static getDerivedStateFromError() {
        return { failed: true };
    }
    render() {
        return this.state.failed ? (
            <div className="flow-load-message" role="alert">
                Flow view could not load. The command editor remains available.
                <button className="button secondary" onClick={this.props.close}>
                    Close flow
                </button>
            </div>
        ) : (
            this.props.children
        );
    }
}
// Only this small entry is eager. Model, layout, styles and exporters load on explicit use.
export default function FlowViewerEntry(input: FlowInput) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <button
                className="button secondary"
                aria-haspopup="dialog"
                onClick={(event) => {
                    event.currentTarget.focus({ preventScroll: true });
                    setOpen(true);
                }}
            >
                Show flow
            </button>
            {open && (
                <ViewerBoundary close={() => setOpen(false)}>
                    <Suspense
                        fallback={
                            <div role="status" className="flow-load-message">
                                Loading flow…{' '}
                                <button className="button secondary" onClick={() => setOpen(false)}>
                                    Close flow
                                </button>
                            </div>
                        }
                    >
                        <Viewer input={input} onClose={() => setOpen(false)} />
                    </Suspense>
                </ViewerBoundary>
            )}
        </>
    );
}
