"""Portable format/installation fixtures. No actual GNOME settings or commands are used."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

source, archives = sys.argv[1:]
spec = importlib.util.spec_from_file_location('genie_setup', source)
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)
version = '1.2.3-test.1'
commit = 'a' * 40

for format in ('modern', 'legacy42'):
    archive = str(Path(archives) / (format + '.zip'))
    files, build = setup.validate_archive(archive, version, commit, format)
    other = 'legacy42' if format == 'modern' else 'modern'
    try:
        setup.validate_archive(archive, version, commit, other)
    except ValueError:
        pass
    else:
        raise AssertionError('Cross-format archive accepted')
    with tempfile.TemporaryDirectory(prefix='hub-genie-format-install-') as directory:
        root = Path(directory)
        app = root / 'app with spaces.AppImage'
        app.write_bytes(b'verified fixture')
        settings = {'enabled-extensions': ['other@example.com'], 'disable-user-extensions': False}
        loaded = None
        fail_write = False
        calls = []
        def command(args, required=True):
            global fail_write
            calls.append(args)
            if args[0] == 'gsettings':
                key = args[3]
                if args[1] == 'get':
                    value = settings[key]
                    return repr(value) if isinstance(value, list) else str(value).lower()
                value = __import__('ast').literal_eval(args[4])
                if fail_write and setup.UUID in value:
                    fail_write = False
                    raise RuntimeError('Injected enablement failure')
                settings[key] = value
                return ''
            if args[0] == 'gnome-extensions':
                return None
            if args[0] == 'gdbus':
                return repr((json.dumps(loaded),)) if loaded else None
            raise AssertionError(args)
        args = SimpleNamespace(archive=archive, version=version, commit=commit, format=format,
                               app=str(app), appimage=True, app_sha256=hashlib.sha256(app.read_bytes()).hexdigest())
        def install():
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                setup.install(args)
            return output.getvalue()
        # Windows has no Unix uid API; only this temporary filesystem fixture supplies it.
        uid = app.stat().st_uid
        with patch.dict(os.environ, {'XDG_DATA_HOME': str(root / 'user data')}), \
             patch.object(setup.os, 'getuid', return_value=uid, create=True), \
             patch.object(setup, 'command', command):
            assert 'pending activation' in install()
            _data, extension, desktop, icon = setup.paths()
            original = setup.managed(extension, desktop, icon)
            assert original['build']['format'] == format
            loaded = {**build, 'active': True, 'animations': True}
            assert 'active for Diagnostic Hub' in install()
            loaded = {**loaded, 'format': other}
            assert 'pending activation' in install()
            calls.clear()
            assert 'pending activation' in install()
            assert not any(call[:2] == ['gsettings', 'set'] for call in calls)
            # A real cross-format replacement must roll back byte-for-byte on enable failure.
            def snapshot():
                return {str(p.relative_to(root)): p.read_bytes()
                        for p in root.rglob('*') if p.is_file()}
            baseline = snapshot()
            args.archive = str(Path(archives) / (other + '.zip'))
            args.format = other
            fail_write = True
            try:
                install()
            except RuntimeError:
                pass
            else:
                raise AssertionError('Cross-format update failure ignored')
            assert snapshot() == baseline
            assert setup.managed(extension, desktop, icon) == original
            assert settings['enabled-extensions'] == ['other@example.com', setup.UUID]
            # The still-loaded previous module cannot report the newly installed format active.
            loaded = {**build, 'active': True, 'animations': True}
            assert 'pending activation' in install()
            migrated = setup.managed(extension, desktop, icon)
            assert migrated['build']['format'] == other
            loaded = {**migrated['build'], 'active': True, 'animations': True}
            assert 'active for Diagnostic Hub' in install()
            # Migrating back also preserves other extensions and the verified application.
            args.archive = archive
            args.format = format
            assert 'pending activation' in install()
            assert setup.managed(extension, desktop, icon) == original
            loaded = {**build, 'active': True, 'animations': True}
            assert 'active for Diagnostic Hub' in install()
            # Changing launch format forces an update; rollback must restore all owned files.
            args.appimage = False
            fail_write = True
            try:
                install()
            except RuntimeError:
                pass
            else:
                raise AssertionError('Injected update failure ignored')
            assert setup.managed(extension, desktop, icon) == original
            assert settings['enabled-extensions'] == ['other@example.com', setup.UUID]
            with contextlib.redirect_stdout(io.StringIO()):
                setup.remove()
                setup.remove()
            assert app.read_bytes() == b'verified fixture'
            assert settings['enabled-extensions'] == ['other@example.com']
print('Both formats: validation, cross-format migration in both directions, byte-for-byte rollback, stale status, repeat setup and removal passed.')
