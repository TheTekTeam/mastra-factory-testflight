#!/usr/bin/env node
// Factory acceptance harness entrypoint. See harness/README.md for the boundary.
import { parseArgs } from 'node:util';

import { EvidenceRun } from './lib/evidence.mjs';
import { FactoryClient } from './lib/factory.mjs';
import { StateDb } from './lib/statedb.mjs';
import { createContext, NOT_APPLICABLE, SCENARIOS } from './scenarios.mjs';

const { values } = parseArgs({
  options: {
    'factory-url': { type: 'string' },
    project: { type: 'string' },
    'state-db': { type: 'string' },
    'candidate-sha': { type: 'string' },
    'base-branch': { type: 'string', default: 'harness/acceptance-134' },
    scenarios: { type: 'string', default: 'all' },
    token: { type: 'string' },
    out: { type: 'string' },
  },
});
for (const required of ['factory-url', 'project', 'state-db', 'candidate-sha', 'out']) {
  if (!values[required]) {
    console.error(`--${required} is required`);
    process.exit(2);
  }
}

const token = values.token ?? `RC-${values['candidate-sha'].slice(0, 8)}-${Date.now().toString(36)}`;
const client = new FactoryClient(values['factory-url']);
await client.project(values.project); // refuses ModelSpend projects
const run = new EvidenceRun({
  out: values.out,
  meta: {
    issue: 'TheTekTeam/dev-cluster-optimisation#134',
    candidateSha: values['candidate-sha'],
    factoryUrl: values['factory-url'],
    projectId: values.project,
    baseBranch: values['base-branch'],
    token,
  },
});
const ctx = createContext({ client, projectId: values.project, db: new StateDb(values['state-db']), token, baseBranch: values['base-branch'] });

const wanted = values.scenarios === 'all' ? null : new Set(values.scenarios.split(','));
for (const scenario of SCENARIOS) {
  if (wanted && !wanted.has(scenario.id)) continue;
  const { record, check, note } = run.scenario(scenario.id, scenario.title, scenario.gates);
  console.log(`▶ ${scenario.id}`);
  try {
    await scenario.run(ctx, { check, note });
    run.finish(record);
  } catch (error) {
    run.finish(record, error);
  }
  console.log(`  ${record.status}`);
  if (scenario.id === 'issue_ingestion' && record.status !== 'PASS') break; // every later scenario needs the item
}
for (const na of NOT_APPLICABLE) {
  if (wanted && !wanted.has(na.id)) continue;
  const { record } = run.scenario(na.id, na.title, []);
  record.status = 'NOT_APPLICABLE';
  record.reason = na.reason;
  record.finishedAt = new Date().toISOString();
}
const summary = run.flush();
console.log(`RESULT pass=${summary.pass} fail=${summary.fail} total=${summary.total} out=${values.out}`);
process.exit(summary.fail === 0 ? 0 : 1);
