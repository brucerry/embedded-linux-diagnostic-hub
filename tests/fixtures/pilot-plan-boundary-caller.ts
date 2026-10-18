import {
    reportStartupIdentity,
    planStartupIdentity,
    requireIdentityPlan,
} from '../../scripts/lib/startup-identity-report.mjs';
export const sourceURL = import.meta.url;
export const makeFromTs = planStartupIdentity;
export const checkFromTs = requireIdentityPlan;
export function publishFromTs(emit: any, stage: string, data: unknown) {
    return reportStartupIdentity(emit, stage, data);
}
