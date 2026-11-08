import nativePath from 'path';

// The checked-in Map filesystem uses one POSIX namespace on every test host.
// Bare 'path' is Node's core module and avoids reapplying the node:path alias here.
export default nativePath.posix;
