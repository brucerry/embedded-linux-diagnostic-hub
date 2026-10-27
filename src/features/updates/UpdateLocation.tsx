import { useEffect, useState } from 'react';
import { Copy, FolderOpen } from 'lucide-react';
import type { DesktopBridge, UpdateInfo } from '../../../shared/types';
import { message } from '../../services/errors';
export function UpdateLocation({ bridge, info }: { bridge: DesktopBridge; info: UpdateInfo }) {
    const [error, setError] = useState(''),
        [copied, setCopied] = useState('');
    const action = async (target: 'current' | 'verified', copy: boolean) => {
        try {
            if (copy) {
                await bridge.copyUpdatePath?.(target);
                setCopied(target);
            } else await bridge.openUpdateFolder?.(target);
            setError('');
        } catch (e) {
            setError(message(e));
        }
    };
    return (
        <section className="update-location" aria-label="Application executable locations">
            <p>
                Running version: <strong>v{info.currentVersion}</strong>
            </p>
            {info.currentPath ? (
                <div>
                    <strong>Current launchable app</strong>
                    <code>{info.currentPath}</code>
                    <button
                        className="button secondary"
                        disabled={!bridge.openUpdateFolder}
                        onClick={() => void action('current', false)}
                    >
                        <FolderOpen size={16} />
                        Open current app folder
                    </button>
                    <button
                        className="button secondary"
                        disabled={!bridge.copyUpdatePath}
                        onClick={() => void action('current', true)}
                    >
                        <Copy size={16} />
                        Copy current app path
                    </button>
                </div>
            ) : (
                <p>Portable launch location is unavailable in this runtime.</p>
            )}
            {info.receipt && (
                <div>
                    <p>
                        Update from <strong>v{info.receipt.previousVersion}</strong> to{' '}
                        <strong>v{info.receipt.version}</strong>:{' '}
                        {info.handoffConfirmed
                            ? 'New version confirmed running from the verified destination.'
                            : info.receipt.state === 'restart-failed'
                              ? 'Restart request failed; the verified executable is saved.'
                              : 'Verified executable saved; successful handoff is not confirmed by this running app.'}
                    </p>
                    <strong>Verified update destination</strong>
                    <code>{info.receipt.executable}</code>
                    <button
                        className="button secondary"
                        disabled={!bridge.openUpdateFolder}
                        onClick={() => void action('verified', false)}
                    >
                        <FolderOpen size={16} />
                        Open update folder
                    </button>
                    <button
                        className="button secondary"
                        disabled={!bridge.copyUpdatePath}
                        onClick={() => void action('verified', true)}
                    >
                        <Copy size={16} />
                        Copy update path
                    </button>
                    <p>
                        Use this executable for your next launch. The originally downloaded app
                        remains in its original folder.
                    </p>
                </div>
            )}
            {copied && (
                <p aria-live="polite">
                    {copied === 'current' ? 'Current app' : 'Update'} path copied.
                </p>
            )}
            {error && (
                <p role="alert" className="form-error">
                    {error}
                </p>
            )}
        </section>
    );
}
export function UpdateReceiptNotice({ bridge }: { bridge: DesktopBridge }) {
    const [info, setInfo] = useState<UpdateInfo | null>(null),
        [error, setError] = useState('');
    useEffect(() => {
        let active = true;
        void bridge
            .readUpdateInfo?.()
            .then((value) => {
                if (active && value.receipt) setInfo(value);
            })
            .catch((e) => {
                if (active) setError(message(e));
            });
        return () => {
            active = false;
        };
    }, [bridge]);
    return info ? (
        <details className="update-receipt-notice">
            <summary>
                Update v{info.receipt!.previousVersion} → v{info.receipt!.version} ·{' '}
                {info.handoffConfirmed
                    ? 'New version confirmed running'
                    : info.receipt!.state === 'restart-failed'
                      ? 'Restart request failed'
                      : 'Verified executable saved'}{' '}
                · App locations
            </summary>
            <UpdateLocation bridge={bridge} info={info} />
        </details>
    ) : error ? (
        <p role="alert">Update location unavailable: {error}</p>
    ) : null;
}
