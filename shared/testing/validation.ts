export function object(value: unknown, keys: string[], label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw Error(`${label}: expected an object.`);
    const data = value as Record<string, unknown>;
    for (const key of Object.keys(data))
        if (!keys.includes(key)) throw Error(`${label}: unsupported field ${key}.`);
    return data;
}
export function text(value: unknown, label: string, max = 512, empty = true): string {
    if (
        typeof value !== 'string' ||
        value.length > max ||
        (!empty && !value.trim()) ||
        /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)
    )
        throw Error(`${label}: invalid text.`);
    return value;
}
export function id(value: unknown, label: string): string {
    const s = text(value, label, 64, false);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(s))
        throw Error(`${label}: use letters, numbers, dots, underscores or hyphens.`);
    return s;
}
export function number(value: unknown, label: string, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
        throw Error(`${label}: expected an integer from ${min} to ${max}.`);
    return value;
}
export function bool(value: unknown, label: string): boolean {
    if (typeof value !== 'boolean') throw Error(`${label}: expected true or false.`);
    return value;
}
export function list(value: unknown, label: string, max: number): unknown[] {
    if (!Array.isArray(value) || value.length > max)
        throw Error(`${label}: expected at most ${max} items.`);
    return value;
}
export function date(value: unknown, label: string, optional = false): string {
    const s = text(value, label, 40);
    if (!(optional && !s) && !Number.isFinite(Date.parse(s)))
        throw Error(`${label}: invalid timestamp.`);
    return s;
}
export function choice<T extends string>(value: unknown, choices: readonly T[], label: string): T {
    if (typeof value !== 'string' || !choices.includes(value as T))
        throw Error(`${label}: unsupported value.`);
    return value as T;
}
export function bounded(value: unknown, bytes: number, label: string): void {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > bytes)
        throw Error(`${label}: size limit exceeded.`);
}
export function unique<T>(items: T[], key: (item: T) => string, label: string): T[] {
    if (new Set(items.map(key)).size !== items.length)
        throw Error(`${label}: duplicate identifiers.`);
    return items;
}
export function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object')
        return `{${Object.keys(value)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
            .join(',')}}`;
    return JSON.stringify(value);
}
export async function digest(value: unknown): Promise<string> {
    if (!globalThis.crypto?.subtle)
        throw Error(
            'Profile verification requires a secure browser context. Use HTTPS, localhost or the desktop application.',
        );
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
    return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}
