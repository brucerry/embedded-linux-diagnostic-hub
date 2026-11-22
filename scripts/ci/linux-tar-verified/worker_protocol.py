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

WORKER_STAGES = ('runtime', 'provider_layout', *PROVIDER_STAGES, 'installed', 'build', 'archive')
