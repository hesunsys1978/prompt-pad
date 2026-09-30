import { addPrompt, loadPrompts, titleFromContent } from './lib/store.js';

const MENU_ID = 'prompt-pad-save-selection';

chrome.runtime.onInstalled.addListener(async () => {
  // 首次安装时写入 3 条示例（已有数据则不动）
  await loadPrompts();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: '保存选中文字为提示词',
      contexts: ['selection'],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return;

  // info.selectionText 会丢失换行，优先从页面读取原始选区
  let text = info.selectionText || '';
  if (tab && tab.id !== undefined) {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [info.frameId || 0] },
        func: () => String(window.getSelection() || ''),
      });
      if (res && typeof res.result === 'string' && res.result.trim()) text = res.result;
    } catch (e) {
      // 受限页面（如 chrome://）无法注入，使用 selectionText
    }
  }

  text = text.trim();
  if (!text) return;

  await addPrompt({ title: titleFromContent(text), content: text, tags: [], pinned: false });
  flashBadge(tab && tab.id);
});

async function flashBadge(tabId) {
  const opts = tabId !== undefined ? { tabId } : {};
  await chrome.action.setBadgeBackgroundColor({ ...opts, color: '#16a34a' });
  await chrome.action.setBadgeText({ ...opts, text: '✓' });
  setTimeout(() => chrome.action.setBadgeText({ ...opts, text: '' }), 2000);
}
