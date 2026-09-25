export class MemoryStore {
  values = new Map();
  version = 0;
  async get(key) { return structuredClone(this.values.get(key)?.data || null); }
  async getWithMetadata(key) { return structuredClone(this.values.get(key) || null); }
  async setJSON(key, data, condition = {}) {
    const previous = this.values.get(key);
    if (condition.onlyIfNew && previous || condition.onlyIfMatch && previous?.etag !== condition.onlyIfMatch) return { modified: false };
    const etag = String(++this.version);
    this.values.set(key, { data: structuredClone(data), etag });
    return { modified: true, etag };
  }
}
export const toolResponse = (name, args, id = 'call_1') => {
  const call = { id, name, arguments: JSON.stringify(args) };
  return { output: [{ type: 'function_call', call_id: id, name, arguments: call.arguments }], calls: [call], text: '', usage: { input: 20, output: 10 } };
};
export const finalResponse = (text = 'Finished.') => ({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], calls: [], text, usage: { input: 20, output: 10 } });
export const baseContext = () => ({ store: new MemoryStore(), userId: 'owner', env: { OPENAI_API_KEY: 'fixture-key' }, now: 1000000 });
export const startBody = (id = 'task_fixture_000001') => ({ op: 'start', id, prompt: 'Complete the task.', workspace: 'workspace-1' });
