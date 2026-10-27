import { RoundedIcon } from './RoundedIcon';

export function Metric({
    title,
    icon,
    value,
    unit,
    detail,
    children,
}: {
    title: string;
    icon: string;
    value: string;
    unit?: string;
    detail: string;
    children: React.ReactNode;
}) {
    return (
        <section className="metric-card">
            <div className="metric-title">
                <span>{title}</span>
                <RoundedIcon name={icon} size={25} />
            </div>
            <div className="metric-value">
                {value}
                <span>{unit}</span>
            </div>
            <div className="metric-detail">{detail}</div>
            {children}
        </section>
    );
}
