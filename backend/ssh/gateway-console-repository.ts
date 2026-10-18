import { RemoteConsoleRepository } from '../../shared/console-storage';
import type { GatewayConsoleDisposal } from '../../shared/console-journal';
import type { ConsoleOperationPort } from './console-port';

/** Gateway owns the operation adapter; the browser owns its durable journal and connection. */
export class GatewayConsoleRepository extends RemoteConsoleRepository {
    private loss?: Error;
    private disposed = false;
    constructor(private port: ConsoleOperationPort) {
        super(port.call);
    }
    transportLost(error: Error) {
        this.loss ??= error;
        this.port.fail(this.loss);
    }
    override async close() {
        if (this.disposed || this.resourceClosed) return;
        if (!this.loss) {
            try {
                await super.close();
                return;
            } catch (error) {
                if (!this.loss) throw error;
            }
        }
        await this.port.dispose(this.loss!);
        this.disposed = true;
    }
    get localDisposal(): GatewayConsoleDisposal | null {
        return this.loss
            ? {
                  scope: 'gateway-operation-adapter',
                  disposed: this.disposed,
                  journalClosure: 'unacknowledged',
              }
            : null;
    }
}
