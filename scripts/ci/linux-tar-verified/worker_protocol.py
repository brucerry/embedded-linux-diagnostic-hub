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
LOADER_FAILURES = ('command', 'framing', 'dependency_plan', 'map')
LOADER_PRECHECK_FAILURES = ('target_roster', 'plugin_readback', 'plugin_elf')

# Only already-declared isolation targets may be projected into metadata.
MASK_TARGETS = (
    '/proc/interrupts', '/proc/kcore', '/proc/keys', '/proc/latency_stats',
    '/proc/timer_list', '/proc/timer_stats', '/proc/sched_debug',
)
WRITE_TARGETS = ('/work', '/scratch')
READ_TARGETS = ('/', '/inputs', '/control', '/etc/hosts', '/etc/hostname', '/etc/resolv.conf')
MOUNT_TARGETS = (*MASK_TARGETS, *WRITE_TARGETS, *READ_TARGETS, '/dev/null')
MOUNT_FAILURES = {
    'read': (0,),
    'frame': (0,),
    'duplicate': tuple(range(len(MOUNT_TARGETS) + 1)),
    'mask_form': tuple(range(1, 8)),
    'tmpfs_options': (8, 9),
    'unexpected_write': (0,),
    'null_device': (16,),
    'mask_stat': tuple(range(1, 8)),
    'mask_identity': tuple(range(1, 8)),
    'read_only': tuple(range(10, 16)),
    'mask_uncovered': tuple(range(1, 8)),
    'mask_absence_stat': tuple(range(1, 8)),
}
