import { BrowserWindow, session } from 'electron';
import { reportHtml } from '../shared/testing/report';
import type { TestReport } from '../shared/testing/types';

let printing = false;
export async function renderTestPdf(report: TestReport): Promise<Buffer> {
    if (printing) throw Error('A PDF report is already being generated.');
    printing = true;
    let view: BrowserWindow | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const partition = session.fromPartition(`test-report-${crypto.randomUUID()}`);
        partition.setPermissionRequestHandler((_contents, _permission, callback) =>
            callback(false),
        );
        partition.setPermissionCheckHandler(() => false);
        partition.webRequest.onBeforeRequest((details, callback) =>
            callback({ cancel: !details.url.startsWith('data:text/html;') }),
        );
        view = new BrowserWindow({
            show: false,
            width: 1000,
            height: 900,
            webPreferences: {
                session: partition,
                sandbox: true,
                nodeIntegration: false,
                contextIsolation: true,
                javascript: false,
            },
        });
        view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        view.webContents.on('will-navigate', (event) => event.preventDefault());
        const renderer = view;
        const generate = async () => {
            await renderer.loadURL(
                `data:text/html;charset=utf-8;base64,${Buffer.from(reportHtml(report)).toString('base64')}`,
            );
            return renderer.webContents.printToPDF({
                pageSize: 'A4',
                printBackground: true,
                preferCSSPageSize: true,
                displayHeaderFooter: true,
                headerTemplate: '<span></span>',
                footerTemplate:
                    '<div style="font:8px Arial;width:100%;text-align:center;color:#607570">Diagnostic Hub · <span class="pageNumber"></span> / <span class="totalPages"></span></div>',
            });
        };
        return await Promise.race([
            generate(),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () =>
                        reject(
                            Error(
                                'PDF generation exceeded its 30-second limit. JSON evidence remains available.',
                            ),
                        ),
                    30000,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
        view?.destroy();
        printing = false;
    }
}
