// Thin client over Factory's public HTTP contracts. Never calls /runs/start.
export class FactoryClient {
  constructor(baseUrl) {
    const url = new URL(baseUrl);
    if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
      throw new Error(`harness only targets loopback Factory instances, got ${url.hostname}`);
    }
    this.baseUrl = url.toString().replace(/\/$/, '');
  }

  async request(method, path, body) {
    if (path.includes('/runs/start')) throw new Error('/runs/start is prohibited for acceptance evidence');
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { nonJson: text.slice(0, 200) };
    }
    return { status: response.status, body: json };
  }

  get(path) {
    return this.request('GET', path);
  }

  post(path, body) {
    return this.request('POST', path, body ?? {});
  }

  patch(path, body) {
    return this.request('PATCH', path, body);
  }

  async project(projectId) {
    const res = await this.get(`/web/factory/projects/${projectId}`);
    if (res.status !== 200) throw new Error(`project ${projectId} unavailable: ${res.status}`);
    const project = res.body.project ?? res.body;
    if (/modelspend/i.test(project.name ?? '')) {
      throw new Error('refusing to run acceptance scenarios against a ModelSpend production project');
    }
    return project;
  }

  async workItems(projectId) {
    const res = await this.get(`/web/factory/projects/${projectId}/work-items`);
    if (res.status !== 200) throw new Error(`work-item list failed: ${res.status}`);
    return res.body.workItems ?? [];
  }

  async workItem(projectId, workItemId) {
    return (await this.workItems(projectId)).find(item => item.id === workItemId) ?? null;
  }

  async decisions(projectId, query = '') {
    const all = [];
    let cursor;
    do {
      const qs = new URLSearchParams(query);
      if (cursor) qs.set('cursor', cursor);
      const res = await this.get(`/web/factory/projects/${projectId}/decisions?${qs}`);
      if (res.status !== 200) throw new Error(`decision list failed: ${res.status} ${JSON.stringify(res.body)}`);
      all.push(...(res.body.decisions ?? []));
      cursor = res.body.nextCursor;
    } while (cursor);
    return all;
  }

  automationRun(projectId, workItemId, body) {
    return this.post(`/web/factory/projects/${projectId}/work-items/${workItemId}/automation-runs`, body);
  }
}

export async function waitFor(label, probe, { timeoutMs = 120_000, intervalMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for ${label}`);
}
