import type { LucideIcon } from 'lucide-react';

export function Nav({
    icon: Icon,
    label,
    active,
    onClick,
    suffix,
}: {
    icon: LucideIcon;
    label: string;
    active: boolean;
    onClick: () => void;
    suffix?: string;
}) {
    return (
        <button
            className={`nav-item ${active ? 'active' : ''}`}
            aria-label={`${label}${suffix ? ` ${suffix}` : ''}`}
            aria-current={active ? 'page' : undefined}
            onClick={onClick}
        >
            <Icon size={18} />
            <span>{label}</span>
            {suffix && <small>{suffix}</small>}
        </button>
    );
}
