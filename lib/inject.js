// 注入到当前页面执行的函数（通过 chrome.scripting.executeScript 序列化传入）。
// 必须自包含：不能引用本文件以外的任何变量。
//
// 把 text 插入到页面当前聚焦的输入框末尾，并把光标放到末尾。
// 支持 <textarea>、文本类 <input>、contenteditable（claude.ai / chatgpt.com 的 ProseMirror、
// gemini.google.com 的 Quill）。返回 { ok: true } 或 { ok: false, reason }。
export async function insertIntoFocused(text) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 找到真正聚焦的元素：穿透 Shadow DOM 和同源 iframe
  function deepActive(doc) {
    let el = doc.activeElement;
    for (;;) {
      if (el && el.shadowRoot && el.shadowRoot.activeElement) {
        el = el.shadowRoot.activeElement;
      } else if (el && (el.tagName === 'IFRAME' || el.tagName === 'FRAME')) {
        let inner = null;
        try { inner = el.contentDocument; } catch (e) { inner = null; }
        if (!inner || !inner.activeElement) break;
        el = inner.activeElement;
      } else {
        break;
      }
    }
    return el;
  }

  const el = deepActive(document);
  if (!el) return { ok: false, reason: 'no-focus' };

  const doc = el.ownerDocument;
  const win = doc.defaultView;

  // ---- textarea / input ----
  const TEXT_TYPES = ['text', 'search', 'url', 'email', 'tel', ''];
  const isField =
    el.tagName === 'TEXTAREA' ||
    (el.tagName === 'INPUT' && TEXT_TYPES.includes((el.getAttribute('type') || '').toLowerCase()));
  if (isField) {
    if (el.readOnly || el.disabled) return { ok: false, reason: 'readonly' };
    el.focus();
    const before = el.value;
    const end = before.length;
    try { el.setSelectionRange(end, end); } catch (e) { /* 某些 input 类型不支持 */ }
    let inserted = false;
    try { inserted = doc.execCommand('insertText', false, text); } catch (e) { inserted = false; }
    if (!inserted || el.value === before) {
      // 兼容 React 等受控组件：用原生 setter 赋值再派发 input 事件
      const proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, before + text);
      el.dispatchEvent(new win.Event('input', { bubbles: true }));
    }
    const len = el.value.length;
    try { el.setSelectionRange(len, len); } catch (e) { /* ignore */ }
    el.scrollTop = el.scrollHeight;
    return { ok: el.value !== before };
  }

  // ---- contenteditable ----
  if (!el.isContentEditable) return { ok: false, reason: 'not-editable' };
  let host = el;
  while (host.parentElement && host.parentElement.isContentEditable) host = host.parentElement;

  const caretToEnd = () => {
    const sel = win.getSelection();
    const range = doc.createRange();
    range.selectNodeContents(host);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  };

  host.focus();
  caretToEnd();
  // 让编辑器（ProseMirror 等）通过 selectionchange 同步到新的光标位置
  await sleep(30);

  const before = host.innerText;
  const isQuill = host.classList.contains('ql-editor');
  let handled = false;

  // ProseMirror（claude.ai / chatgpt.com）等：模拟一次粘贴，最能保留换行
  if (!isQuill) {
    try {
      const dt = new win.DataTransfer();
      dt.setData('text/plain', text);
      const ev = new win.ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      host.dispatchEvent(ev);
      handled = ev.defaultPrevented;
    } catch (e) {
      handled = false;
    }
  }

  // Quill（gemini.google.com）或没有粘贴处理的普通 contenteditable
  if (!handled) {
    caretToEnd();
    try { doc.execCommand('insertText', false, text); } catch (e) { /* ignore */ }
  }

  await sleep(30);
  caretToEnd();
  host.scrollTop = host.scrollHeight;
  return host.innerText !== before ? { ok: true } : { ok: false, reason: 'insert-failed' };
}
