// ===========================================================================
// RECORD ELEMENT (P4b) — ghi tương tác UI của user trên tab Google Flow
// (click / input / change: bấm nút gì, lúc nào, đang gõ/chọn gì, file nào)
// → gửi về background qua message 'recUi'. Background ghép timeline UI này với
// network requests (Network Recorder) khi export JSON:
//   "bấm nút X lúc T₀ → request API nào chạy sau đó → prompt đang gõ là gì".
//
// QUY TẮC BẢO MẬT / DUNG LƯỢNG:
//   - CHỈ click/input/change — KHÔNG bắt mousemove/scroll/keydown/keyup.
//   - Bỏ qua event do JS tổng hợp (e.isTrusted === false) — automation (content.js)
//     bấm bằng JS tổng hợp sẽ không lấn timeline của user.
//   - KHÔNG lưu class hashed (sc-xxxx), KHÔNG lưu ảnh/base64, KHÔNG lưu CSS selector.
//   - files: chỉ mảng TÊN file (KHÔNG đọc nội dung / kích thước), bỏ 'C:\fakepath'.
//   - Cắt gọn mọi chuỗi: label 120 ký tự, value/composerText 300 ký tự.
// ===========================================================================
(() => {
  'use strict';

  const MAX_LABEL = 120;
  const MAX_VALUE = 300;
  const MAX_COMPOSER = 300;

  // --- helpers chuỗi ---
  function truncate(s, max) {
    s = String(s == null ? '' : s);
    if (s.length <= max) return s;
    return s.slice(0, max) + '…';
  }
  function collapseWs(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }
  function getAttr(el, name) {
    return el && typeof el.getAttribute === 'function' ? (el.getAttribute(name) || '') : '';
  }

  // Nút bấm THỰC TẾ: click thường rơi đúng vào con bên trong button (vd icon
  // <i class="google-symbols">arrow_forward</i>) — aria-label / innerText "Create"
  // nằm trên button bao ngoài, nên label/icon lấy từ ancestor interactive.
  function interactiveAncestor(target) {
    if (!target || typeof target.closest !== 'function') return target;
    const t = target.tagName ? target.tagName.toLowerCase() : '';
    if (t === 'button' || t === 'a' || t === 'summary' || getAttr(target, 'role') === 'button') return target;
    return target.closest('button, a, summary, [role="button"]') || target;
  }

  // Label hiển thị: innerText (collapse + cắt 120). Nút có icon google-symbols con
  // (arrow_forward / add_2 / grid_view ...) ghi kèm glyph: 'icon:arrow_forward label:Create'.
  function elementLabel(target) {
    const btn = interactiveAncestor(target);
    const icon = btn.querySelector
      ? btn.querySelector('i.google-symbols, span.google-symbols, [class*="google-symbols"]')
      : null;
    let glyph = icon ? collapseWs(icon.textContent || '') : '';
    let text = btn.innerText != null ? String(btn.innerText) : '';
    if (glyph) {
      // bỏ glyph icon ra khỏi innerText — nếu không label thành 'arrow_forward Create'
      text = text.replace(new RegExp(glyph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), ' ');
    }
    text = truncate(collapseWs(text), MAX_LABEL);
    let label = text || getAttr(btn, 'aria-label');
    if (glyph) label = 'icon:' + glyph + (label ? ' label:' + label : '');
    return label;
  }

  // Text đang nhập trong composer gần nhất — để biết "lúc user bấm nút gửi thì
  // prompt đang là gì". div[role=textbox] (contenteditable) dùng innerText,
  // textarea dùng .value — cắt 300 ký tự.
  function readBoxText(box) {
    if (!box) return '';
    const t = box.tagName ? box.tagName.toLowerCase() : '';
    const raw = t === 'textarea'
      ? (box.value || '')
      : (box.innerText != null ? box.innerText : (box.textContent || ''));
    return truncate(collapseWs(raw), MAX_COMPOSER);
  }
  // CHỈ khi el là button: tìm ancestor gần nhất là textbox/composer, lấy prompt.
  function composerTextFor(target) {
    const t = target && target.tagName ? target.tagName.toLowerCase() : '';
    if (t !== 'button') return '';
    let anc = target.parentElement;
    while (anc && anc !== document.documentElement) {
      if (anc.matches && anc.matches('textarea, div[role="textbox"]')) {
        const txt = readBoxText(anc);
        if (txt) return txt;
      }
      const cls = typeof anc.className === 'string' ? anc.className : '';
      const meta = getAttr(anc, 'data-testid') + ' ' + (anc.id || '') + ' ' + cls;
      if (/composer|prompt/i.test(meta)) {
        const box = anc.querySelector('textarea, div[role="textbox"]');
        const txt = readBoxText(box);
        if (txt) return txt;
      }
      anc = anc.parentElement;
    }
    return '';
  }

  // Metadata event — cấu trúc theo THIẾT KẾ: {t, type, el:{tag, role, aria, label,
  // text, placeholder, value, files}}. KHÔNG class/selector/ảnh trong el.
  function buildEvent(type, target) {
    const tag = target && target.tagName ? target.tagName.toLowerCase() : 'document';
    const el = {
      tag,
      role: getAttr(target, 'role'),
      aria: getAttr(target, 'aria-label'),
      label: elementLabel(target),
      text: truncate(collapseWs(target && target.innerText != null ? target.innerText : ''), MAX_LABEL),
    };
    // value: CHỈ input/textarea/select (textarea/input: .value; select: selectedOptions).
    // input[type=file]: .value là đường dẫn giả 'C:\fakepath\...' → bỏ, dùng files.
    if (target && (tag === 'input' || tag === 'textarea' || tag === 'select')) {
      const isFile = tag === 'input' && (target.type || '').toLowerCase() === 'file';
      if (isFile) {
        el.value = '';
        if (target.files && target.files.length) {
          const names = [];
          for (const f of target.files) {
            const n = (f && f.name) || '';
            if (n && !/^c:\\fakepath/i.test(n)) names.push(n); // chỉ tên file thật
          }
          if (names.length) el.files = names;
        }
      } else if (tag === 'select') {
        const opts = target.selectedOptions ? Array.from(target.selectedOptions) : [];
        el.value = truncate(opts.map((o) => collapseWs(o.textContent || '')).join(' | '), MAX_VALUE);
      } else {
        el.value = truncate(target.value != null ? target.value : '', MAX_VALUE);
      }
      if (tag === 'input' || tag === 'textarea') el.placeholder = getAttr(target, 'placeholder');
    }
    if (tag === 'button' || (target && target.closest && target.closest('button'))) {
      // Click thường rơi vào con bên trong button (icon <i>/<span>) — dùng
      // ancestor interactive (đã chuẩn cho label) để tìm composer, không bỏ sót.
      const btn = interactiveAncestor(target);
      const c = composerTextFor(btn);
      if (c) el.composerText = c;
    }
    return { t: Date.now(), type, el };
  }

  window.__reconLogs = window.__reconLogs || [];

  // Gửi fire-and-forget — background tự lọc (recActive / tab / cap).
  function send(meta) {
    window.__reconLogs.push(meta);
    
    // In màu đẹp ra Console để bạn dễ theo dõi realtime
    console.log(
      '%c[Recon] %c' + meta.type + ' %c' + (meta.el.tag || '') + (meta.el.label ? ' "' + meta.el.label + '"' : ''), 
      'background: #8b7cff; color: white; padding: 2px 4px; border-radius: 4px;',
      'color: #34d399; font-weight: bold;',
      'color: #a3a3b3;',
      meta
    );

    try {
      chrome.runtime.sendMessage({ type: 'recUi', e: meta }).catch(() => {});
    } catch (_) {
      // extension đang tải lại / channel đóng — bỏ qua im lặng
    }
  }

  function onEvent(type) {
    return (ev) => {
      if (!ev || ev.isTrusted === false) return; // bỏ qua event do automation tạo
      send(buildEvent(type, ev.target));
    };
  }

  // Delegation trên document, capture + passive — không chặn trang, không
  // can thiệp default behavior của Flow.
  document.addEventListener('click', onEvent('click'), { capture: true, passive: true });
  document.addEventListener('input', onEvent('input'), { capture: true, passive: true });
  document.addEventListener('change', onEvent('change'), { capture: true, passive: true });
})();
