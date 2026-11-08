import { createRequire } from 'node:module';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { CaptureStorageError, integer, validId } from '../shared/capture-store';

/** Disposable membership index. It never stores or replaces authoritative capture evidence. */
export class NativeCaptureCatalog {
    private db: DatabaseSync;
    private insert: StatementSync;
    private remove: StatementSync;
    private query: StatementSync;
    constructor(file: string) {
        const { DatabaseSync } = createRequire(process.execPath)(
            'node:sqlite',
        ) as typeof import('node:sqlite');
        this.db = new DatabaseSync(file, {
            allowExtension: false,
            enableDoubleQuotedStringLiterals: false,
            defensive: true,
            timeout: 0,
        });
        try {
            // Rebuilt from physical metadata on every open. Only this disposable cache uses
            // a memory journal; raw journals and capture/outcome commits keep their fsyncs.
            // Each transaction changes one short row, and the pager has a 1 MiB target.
            this.db.exec(`
                PRAGMA journal_mode=MEMORY;
                PRAGMA cache_size=-1024;
                PRAGMA temp_store=FILE;
                CREATE TABLE membership(sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE) STRICT;
            `);
            this.insert = this.db.prepare('INSERT INTO membership(sequence,id) VALUES (?,?)');
            this.remove = this.db.prepare('DELETE FROM membership WHERE id=?');
            this.query = this.db.prepare(
                'SELECT sequence,id FROM membership WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT ?',
            );
        } catch (error) {
            this.db.close();
            throw error;
        }
    }
    add(sequence: number, id: string) {
        integer(sequence, 1);
        validId(id);
        try {
            this.insert.run(sequence, id);
        } catch (error) {
            const code = (error as { errcode?: number }).errcode;
            if (code === 1555 || code === 2067)
                throw new CaptureStorageError(
                    'integrity',
                    'Stored capture identities or sequences conflict; evidence was retained.',
                );
            throw error;
        }
    }
    delete(id: string) {
        validId(id);
        this.remove.run(id);
    }
    page(after: number, through: number, limit: number) {
        const rows = this.query.all(after, through, limit + 1);
        return rows.map((row) => {
            integer(row.sequence as number, 1);
            validId(row.id as string);
            return { sequence: row.sequence as number, id: row.id as string };
        });
    }
    close() {
        this.db.close();
    }
}
