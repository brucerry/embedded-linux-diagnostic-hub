// The already reviewed exact_artifact_admission.py limits; admission bounds, not memory policy.
export const WEB_ARCHIVE_LIMITS = Object.freeze({
    archive: 128 * 1024 ** 2,
    expanded: 256 * 1024 ** 2,
    member: 64 * 1024 ** 2,
    entries: 4096,
    path: 1024,
});
