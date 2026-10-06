export function message(error: unknown): string {
    return error instanceof Error
        ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
        : 'The operation could not be completed.';
}
