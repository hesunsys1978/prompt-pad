import {
  loadPrompts, savePrompts, newId, parseTags, titleFromContent,
  extractVars, fillVars, loadVarHistory, saveVarHistory, mergeImport,
} from './lib/store.js';
import { insertIntoFocused } from './lib/inject.js';

const $ = (sel) => document.querySelector(sel);

// 以扩展弹窗打开时为 popup 模式；在标签页中打开（选项页 / 导入）时为 tab 模式
const isPopup =
  new URLSearchParams(location.search).get('view') === 'popup' ||
  chrome.extension.getViews({ type: 'popup' }).includes(window);
if (!isPopup) document.body.classList.add('tab');

const ICONS = {
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76V6h6v4.76l2 3.24H7z"/><path d="M8 3h8"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  del: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>',
};

const state = {
  prompts: [],
  query: '',
  tag: null,
  active: 0,
  visible: [],
  editingId: null,
  pendingPrompt: null, // 正在填写变量的提示词
};

// ---------- 工具 ----------

let toastTimer = 0;
function toast(msg, ms = 1800) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function preview(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? flat.slice(0, 60) + '…' : flat;
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v; // 仅用于内置 SVG 常量
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = el('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

function showView(name) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${name}`;
}

async function persist() {
  await savePrompts(state.prompts);
}

// ---------- 列表 ----------

function sorted(list) {
  return list.slice().sort((a, b) =>
    (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt)
  );
}

function allTags() {
  const set = new Set();
  for (const p of state.prompts) for (const t of p.tags || []) set.add(t);
  return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function renderTags() {
  const nav = $('#tags');
  nav.replaceChildren();
  const tags = allTags();
  if (state.tag && !tags.includes(state.tag)) state.tag = null;
  if (!tags.length) return;
  const chip = (label, value) => {
    const b = el('button', { class: 'chip' + (state.tag === value ? ' on' : ''), text: label, type: 'button' });
    b.addEventListener('click', () => {
      state.tag = state.tag === value || value === null ? null : value;
      state.active = 0;
      render();
    });
    return b;
  };
  nav.append(chip('全部', null));
  for (const t of tags) nav.append(chip(t, t));
}

function filtered() {
  const q = state.query.trim().toLowerCase();
  return sorted(state.prompts).filter((p) => {
    if (state.tag && !(p.tags || []).includes(state.tag)) return false;
    if (!q) return true;
    return [p.title, p.content, ...(p.tags || [])].some((s) => String(s).toLowerCase().includes(q));
  });
}

function render() {
  renderTags();
  const list = $('#list');
  state.visible = filtered();
  if (state.active >= state.visible.length) state.active = Math.max(0, state.visible.length - 1);
  list.replaceChildren(...state.visible.map(renderItem));

  const empty = $('#empty');
  empty.hidden = state.visible.length > 0;
  empty.textContent = state.prompts.length ? '没有匹配的提示词' : '还没有提示词，点右上角「＋ 新建」添加';
  $('#count').textContent = `共 ${state.prompts.length} 条`;
}

function renderItem(p, index) {
  const title = el('div', { class: 'item-title' });
  if (p.pinned) title.append(el('span', { class: 'pin', text: '📌' }));
  title.append(p.title);

  const tags = el('div', { class: 'item-tags' }, (p.tags || []).map((t) => el('span', { class: 'tag', text: t })));
  const main = el('div', { class: 'item-main' }, [
    title,
    el('div', { class: 'item-preview', text: preview(p.content) }),
    tags,
  ]);

  const pinBtn = el('button', { class: 'icon-btn' + (p.pinned ? ' pinned' : ''), title: p.pinned ? '取消置顶' : '置顶', type: 'button', html: ICONS.pin });
  const editBtn = el('button', { class: 'icon-btn', title: '编辑', type: 'button', html: ICONS.edit });
  const delBtn = el('button', { class: 'icon-btn danger', title: '删除', type: 'button', html: ICONS.del });

  pinBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    p.pinned = !p.pinned;
    await persist();
    render();
  });
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditor(p);
  });
  // 删除需要二次确认（弹窗里 confirm() 不可靠）
  let confirmTimer = 0;
  delBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!delBtn.classList.contains('confirm')) {
      delBtn.classList.add('confirm');
      delBtn.textContent = '确认删除';
      confirmTimer = setTimeout(() => {
        delBtn.classList.remove('confirm');
        delBtn.innerHTML = ICONS.del;
      }, 3000);
      return;
    }
    clearTimeout(confirmTimer);
    state.prompts = state.prompts.filter((x) => x.id !== p.id);
    await persist();
    render();
    toast('已删除');
  });

  const li = el('li', { class: 'item' + (index === state.active ? ' active' : ''), title: '点击填入当前页面输入框' }, [
    main,
    el('div', { class: 'item-actions' }, [pinBtn, editBtn, delBtn]),
  ]);
  li.addEventListener('click', () => usePrompt(p));
  li.addEventListener('mousemove', () => {
    if (state.active !== index) {
      state.active = index;
      for (const [i, node] of [...$('#list').children].entries()) node.classList.toggle('active', i === index);
    }
  });
  return li;
}

// ---------- 使用提示词 ----------

async function usePrompt(p) {
  const vars = extractVars(p.content);
  if (vars.length) {
    await openVarsForm(p, vars);
    return;
  }
  await deliver(p.content);
}

async function deliver(text) {
  if (isPopup) {
    let result = null;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id !== undefined) {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: insertIntoFocused,
          args: [text],
        });
        result = res && res.result;
      }
    } catch (e) {
      result = null; // chrome:// 等受限页面无法注入
    }
    if (result && result.ok) {
      window.close();
      return;
    }
  }
  const copied = await copyText(text);
  if (!isPopup) toast(copied ? '已复制到剪贴板' : '复制失败');
  else toast(copied ? '当前页面没有聚焦的输入框，已复制到剪贴板' : '复制失败', 2600);
  showView('list');
}

async function openVarsForm(p, vars) {
  state.pendingPrompt = p;
  $('#vars-heading').textContent = `填写变量 · ${p.title}`;
  const history = await loadVarHistory();
  const box = $('#vars-fields');
  box.replaceChildren(
    ...vars.map((name) => {
      const ta = el('textarea', { rows: '1', 'data-var': name, placeholder: name });
      ta.value = history[name] || '';
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          $('#vars-form').requestSubmit();
        }
      });
      const label = el('label', {}, [el('code', { text: `{{${name}}}` }), ta]);
      return label;
    })
  );
  showView('vars');
  const first = box.querySelector('textarea');
  first.focus();
  first.select();
}

$('#vars-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const p = state.pendingPrompt;
  if (!p) return;
  const values = {};
  for (const ta of document.querySelectorAll('#vars-fields textarea')) values[ta.dataset.var] = ta.value;
  await saveVarHistory(values);
  state.pendingPrompt = null;
  await deliver(fillVars(p.content, values));
});

// ---------- 新建 / 编辑 ----------

function openEditor(p = null, preset = {}) {
  state.editingId = p ? p.id : null;
  $('#edit-heading').textContent = p ? '编辑提示词' : '新建提示词';
  $('#f-title').value = p ? p.title : preset.title || '';
  $('#f-content').value = p ? p.content : preset.content || '';
  $('#f-tags').value = p ? (p.tags || []).join(', ') : state.tag || '';
  $('#f-pinned').checked = p ? !!p.pinned : false;
  showView('edit');
  (p ? $('#f-content') : $('#f-title')).focus();
}

$('#edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const content = $('#f-content').value;
  if (!content.trim()) {
    toast('内容不能为空');
    $('#f-content').focus();
    return;
  }
  const fields = {
    title: $('#f-title').value.trim() || titleFromContent(content),
    content,
    tags: parseTags($('#f-tags').value),
    pinned: $('#f-pinned').checked,
    updatedAt: Date.now(),
  };
  if (state.editingId) {
    const p = state.prompts.find((x) => x.id === state.editingId);
    if (p) Object.assign(p, fields);
  } else {
    state.prompts.push({ id: newId(), createdAt: Date.now(), ...fields });
  }
  await persist();
  state.editingId = null;
  showView('list');
  render();
  toast('已保存');
  $('#search').focus();
});

$('#edit-form').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    $('#edit-form').requestSubmit();
  }
});

// ---------- 导入 / 导出 ----------

$('#btn-export').addEventListener('click', () => {
  const data = {
    app: 'prompt-pad',
    version: 1,
    exportedAt: new Date().toISOString(),
    prompts: state.prompts,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const a = el('a', { href: url, download: `prompt-pad-${stamp}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(`已导出 ${state.prompts.length} 条`);
});

$('#btn-import').addEventListener('click', () => {
  if (isPopup) {
    // 弹窗打开系统文件对话框时会失去焦点并关闭，所以在标签页中完成导入
    chrome.tabs.create({ url: chrome.runtime.getURL('popup.html#import') });
    window.close();
    return;
  }
  $('#file').click();
});

$('#file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const r = mergeImport(state.prompts, data);
    state.prompts = r.prompts;
    await persist();
    render();
    toast(`导入完成：新增 ${r.added} 条，更新 ${r.updated} 条，跳过 ${r.skipped} 条`, 3000);
  } catch (err) {
    toast('导入失败：' + (err instanceof SyntaxError ? '不是有效的 JSON' : err.message), 3000);
  }
});

// ---------- 键盘与导航 ----------

$('#search').addEventListener('input', (e) => {
  state.query = e.target.value;
  state.active = 0;
  render();
});

$('#search').addEventListener('keydown', (e) => {
  const n = state.visible.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!n) return;
    state.active = (state.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    render();
    $('#list').children[state.active]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    const p = state.visible[state.active];
    if (p) usePrompt(p);
  }
});

$('#btn-new').addEventListener('click', () => openEditor());

for (const b of document.querySelectorAll('[data-back]')) {
  b.addEventListener('click', () => {
    showView('list');
    $('#search').focus();
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#view-list').hidden) {
    e.preventDefault();
    showView('list');
    $('#search').focus();
  }
});

// 其他页面（如右键保存）修改数据时同步刷新
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.prompts && Array.isArray(changes.prompts.newValue)) {
    state.prompts = changes.prompts.newValue;
    if (!$('#view-list').hidden) render();
  }
});

// ---------- 启动 ----------

(async () => {
  state.prompts = await loadPrompts();
  render();
  $('#search').focus();
  if (!isPopup && location.hash === '#import') {
    toast('点击底部「导入」选择 JSON 文件', 4000);
    $('#btn-import').classList.add('primary');
  }
})();
