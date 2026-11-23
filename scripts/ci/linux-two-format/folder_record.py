"""Primary build record for the private tar-only qualification, never a release-pair record."""
import json

TARBALL = 'Diagnostic-Hub-linux-x64.tar.gz'


def record(attempt, size, digest):
    return {
        'schema': 'hub-linux-folder-build-v1',
        'version': '0.6.0',
        'platform': 'linux',
        'arch': 'x64',
        'attempt': attempt,
        'artifact': {'name': TARBALL, 'bytes': size, 'sha256': digest},
        'validation': 'build-only',
    }


def encode(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode('ascii')
