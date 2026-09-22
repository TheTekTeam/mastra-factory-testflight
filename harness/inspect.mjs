#!/usr/bin/env node
// Read-only snapshot of a Factory project's work items and decisions.
// Usage: node harness/inspect.mjs <factory-url> <project-id> [--wait-items N]
import { FactoryClient, waitFor } from './lib/factory.mjs';

const [url, projectId, flag, n] = process.argv.slice(2);
const client = new FactoryClient(url);
if (flag === '--wait-items') {
  await waitFor(`${n} work items`, async () => (await client.workItems(projectId)).length >= Number(n), {
    timeoutMs: 180_000,
    intervalMs: 5_000,
  });
}
const items = await client.workItems(projectId);
for (const item of items) {
  console.log(
    JSON.stringify({
      id: item.id,
      revision: item.revision,
      stages: item.stages,
      title: item.title?.slice(0, 70),
      source: item.externalSource?.externalId,
      sessions: Object.fromEntries(Object.entries(item.sessions ?? {}).map(([k, v]) => [k, v.branch])),
    }),
  );
}
for (const d of await client.decisions(projectId)) {
  console.log(
    JSON.stringify({
      decision: d.id,
      status: d.status,
      workItemId: d.workItemId,
      type: d.decision?.type,
      skill: d.decision?.skillName,
      role: d.decision?.role,
      key: d.idempotencyKey ?? d.decision?.idempotencyKey,
      attempts: d.attempts,
      lastError: d.lastError?.slice?.(0, 160),
    }),
  );
}
