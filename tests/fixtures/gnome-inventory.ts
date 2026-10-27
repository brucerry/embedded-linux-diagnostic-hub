// Software board inventory for the isolated real OpenSSH/Bash continuity fixture.
import { writeFile } from 'node:fs/promises';
import { discoveryWire } from './testing';
import { simulatedInventory } from '../../shared/testing/simulation';
const inventory = simulatedInventory();
writeFile(process.argv[2], discoveryWire(inventory), { mode: 0o644 }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
