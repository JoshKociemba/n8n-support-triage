"""macOS Keychain bridge. Secret values never enter subprocess arguments."""
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
ACCOUNT_PATTERN = re.compile(r'^[A-Z][A-Z0-9_]*$')
CONFIG_NAMES = {'OLLAMA_MODEL'}

class SecretStoreError(RuntimeError):
    pass

class KeychainStore:
    """Store project secrets through a native helper with captured stdin/stdout pipes."""
    def __init__(self, root=ROOT):
        self.root = pathlib.Path(root)
        self.helper = self.root / '.local' / 'keychain-helper'

    def ensure_helper(self):
        """Build the native bridge at a stable path for macOS Keychain access prompts."""
        if sys.platform != 'darwin':
            raise SecretStoreError('This secret store requires macOS Keychain.')
        source = self.root / 'scripts' / 'keychain-helper.swift'
        if self.helper.exists() and self.helper.stat().st_mtime >= source.stat().st_mtime:
            return
        self.helper.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        result = subprocess.run(['/usr/bin/swiftc', '-module-cache-path', str(self.helper.parent / 'swift-cache'),
                                 str(source), '-o', str(self.helper)], capture_output=True)
        if result.returncode:
            raise SecretStoreError('Unable to build Keychain helper. Install the Apple Command Line Tools with xcode-select --install.')
        self.helper.chmod(0o700)

    def _call(self, operation, account, value=None):
        """Use a stdin request so secret values never appear in process arguments."""
        if not ACCOUNT_PATTERN.fullmatch(account):
            raise SecretStoreError('Invalid secret name.')
        self.ensure_helper()
        request = {'operation': operation, 'account': account}
        if value is not None:
            request['value'] = value
        result = subprocess.run([str(self.helper)], input=json.dumps(request).encode(), capture_output=True)
        # Only a missing item is optional; locked or denied access must not look like absence.
        if result.returncode == 44 and operation == 'get':
            return None
        if result.returncode:
            raise SecretStoreError('Keychain access failed. Unlock your login keychain and allow the project helper if macOS prompts.')
        return result.stdout.decode()

    def get(self, name):
        """Return the secret for an uppercase account name, or None if no item exists."""
        return self._call('get', name)

    def set(self, name, value):
        """Create or replace a named secret, rejecting empty values."""
        if not value:
            raise SecretStoreError('Empty secret rejected.')
        self._call('set', name, value)

STORE = KeychainStore()

def get_secret(name, required=True):
    """Read a Keychain item, raising setup guidance when a required secret is absent."""
    value = STORE.get(name)
    if required and not value:
        raise SecretStoreError('Missing ' + name + '. Run python3 scripts/manage-secrets.py set ' + name + '.')
    return value

def load_config(root=ROOT):
    """Read only allowlisted non-secret .env settings; never fall back to plaintext keys."""
    path = pathlib.Path(root) / '.env'
    config = {}
    if not path.exists():
        return config
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#') or '=' not in line:
            continue
        name, value = line.split('=', 1)
        name = name.strip()
        if name not in CONFIG_NAMES:
            raise SecretStoreError('.env may contain only non-secret settings. Run python3 scripts/manage-secrets.py migrate.')
        config[name] = value.strip().strip(chr(34) + chr(39))
    return config

def atomic_write(path, content):
    """Replace one file atomically with owner-only permissions."""
    path = pathlib.Path(path)
    # Create beside the destination so os.replace stays on the same filesystem.
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.' + path.name + '-')
    try:
        with os.fdopen(fd, 'w') as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def migrate(root=ROOT, store=STORE):
    """Verify every Keychain round trip before removing any plaintext values."""
    root = pathlib.Path(root)
    env = root / '.env'
    state_path = root / '.plain-webhook-state.json'
    lines = env.read_text().splitlines(keepends=True) if env.exists() else []
    retained, pending = [], {}
    for line in lines:
        if not line.strip() or line.lstrip().startswith('#'):
            retained.append(line)
            continue
        if '=' not in line:
            raise SecretStoreError('Invalid .env line; no plaintext files were changed.')
        name, value = line.split('=', 1)
        name = name.strip()
        if name in CONFIG_NAMES:
            retained.append(line)
            continue
        if not ACCOUNT_PATTERN.fullmatch(name) or not any(part in name for part in ['KEY', 'TOKEN', 'SECRET', 'PASSWORD']):
            raise SecretStoreError('Unknown .env setting ' + name + '; no plaintext files were changed.')
        value = value.strip().strip(chr(34) + chr(39))
        if not value:
            raise SecretStoreError('Empty secret in .env; no plaintext files were changed.')
        if name in pending and pending[name] != value:
            raise SecretStoreError('Conflicting duplicate secret; no plaintext files were changed.')
        pending[name] = value
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    if state.get('ingressToken'):
        pending['PLAIN_WEBHOOK_TOKEN'] = state['ingressToken']
    # Check every conflict before importing anything, preserving existing Keychain values.
    for name, value in pending.items():
        existing = store.get(name)
        if existing is not None and existing != value:
            raise SecretStoreError('Keychain already has a different ' + name + '; no plaintext files were changed.')
    for name, value in pending.items():
        store.set(name, value)
        if store.get(name) != value:
            raise SecretStoreError('Keychain verification failed; no plaintext files were changed.')
    # Both plaintext files stay intact until all imported values have passed a read-back check.
    if env.exists():
        atomic_write(env, ''.join(retained) or '# Non-secret settings only. API keys are stored in macOS Keychain.\n')
    if 'ingressToken' in state:
        del state['ingressToken']
        atomic_write(state_path, json.dumps(state) + '\n')
    return list(pending)
