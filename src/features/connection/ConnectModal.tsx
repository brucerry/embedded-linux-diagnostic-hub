import { Cable, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ConnectOptions, HostKeyVerification } from '../../../shared/types';
import { GatewayClient, type GatewaySettings } from '../../services/GatewayClient';

import { Modal } from '../../components/Modal';
import { message } from '../../services/errors';
interface ConnectModalProps {
    hostVerification: HostKeyVerification | null;
    onConfirmHostKey: (accepted: boolean) => Promise<void>;
    native: boolean;
    busy: boolean;
    error: string;
    onClose: () => void;
    onConnect: (options: ConnectOptions, settings?: GatewaySettings) => Promise<void>;
    onPickKey: () => Promise<string | null>;
}

export function ConnectModal({
    hostVerification,
    onConfirmHostKey,
    native,
    busy,
    error,
    onClose,
    onConnect,
    onPickKey,
}: ConnectModalProps) {
    const cancelVerification = useRef<HTMLButtonElement>(null);
    const browserKeyInput = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (hostVerification) cancelVerification.current?.focus({ preventScroll: true });
    }, [hostVerification]);
    const [host, setHost] = useState('192.168.1.1');
    const [port, setPort] = useState('22');
    const [username, setUsername] = useState('root');
    const [auth, setAuth] = useState<'password' | 'key'>('password');
    const [secret, setSecret] = useState('');
    const [keyName, setKeyName] = useState('');
    const [privateKey, setPrivateKey] = useState('');
    const [keyError, setKeyError] = useState('');
    const [gatewayUrl, setGatewayUrl] = useState('');
    const [gatewayToken, setGatewayToken] = useState('');
    const [hostFingerprint, setHostFingerprint] = useState('');
    const [verified, setVerified] = useState(false);
    const [discovering, setDiscovering] = useState(false);
    useEffect(() => {
        setHostFingerprint('');
        setVerified(false);
    }, [host, port, gatewayUrl, gatewayToken]);
    return (
        <Modal title="Connect a Linux device" onClose={onClose} busy={busy || discovering}>
            <div className="modal-intro">
                <span className="connect-symbol">
                    <Cable size={24} />
                </span>
                <p>
                    {native
                        ? 'Connect directly over SSH, with or without internet.'
                        : 'Connect through your authenticated HTTPS lab gateway.'}
                    <br />
                    No device agent is required.
                </p>
            </div>
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    const options: ConnectOptions = {
                        host: host.trim(),
                        port: Number(port),
                        username: username.trim(),
                        auth,
                        expectedFingerprint: hostFingerprint,
                        ...(auth === 'password'
                            ? { password: secret }
                            : { passphrase: secret, ...(!native ? { privateKey } : {}) }),
                    };
                    const settings = native
                        ? undefined
                        : { url: gatewayUrl.trim(), token: gatewayToken };
                    setSecret('');
                    setPrivateKey('');
                    if (!native) {
                        setKeyName('');
                        if (browserKeyInput.current) browserKeyInput.current.value = '';
                    }
                    void onConnect(options, settings);
                }}
            >
                <fieldset disabled={busy || discovering} hidden={Boolean(hostVerification)}>
                    {!native && (
                        <>
                            <label>
                                Gateway HTTPS address
                                <input
                                    type="url"
                                    required
                                    value={gatewayUrl}
                                    onChange={(event) => setGatewayUrl(event.target.value)}
                                    placeholder="https://gateway.your-lab.example"
                                />
                            </label>
                            <label>
                                Gateway access token
                                <input
                                    type="password"
                                    autoComplete="new-password"
                                    required
                                    value={gatewayToken}
                                    onChange={(event) => setGatewayToken(event.target.value)}
                                    placeholder="Token supplied by your administrator"
                                />
                            </label>
                        </>
                    )}
                    <div className="form-grid">
                        <label className="host-field">
                            Hostname or IP address
                            <input
                                autoComplete="off"
                                required
                                value={host}
                                onChange={(event) => setHost(event.target.value)}
                                placeholder="192.168.1.1"
                            />
                        </label>
                        <label>
                            Port
                            <input
                                type="number"
                                min="1"
                                max="65535"
                                required
                                value={port}
                                onChange={(event) => setPort(event.target.value)}
                            />
                        </label>
                    </div>
                    <label>
                        SSH username
                        <input
                            autoComplete="off"
                            required
                            value={username}
                            onChange={(event) => setUsername(event.target.value)}
                        />
                    </label>
                    <label>
                        Authentication
                        <select
                            aria-label="Authentication"
                            value={auth}
                            onChange={(event) => {
                                setAuth(event.target.value as 'password' | 'key');
                                setSecret('');
                                setPrivateKey('');
                                setKeyName('');
                                setKeyError('');
                            }}
                        >
                            <option value="password">Password</option>
                            <option value="key">Private key</option>
                        </select>
                    </label>
                    {auth === 'key' && native && (
                        <div className="key-picker">
                            <span>{keyName || 'No private key selected'}</span>
                            <button
                                type="button"
                                className="button secondary"
                                onClick={async () => {
                                    try {
                                        const name = await onPickKey();
                                        if (name) setKeyName(name);
                                    } catch (err) {
                                        setKeyError(message(err));
                                    }
                                }}
                            >
                                Choose key
                            </button>
                        </div>
                    )}
                    {auth === 'key' && !native && (
                        <label>
                            SSH private key file
                            <input
                                ref={browserKeyInput}
                                type="file"
                                onChange={async (event) => {
                                    const file = event.target.files?.[0];
                                    setPrivateKey('');
                                    setKeyName('');
                                    setKeyError('');
                                    if (!file) return;
                                    try {
                                        if (file.size > 65536)
                                            throw new Error(
                                                'Choose a private key smaller than 64 KiB.',
                                            );
                                        const value = await file.text();
                                        if (!value.trim())
                                            throw new Error('The selected key file is empty.');
                                        setPrivateKey(value);
                                        setKeyName(file.name);
                                    } catch (err) {
                                        setKeyError(message(err));
                                    }
                                }}
                            />
                            <span className="field-help">
                                Only choose a gateway you trust: this key and its passphrase are
                                sent over HTTPS to authenticate SSH. They are kept in memory, never
                                saved to disk.
                            </span>
                        </label>
                    )}
                    <label>
                        {auth === 'password' ? 'Password' : 'Key passphrase (optional)'}
                        <input
                            type="password"
                            autoComplete="new-password"
                            value={secret}
                            onChange={(event) => setSecret(event.target.value)}
                            placeholder={
                                auth === 'password'
                                    ? 'Enter device password'
                                    : 'For encrypted private keys'
                            }
                        />
                    </label>
                    {!native && (
                        <div className="fingerprint-panel">
                            <div className="fingerprint-heading">
                                <span>SSH device fingerprint</span>
                                <button
                                    type="button"
                                    className="text-button"
                                    onClick={async () => {
                                        setDiscovering(true);
                                        setKeyError('');
                                        setVerified(false);
                                        setHostFingerprint('');
                                        try {
                                            setHostFingerprint(
                                                await new GatewayClient({
                                                    url: gatewayUrl.trim(),
                                                    token: gatewayToken,
                                                }).discover({
                                                    host: host.trim(),
                                                    port: Number(port),
                                                    username: username.trim(),
                                                    auth: 'password',
                                                }),
                                            );
                                        } catch (err) {
                                            setKeyError(message(err));
                                        } finally {
                                            setDiscovering(false);
                                        }
                                    }}
                                    disabled={!gatewayUrl || !gatewayToken}
                                >
                                    {discovering ? 'Reading…' : 'Read fingerprint'}{' '}
                                    <RefreshCw size={12} />
                                </button>
                            </div>
                            <code>{hostFingerprint || 'Read the host key before connecting.'}</code>
                            <p id="fingerprint-help" className="field-help">
                                {hostFingerprint
                                    ? 'Compare this fingerprint with the device console or a trusted record, then check the box below.'
                                    : 'First enter your gateway address and token, then click Read fingerprint to enable verification.'}
                            </p>
                            <label className="checkbox-label">
                                <input
                                    type="checkbox"
                                    checked={verified}
                                    aria-describedby="fingerprint-help"
                                    disabled={!hostFingerprint}
                                    onChange={(event) => setVerified(event.target.checked)}
                                />
                                I verified this fingerprint with a trusted source.
                            </label>
                        </div>
                    )}
                </fieldset>
                {hostVerification && (
                    <section
                        className="host-verification fingerprint-panel"
                        role="alertdialog"
                        aria-labelledby="host-verification-title"
                        aria-describedby="host-verification-description"
                        onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                                event.preventDefault();
                                event.stopPropagation();
                                void onConfirmHostKey(false);
                            }
                        }}
                    >
                        <h3 id="host-verification-title">
                            {hostVerification.saved
                                ? 'SSH host key changed'
                                : 'Verify SSH device identity'}
                        </h3>
                        <p id="host-verification-description">
                            {hostVerification.saved
                                ? 'A different board or SSH key was detected at'
                                : 'Verify the device at'}{' '}
                            <strong>{hostVerification.endpoint}</strong>. Compare the new
                            fingerprint with the device console or a trusted provisioning record
                            before accepting.
                        </p>
                        {hostVerification.saved && (
                            <div className="host-fingerprint">
                                <span>Saved fingerprint</span>
                                <code>{hostVerification.saved}</code>
                            </div>
                        )}
                        <div className="host-fingerprint">
                            <span>New fingerprint</span>
                            <code>{hostVerification.received}</code>
                        </div>
                        <div className="host-verification-actions">
                            <button
                                ref={cancelVerification}
                                type="button"
                                className="button secondary"
                                onClick={() => void onConfirmHostKey(false)}
                            >
                                Cancel verification
                            </button>
                            <button
                                type="button"
                                className="button primary"
                                onClick={() => void onConfirmHostKey(true)}
                            >
                                {hostVerification.saved
                                    ? 'Trust replacement device'
                                    : 'Trust device'}
                            </button>
                        </div>
                    </section>
                )}
                {(error || keyError) && (
                    <div className="form-error" role="alert">
                        {error || keyError}
                    </div>
                )}
                <div
                    className="connect-info"
                    style={{ display: hostVerification ? 'none' : undefined }}
                >
                    <ShieldCheck size={15} />
                    <span>
                        {native
                            ? 'SSH stays connected until you disconnect or close the app. Pausing live updates keeps the connection open; authentication secrets are never saved to disk.'
                            : 'The gateway enforces allowed targets and pinned host keys. Your access token stays in memory for this session.'}
                    </span>
                </div>
                <div
                    className="modal-actions"
                    style={{ display: hostVerification ? 'none' : undefined }}
                >
                    <button
                        type="button"
                        className="button secondary"
                        onClick={onClose}
                        disabled={busy || discovering}
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        className="button primary"
                        disabled={
                            busy ||
                            discovering ||
                            (!native && !verified) ||
                            (auth === 'key' && !keyName)
                        }
                    >
                        {busy ? <LoaderCircle size={16} className="spin" /> : <Cable size={16} />}
                        {busy ? 'Connecting & collecting…' : 'Connect via SSH'}
                    </button>
                </div>
            </form>
        </Modal>
    );
}
