import { Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export function CopyButton({
    text,
    label,
    onCopy,
}: {
    text: string;
    label: string;
    onCopy: (text: string) => Promise<void>;
}) {
    const [feedback, setFeedback] = useState<{ id: number; success: boolean } | null>(null);
    const [pending, setPending] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const sequence = useRef(0);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            if (timer.current) clearTimeout(timer.current);
        };
    }, []);
    async function copy() {
        setPending(true);
        let success = true;
        try {
            await onCopy(text);
        } catch {
            success = false;
        }
        if (!mounted.current) return;
        setPending(false);
        if (timer.current) clearTimeout(timer.current);
        setFeedback({ id: ++sequence.current, success });
        timer.current = setTimeout(
            () => {
                setFeedback(null);
                timer.current = null;
            },
            success ? 1000 : 3000,
        );
    }
    return (
        <div className="snippet-copy-area">
            <button
                className="snippet-copy"
                aria-label={label}
                title={label}
                disabled={pending}
                onClick={() => void copy()}
            >
                <Copy size={17} />
            </button>
            {feedback && (
                <span
                    key={feedback.id}
                    className={`copy-feedback ${feedback.success ? 'success' : 'failure'}`}
                    role="status"
                    aria-live="polite"
                >
                    {feedback.success ? 'Copied!' : 'Copy failed. Select text to copy.'}
                </span>
            )}
        </div>
    );
}
