import type { CommandCapture } from './automation';
import {
    CAPTURE_STORAGE,
    type CaptureFrame,
    type StoredCapture,
    type CaptureStorageError,
} from './capture-store';

/** Receive observations, not display blocks. The producer must await each append. */
export interface CommandOutputSink {
    append(bytes: Uint8Array, receivedAt: string, stream: CaptureFrame['stream']): Promise<void>;
    /** Persist accepted observations; enqueue acknowledgement alone is not durable credit. */
    flush?(): Promise<void>;
    /** An observation could not enter the bounded queue. Count it and stop capture. */
    rejectObservation(bytes: number, error: CaptureStorageError): void;
}
export interface StreamedCommandCapture extends CommandCapture {
    previewClipped: boolean;
}
export interface StoredCommandCapture extends StreamedCommandCapture {
    stored: StoredCapture;
}

/** A small UTF-8 display projection, separate from raw completeness and command completion. */
export class CommandPreview {
    private remaining: number = CAPTURE_STORAGE.previewBytes;
    private decoders = new Map<CaptureFrame['stream'], TextDecoder>();
    private text = { stdout: '', stderr: '', serial: '' };
    clipped = false;
    append(bytes: Uint8Array, stream: CaptureFrame['stream']) {
        const kept = bytes.subarray(0, this.remaining);
        this.remaining -= kept.length;
        this.clipped ||= kept.length < bytes.length;
        if (!kept.length) return;
        let decoder = this.decoders.get(stream);
        if (!decoder) this.decoders.set(stream, (decoder = new TextDecoder()));
        this.text[stream] += decoder.decode(kept, { stream: true });
    }
    finish() {
        for (const [stream, decoder] of this.decoders) this.text[stream] += decoder.decode();
        this.decoders.clear();
        return { stdout: this.text.stdout + this.text.serial, stderr: this.text.stderr };
    }
}
