#!/usr/bin/env python3
"""Seed a FRESH candidate test database with the existing GitHub App installation link.

The native link is created by an interactive OAuth browser flow (/auth/github/callback),
which an unattended qualification run can't perform. This writes the same non-secret
record that flow would persist (integration `github`, installation external id, account),
scoped to the no-auth `local` org.

Refuses to touch production state. Usage:
  seed-installation.py <candidate-state-dir> <installation-external-id> <account-login>
"""
import datetime
import sqlite3
import sys
import uuid
from pathlib import Path

state, external_id, account = Path(sys.argv[1]).resolve(), sys.argv[2], sys.argv[3]
if str(state).startswith("/var/lib/modelspend-cluster"):
    sys.exit("refusing to seed production state")
db = sqlite3.connect(state / "mastra.db", timeout=10)
cols = {r[1] for r in db.execute("pragma table_info(source_control_installations)")}
existing = db.execute(
    "select id from source_control_installations where org_id='local' and external_id=?", (external_id,)
).fetchone()
if existing:
    print(existing[0])
    sys.exit(0)
now = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
row = {
    "id": str(uuid.uuid4()),
    "integration_id": "github",
    "org_id": "local",
    "connected_by_user_id": "local",
    "external_id": external_id,
    "account_name": account,
    "account_type": "Organization",
    "provider_metadata": "{}",
    "created_at": now,
}
row = {k: v for k, v in row.items() if k in cols}
db.execute(f"insert into source_control_installations ({','.join(row)}) values ({','.join('?' * len(row))})",
           list(row.values()))
db.commit()
print(row["id"])
