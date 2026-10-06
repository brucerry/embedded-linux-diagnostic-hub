import { Check, CircleAlert } from 'lucide-react';
import type { ProbeResult } from '../../shared/types';

export function Badge({ status }: { status?: ProbeResult['status'] }) {
    if (!status) return <span className="badge pending">Not collected</span>;
    return (
        <span className={`badge ${status}`}>
            {status === 'collected' ? <Check size={12} /> : <CircleAlert size={12} />}
            {status === 'collected'
                ? 'Collected'
                : status === 'unavailable'
                  ? 'Unavailable'
                  : 'Error'}
        </span>
    );
}
