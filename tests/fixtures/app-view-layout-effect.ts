// Verbatim App layout-effect bodies; current-source binding is checked by the test.
// Lexical injection only, no React mount, DOM, clocks or application import.
import type { View } from '../../src/app/view';
export interface EffectContext {
    view: View;
    workspaceMain: {
        current: { style: { animation: string }; readonly offsetWidth: number } | null;
    };
    lastTransitionView: { current: View };
    markRendererAppLayoutEffect(): void;
}
export const currentSpan =
    "    useLayoutEffect(() => {\n        // First App layout effect only; not paint, visible-window or interactive proof.\n        markRendererAppLayoutEffect();\n        // CSS supplies the initial animation; replay only after a committed view change.\n        if (lastTransitionView.current === view) return;\n        lastTransitionView.current = view;\n        // Replay the page transition without remounting a live terminal channel.\n        const main = workspaceMain.current;\n        if (!main) return;\n        main.style.animation = 'none';\n        void main.offsetWidth;\n        main.style.animation = '';\n    }, [view]);";
export const guardInitializer = 'const lastTransitionView = useRef<View>(view);';
export const beforeSourceSHA256 =
    '97295889bac1bbd561341386e875d556c6fb4a3b4c4e58f7d3ac7eabbd9df6c9';
export function beforeLayoutEffect(context: EffectContext) {
    const { view, workspaceMain, markRendererAppLayoutEffect } = context;

    // First App layout effect only; not paint, visible-window or interactive proof.
    markRendererAppLayoutEffect();
    // Replay the page transition without remounting a live terminal channel.
    const main = workspaceMain.current;
    if (!main) return;
    main.style.animation = 'none';
    void main.offsetWidth;
    main.style.animation = '';
}
export function currentLayoutEffect(context: EffectContext) {
    const { view, workspaceMain, lastTransitionView, markRendererAppLayoutEffect } = context;

    // First App layout effect only; not paint, visible-window or interactive proof.
    markRendererAppLayoutEffect();
    // CSS supplies the initial animation; replay only after a committed view change.
    if (lastTransitionView.current === view) return;
    lastTransitionView.current = view;
    // Replay the page transition without remounting a live terminal channel.
    const main = workspaceMain.current;
    if (!main) return;
    main.style.animation = 'none';
    void main.offsetWidth;
    main.style.animation = '';
}
