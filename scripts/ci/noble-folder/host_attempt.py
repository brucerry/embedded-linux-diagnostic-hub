"""Host-side expected identity from the reviewed runner, without claiming a live tool receipt."""
from dataclasses import dataclass
import json
from pathlib import Path
import re

import handoff


@dataclass(frozen=True)
class HostAttempt:
    source_commit: str
    workflow_sha256: str
    worker_binding: str
    run_id: str
    job: str = 'two-format'

    @property
    def fields(self):
        handoff.need(handoff.hex_string(self.source_commit,40) and
                     self.source_commit!='5e3c66f4a62e3606abdd650972e0f76b71ff5c54' and
                     handoff.hex_string(self.workflow_sha256,64) and handoff.hex_string(self.worker_binding,64) and
                     re.fullmatch(r'[1-9][0-9]{0,18}',self.run_id) and self.job=='two-format','host-attempt-scope')
        return {'source_commit':self.source_commit,'workflow_sha256':self.workflow_sha256,
                'worker_binding':self.worker_binding,'run_id':self.run_id,'job':self.job,
                'repository':handoff.REPOSITORY,'source_checkout_tree':handoff.SOURCE_CHECKOUT_TREE,
                'product_tree':handoff.PRODUCT_TREE,'manifest_sha256':handoff.PRODUCT_MANIFEST,
                'lock_sha256':handoff.LINUX_LOCK,'run_attempt':1}


def expected(input_path, head, workflow, worker_binding, run_id):
    raw=Path(input_path).read_bytes()
    row=json.loads(raw,object_pairs_hook=handoff.closed_object)
    wanted=HostAttempt(head,workflow,worker_binding,run_id)
    handoff.need(row=={field:getattr(wanted,field) for field in
                       ('source_commit','workflow_sha256','worker_binding','run_id')},'host-attempt-input')
    return wanted
