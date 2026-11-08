import { useImperativeHandle, type Ref } from 'react';
import ConsoleResultsView from './ConsoleResultsView';
import { useConsoleResults, type ConsoleResultsAdmission } from './use-console-results';

export default function StoredConsoleResults(props: {
    visible: boolean;
    running: boolean;
    epoch: number;
    headingRef: Ref<HTMLHeadingElement>;
    headerOffset: number;
    onBusy(value: boolean): void;
    admissionRef?: Ref<ConsoleResultsAdmission>;
}) {
    const view = useConsoleResults({
        visible: props.visible,
        running: props.running,
        revision: props.epoch,
        onBusy: props.onBusy,
    });
    useImperativeHandle(props.admissionRef, () => ({ quiesce: view.quiesce }), [view.quiesce]);
    if (!props.visible) return null;
    return (
        <section className="automation-stored-results" aria-label="Stored SSH console results">
            <h3
                ref={props.headingRef}
                tabIndex={-1}
                style={{ scrollMarginTop: props.headerOffset }}
            >
                Stored SSH console results
            </h3>
            <ConsoleResultsView {...view} />
        </section>
    );
}
