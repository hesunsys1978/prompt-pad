// 数据层：所有数据保存在 chrome.storage.local，不做任何网络请求。
//
// prompts: [{ id, title, content, tags: string[], pinned: boolean, createdAt, updatedAt }]
// varHistory: { 变量名: 上次填写的值 }

export const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function seedPrompts() {
  const now = Date.now();
  const mk = (title, content, tags, offset) => ({
    id: newId(),
    title,
    content,
    tags,
    pinned: false,
    createdAt: now - offset,
    updatedAt: now - offset,
  });
  return [
    mk(
      '看待办',
      '请先查看项目当前的待办事项（TODO、docs/TASKS/ 下的任务文件、未关闭的 issue 等），按优先级列出所有未完成的任务，并说明建议下一步先做哪一项、为什么。先不要改代码。',
      ['示例', '开发'],
      0
    ),
    mk(
      '按 docs/TASKS/<版本>.md 做',
      '请阅读 docs/TASKS/{{版本}}.md，按其中的任务清单逐项实现：\n1. 每完成一项，就在该文件中勾选对应条目；\n2. 全部完成后运行测试 / lint，确保通过；\n3. 用清晰的提交信息提交代码，并总结做了什么、还有什么没做。',
      ['示例', '开发'],
      1
    ),
    mk('继续', '继续', ['示例'], 2),
  ];
}

export async function loadPrompts() {
  const { prompts } = await chrome.storage.local.get('prompts');
  if (Array.isArray(prompts)) return prompts;
  const seeded = seedPrompts();
  await savePrompts(seeded);
  return seeded;
}

export async function savePrompts(prompts) {
  await chrome.storage.local.set({ prompts });
}

export async function addPrompt(fields) {
  const prompts = await loadPrompts();
  const now = Date.now();
  const p = normalizePrompt({ ...fields, id: newId(), createdAt: now, updatedAt: now });
  prompts.push(p);
  await savePrompts(prompts);
  return p;
}

export async function loadVarHistory() {
  const { varHistory } = await chrome.storage.local.get('varHistory');
  return varHistory && typeof varHistory === 'object' ? varHistory : {};
}

export async function saveVarHistory(values) {
  const history = await loadVarHistory();
  await chrome.storage.local.set({ varHistory: { ...history, ...values } });
}

export function titleFromContent(content, max = 24) {
  const line = String(content).trim().split(/\r?\n/).find((l) => l.trim()) || '未命名';
  const t = line.trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

export function parseTags(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[,，、;；\s]+/);
  return [...new Set(list.map((t) => String(t).trim()).filter(Boolean))];
}

export function extractVars(content) {
  const names = [];
  for (const m of String(content).matchAll(VAR_RE)) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

export function fillVars(content, values) {
  return String(content).replace(VAR_RE, (whole, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole
  );
}

// 规范化一条提示词（用于新建与导入）；content 不是字符串则返回 null。
export function normalizePrompt(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.content !== 'string') return null;
  const now = Date.now();
  const content = raw.content;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : titleFromContent(content),
    content,
    tags: parseTags(raw.tags),
    pinned: Boolean(raw.pinned),
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : now,
  };
}

// 合并导入：同 id 覆盖；标题与内容完全相同的跳过；其余追加。
export function mergeImport(existing, data) {
  const items = Array.isArray(data) ? data : data && Array.isArray(data.prompts) ? data.prompts : null;
  if (!items) throw new Error('文件格式不正确：需要提示词数组或 { "prompts": [...] }');
  const result = existing.slice();
  let added = 0, updated = 0, skipped = 0;
  for (const raw of items) {
    const p = normalizePrompt(raw);
    if (!p) { skipped++; continue; }
    const idx = result.findIndex((e) => e.id === p.id);
    if (idx >= 0) {
      result[idx] = p;
      updated++;
    } else if (result.some((e) => e.title === p.title && e.content === p.content)) {
      skipped++;
    } else {
      result.push(p);
      added++;
    }
  }
  return { prompts: result, added, updated, skipped };
}
