/** Build orchestration only. No runtime, launch, socket, profile loader or package capability. */
const steps = ['verify', 'directories', 'renderer', 'main', 'syntax', 'metadata'] as const;
export type NativeBuildPorts = Record<(typeof steps)[number], () => Promise<unknown>> & {
    admit(): void;
};
export async function prepareNativeBuild(ports: NativeBuildPorts) {
    if (!ports || typeof ports !== 'object' || Array.isArray(ports))
        throw Error('Native build ports absent.');
    const names = [...steps, 'admit'] as const;
    if (Object.keys(ports).some((name) => !names.includes(name as (typeof names)[number])))
        throw Error('Unsupported native preparation capability.');
    for (const name of names)
        if (!Object.hasOwn(ports, name) || typeof ports[name] !== 'function')
            throw Error('Native preparation step absent: ' + name);
    for (const step of steps) {
        ports.admit();
        await ports[step]();
    }
    ports.admit();
    return { scope: 'private-build-only' as const, runtimeStarted: false as const };
}
