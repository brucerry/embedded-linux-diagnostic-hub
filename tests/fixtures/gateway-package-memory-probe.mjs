// Inert loader check: export references only; never invoke a filesystem or child API.
import * as filesystem from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
export const observedPorts = { ...filesystem, spawnSync, tmpdir };
