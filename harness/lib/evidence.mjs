// Evidence recorder: one bounded run → one directory with results.json and
// results.log. Holds no state beyond the process lifetime.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SECRET_PATTERN = /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/g;

/** Redact anything credential-shaped before it reaches disk. */
export function redact(value) {
  return JSON.parse(JSON.stringify(value ?? null).replace(SECRET_PATTERN, '<redacted>'));
}

export class EvidenceRun {
  constructor({ out, meta }) {
    this.out = out;
    mkdirSync(out, { recursive: true });
    this.meta = { ...meta, startedAt: new Date().toISOString() };
    this.scenarios = [];
  }

  scenario(id, title, gates) {
    const record = { id, title, gates, status: 'RUNNING', assertions: [], evidence: {}, startedAt: new Date().toISOString() };
    this.scenarios.push(record);
    const check = (name, pass, detail) => {
      record.assertions.push({ name, pass: Boolean(pass), detail: redact(detail) });
      return Boolean(pass);
    };
    const note = (key, value) => {
      record.evidence[key] = redact(value);
    };
    return { record, check, note };
  }

  finish(record, error) {
    record.finishedAt = new Date().toISOString();
    if (error) {
      record.status = 'FAIL';
      record.error = redact(String(error?.stack || error));
    } else {
      record.status = record.assertions.length > 0 && record.assertions.every(a => a.pass) ? 'PASS' : 'FAIL';
    }
    const failed = record.assertions.filter(a => !a.pass).map(a => a.name);
    appendFileSync(
      join(this.out, 'results.log'),
      `${record.finishedAt} ${record.status} ${record.id} — ${record.title}` +
        (failed.length ? ` [failed: ${failed.join(', ')}]` : '') +
        (record.error ? ` [error: ${record.error.split('\n')[0]}]` : '') +
        '\n',
    );
    this.flush();
  }

  flush() {
    const summary = {
      pass: this.scenarios.filter(s => s.status === 'PASS').length,
      fail: this.scenarios.filter(s => s.status === 'FAIL').length,
      total: this.scenarios.length,
    };
    writeFileSync(
      join(this.out, 'results.json'),
      JSON.stringify({ schema: 'factory-acceptance/v1', ...this.meta, finishedAt: new Date().toISOString(), summary, scenarios: this.scenarios }, null, 2) + '\n',
    );
    return summary;
  }
}
