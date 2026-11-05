// Separate target build input: importing this starts dependencies. No observer or registry copy.
// The future native producer must bind this artifact separately from its builtin-only early artifact.
export {createGateway} from '../../gateway/server';
