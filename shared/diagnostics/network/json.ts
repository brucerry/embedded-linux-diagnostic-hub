// Preserve large integer tokens before JSON.parse can round a 64-bit counter.
// Quoted strings and escapes are copied verbatim, never regexp-replaced.
export function networkJson(text: string): unknown {
    if (new TextEncoder().encode(text).length > 262144)
        throw Error('JSON output exceeds the evidence bound.');
    let encoded = '',
        index = 0,
        nodes = 0,
        depth = 0;
    while (index < text.length) {
        const character = text[index];
        if (character === '"') {
            const start = index++;
            let ended = false;
            while (index < text.length) {
                if (text[index] === '\\') index += 2;
                else if (text[index++] === '"') {
                    ended = true;
                    break;
                }
            }
            if (!ended) throw Error('Unterminated JSON string.');
            encoded += text.slice(start, index);
        } else if (character === '-' || /\d/.test(character)) {
            const match = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
            if (!match) throw Error('Invalid JSON number.');
            const token = match[0];
            encoded +=
                /^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token))
                    ? JSON.stringify(token)
                    : token;
            index += token.length;
        } else {
            if (character === '{' || character === '[') {
                if (++depth > 32 || ++nodes > 8192)
                    throw Error('JSON nesting exceeds the evidence bound.');
            } else if (character === '}' || character === ']') depth--;
            encoded += character;
            index++;
        }
    }
    return JSON.parse(encoded);
}
export function records(text: string): Record<string, unknown>[] {
    const value = networkJson(text);
    if (!Array.isArray(value)) throw Error('Expected a network record array.');
    return value
        .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
        .slice(0, 2000);
}
export function decimal(value: unknown): string | undefined {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
        return String(value);
    if (typeof value === 'string' && /^\d+$/.test(value)) return value;
    return undefined;
}
