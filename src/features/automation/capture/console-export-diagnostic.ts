import type { BrowserExportDiagnostic } from './browser-export';

/** A diagnostic belongs to one admitted export, independently of the visible view. */
export class ConsoleExportDiagnostic {
    private owned?: { owner: object; generation: symbol; value: Readonly<BrowserExportDiagnostic> | null };
    begin(owner: object): symbol | null {
        if (this.owned) return null;
        const generation = Symbol('console export diagnostic');
        this.owned = { owner, generation, value: null };
        return generation;
    }
    owns(owner: object, generation: symbol) {
        return this.owned?.owner === owner && this.owned.generation === generation;
    }
    update(owner: object, generation: symbol, value: BrowserExportDiagnostic) {
        if (!this.owns(owner, generation)) return false;
        this.owned!.value = Object.freeze({
            retirement: value.retirement,
            message: value.message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 512),
        });
        return true;
    }
    finish(owner: object, generation: symbol) {
        if (!this.owns(owner, generation)) return false;
        this.owned = undefined;
        return true;
    }
    get snapshot() {
        return this.owned?.value ?? null;
    }
}
