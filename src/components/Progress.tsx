export function Progress({ value, warning }: { value: number; warning?: boolean }) {
    return (
        <div className={`progress-track ${warning && value >= 85 ? 'warning' : ''}`}>
            <span style={{ width: `${Math.max(0, Math.min(value, 100))}%` }} />
        </div>
    );
}
