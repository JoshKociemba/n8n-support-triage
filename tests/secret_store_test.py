import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
from secret_store import KeychainStore, SecretStoreError, load_config, migrate

class MemoryStore:
    def __init__(self, values=None, broken=None):
        self.values = values or {}
        self.broken = broken
    def get(self, name):
        return self.values.get(name)
    def set(self, name, value):
        self.values[name] = 'wrong-value' if name == self.broken else value

class SecretStoreTests(unittest.TestCase):
    def setup_files(self, root):
        (root / '.env').write_text('# Local config\nN8N_API_KEY=synthetic-n8n\nPLAIN_API_KEY="synthetic-plain"\nOLLAMA_MODEL=qwen3:4b\n')
        (root / '.plain-webhook-state.json').write_text(json.dumps({'workflowId': 'demo', 'ingressToken': 'synthetic-webhook'}))

    def test_migration_verifies_secrets_and_preserves_config_and_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.setup_files(root)
            store = MemoryStore()
            self.assertEqual(set(migrate(root, store)), {'N8N_API_KEY', 'PLAIN_API_KEY', 'PLAIN_WEBHOOK_TOKEN'})
            self.assertEqual(store.values['PLAIN_WEBHOOK_TOKEN'], 'synthetic-webhook')
            self.assertEqual(load_config(root), {'OLLAMA_MODEL': 'qwen3:4b'})
            self.assertEqual(json.loads((root / '.plain-webhook-state.json').read_text()), {'workflowId': 'demo'})
            for path in [root / '.env', root / '.plain-webhook-state.json']:
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertNotIn('synthetic-', path.read_text())
            self.assertEqual(migrate(root, store), [])

    def test_keychain_conflict_or_failed_roundtrip_keeps_plaintext_files_intact(self):
        for store in [MemoryStore({'N8N_API_KEY': 'existing-different'}), MemoryStore(broken='PLAIN_WEBHOOK_TOKEN')]:
            with tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                self.setup_files(root)
                before = {p.name: p.read_text() for p in root.iterdir()}
                with self.assertRaises(SecretStoreError): migrate(root, store)
                self.assertEqual(before, {p.name: p.read_text() for p in root.iterdir()})

    def test_config_rejects_secret_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.setup_files(root)
            with self.assertRaises(SecretStoreError): load_config(root)

    def test_secret_is_passed_over_stdin_not_process_arguments(self):
        store = KeychainStore('/tmp/synthetic-keychain-project')
        with patch.object(store, 'ensure_helper'), patch('secret_store.subprocess.run') as run:
            run.return_value.returncode = 0
            run.return_value.stdout = b''
            store.set('N8N_API_KEY', 'synthetic-secret')
            args, kwargs = run.call_args
            self.assertNotIn('synthetic-secret', str(args))
            self.assertEqual(json.loads(kwargs['input'])['value'], 'synthetic-secret')
            self.assertTrue(kwargs['capture_output'])

if __name__ == '__main__': unittest.main()
