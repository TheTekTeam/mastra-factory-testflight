#!/usr/bin/env node
// Provision a Testflight project on a FRESH candidate instance through Factory's own API:
// project → source-control connection (seeded installation) → repository link on the
// harness base branch → intake source selection. Prints the ids as JSON.
// Usage: setup-project.mjs <factory-url> <installation-id> <repo-external-id> [base-branch]
import { FactoryClient } from '../lib/factory.mjs';

const [url, installationId, repoExternalId, branch = 'harness/acceptance-134'] = process.argv.slice(2);
const client = new FactoryClient(url);
const must = (label, res, ok = [200, 201]) => {
  if (!ok.includes(res.status)) throw new Error(`${label} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};

const { project } = must('project', await client.post('/web/factory/projects', { name: `testflight-${Date.now().toString(36)}` }));
const { connection } = must(
  'connection',
  await client.post(`/web/factory/projects/${project.id}/source-control-connections`, { integrationId: 'github', installationId }),
);
const { projectRepository } = must(
  'repository',
  await client.post(`/web/factory/projects/${project.id}/source-control-connections/${connection.id}/repositories`, {
    repository: { externalId: repoExternalId, slug: 'TheTekTeam/mastra-factory-testflight' },
    branch,
    sandboxProvider: 'custom',
    sandboxWorkdir: '~/mastra-factory-testflight',
    setupCommand: null,
    teardownCommand: null,
  }),
);
must('intake', await client.request('PUT', '/web/intake/config', { github: { enabled: true, sourceIds: [projectRepository.repositoryId] } }));
// Observational Memory parity with Dell production's persisted memory_settings
// (without it OM falls back to an upstream default model with no credentials).
for (const [role, modelId, factoryId] of [
  ['observer', 'openai/gpt-5.6-luna'],
  ['reflector', 'openai/gpt-5.6-terra'],
  ['observer', 'openai/gpt-5.6-luna', project.id],
  ['reflector', 'openai/gpt-5.6-luna', project.id],
]) {
  must(`om ${role}`, await client.request('PUT', `/web/config/om/${role}/model`, { modelId, ...(factoryId ? { factoryId } : {}) }));
}
const status = must('github status', await client.get('/web/github/status'));
console.log(
  JSON.stringify({
    projectId: project.id,
    connectionId: connection.id,
    projectRepositoryId: projectRepository.id,
    repositoryId: projectRepository.repositoryId,
    baseBranch: projectRepository.branch,
    githubConnected: status.connected,
    githubEnabled: status.enabled,
  }),
);
