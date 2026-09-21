// Acceptance scenarios. Each drives Factory only through its public contracts
// and asserts on the candidate instance's own durable state. Scenarios share a
// lifecycle work item created by `issue_ingestion`.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { waitFor } from './lib/factory.mjs';
import { createIssue, prFiles, prsForBranch, TESTFLIGHT_REPO } from './lib/github.mjs';

const KEY = rid => `external-orchestrator:${rid}`;
const DONE = new Set(['succeeded', 'failed', 'dismissed', 'superseded']);

function remoteHead(branch) {
  const out = execFileSync('git', ['ls-remote', `https://github.com/${TESTFLIGHT_REPO}.git`, `refs/heads/${branch}`], {
    encoding: 'utf8',
  });
  return out.split(/\s+/)[0] || null;
}

/** Thread metadata is binary-encoded; pull the selected model ids out of it. */
function selectedModels(metadata) {
  const text = Buffer.isBuffer(metadata) || metadata instanceof Uint8Array ? Buffer.from(metadata).toString('latin1') : String(metadata ?? '');
  const pick = key => {
    const at = text.indexOf(key);
    if (at < 0) return null;
    const rest = text.slice(at + key.length);
    const match = rest.match(/^[\s\S]{1,2}?([a-z0-9-]+\/[A-Za-z0-9._:-]+)/);
    return match ? match[1] : null;
  };
  return { currentModelId: pick('currentModelId'), buildModelId: pick('modeModelId_build') };
}

export function createContext({ client, projectId, db, token, baseBranch }) {
  const ctx = { client, projectId, db, token, baseBranch, item: null, issue: null };

  ctx.refresh = async () => {
    ctx.item = await client.workItem(projectId, ctx.item.id);
    return ctx.item;
  };

  ctx.submit = async ({ role, skillName, args, requestId = randomUUID(), expectedRevision }) => {
    const item = await ctx.refresh();
    const body = {
      requestId,
      expectedRevision: expectedRevision ?? item.revision,
      role,
      skillName,
      ...(args ? { arguments: args } : {}),
    };
    const res = await client.automationRun(projectId, item.id, body);
    return { requestId, body, res };
  };

  // Consent is only meaningful once the dispatcher has proposed the decision;
  // approving a still-`pending` row is rejected, so wait for `proposed` first.
  ctx.approve = async requestId => {
    const row = await waitFor(
      `decision ${requestId} to be proposed`,
      async () => {
        const [r] = db.decisionsByKey(KEY(requestId));
        return r && r.status !== 'pending' ? r : null;
      },
      { timeoutMs: 120_000, intervalMs: 500 },
    );
    if (row.status !== 'proposed') return { status: 'not-required', body: { decisionStatus: row.status } };
    const res = await client.post(`/web/factory/projects/${projectId}/decisions/${row.id}/approve`, {});
    if (res.status !== 200) throw new Error(`approve ${row.id} failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res;
  };

  ctx.settle = async (requestId, timeoutMs = 600_000) =>
    waitFor(
      `decision ${requestId} to settle`,
      async () => {
        const [row] = db.decisionsByKey(KEY(requestId));
        return row && DONE.has(row.status) ? row : null;
      },
      { timeoutMs, intervalMs: 3_000 },
    );

  ctx.binding = role => db.bindings(ctx.item.id).filter(b => b.role === role).at(-1) ?? null;

  /** Messages on the role's thread after `since` (ISO). */
  ctx.threadMessages = (role, since) => {
    const binding = ctx.binding(role);
    if (!binding) return [];
    return db.messages(binding.thread_id).filter(m => !since || m.createdAt >= since);
  };

  ctx.invoke = async ({ role, skillName, args, note, label }) => {
    const since = new Date().toISOString();
    const { requestId, res } = await ctx.submit({ role, skillName, args });
    if (res.status !== 202) throw new Error(`${label ?? skillName} not committed: ${res.status} ${JSON.stringify(res.body)}`);
    const approved = await ctx.approve(requestId);
    const settled = await ctx.settle(requestId);
    const messages = ctx.threadMessages(role, since);
    note?.(`${label ?? skillName}`, {
      requestId,
      approveStatus: approved.status,
      decision: { id: settled.id, status: settled.status, attempts: settled.attempts, failureCode: settled.failure_code },
      messages: messages.map(m => ({ role: m.role, type: m.type, at: m.createdAt, text: m.text.slice(0, 600) })),
    });
    return { requestId, settled, messages, since };
  };

  ctx.selectedModels = selectedModels;
  ctx.remoteHead = remoteHead;
  return ctx;
}

// Dispatcher kickoffs are persisted as signal messages (role 'signal', type 'user').
const isKickoff = m => (m.role === 'user' || m.type === 'user') && m.text.includes('<skill name=');
const lastAssistant = messages => messages.filter(m => m.role === 'assistant' && !m.text.includes('"type":"error"')).at(-1)?.text ?? '';
const field = (text, name) => text.match(new RegExp(`${name}=([^\\s\`]+)`))?.[1] ?? null;

export const SCENARIOS = [
  {
    id: 'issue_ingestion',
    title: 'GitHub issue → native intake → Factory work item',
    gates: ['issue ingestion', 'GitHub integration'],
    async run(ctx, { check, note }) {
      const issue = createIssue(
        `TESTFLIGHT.${ctx.token} — Factory candidate acceptance fixture`,
        `Qualification fixture for TheTekTeam/dev-cluster-optimisation#134 (token \`${ctx.token}\`). Driven only by harness/ against an isolated loopback candidate. Changes are limited to proofs/issue-<number>.md.`,
      );
      ctx.issue = issue;
      note('issue', issue);
      const intake = await waitFor(
        'issue to appear in native intake',
        async () => {
          const res = await ctx.client.get('/web/intake/items');
          return res.body?.items?.find(i => i.metadata?.number === issue.number) ?? null;
        },
        { timeoutMs: 180_000, intervalMs: 5_000 },
      );
      check('issue visible through native GitHub intake', intake.externalSource?.integrationId === 'github', intake.externalSource);
      const created = await ctx.client.post(`/web/factory/projects/${ctx.projectId}/work-items`, {
        title: intake.title,
        externalSource: intake.externalSource,
      });
      check('work item created', [200, 201].includes(created.status) && Boolean(created.body?.workItem?.id), created.status);
      ctx.item = created.body.workItem;
      const again = await ctx.client.post(`/web/factory/projects/${ctx.projectId}/work-items`, {
        title: intake.title,
        externalSource: intake.externalSource,
      });
      check('re-ingesting the same issue returns the same work item', again.body?.workItem?.id === ctx.item.id, {
        first: ctx.item.id,
        again: again.body?.workItem?.id,
        status: again.status,
      });
      note('workItem', { id: ctx.item.id, revision: ctx.item.revision, stages: ctx.item.stages, externalSource: ctx.item.externalSource });
      check('work item linked to the exact issue', ctx.item.externalSource?.url?.endsWith(`/issues/${issue.number}`), ctx.item.externalSource);
      check('work item starts at revision 1 in intake', ctx.item.revision === 1 && ctx.item.stages.includes('intake'), ctx.item);
    },
  },
  {
    id: 'ingress_accepted',
    title: 'native /automation-runs commits exactly one durable invokeSkill decision',
    gates: ['native /automation-runs accepted decision'],
    async run(ctx, { check, note }) {
      const { requestId, res } = await ctx.submit({ role: 'work', skillName: 'testflight-probe', args: `probe=${ctx.token}-ingress` });
      ctx.ingress = { requestId };
      note('response', res);
      check('202 committed', res.status === 202 && res.body.status === 'committed', res);
      const rows = ctx.db.decisionsByKey(KEY(requestId));
      note('decisions', rows);
      check('exactly one durable decision for the request', rows.length === 1, rows.length);
      check('decision is invokeSkill for the requested skill/role', rows[0]?.decision?.type === 'invokeSkill' && rows[0]?.decision?.skillName === 'testflight-probe' && rows[0]?.decision?.role === 'work', rows[0]?.decision);
      const proposed = await waitFor('dispatcher to request consent', async () => {
        const [row] = ctx.db.decisionsByKey(KEY(requestId));
        return row?.status === 'proposed' ? row : null;
      }, { timeoutMs: 60_000, intervalMs: 1_000 }).catch(() => null);
      check('dispatcher holds it for consent (auto-run off), never auto-executes', proposed?.status === 'proposed', proposed?.status);
      const queued = ctx.db.audit('factory.run.queued').filter(a => String(a.metadata).includes(requestId));
      check('queued audit event recorded with system actor', queued.length === 1 && queued[0].actor_type === 'system', queued);
    },
  },
  {
    id: 'duplicate_replay',
    title: 'identical request replays without a second decision',
    gates: ['replay/dedupe', 'duplicate automation request'],
    async run(ctx, { check, note }) {
      const { requestId } = ctx.ingress;
      const [before] = ctx.db.decisionsByKey(KEY(requestId));
      const replays = await Promise.all(
        [1, 2, 3].map(() =>
          ctx.client.automationRun(ctx.projectId, ctx.item.id, {
            requestId,
            expectedRevision: 1,
            role: 'work',
            skillName: 'testflight-probe',
            arguments: `probe=${ctx.token}-ingress`,
          }),
        ),
      );
      note('replays', replays);
      check('every replay returns 200 replayed', replays.every(r => r.status === 200 && r.body.status === 'replayed'), replays.map(r => r.status));
      const rows = ctx.db.decisionsByKey(KEY(requestId));
      check('still exactly one decision', rows.length === 1 && rows[0].id === before.id, rows.map(r => r.id));
    },
  },
  {
    id: 'request_id_collision',
    title: 'same requestId with a different payload fails closed',
    gates: ['request-ID collision fail-closed'],
    async run(ctx, { check, note }) {
      const { requestId } = ctx.ingress;
      const variants = [
        { skillName: 'testflight-probe', arguments: `probe=${ctx.token}-DIFFERENT` },
        { skillName: 'testflight-implement', arguments: `probe=${ctx.token}-ingress` },
      ];
      for (const variant of variants) {
        const res = await ctx.client.automationRun(ctx.projectId, ctx.item.id, { requestId, expectedRevision: 1, role: 'work', ...variant });
        note(`collision:${variant.skillName}`, res);
        check(`409 request_id_conflict (${variant.skillName})`, res.status === 409 && res.body.code === 'request_id_conflict', res);
      }
      check('no additional decision', ctx.db.decisionsByKey(KEY(requestId)).length === 1);
    },
  },
  {
    id: 'stale_revision',
    title: 'stale expectedRevision yields no runnable decision',
    gates: ['stale revision fail-closed'],
    async run(ctx, { check, note }) {
      const item = await ctx.refresh();
      for (const expectedRevision of [item.revision + 3]) {
        const { requestId, res } = await ctx.submit({ role: 'work', skillName: 'testflight-probe', args: 'probe=stale', expectedRevision });
        note(`stale:${expectedRevision}`, res);
        check(`409 stale at revision ${expectedRevision} (current ${item.revision})`, res.status === 409 && res.body.code === 'stale', res);
        const rows = ctx.db.decisionsByKey(KEY(requestId));
        check('no runnable decision committed', rows.every(r => r.status !== 'pending' && r.status !== 'proposed'), rows);
      }
    },
  },
  {
    id: 'invalid_fail_closed',
    title: 'unsupported roles/effects/shapes fail closed',
    gates: ['invalid/unsupported operation fail-closed'],
    async run(ctx, { check, note }) {
      const base = { requestId: randomUUID(), expectedRevision: 1, role: 'work', skillName: 'testflight-probe' };
      const cases = {
        unsupported_role: { ...base, role: 'admin' },
        extra_effect_field: { ...base, requestId: randomUUID(), effects: ['merge'] },
        non_uuid_request_id: { ...base, requestId: 'not-a-uuid' },
        empty_skill: { ...base, requestId: randomUUID(), skillName: '  ' },
        oversized_arguments: { ...base, requestId: randomUUID(), arguments: 'x'.repeat(5000) },
      };
      for (const [name, body] of Object.entries(cases)) {
        const res = await ctx.client.automationRun(ctx.projectId, ctx.item.id, body);
        note(name, res);
        check(`${name} → 400`, res.status === 400, res.status);
        if (typeof body.requestId === 'string') check(`${name} commits nothing`, ctx.db.decisionsByKey(KEY(body.requestId)).length === 0);
      }
      const missingItem = await ctx.client.automationRun(ctx.projectId, randomUUID(), { ...base, requestId: randomUUID() });
      check('unknown work item → 404', missingItem.status === 404, missingItem.status);
      const malformed = await ctx.client.request('POST', `/web/factory/projects/${ctx.projectId}/work-items/${ctx.item.id}/automation-runs`, '{not json');
      check('malformed JSON → 400', malformed.status === 400, malformed.status);
    },
  },
  {
    id: 'local_noauth_scope',
    title: 'explicit no-auth mode serves the sentinel local tenant only',
    gates: ['local/no-auth scope'],
    async run(ctx, { check, note }) {
      const caps = await ctx.client.get('/api/auth/capabilities');
      check('auth disabled', caps.body?.enabled === false, caps.body);
      const project = await ctx.client.project(ctx.projectId);
      check('project owned by local org', project.orgId === 'local', project.orgId);
      const other = await ctx.client.automationRun(randomUUID(), ctx.item.id, { requestId: randomUUID(), expectedRevision: 1, role: 'work', skillName: 'x' });
      check('unknown project → 404 (no cross-project reach)', other.status === 404, other.status);
      const surfaces = {};
      for (const path of ['/web/factory/projects', `/web/factory/projects/${ctx.projectId}/work-items`, '/web/intake/config', '/web/github/status']) {
        surfaces[path] = (await ctx.client.get(path)).status;
      }
      note('surfaces', surfaces);
      check('Dell no-auth surfaces reachable (200)', Object.values(surfaces).every(s => s === 200), surfaces);
    },
  },
  {
    id: 'skill_discovery_invocation',
    title: 'repository-local skill discovered and invoked on a real provider',
    gates: ['native local skill discovery/invocation', 'accepted durable invokeSkill', 'real provider-backed run'],
    async run(ctx, { check, note }) {
      await ctx.approve(ctx.ingress.requestId);
      const settled = await ctx.settle(ctx.ingress.requestId);
      const messages = ctx.threadMessages('work');
      note('decision', { status: settled.status, attempts: settled.attempts, failureCode: settled.failure_code });
      note('messages', messages.map(m => ({ role: m.role, type: m.type, at: m.createdAt, text: m.text.slice(0, 800) })));
      check('decision succeeded', settled.status === 'succeeded', settled);
      check('kickoff carried the repository-local skill', messages.some(m => m.text.includes('<skill name="testflight-probe">') && m.text.includes('Testflight probe')));
      const reply = lastAssistant(messages);
      check('agent executed the skill (token echoed)', field(reply, 'TESTFLIGHT_PROBE') === `${ctx.token}-ingress`, reply.slice(0, 400));
      const head = field(reply, 'TESTFLIGHT_HEAD');
      const baseHead = ctx.remoteHead(ctx.baseBranch);
      note('heads', { reported: head, base: baseHead });
      check('workspace is the exact configured base head', head === baseHead, { head, baseHead });
    },
  },
  {
    id: 'selected_model_context',
    title: 'selected model and session/request context preserved into the run',
    gates: ['selected-model preservation', 'request/session-context preservation'],
    async run(ctx, { check, note }) {
      const binding = ctx.binding('work');
      const thread = ctx.db.thread(binding.thread_id);
      const models = ctx.selectedModels(thread.metadata);
      note('binding', binding);
      note('thread', { id: thread.id, resourceId: thread.resourceId, title: thread.title, models });
      check('thread recorded a selected model', Boolean(models.currentModelId), models);
      check('build-mode model equals the selected model', models.buildModelId === models.currentModelId, models);
      check('binding thread = session thread', binding.thread_id === thread.id);
      check('thread resource is the bound session resource', thread.resourceId === binding.resource_id, { thread: thread.resourceId, binding: binding.resource_id });
      const phase = ctx.threadMessages('work').find(m => m.type === 'factory-phase');
      check('run received its work-item/role request context', Boolean(phase?.text.includes(ctx.item.id) && phase?.text.includes('Role: work')), phase?.text);
      const item = await ctx.refresh();
      check('work item session points at the bound session', item.sessions?.work?.sessionId === binding.session_id, item.sessions?.work);
    },
  },
  {
    id: 'ingress_reinvocation_same_binding',
    title: 'repeated external invocation reuses the live binding/session with fresh arguments',
    gates: ['same-stage re-entry (orchestrator ingress)'],
    async run(ctx, { check, note }) {
      const bindingBefore = ctx.binding('work');
      const { settled, messages } = await ctx.invoke({ role: 'work', skillName: 'testflight-probe', args: `probe=${ctx.token}-reentry`, note, label: 'reentry' });
      check('re-invocation succeeded', settled.status === 'succeeded', settled);
      check('same binding/session reused (no new seat)', ctx.binding('work').id === bindingBefore.id && ctx.db.bindings(ctx.item.id).filter(b => b.role === 'work').length === 1);
      check('fresh arguments delivered', field(lastAssistant(messages), 'TESTFLIGHT_PROBE') === `${ctx.token}-reentry`);
      // By upstream contract /automation-runs decisions never carry `resume`, so an
      // external re-invocation re-delivers the full skill. Recorded, not asserted.
      const kickoff = messages.filter(isKickoff).find(m => m.text.includes('<skill name="testflight-probe">'));
      note('kickoffForm', kickoff?.text.includes('Resume the active') ? 'compact-resume' : 'full-skill (by /automation-runs contract)');
    },
  },
  {
    id: 'serialized_dispatch',
    title: 'concurrent requests to one binding run strictly one at a time',
    gates: ['single-binding serialized dispatch', 'concurrent requests to one binding'],
    async run(ctx, { check, note }) {
      const since = new Date().toISOString();
      const item = await ctx.refresh();
      const tokens = ['A', 'B', 'C'].map(t => `${ctx.token}-serial-${t}`);
      const submitted = await Promise.all(
        tokens.map(t => ctx.submit({ role: 'work', skillName: 'testflight-probe', args: `probe=${t}`, expectedRevision: item.revision })),
      );
      note('submitted', submitted.map(s => ({ requestId: s.requestId, status: s.res.status, body: s.res.body })));
      const committed = submitted.filter(s => s.res.status === 202);
      check('concurrent requests committed', committed.length >= 1, submitted.map(s => s.res.status));
      await Promise.all(committed.map(s => ctx.approve(s.requestId)));
      const settled = await Promise.all(committed.map(s => ctx.settle(s.requestId)));
      note('settled', settled.map(s => ({ status: s.status, attempts: s.attempts, failureCode: s.failure_code })));
      check('every committed request succeeded', settled.every(s => s.status === 'succeeded'), settled.map(s => s.status));
      const messages = ctx.threadMessages('work', since);
      const spans = committed.map(s => {
        const t = s.body.arguments.split('=')[1];
        const starts = messages.filter(m => isKickoff(m) && m.text.includes(`probe=${t}`));
        const start = starts[0]?.createdAt;
        const kickoffCount = starts.length;
        const end = messages.filter(m => m.role === 'assistant' && m.text.includes(`TESTFLIGHT_PROBE=${t}`)).at(-1)?.createdAt;
        return { token: t, start, end, kickoffCount };
      });
      note('spans', spans);
      check('each run delivered and answered exactly once', spans.every(s => s.start && s.end && s.kickoffCount === 1), spans);
      const ordered = [...spans].sort((a, b) => a.start.localeCompare(b.start));
      const overlaps = ordered.slice(1).filter((s, i) => s.start < ordered[i].end);
      check('no run started before the previous finished', overlaps.length === 0, overlaps);
      check('still one work binding', ctx.db.bindings(ctx.item.id).filter(b => b.role === 'work' && b.status === 'active').length === 1);
    },
  },
  {
    id: 'failure_retry',
    title: 'failing dispatch fails closed, surfaces a stable code, and retries on request',
    gates: ['failure/retry'],
    async run(ctx, { check, note }) {
      const { requestId, res } = await ctx.submit({ role: 'work', skillName: 'testflight-does-not-exist' });
      check('unknown skill still commits (validated at dispatch)', res.status === 202, res);
      await ctx.approve(requestId);
      const failed = await ctx.settle(requestId);
      note('failed', failed);
      check('decision fails terminally', failed.status === 'failed', failed.status);
      check('failure is attributed, not silent', Boolean(failed.failure_code) || failed.attempts > 0, failed);
      const retry = await ctx.client.post(`/web/factory/projects/${ctx.projectId}/decisions/${failed.id}/retry`, {});
      note('retry', retry);
      check('native retry accepted', retry.status === 200 && ['retry', 'pending'].includes(retry.body?.decision?.status), retry.body?.decision?.status);
      const again = await ctx.settle(requestId);
      check('retried decision re-fails closed (skill still absent)', again.status === 'failed', again.status);
      const item = await ctx.refresh();
      check('work item not corrupted by failures', item.stages.length > 0 && !item.stages.includes('done'), item.stages);
    },
  },
  {
    id: 'implement_pr',
    title: 'implementation opens a PR containing only the proof file',
    gates: ['implementation', 'validation'],
    async run(ctx, { check, note }) {
      const { settled, messages } = await ctx.invoke({ role: 'work', skillName: 'testflight-implement', args: `issue=${ctx.issue.number} token=${ctx.token}-v1 base=${ctx.baseBranch}`, note, label: 'implement-v1' });
      check('implementation run succeeded', settled.status === 'succeeded', settled);
      const reply = lastAssistant(messages);
      check('skill reported PASS', field(reply, 'TESTFLIGHT_IMPLEMENT') === 'PASS', reply.slice(0, 400));
      const branch = ctx.binding('work').branch;
      const pr = await waitFor('PR for branch', async () => prsForBranch(branch)[0] ?? null, { timeoutMs: 120_000 });
      ctx.pr = pr;
      note('pr', pr);
      check('PR head equals reported head', pr.headRefOid === field(reply, 'TESTFLIGHT_HEAD'), { pr: pr.headRefOid, reported: field(reply, 'TESTFLIGHT_HEAD') });
      const files = prFiles(pr.number);
      check('PR targets the configured project base branch', pr.baseRefName === ctx.baseBranch, pr.baseRefName);
      check('PR changes only the proof file', files.length === 1 && files[0] === `proofs/issue-${ctx.issue.number}.md`, files);
    },
  },
  {
    id: 'exact_head_review',
    title: 'review runs on the exact PR head',
    gates: ['review', 'exact PR-head review', 'exact-head validation/review', 'completion review'],
    async run(ctx, { check, note }) {
      const head = prsForBranch(ctx.binding('work').branch)[0].headRefOid;
      const { settled, messages } = await ctx.invoke({ role: 'review', skillName: 'testflight-review', args: `issue=${ctx.issue.number} token=${ctx.token}-v1 expected_head=${head}`, note, label: 'review-v1' });
      check('review run succeeded', settled.status === 'succeeded', settled);
      const reply = lastAssistant(messages);
      check('reviewed head equals PR head', field(reply, 'TESTFLIGHT_REVIEWED_HEAD') === head, { reviewed: field(reply, 'TESTFLIGHT_REVIEWED_HEAD'), head });
      check('verdict APPROVE on correct proof', field(reply, 'TESTFLIGHT_REVIEW') === 'APPROVE', reply.slice(0, 400));
      ctx.reviewedHeads = [head];
    },
  },
  {
    id: 'rereview_same_pr',
    title: 'follow-up implementation updates the same PR; re-review binds to the new head',
    gates: ['re-review', 'exact-head validation/review'],
    async run(ctx, { check, note }) {
      const before = ctx.pr;
      const impl = await ctx.invoke({ role: 'work', skillName: 'testflight-implement', args: `issue=${ctx.issue.number} token=${ctx.token}-v2 base=${ctx.baseBranch}`, note, label: 'implement-v2' });
      check('follow-up implementation succeeded', impl.settled.status === 'succeeded', impl.settled);
      const after = prsForBranch(ctx.binding('work').branch)[0];
      note('pr', { before, after });
      check('same PR updated in place', after.number === before.number, { before: before.number, after: after.number });
      check('PR head advanced', after.headRefOid !== before.headRefOid);
      const rev = await ctx.invoke({ role: 'review', skillName: 'testflight-review', args: `issue=${ctx.issue.number} token=${ctx.token}-v2 expected_head=${after.headRefOid}`, note, label: 'review-v2' });
      const reply = lastAssistant(rev.messages);
      check('re-review succeeded', rev.settled.status === 'succeeded', rev.settled);
      check('re-review bound to the new head', field(reply, 'TESTFLIGHT_REVIEWED_HEAD') === after.headRefOid, reply.slice(0, 400));
      check('re-review verdict APPROVE', field(reply, 'TESTFLIGHT_REVIEW') === 'APPROVE');
      const stale = await ctx.invoke({ role: 'review', skillName: 'testflight-review', args: `issue=${ctx.issue.number} token=${ctx.token}-v2 expected_head=${before.headRefOid}`, note, label: 'review-stale-head' });
      check('review against a stale expected head is rejected', field(lastAssistant(stale.messages), 'TESTFLIGHT_REVIEW') === 'REQUEST_CHANGES');
    },
  },
  {
    id: 'native_same_stage_continuation',
    title: 'review→review re-entry continues the live factory-review session with a compact kickoff',
    gates: ['same-stage re-entry', 'same-stage continuation', 'completion review'],
    async run(ctx, { check, note }) {
      const pr = ctx.pr;
      if (!pr) throw new Error('requires implement_pr to have produced a PR');
      const intake = await waitFor('PR in native intake', async () => {
        const res = await ctx.client.get('/web/intake/items');
        return res.body?.items?.find(i => i.metadata?.number === pr.number && i.externalSource?.type !== 'issue') ?? null;
      }, { timeoutMs: 180_000, intervalMs: 5_000 });
      note('prIntake', intake.externalSource);
      const created = await ctx.client.post(`/web/factory/projects/${ctx.projectId}/work-items`, {
        title: intake.title,
        board: 'review',
        externalSource: intake.externalSource,
      });
      check('review-board work item created for the PR', [200, 201].includes(created.status) && created.body?.workItem?.board === 'review', created.body?.workItem?.board);
      let item = created.body.workItem;

      const decide = async (label, predicate) => {
        const row = await waitFor(`${label} decision`, async () => ctx.db.decisionsForItem(item.id).find(predicate) ?? null, { timeoutMs: 120_000, intervalMs: 1_000 });
        const proposed = await waitFor(`${label} proposed`, async () => {
          const r = ctx.db.decisionsForItem(item.id).find(d => d.id === row.id);
          return r && r.status !== 'pending' ? r : null;
        }, { timeoutMs: 120_000, intervalMs: 500 });
        if (proposed.status === 'proposed') {
          const res = await ctx.client.post(`/web/factory/projects/${ctx.projectId}/decisions/${row.id}/approve`, {});
          if (res.status !== 200) throw new Error(`approve ${label} failed ${res.status}`);
        }
        const settled = await waitFor(`${label} settled`, async () => {
          const r = ctx.db.decisionsForItem(item.id).find(d => d.id === row.id);
          return r && DONE.has(r.status) ? r : null;
        }, { timeoutMs: 900_000, intervalMs: 3_000 });
        note(label, { id: settled.id, status: settled.status, attempts: settled.attempts, decision: settled.decision });
        return settled;
      };
      const transition = async (stage, extra = {}) => {
        item = await ctx.client.workItem(ctx.projectId, item.id);
        return ctx.client.post(`/web/factory/projects/${ctx.projectId}/work-items/${item.id}/transition`, {
          board: 'review', stage, expectedRevision: item.revision, requestId: randomUUID(), cause: `harness: ${stage}`, ...extra,
        });
      };

      const toReview = await transition('review');
      check('intake → review accepted', toReview.status >= 200 && toReview.status < 300, toReview.status);
      const first = await decide('first-review', d => d.decision?.type === 'invokeSkill' && d.decision?.role === 'review');
      check('first factory-review pass succeeded', first.status === 'succeeded', first.status);
      check('first pass is a full skill kickoff (resume not set)', first.decision?.resume !== true, first.decision);
      const binding = ctx.db.bindings(item.id).find(b => b.role === 'review' && b.status === 'active');
      check('review seat bound', Boolean(binding));
      const since = new Date().toISOString();

      const reenter = await transition('review', { reenter: true });
      check('review → review re-entry accepted', reenter.status >= 200 && reenter.status < 300, reenter.status);
      const second = await decide('reentry-review', d => d.decision?.type === 'invokeSkill' && d.decision?.resume === true);
      check('re-entry decision carries native resume + cancelInFlight', second.decision?.resume === true && second.decision?.cancelInFlight === true, second.decision);
      check('re-entry run succeeded', second.status === 'succeeded', second.status);
      const after = ctx.db.bindings(item.id).filter(b => b.role === 'review' && b.status === 'active');
      check('same review session continued (no new seat)', after.length === 1 && after[0].id === binding?.id, after.map(b => b.id));
      const kickoff = ctx.db.messages(binding.thread_id).filter(m => m.createdAt >= since).find(isKickoff);
      note('reentryKickoff', kickoff?.text.slice(0, 600));
      check('compact continuation (skill referenced, body not re-pasted)', Boolean(kickoff) && kickoff.text.includes('Resume the active factory-review session') && kickoff.text.length < 4000, kickoff?.text.length);
      ctx.reviewItem = item;
    },
  },
  {
    id: 'terminal_transition',
    title: 'terminal transition retires bindings; later requests cannot run',
    gates: ['terminal transition', 'terminal-session retirement'],
    async run(ctx, { check, note }) {
      const item = await ctx.refresh();
      const res = await ctx.client.post(`/web/factory/projects/${ctx.projectId}/work-items/${item.id}/transition`, {
        board: 'work',
        stage: 'done',
        expectedRevision: item.revision,
        requestId: randomUUID(),
        cause: 'harness: terminal transition acceptance',
      });
      note('transition', res);
      check('transition to done accepted', res.status >= 200 && res.status < 300, res);
      const bindings = await waitFor('bindings revoked', async () => {
        const rows = ctx.db.bindings(item.id);
        return rows.every(b => b.status !== 'active') ? rows : null;
      });
      note('bindings', bindings);
      check('every binding revoked', bindings.every(b => b.status === 'revoked' && b.revoked_at));
      const after = await ctx.submit({ role: 'work', skillName: 'testflight-probe', args: 'probe=after-terminal' });
      note('afterTerminal', after.res);
      if (after.res.status === 202) {
        await ctx.approve(after.requestId).catch(() => null);
        const settled = await ctx.settle(after.requestId, 180_000);
        // Upstream (5e4ddac) short-circuits a no-seat role on a terminal card and records
        // the decision as settled without running it. Execution is what matters: prove
        // no kickoff, no answer and no seat. Decision status is evidence only.
        const ran = ctx.db.all("select count(*) as n from mastra_messages where content like ?", '%probe=after-terminal%')[0].n;
        note('postTerminalDecision', { status: settled.status, attempts: settled.attempts, executedMessages: ran });
        check('post-terminal request never executes (no kickoff/answer)', ran === 0, { executedMessages: ran, decisionStatus: settled.status });
      } else {
        check('post-terminal request rejected', after.res.status >= 400, after.res.status);
      }
      check('no binding re-minted for the done item', ctx.db.bindings(item.id).every(b => b.status !== 'active'));
    },
  },
];

export const NOT_APPLICABLE = [
  {
    id: 'blocked_dependency',
    title: 'blocked dependency / newly unblocked dependency',
    reason:
      'Dependency gating is owned by the ModelSpend deterministic queue/reconciler (authoritative GitHub re-fetch), not by the Factory runtime. Factory only receives an automation-run once the orchestrator decides work is runnable. Proven separately by ModelSpend #884/#889 per #134 §13.',
  },
];
