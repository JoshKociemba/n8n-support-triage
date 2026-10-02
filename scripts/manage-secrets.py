"""Manage project secrets without echoing them or putting them in shell history."""
import getpass
import sys
from secret_store import STORE, SecretStoreError, migrate

try:
    command = sys.argv[1] if len(sys.argv) > 1 else 'status'
    if command == 'migrate':
        names = migrate()
        print('Migrated and verified ' + str(len(names)) + ' secret(s). Plaintext copies removed from .env and state.')
    elif command == 'set' and len(sys.argv) == 3:
        if not sys.stdin.isatty():
            raise SecretStoreError('Run this command in an interactive terminal; values are entered with hidden input.')
        name = sys.argv[2]
        value = getpass.getpass(name + ': ')
        STORE.set(name, value)
        if STORE.get(name) != value:
            raise SecretStoreError('Keychain verification failed.')
        print(name + ' saved and verified in Keychain.')
    elif command == 'status':
        for name in ['N8N_API_KEY', 'PLAIN_API_KEY', 'TAVILY_API_KEY', 'PLAIN_WEBHOOK_TOKEN']:
            print(name + ': ' + ('stored' if STORE.get(name) else 'missing'))
    else:
        raise SecretStoreError('Usage: manage-secrets.py [migrate | status | set SECRET_NAME]')
except SecretStoreError as error:
    raise SystemExit(str(error))
