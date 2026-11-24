"""Ordered fixed metadata labels for the tar-only worker."""
PROVIDER_STAGES = (
    'provider_inputs',
    'provider_node',
    'provider_plan',
    'provider_filelist_ssh2',
    'provider_builder_matcher',
    'provider_go_toolchain',
    'provider_go_telemetry',
    'provider_go_version',
    'provider_go_modules',
    'provider_esbuild_compile',
    'provider_esbuild_identity',
    'provider_esbuild_wrappers',
    'provider_proxy_compilers',
    'provider_agent_base',
    'provider_http_proxy_agent',
    'provider_https_proxy_agent',
    'provider_gzip_builder',
    'provider_archive_digests',
    'provider_process_closure',
    'providers',
)

CLOSURE_STAGES = frozenset(PROVIDER_STAGES) - {
    'provider_inputs', 'provider_node', 'provider_plan', 'provider_filelist_ssh2', 'provider_go_toolchain',
    'provider_archive_digests', 'providers',
}

# Separate from the literal disabled job guard. No environment or job input can enable it.
EXTRACTION_POLICY_REVIEWED = False

VERIFIER_CHILD_STAGES = (
    'prepare', 'staged_bundle', 'tar_headers', 'tar_extract', 'tar_contents',
    'tar_final_identity', 'appimage_extract', 'appimage_contents', 'inner_cleanup',
)
VERIFIER_CONDITIONS = (
    'temp_allocate', 'seal_before', 'reader_seal', 'process_start', 'process_capture',
    'process_exit', 'process_closure', 'child_frame', 'child_stderr',
    *VERIFIER_CHILD_STAGES, 'seal_after', 'temp_empty', 'temp_retirement',
)


class ArchiveVerificationRefused(Exception):
    def __init__(self, condition, retirement):
        if condition not in VERIFIER_CONDITIONS or retirement not in ('pass', 'fail', 'unreached'):
            raise ValueError('unexpected-verifier-outcome')
        self.condition = condition
        self.retirement = retirement
        super().__init__(condition)


EXTRACTION_STAGES = ('reader_admission', 'archive_inventory') if EXTRACTION_POLICY_REVIEWED else ()
WORKER_STAGES = (
    'runtime', 'provider_layout', *PROVIDER_STAGES, 'installed',
    'packer_preload', 'packer_members', 'packer_stock', 'packer_loader', 'packer', 'build',
    'appimage_envelope', *EXTRACTION_STAGES, 'archive_verification', 'original_evidence', 'tar_original_members',
)
DIGEST_KEYS = ('tar_sha256', 'appimage_sha256', 'record_sha256', 'launcher_sha256')
