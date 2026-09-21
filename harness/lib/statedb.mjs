// Read-only evidence reader over a CANDIDATE instance's own state DB.
// Refuses production state. Never writes.
import { DatabaseSync } from 'node:sqlite';

export class StateDb {
  constructor(path) {
    if (!path) throw new Error('--state-db is required for durable-state evidence');
    if (path.startsWith('/var/lib/modelspend-cluster')) throw new Error('refusing to read production Factory state');
    this.db = new DatabaseSync(path, { readOnly: true });
  }

  all(sql, ...params) {
    return this.db.prepare(sql).all(...params).map(row => ({ ...row }));
  }

  get(sql, ...params) {
    const row = this.db.prepare(sql).get(...params);
    return row ? { ...row } : null;
  }

  decisionsByKey(key) {
    return this.all(
      'select id, status, attempts, failure_code, idempotency_key, decision, approved_at, completed_at from factory_deferred_decisions where idempotency_key = ?',
      key,
    ).map(row => ({ ...row, decision: JSON.parse(row.decision) }));
  }

  decisionsForItem(workItemId) {
    return this.all(
      'select id, status, attempts, failure_code, idempotency_key, decision, created_at, completed_at from factory_deferred_decisions where work_item_id = ? order by created_at',
      workItemId,
    ).map(row => ({ ...row, decision: JSON.parse(row.decision) }));
  }

  bindings(workItemId) {
    return this.all(
      'select id, role, status, thread_id, resource_id, session_id, branch, created_at, revoked_at from factory_run_bindings where work_item_id = ? order by created_at',
      workItemId,
    );
  }

  pendingStarts(bindingId) {
    return this.all('select id, status, attempts, kickoff_key, created_at, completed_at from factory_pending_starts where binding_id = ?', bindingId);
  }

  thread(threadId) {
    const row = this.get('select id, resourceId, title, metadata, createdAt from mastra_threads where id = ?', threadId);
    if (row?.metadata && typeof row.metadata === 'string') {
      try {
        row.metadata = JSON.parse(row.metadata);
      } catch {
        // metadata may be binary-encoded; keep raw
      }
    }
    return row;
  }

  messages(threadId) {
    return this.all('select id, role, type, content, createdAt from mastra_messages where thread_id = ? order by createdAt', threadId).map(
      row => ({ ...row, text: messageText(row.content) }),
    );
  }

  audit(action) {
    return this.all('select action, actor_id, actor_type, metadata, occurred_at from audit_events where action = ? order by occurred_at', action);
  }
}

/** Flatten a stored message's content to plain text for assertions. */
export function messageText(content) {
  let value = content;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return value;
    }
  }
  const parts = [];
  const walk = node => {
    if (node == null) return;
    if (typeof node === 'string') parts.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (typeof node === 'object') {
      if (typeof node.text === 'string') parts.push(node.text);
      if (typeof node.content === 'string') parts.push(node.content);
      if (node.parts) walk(node.parts);
      if (Array.isArray(node.content)) walk(node.content);
    }
  };
  walk(value);
  return parts.join('\n');
}
