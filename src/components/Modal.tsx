import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';

export function Modal({
    children,
    title,
    onClose,
    busy = false,
    wide = false,
}: {
    children: React.ReactNode;
    title: string;
    onClose: () => void;
    busy?: boolean;
    wide?: boolean;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const actions = useRef({ busy, onClose });
    actions.current = { busy, onClose };
    useEffect(() => {
        const previous = document.activeElement as HTMLElement | null;
        const modal = ref.current!;
        const overflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const selector =
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea, summary, a[href], [tabindex="0"]';
        ((modal.querySelector(selector) as HTMLElement | null) ?? modal).focus({
            preventScroll: true,
        });
        const listener = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !actions.current.busy) actions.current.onClose();
            if (event.key === 'Tab') {
                const elements = Array.from(modal.querySelectorAll<HTMLElement>(selector)).filter(
                    (element) => element.getClientRects().length > 0,
                );
                if (!elements.length) {
                    event.preventDefault();
                    modal.focus({ preventScroll: true });
                    return;
                }
                const first = elements[0];
                const last = elements[elements.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last?.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first?.focus();
                }
            }
        };
        document.addEventListener('keydown', listener);
        return () => {
            document.removeEventListener('keydown', listener);
            document.body.style.overflow = overflow;
            previous?.focus({ preventScroll: true });
        };
    }, []);
    return (
        <div
            className="modal-backdrop"
            onClick={(event) => {
                if (event.target === event.currentTarget && !busy) onClose();
            }}
        >
            <div
                className={`modal ${wide ? 'wide-modal' : ''}`}
                ref={ref}
                tabIndex={-1}
                role="dialog"
                aria-modal="true"
                aria-label={title}
            >
                <div className="modal-heading">
                    <h2>{title}</h2>
                    <button
                        className="icon-button"
                        aria-label="Close dialog"
                        onClick={onClose}
                        disabled={busy}
                    >
                        <X size={20} />
                    </button>
                </div>
                {children}
            </div>
        </div>
    );
}
