const caseIgnorable = /\p{Case_Ignorable}/u;
const casedCharacter = /\p{Cased}/u;

interface SearchState {
    length: number;
    found: boolean;
}

/** Literal membership in whole-stream default lowercase text, without normalization.
 * Input comes from a streaming TextDecoder (complete code points). Unicode default
 * lowercasing has one contextual mapping: capital sigma. Keep both possible KMP
 * states until a non-case-ignorable code point or EOF resolves its final form.
 * State is O(lowercased query length), even across arbitrarily long ignorable runs.
 */
export class CaptureTextSearch {
    private readonly query: string;
    private readonly prefix: number[] = [];
    private normal: SearchState;
    private final?: SearchState;
    private previousCased = false;

    constructor(query: string) {
        this.query = query.toLowerCase();
        this.normal = { length: 0, found: !this.query };
        for (let i = 0, length = 0; i < this.query.length; i++) {
            if (i) {
                while (length && this.query[i] !== this.query[length])
                    length = this.prefix[length - 1];
                if (this.query[i] === this.query[length]) length++;
            }
            this.prefix.push(length);
        }
    }

    private advance(state: SearchState, text: string) {
        if (state.found) return;
        for (let i = 0; i < text.length; i++) {
            while (state.length && text[i] !== this.query[state.length])
                state.length = this.prefix[state.length - 1];
            if (text[i] === this.query[state.length]) state.length++;
            if (state.length === this.query.length) {
                state.found = true;
                return;
            }
        }
    }

    append(text: string): boolean {
        for (const c of text) {
            const ignorable = caseIgnorable.test(c);
            const cased = casedCharacter.test(c);
            if (this.final && !ignorable) {
                if (!cased) this.normal = this.final;
                this.final = undefined;
            }
            if (c === '\u03a3' && this.previousCased) {
                this.final = { ...this.normal };
                this.advance(this.normal, '\u03c3');
                this.advance(this.final, '\u03c2');
            } else {
                const lower = c.toLowerCase();
                this.advance(this.normal, lower);
                if (this.final) this.advance(this.final, lower);
            }
            if (!ignorable) this.previousCased = cased;
        }
        // A provisional match is safe only when both remaining cases match.
        return this.normal.found && (!this.final || this.final.found);
    }

    finish(): boolean {
        if (this.final) this.normal = this.final;
        this.final = undefined;
        return this.normal.found;
    }
}
