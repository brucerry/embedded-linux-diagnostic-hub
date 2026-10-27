import { FileInput, ShieldCheck, Unplug } from 'lucide-react';
import { RoundedIcon } from '../components/RoundedIcon';

export function EmptyOverview({
    onConnect,
    onImport,
}: {
    onConnect: () => void;
    onImport: () => void;
}) {
    return (
        <section className="panel connection-start" aria-labelledby="connection-start-title">
            <span className="connection-start-icon">
                <RoundedIcon name="hardware" size={56} />
            </span>
            <div className="eyebrow">READY WHEN YOUR DEVICE IS</div>
            <h2 id="connection-start-title">Connect your target device</h2>
            <p>
                Device identity, system readings, hardware evidence, and logs will appear after your
                first SSH collection.
            </p>
            <ol className="connection-steps">
                <li>
                    <strong>Connect over SSH</strong>
                    <span>Enter the device address and your SSH credentials.</span>
                </li>
                <li>
                    <strong>Verify the device</strong>
                    <span>Check its host fingerprint before accepting the connection.</span>
                </li>
                <li>
                    <strong>Explore real evidence</strong>
                    <span>Inspect the collected readings and export a diagnostic report.</span>
                </li>
            </ol>
            <div className="heading-actions">
                <button className="button primary" onClick={onConnect}>
                    <Unplug size={18} />
                    Connect target device
                </button>
                <button className="button secondary" onClick={onImport}>
                    <FileInput size={17} />
                    Import report
                </button>
            </div>
            <span className="connection-start-note">
                <ShieldCheck size={16} />
                Collection reads diagnostic information without changing device configuration.
            </span>
        </section>
    );
}
