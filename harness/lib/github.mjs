// Minimal GitHub access for evidence, via the operator's `gh` CLI.
// Only ever targets the Testflight repository.
import { execFileSync } from 'node:child_process';

export const TESTFLIGHT_REPO = 'TheTekTeam/mastra-factory-testflight';

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }).trim();
}

export function createIssue(title, body) {
  const url = gh(['issue', 'create', '-R', TESTFLIGHT_REPO, '--title', title, '--body', body]);
  return { url, number: Number(url.split('/').pop()) };
}

export function closeIssue(number, comment) {
  gh(['issue', 'close', String(number), '-R', TESTFLIGHT_REPO, '--comment', comment]);
}

/** Pull requests whose head branch matches. */
export function prsForBranch(branch) {
  return JSON.parse(
    gh(['pr', 'list', '-R', TESTFLIGHT_REPO, '--state', 'all', '--head', branch, '--json', 'number,headRefOid,headRefName,state,isDraft,url']),
  );
}

export function prFiles(number) {
  return JSON.parse(gh(['pr', 'view', String(number), '-R', TESTFLIGHT_REPO, '--json', 'files'])).files.map(f => f.path);
}

export function repoId() {
  return gh(['api', `repos/${TESTFLIGHT_REPO}`, '--jq', '.id']);
}
