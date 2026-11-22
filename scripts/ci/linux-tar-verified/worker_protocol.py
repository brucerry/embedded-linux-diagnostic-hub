"""Fixed public worker predicates, in execution order."""

IDENTITY_STAGES = (
    'runtime_account',
    'runtime_sandbox',
    'runtime_network',
    'runtime_mounts',
    'runtime_write_caps',
    'runtime_pid',
    'runtime_manifests',
    'compiler_packages',
    'compiler_package_members',
    'compiler_plan',
    'compiler_aliases',
    'compiler_elf_members',
    'compiler_no_preload',
    'compiler_loader_trace',
    'runtime_subreaper',
)
LOADER_TARGETS = (
    '/usr/bin/x86_64-linux-gnu-as',
    '/usr/bin/x86_64-linux-gnu-gcc-13',
    '/usr/bin/x86_64-linux-gnu-ld.bfd',
    '/usr/libexec/gcc/x86_64-linux-gnu/13/cc1',
    '/usr/libexec/gcc/x86_64-linux-gnu/13/collect2',
    '/usr/libexec/gcc/x86_64-linux-gnu/13/liblto_plugin.so',
)
LOADER_FAILURES = ('command', 'framing', 'map')
