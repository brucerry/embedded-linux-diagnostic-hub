"""Closed nonce-bound guest receipt vocabulary."""
from apply import EXIT_STATES, STREAM_STATES, PROGRESS_STATES

PHASES=('prov_identity','prov_media','prov_growth','prov_tools','prov_cache','prov_config',
        'prov_simulation','prov_apply','prov_database','prov_observer','prov_capacity')
EXTRA={
    'prov_exit':EXIT_STATES,
    'prov_status':STREAM_STATES,
    'prov_progress':PROGRESS_STATES,
    'prov_error':('seen','not-seen','unobserved'),
    'prov_prompt':('seen','not-seen','unobserved'),
    'prov_child':('closed','uncertain'),
}
