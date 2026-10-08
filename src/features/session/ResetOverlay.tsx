import { LoaderCircle } from 'lucide-react';
import { createPortal } from 'react-dom';
import { Modal } from '../../components/Modal';

export function ResetOverlay({ progress }: { progress: string }) {
    // Render outside the inert application so the progress dialog remains accessible.
    return createPortal(
        <div className="reset-overlay">
            <Modal title="Resetting session data" busy onClose={() => {}}>
                <div className="reset-progress" role="status" aria-live="polite">
                    <LoaderCircle className="spin" size={32} aria-hidden="true" />
                    <p>{progress}</p>
                </div>
                <p>Please wait. Saved reports and the SSH connection are kept.</p>
                <p>
                    Your current page stays in place. Live updates resume afterward if they were
                    enabled.
                </p>
            </Modal>
        </div>,
        document.body,
    );
}
