import { CopyButton } from '../../components/CopyButton';

export function TestJsonEditor({
    label,
    value,
    onChange,
    disabled,
    error,
    readOnly,
}: {
    label: string;
    value: string;
    onChange?(value: string): void;
    disabled?: boolean;
    error?: string;
    readOnly?: boolean;
}) {
    const errorId = label === 'Profile JSON' ? 'profile-json-error' : 'direct-json-error';
    return (
        <div className="test-json-editor">
            <label>
                {label}
                <textarea
                    aria-label={label}
                    className="test-json"
                    rows={14}
                    value={value}
                    disabled={disabled}
                    readOnly={readOnly}
                    spellCheck={false}
                    aria-invalid={Boolean(error)}
                    aria-describedby={error ? errorId : undefined}
                    onChange={(e) => onChange?.(e.target.value)}
                />
            </label>
            <CopyButton
                text={value}
                label={`Copy ${label.charAt(0).toLowerCase()}${label.slice(1)}`}
                disabled={!value}
                onCopy={async (content) => {
                    if (window.diagnosticHub?.copyText)
                        await window.diagnosticHub.copyText(content);
                    else await navigator.clipboard.writeText(content);
                }}
            />
            {error && (
                <p id={errorId} className="test-field-error" role="alert">
                    {error}
                </p>
            )}
        </div>
    );
}
