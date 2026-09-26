(() => {
  'use strict';

  // ===========================================================================
  // Ads Story Flow — content.js v2 (P2)
  // Automation driver cho Google Flow (labs.google/fx/tools/flow):
  //   - detectAccount (tier ULTRA / normal)      [giữ từ P0]
  //   - ensureModel (video model qua tune Settings) [giữ từ P0]
  //   - applySettings: ghi toàn bộ Agent Settings (confirm / model ảnh+video /
  //     ratio ảnh=video / số lượng x1) — dùng mode ACTIVE (Agent bật, tune
  //     Settings tồn tại); x1 tránh Flow xuất 2 media/card (mặc định x2)
  //   - setDurationNative: thời lượng 4/6/8/10s qua compact picker (mode
  //     DEACTIVATED — Agent tắt) rồi bật lại Agent
  //   - generate(kind): upload ingredient → typePrompt (CDP) → clickSend (CDP)
  //     → poll media card → emit 'done' {url, sceneIdx, kind} / 'fail'
  // Message contract mới (P2):
  //   nhận 'detect' | 'applySettings' | 'setDurationNative' | 'create' |
  //        'createImage' | 'setModel'
  //   sends 'log' {text} | 'done' {url, sceneIdx, kind, runId, mediaId} |
  //        'fail' {sceneIdx, kind, reason, runId, prompt?} (S2: runId echoed
  //        verbatim next to the original sceneIdx; mediaId = content uuid; reason
  //        'policy_blocked' when the submit is policy-rejected — §3.7 PRD)
  // ===========================================================================

  // WORLD-COLLISION (fix): content.js runs against the shared window — the
  // manifest registers content.js TWICE: document_start + world:"MAIN" (the
  // submit-capture hook, patching the PAGE's fetch/XHR before SPA load) and
  // document_idle (isolated world, automation driver). Chrome lets the isolated
  // world READ THROUGH the main world's globals (own-property reads traverse up
  // to the main world; writes shadow locally). So the MAIN instance must NEVER
  // set the SHARED guard (`__flowContentInjected`) — the isolated driver would
  // see true and exit before registering chrome.runtime.onMessage → the whole
  // automation dies. MAIN uses its OWN marker (`__asfHookMain`) and must come
  // BEFORE the isolated guard so it early-returns first.
  // ---------------------------------------------------------------------------
  if (typeof document !== 'undefined' && document.readyState === 'loading') {
    // MAIN-world hook instance (document_start): install the hook and STOP —
    // touch none of the driver guard, register no chrome.runtime.* listeners.
    if (window.__asfHookMain) return; // per-world idempotent (main-world re-inject)
    window.__asfHookMain = true;
    installAsfReceiptHook();
    return; // S2-MAIN-ONLY: stop before the isolated guard — never set __flowContentInjected
  }
  // Idempotent DRIVER guard (isolated world): when the sidepanel re-injects via
  // chrome.scripting.executeScript (content script missing/not yet in the tab),
  // avoid re-running the whole file and double-registering the
  // chrome.runtime.onMessage listener → bail if already injected. (This write
  // shadows locally in the isolated world — page/MAIN cannot read it, so safe.)
  if (window.__flowContentInjected) return;
  window.__flowContentInjected = true;

  // ---------------------------------------------------------------------------
  // S2 — in-world hook (MAIN world): read the batchexecute response body of the
  // submit YhhmEf (video) / ogiZ0b (image) SENT BY THIS VERY TAB → parse the
  // {jobId, contentUuid} tuple per the batchexecute policy (R3/R7), post to the
  // isolated world via postMessage (pattern blob-capture.js). FAIL-CLOSED: if
  // parsing yields no idlike → post NO capture (no fake capture). Raw body is
  // NEVER persisted — only the id pair is extracted and posted.
  // ---------------------------------------------------------------------------
  function installAsfReceiptHook() {
    try {
      if (window.__asfReceiptHookInstalled) return;
      window.__asfReceiptHookInstalled = true;
      if (!window || typeof window.postMessage !== 'function') return;

      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

      // Submit request body (f.req) always carries the rpc id — status polls
      // (jwpduf/nzlxg) and telemetry (WuwhI) never match → only the submit
      // response is parsed.
      function rpcFromBody(body) {
        let s = '';
        try {
          if (typeof body === 'string') s = body;
          else if (body && typeof body === 'object' && typeof body.toString === 'function') s = body.toString();
        } catch (_) { return null; }
        if (!s || s.length > 1e7) return null;
        if (/\bYhhmEf\b/.test(s)) return 'YhhmEf';
        if (/\bogiZ0b\b/.test(s)) return 'ogiZ0b';
        return null;
      }

      // batchexecute wire: )]}' + \n\n + <plen> + \n + JSON (plen = byte length of
      // the payload). strip XSSI → read the leading digit prefix → slice the
      // EXACT plen bytes (NOT indexOf('[')) → JSON.parse. Fail → fail-closed
      // (no capture).
      function parseBatchExec(text) {
        if (typeof text !== 'string' || !text.length || text.length > 2e7) return { ok: false, reason: 'invalid' };
        let body = text;
        if (body.charCodeAt(0) === 0xFEFF) body = body.slice(1);
        // XSSI: ")]}'" (4 chars incl closing quote) + newlines.
        if (body.indexOf(')]}') === 0) body = body.slice(3);
        if (body[0] === "'" || body[0] === '"') body = body.slice(1);
        body = body.replace(/^[\s\n]*/, '');
        const m = body.match(/^(\d+)/);
        if (!m) return { ok: false, reason: 'no-plen' };
        const plen = Number(m[1]);
        if (!Number.isFinite(plen) || plen <= 0 || plen > body.length) return { ok: false, reason: 'bad-plen' };
        const raw = body.slice(m[0].length);
        const json = (raw[0] === '\n' ? raw.slice(1) : raw).slice(0, plen);
        let data = null;
        try { data = JSON.parse(json); } catch (_) { return { ok: false, reason: 'parse-fail' }; }
        return { ok: true, plen, data };
      }

      // Bounded walker: string elements starting with [ or { are double-parsed
      // (batchexecute encodes nested payloads as JSON strings) — the bound
      // guards against pathological input.
      function walkNode(node, visit, depth) {
        if (depth > 10) return;
        visit(node);
        if (Array.isArray(node)) {
          for (const v of node) walkNode(v, visit, depth + 1);
        } else if (node && typeof node === 'object') {
          for (const k of Object.keys(node)) walkNode(node[k], visit, depth + 1);
        } else if (typeof node === 'string') {
          const s = node.trim();
          if (depth < 7 && (s[0] === '[' || s[0] === '{')) {
            try {
              const inner = JSON.parse(s);
              if (inner !== null && typeof inner === 'object') walkNode(inner, visit, depth + 2);
            } catch (_) { /* string thường — giữ nguyên */ }
          }
        }
      }

      // Submit tuple (literals issue #36 / recon R3+R7):
      //   video YhhmEf: [jobId, [..., contentUuid, runId], projectId] — jobId =
      //     the lowercase uuid at index 0; contentUuid = a lowercase uuid found
      //     WITHIN the remaining part.
      //   image ogiZ0b: [contentUuid, secondUuid, flow-content URL, UPPER, projectId]
      //     — contentUuid = the lowercase uuid at index 0. Uppercase ids
      //     (runId/project) are NEVER treated as content uuids. Missing idlike →
      //     null (fail-closed).
      function extractCapture(rpcId, data) {
        let found = null;
        walkNode(data, (node) => {
          if (found) return;
          if (!Array.isArray(node) || node.length < 2) return;
          if (rpcId === 'YhhmEf') {
            const jobId = (typeof node[0] === 'string' && UUID_RE.test(node[0])) ? node[0] : null;
            if (!jobId) return;
            let contentUuid = null;
            walkNode(node.slice(1), (v) => {
              if (contentUuid) return;
              if (typeof v === 'string' && UUID_RE.test(v)) contentUuid = v;
            }, 1);
            if (contentUuid) found = { rpcId, jobId, contentUuid };
          } else {
            const contentUuid = (typeof node[0] === 'string' && UUID_RE.test(node[0])) ? node[0] : null;
            if (!contentUuid) return;
            found = { rpcId, jobId: null, contentUuid };
          }
        }, 0);
        return found;
      }

      function captureFromResponse(rpcId, text) {
        const parsed = parseBatchExec(text);
        if (!parsed.ok) return { parsedOk: false, capture: null };
        return { parsedOk: true, capture: extractCapture(rpcId, parsed.data) };
      }

      function postReceipt(rpcId, jobId, contentUuid, via) {
        try {
          window.postMessage(
            { source: 'asf-receipt-capture', rpcId, jobId, contentUuid, at: Date.now(), via },
            '*'
          );
        } catch (_) { /* page blocked postMessage — skip */ }
      }

      // (BLOCKER B) A submit response that parsed OK but carried NO idlike is itself a
      // SIGNAL the run resolved without a capture. The policy detector must NOT call a
      // run "policy-rejected" merely because no capture arrived yet — the hook posts a
      // capture only after the page consumes res.text()/loadend, and an error tile can
      // mount BEFORE that (Flow's own load handlers register before the hook's loadend).
      // So a parsed-ok-but-no-idlike response posts this marker; the isolated bridge
      // records runResolved and only THEN may classify policy_blocked. A PARSE FAIL
      // stays silent (the response is unreadable/cross-origin → treat as unresolved, do
      // not post a marker).
      function postReceiptResolved(rpcId, via) {
        try {
          window.postMessage(
            { source: 'asf-receipt-capture', rpcId, jobId: null, contentUuid: null, noIdlike: true, at: Date.now(), via },
            '*'
          );
        } catch (_) { /* page blocked postMessage — skip */ }
      }

      // XHR: patch open/send without overriding the page's handlers (uses
      // addEventListener 'loadend' — never breaks Flow's onreadystatechange/
      // onload). responseText is only READ (never consumed); responseType
      // 'json' reads the parsed response object.
      const XHR = window.XMLHttpRequest;
      if (XHR && XHR.prototype && typeof XHR.prototype.open === 'function' && typeof XHR.prototype.send === 'function') {
        const origOpen = XHR.prototype.open;
        const origSend = XHR.prototype.send;
        XHR.prototype.open = function (method, url) {
          try { this.__asfSubmitRpc = null; } catch (_) {}
          return origOpen.apply(this, arguments);
        };
        XHR.prototype.send = function (body) {
          try {
            const rpcId = rpcFromBody(body);
            if (rpcId) {
              this.__asfSubmitRpc = rpcId;
              this.addEventListener('loadend', () => {
                try {
                  if (!this.__asfSubmitRpc) return;
                  let cap = null;
                  if (this.responseType === 'json' && this.response) {
                    cap = extractCapture(this.__asfSubmitRpc, this.response);
                    if (!cap) postReceiptResolved(this.__asfSubmitRpc, 'xhr');
                  } else {
                    const t = this.responseText;
                    if (typeof t === 'string' && t.length) {
                      const r = captureFromResponse(this.__asfSubmitRpc, t);
                      if (r.capture) { cap = r.capture; }
                      else if (r.parsedOk) postReceiptResolved(this.__asfSubmitRpc, 'xhr');
                    }
                  }
                  if (cap) postReceipt(cap.rpcId, cap.jobId, cap.contentUuid, 'xhr');
                } catch (_) { /* response read disallowed (cross-origin) — skip */ }
              });
            }
          } catch (_) {}
          return origSend.apply(this, arguments);
        };
      }

      // fetch: tee response .text() — the page still receives the intact body,
      // the hook only reads it.
      const F = window.fetch;
      if (typeof F === 'function') {
        window.fetch = function (input, init) {
          let rpcId = null;
          try {
            const body = (init && init.body) || (input && typeof input !== 'string' && input.body) || null;
            rpcId = rpcFromBody(body);
          } catch (_) {}
          if (!rpcId) return F.apply(this, arguments);
          const p = F.apply(this, arguments);
          if (p && typeof p.then === 'function') {
            return p.then((res) => {
              try {
                if (!res || typeof res.text !== 'function') return res;
                const origText = res.text.bind(res);
                let doneTee = false;
                res.text = () => origText().then((t) => {
                  if (!doneTee) {
                    doneTee = true;
                    try {
                      const r = captureFromResponse(rpcId, t);
                      if (r.capture) postReceipt(r.capture.rpcId, r.capture.jobId, r.capture.contentUuid, 'fetch');
                      else if (r.parsedOk) postReceiptResolved(rpcId, 'fetch');
                    } catch (_) {}
                  }
                  return t;
                });
              } catch (_) {}
              return res;
            });
          }
          return p;
        };
      }
    } catch (_) { /* page blocked the override — continue unhooked (fail-closed: no capture) */ }
  }

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  const LOWER_PRIORITY = 'Veo 3.1 - Lite [Lower Priority]';
  const VIDEO_MODEL_NAMES = [
    'Omni 1.1 Flash',
    'Veo 3.1 - Lite',
    'Veo 3.1 - Fast',
    'Veo 3.1 - Quality',
    LOWER_PRIORITY,
  ];
  let pollHealth = null;
  const POLL_INTERVAL_MS = 2500;
  const POLL_MAX_VIDEO_MS = 180000; // 3 phút
  const POLL_MAX_IMAGE_MS = 120000; // ordinary image jobs: 2 minutes
  const POLL_MAX_EXTRACT_MS = 300000; // collage exceeded 120s on 2026-09-24; finite fail-closed ceiling
  // MUST equal BUILD in sidepanel.js (asf-version handshake); see that comment for the <code> sha rule.
  const CONTENT_BUILD = 'b011450+s6-close-writer-v2';
  // G10-QA-B2 (S2): wait for Flow to be idle before sending a new command. The cap is
  // finite -- on expiry we fail closed (never click Send blindly) instead of letting Flow
  // queue 2-3 images at once.
  const FLOW_IDLE_WAIT_MS = 30000;
  const FLOW_IDLE_POLL_MS = 1000;
  const QUEUE_RE = /scheduled|waiting in the queue|queue due/i;

  // Whitespace-insensitive text comparison helper.
  const norm = (s) => (s || '').replace(/\s+/g, '');
  // T43: khóa model CHÍNH XÁC (chống chọn nhầm biến thể). Lowercase + bỏ space/dấu
  // gạch/nháy ngoặc. "Veo 3.1 - Lite" → "veo3.1lite"; "Veo 3.1 - Lite [Lower
  // Priority]" → "veo3.1litelowerpriority"; "Nano Banana 2" → "nanobanana2";
  // "Nano Banana 2 Lite" → "nanobanana2lite". So KHỚP = dùng ===, KHÔNG dùng
  // substring (substring cũ khiến "Lite" ăn nhầm "Lite [Lower Priority]").
  const modelKey = (s) => (s || '')
    .replace(/[^\x00-\x7F]/g, '')          // T43: bỏ emoji/unicode — Flow đặt "🍌 " trước Nano Banana (vd "🍌 Nano Banana Pro")
    .replace(/[\s\u2013\u2014-]+/g, '')
    .replace(/[\[\]()]/g, '')
    .toLowerCase();
  // T43: lấy text label SẠCH — bỏ thẻ icon (<mat-icon>/<span.material-icons>…)
  // để chữ ligature "volume_up"/"arrow_drop_down" KHÔNG lẫn vào modelKey. Menu item
  // Flow thật = <mat-icon>volume_up</mat-icon> Omni 1.1 Flash; trigger = <span
  // model-select-trigger-content>…<mat-icon>arrow_drop_down</mat-icon> → clone bỏ
  // icon rồi đọc text.
  function labelTextOf(el) {
    if (!el) return '';
    const c = el.cloneNode(true);
    if (c.querySelectorAll) c.querySelectorAll('mat-icon, .material-icons, [class*="icon"]').forEach((n) => n.remove());
    return (c.textContent || '').replace(/\s+/g, ' ').trim();
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  

  // Runtime state (nội bộ content script).
  const state = {
    tier: null,          // 'ULTRA' | 'normal' | null
    modelSetRun: 0,      // số run đã setModel — cache 1 lần mỗi run
    runSeq: 0,           // số thứ tự run để reset cache model
    busy: false,
    abortRequested: false, // T-stop: user bấm "Dừng khẩn cấp" → chặn clickSend/poll tiếp
  };

  // ---------------------------------------------------------------------------
  // Logging: forward progress to the side panel (and console).
  // ---------------------------------------------------------------------------
  function log(msg) {
    console.log('[FlowAutoTest]', msg);
    try {
      if (chrome.runtime && chrome.runtime.id) {
        chrome.runtime.sendMessage({ type: 'log', text: msg });
      }
    } catch (_) {
      // Extension context invalidated (e.g. reloaded) — nothing to forward to.
    }
  }

  // ---------------------------------------------------------------------------
  // Fresh DOM lookups (re-queried on every action, never cached).
  // ---------------------------------------------------------------------------
  // UI mới (flow.google.com — ProseMirror/Angular): composer = div[contenteditable="true"]
  // class ProseMirror, KHÔNG có role="textbox" (placeholder .prosemirror-placeholder).
  // Ưu tiên ProseMirror; fallback labs cũ role=textbox; fallback bất kỳ
  // [contenteditable="true"] visible gần placeholder 'What do you want to create?'.
  // KHÔNG bao giờ trả ingredient-bar/chip ref (chúng không contenteditable).
  function findComposer() {
    const prosemirror = document.querySelector('div[contenteditable="true"].ProseMirror');
    if (prosemirror) {
      let r = null;
      try { r = prosemirror.getBoundingClientRect(); } catch (_) { /* bỏ qua */ }
      // 0×0 (settings panel mở → .agent-panel-prompt-box-hidden display:none) =
      // KHÔNG phải composer thật → rơi xuống nhánh labs/fallback.
      if (r && r.width && r.height) return prosemirror;
    }
    const labs = document.querySelector('div[contenteditable="true"][role="textbox"]');
    if (labs) {
      let r = null;
      try { r = labs.getBoundingClientRect(); } catch (_) { /* bỏ qua */ }
      if (r && r.width && r.height) return labs;
    }
    const fallback = [...document.querySelectorAll('[contenteditable="true"]')].find((el) => {
      let r = null;
      try { r = el.getBoundingClientRect(); } catch (_) { /* bỏ qua */ }
      if (!r || !r.width || !r.height) return false; // ẩn — không phải composer thật
      const ph = [...document.querySelectorAll(
        '.prosemirror-placeholder, [class*="placeholder" i], [data-placeholder], [placeholder]'
      )].find((p) => {
        const t = norm(p.textContent) + ' ' + ((p.getAttribute && p.getAttribute('placeholder')) || '');
        if (!/whatdoyouwanttocreate/i.test(t)) return false;
        let pr = null;
        try { pr = p.getBoundingClientRect(); } catch (_) { return false; }
        if (!pr || !pr.width || !pr.height) return false;
        return Math.abs(pr.top - r.top) < 60 && Math.abs(pr.left - r.left) < 300;
      });
      return !!ph;
    });
    return fallback || null;
  }
  // ---------------------------------------------------------------------------
  // Settings panel che composer (flow.google.com, CDP-verified 2026-09-05): khi
  // settings MỞ, chain `flow-agent-panel > flow-creative-agent-prompt-box >
  // flow-base-prompt-box > div.base-prompt-box` có cha
  // `div.agent-panel-prompt-box.agent-panel-prompt-box-hidden` với display:none →
  // composer (div.ProseMirror) + nút 'Add ingredients to the prompt box' + Agent
  // toggle + 'Start generation' TẤT CẢ getBoundingClientRect() = 0×0 → findComposer
  // (sau fix visible) trả null + findAddDialogTrigger log 'không tìm thấy nút add
  // dialog' → kịch bản user vừa mở settings bị HỦY. Helper này đóng settings bằng
  // nút 'Back' (aria-label CHÍNH XÁC 'Back' trong flow-agent-panel — KHÔNG dùng
  // includes vì header có nút khác 'Back button to go to previous page' @20,18;
  // nút agent panel @~937,83 34×34 text 'arrow_back') rồi chờ composer thật
  // visible. Trả true = sẵn sàng, false = không đóng được (log cảnh báo).
  // ---------------------------------------------------------------------------
  async function ensurePromptBoxVisible() {
    const box = () => document.querySelector('.agent-panel-prompt-box');
    const pm = () => document.querySelector('div[contenteditable="true"].ProseMirror');
    const boxHidden = () => {
      const b = box();
      if (!b) return false; // không có panel → coi như sẵn sàng
      const cls = b.className || '';
      if (cls.includes('hidden')) return true;
      try { return getComputedStyle(b).display === 'none'; } catch (_) { return false; }
    };
    const pmVisible = () => {
      const p = pm();
      if (!p) return false;
      let r = null;
      try { r = p.getBoundingClientRect(); } catch (_) { return false; }
      return !!(r && r.width && r.height);
    };
    if (!boxHidden()) return true; // đã sẵn sàng — không click gì
    const backBtn = [...document.querySelectorAll('flow-agent-panel button')].find(
      (b) => ((b.getAttribute && b.getAttribute('aria-label')) || '') === 'Back'
    );
    if (!backBtn) {
      log('⚠ Settings panel đang mở nhưng không tìm thấy nút "Back" (aria-label chính xác) — composer ẩn; thử lại.');
      return false;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      let r = null;
      try { r = backBtn.getBoundingClientRect(); } catch (_) { /* bỏ qua */ }
      if (r && r.width && r.height) {
        const x = Math.round(r.left + r.width / 2);
        const y = Math.round(r.top + r.height / 2);
        await clickCdpxy(x, y, backBtn); // CDP trusted click (Input.dispatchMouseEvent) — element.click() trần KHÔNG ăn Angular
        // (P2c) mang marker backBtn: rect đo LẠI mỗi attempt nhưng element đích thì không đổi —
        // background chặn dispatch nếu elementFromPoint lệch (panel Flow dịch vị giữa đo và bấm).
      }
      if (await waitFor(pmVisible, 5000)) return true;
    }
    log('⚠ Settings panel không đóng được — composer ẩn; thử lại');
    return false;
  }
  function findSendButton() {
    return [...document.querySelectorAll('button')].find((b) => {
      const t = norm(b.textContent);
      const l = norm(b.getAttribute('aria-label') || '');
      // Flow mới giấu label trong aria-label. Kiểm tra cả t và l.
      const matchStart = l.includes('Start') || l.includes('Create') || t.includes('Start') || t.includes('Create');
      const hasArrow = t.includes('arrow_forward') || l.includes('arrow_forward');
      if (hasArrow && matchStart) {
        if (l.includes('cancel') || t.includes('cancel')) return false;
        return true;
      }
      return t.endsWith('Start generation') || t.endsWith('Startgeneration') || l.endsWith('Start generation') || l.endsWith('Startgeneration');
    });
  }
  // Lưu ý: text trên page thật là 'tuneSettings' (không space) — norm() phủ cả 2.
  // UI mới (flow.google.com — Angular Material): gear = mat-icon icon:tune + label
  // 'Settings' (label có thể nằm ở aria-label/title thay vì textContent) → selector
  // quét mở rộng button, mat-icon, [role=button]; GIỮ điều kiện tune+Settings.
  function findTuneSettingsButton() {
    return [...document.querySelectorAll('button, mat-icon, [role="button"]')].find((b) => {
      const t = norm(b.textContent);
      if (t.includes('tune') && t.endsWith('Settings')) return true;
      // mat-icon 'tune' đứng độc lập: gộp thêm aria-label/title vào text để khớp.
      const t2 = norm((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.title || ''));
      return t2.includes('tune') && t2.endsWith('Settings');
    });
  }
  // REGRESSION-FIX (đảo ngược FIX-1 của reviewer-37, Đợt B T40 items 10/11):
  // chọn input[type=file] ĐÚNG target. Recon (docs/recon/flow-dom-create.json:
  // element input[type="file"] NGAY SAU nút 'arrow_forward Create' cạnh composer;
  // docs/recon/flow-generate-loop.json: 'File input chuẩn, KHÔNG shadow DOM...
  // DataTransfer trong content script hoạt động bình thường') chứng minh Flow
  // render file-input CHUẨN bị ẨN (display:none/opacity — trigger qua nút attach
  // 'add_2 Create') → getClientRects() trả rỗng/0 cho input HỢP LỆ. FIX-1 lọc
  // visible đó → findUploadInput trả null → MỌI upload ảnh fail live.
  // Luật mới: (a) KHÔNG lọc visible/geometry — input ẩn là CHUẨN, không được loại;
  // chỉ loại input disabled. (b) nếu chỉ 1 input[type=file] → trả luôn. (c) nếu
  // nhiều input (dialog 'Add Media'/popover đóng vẫn mount input ẩn khác) → chọn
  // cái GẦN composer nhất bằng getBoundingClientRect, KHÔNG lọc input theo rect.
  // (d) không có input nào → null (uploadImage log 'Không tìm thấy...' giữ).
  function findUploadInput() {
    // Bỏ input do CHÍNH automation tạo ra trước đó (uploadImageViaDialog đánh
    // dấu data-flow-auto-upload) — đó là input ẨN của dialog đã đóng (flow UI
    // ghép input vào body và GIỮ LẠI sau khi dialog đóng), set file vào đó là
    // dead-end → phải mở dialog mới. Labs KHÔNG đánh dấu → không đổi hành vi.
    const candidates = [...document.querySelectorAll('input[type="file"]')].filter(
      (i) => !i.disabled && !i.dataset.flowAutoUpload
    );
    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0];
    const composer = findComposer();
    if (composer) {
      const cr = composer.getBoundingClientRect();
      let best = null;
      let bestD = Infinity;
      for (const i of candidates) {
        const ir = i.getBoundingClientRect();
        const d = Math.abs(ir.left - cr.left) + Math.abs(ir.top - cr.top);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best) return best;
    }
    return candidates[0];
  }
  
  // Nút 'Agent' (toggle active/deactivated) — aria-pressed=true/false.
  function findAgentToggle() {
    return [...document.querySelectorAll('button')].find(
      (b) => norm(b.textContent) === 'Agent' &&
        (b.hasAttribute('aria-pressed') || b.hasAttribute('aria-checked'))
    );
  }
  // Compact picker khi Agent TẮT: 'Video · 720p · 8s · crop_16_9 · x2' hoặc 'Veo 3.1 - Lite · x1'.
  function findCompactPickerButton() {
    // Ưu tiên selector chính xác (flow.google.com dùng aria-label). Vẫn phải VISIBLE:
    // trigger còn trong DOM nhưng ẩn (composer chưa render) không phải composer sẵn sàng.
    const byAria = document.querySelector('button[aria-label="Settings trigger"]');
    if (byAria && byAria.offsetWidth > 0 && byAria.offsetHeight > 0) return byAria;
    // Fallback: nút picker luôn chứa phần tử chọn số lượng (x1, x2, x3, x4). KHÔNG được
    // chấp nhận candidate là control con (role=radio — vd 'x1' quantity trong pane, luôn
    // visible mặc dù pane đóng) hay phần tử ẩn: bắt mù nút radio ⇒ waitComposer tưởng
    // composer sẵn sàng khi thật sự chưa. Chỉ button PLAIN + visible + đang kết nối.
    return [...document.querySelectorAll('button')].find((b) => {
      if (!(b.offsetWidth > 0 && b.offsetHeight > 0)) return false;
      if (typeof b.isConnected === 'boolean' && !b.isConnected) return false;
      const role = b.getAttribute && b.getAttribute('role');
      if (role && role !== 'button') return false; // radio/menuitem/tab = control con, không phải trigger
      const t = norm(b.textContent);
      return (t.includes('x1') || t.includes('x2') || t.includes('x3') || t.includes('x4')) && /crop_|Audio|Video|Nano|Veo|Omni/.test(t);
    });
  }
  
  // Model trigger dropdown trong overlay — LABEL-FIRST (user yêu cầu; probe Windows
  // 152: Flow đặt aria-label CHÍNH XÁC 'Select model family' trên button model
  // drop-down). Fallback giữ selector cũ (aria-haspopup=menu — UI đời cũ).
  // Dùng chung cho detectAccount + applyConfigViaPicker.
  function findModelTriggerInOverlay(oc) {
    const byAria = oc.querySelector('button[aria-label*="Select model family" i]');
    if (byAria) return byAria;
    return oc.querySelector('button[aria-haspopup="menu"]');
  }
  // Selector chuẩn menu item model (compact picker / tune Settings) — dùng chung.
  const MENU_ITEMS_SEL = 'flow-menu-item button, [role="menuitem"]';

  // Text đặc trưng của control Compact Picker: ratio icon 'crop_9_16' (ligature, KHÔNG phải
  // '9:16') hoặc quantity x1..x4.
  function looksLikePickerControlText(t) {
    return t.includes('x1') || t.includes('x2') || t.includes('x3') || t.includes('x4') ||
      /crop_\d+_\d+/.test(t) || /\d+\s*[:x]\s*\d+/.test(t);
  }
  // P1.1: pane overlay ĐANG MỞ THẬT của Compact Picker — CHỈ pane visible + CHỨA control
  // ratio/quantity. Trước đây isPickerOpen() quét MỌI element trong .cdk-overlay-container,
  // KHÔNG check visibility/đúng pane → overlay ẩn hoặc dialog lạ còn text '9:16' vẫn làm
  // isPickerOpen()===true → clickRealVerified pass GIẢ → không retry → ratio/qty/kind bấm
  // vào pane sai hoặc đã đóng. Dùng chung cho isPickerOpen + scope của findInPopover.
  // B3: Angular CDK render popover trong `.cdk-overlay-popover` (không phải `.cdk-overlay-pane`)
  // — query cả HAI class ở mọi chỗ của cụm picker này; chỉ thiếu 1 class là findPickerPane
  // trả null → P1.4 chặn MỌI lần tạo + detectAccount chết.
  const PICKER_PANE_SEL = '.cdk-overlay-pane, .cdk-overlay-popover';
  // U1: `.cdk-overlay-popover` là khung POSITIONING của CDK (kèm class
  // .cdk-overlay-connected-position-bounding-box, full-viewport 1632x933) — nó KHÔNG bao giờ
  // là pane nội dung; pane thật là `.cdk-overlay-pane` (#cdk-overlay-N, 296x327) chứa
  // FLOW-PROMPT-BOX-SETTINGS. Vẫn query cả 2 class (B3) nhưng LOẠI khung bounding-box và ƯU
  // TIÊN pane SÂU NHẤT — nếu không, findPickerPane trả wrapper full-viewport (nó cũng
  // khớp heuristic ratio vì text nằm trong subtree) ⇒ scope findInPicker phình ra toàn overlay.
  const CDK_POSITIONING_BOX_CLASS = 'cdk-overlay-connected-position-bounding-box';
  function findPickerPane() {
    const trigger = findCompactPickerButton();
    // Trigger báo ĐÓNG tường minh (aria-expanded='false') → không pane nào là picker.
    // (Flow KHÔNG set aria-expanded trên 'Settings trigger' — getAttribute trả null ở mọi
    // thời điểm ⇒ null vẫn phải đi tiếp kiểm pane, chỉ 'false' mới là đóng.)
    if (trigger && trigger.getAttribute && trigger.getAttribute('aria-expanded') === 'false') return null;
    const panes = [...document.querySelectorAll(PICKER_PANE_SEL)].filter((p) => {
      if (p.classList && p.classList.contains && p.classList.contains(CDK_POSITIONING_BOX_CLASS)) return false;
      if (trigger && trigger.contains && trigger.contains(p)) return false; // subtree của trigger
      const r = p.getBoundingClientRect ? p.getBoundingClientRect() : { width: 0, height: 0 };
      if (!(p.offsetWidth > 0 && p.offsetHeight > 0) || r.width < 1 || r.height < 1) return false;
      const els = [...p.querySelectorAll('button, span, [role="radio"], [role="menuitem"]')];
      return els.some((e) => {
        if (!(e.offsetWidth > 0 && e.offsetHeight > 0)) return false;
        return looksLikePickerControlText(norm(e.textContent) + ' ' + norm(e.getAttribute('aria-label') || ''));
      });
    });
    if (!panes.length) return null;
    // U1: pane SÂU NHẤT = ứng viên không chứa ứng viên nào khác (wrapper chứa pane thật).
    const deepest = panes.filter((p) => !panes.some((o) => o !== p && p.contains && p.contains(o)));
    const cands = deepest.length ? deepest : panes;
    // U2 (dữ liệu live): khi model menu mở, container có 2 pane NỘI DUNG là ANH EM — pane
    // settings 296x327 (chứa flow-prompt-box-settings) và pane model menu 280x216 — cả hai
    // đều qua heuristic text nên "sâu nhất" KHÔNG tách được. DOM order hôm nay đúng chỉ vì
    // pane settings chèn trước ⇒ chốt theo dấu hiệu NỘI DUNG, không dựa vào thứ tự chèn.
    const withSettings = cands.find((p) => p.querySelector && p.querySelector('flow-prompt-box-settings'));
    return withSettings || cands[0];
  }
  // Compact Picker đang mở? — CHỈ đúng khi có pane visible của picker (xem findPickerPane).
  // Cấp module (dùng chung detectAccount + applyConfigViaPicker).
  function isPickerOpen() { return !!findPickerPane(); }

  // G9/S2 (#24): đóng dropdown + Compact Picker an toàn — 2× Escape + verify + backdrop
  // fallback. Vốn là hàm LOCAL trong detectAccount (hành vi giữ nguyên 100%, chỉ promote
  // lên cấp module) để MỌI đường mở picker (detectAccount / readFlowSettingsFromPicker)
  // đóng bằng ĐÚNG một chuỗi — không nhân bản bản second-copy.
  async function closeChain() {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    await wait(300);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    await wait(300);
    if (isPickerOpen()) {
      const backdrop = document.querySelector('.cdk-overlay-backdrop');
      if (backdrop) backdrop.click();
      else {
        const p = findCompactPickerButton();
        if (p) await clickReal(p);
      }
      await wait(300);
    }
  }

  // P1.2: tìm element theo text/aria-label trong popover. scopeEl (tuỳ chọn) = pane THẬT của
  // picker đang mở → query CHỈ trong scope đó, KHÔNG fallback document (tránh nhắm element
  // của trang /edit hay overlay khác). Không truyền scopeEl = hành vi cũ: query
  // .cdk-overlay-container, và khi phải query thẳng document thì loại subtree của trigger.
  function findInPopover(textMatchers, role = null, scopeEl = null) {
    const container = scopeEl || document.querySelector('.cdk-overlay-container') || document;
    const trig = (!scopeEl && container === document) ? findCompactPickerButton() : null;
    const els = [...container.querySelectorAll(role ? `[role="${role}"]` : 'button, span, mat-icon')];
    return els.find((e) => {
      if (trig && trig.contains && trig.contains(e)) return false;
      const t = norm(e.textContent);
      const l = norm(e.getAttribute('aria-label') || '');
      return textMatchers.some((m) => t.includes(norm(m)) || l.includes(norm(m)));
    }) || null;
  }

  // P1.3: chọn tab kind (Image/Video) trong Compact Picker — FAIL-CLOSED. Predicate "đã chọn"
  // = isKindControlOn (aria-checked/.mat-button-toggle-checked; chỉ đường kind mới leo tổ tiên,
  // có giới hạn hop — xem B2/N1) → ĐÃ đúng kind thì KHÔNG click lại (click mù có thể lật sang
  // kind kia). Chưa đúng thì click bằng ĐÚNG đường đã verify cho control này ở detectAccount:
  // clickRealVerified (CDP measure-then-click + verify-after-click bằng chính predicate +
  // retry) — .click() trần KHÔNG ăn Angular và không verify được stale-coordinate.
  async function selectKindControl(finder, label) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let btn = null;
      try { btn = finder(); } catch (_) { btn = null; }
      if (!btn) {
        log(`Type "${label}": không tìm thấy control (lần ${attempt}/3).`);
        await wait(400);
        continue;
      }
      let cur = false;
      try { cur = isKindControlOn(btn); } catch (_) { cur = false; }
      if (cur) return true;
      const res = await clickRealVerified(
        finder,
        () => { let b = null; try { b = finder(); } catch (_) { b = null; } return !!b && isKindControlOn(b); },
        { maxRetry: 2 }
      );
      if (res.ok) return true;
      log(`⚠ Type "${label}" chưa xác nhận được (lần ${attempt}/3).`);
    }
    return false;
  }

  
  // Đọc state CHỌN thật trên CHÍNH element (không leo tổ tiên).
  function stateOnEl(el) {
    if (!el || !el.getAttribute) return false;
    const s = (el.getAttribute('data-state') || el.getAttribute('aria-selected') || el.getAttribute('aria-pressed') || el.getAttribute('aria-checked') || '').toLowerCase();
    const has = (c) => !!(el.classList && el.classList.contains && el.classList.contains(c));
    return s === 'active' || s === 'true' || s === 'checked' || has('on') ||
      has('active') || has('selected') || has('mat-button-toggle-checked');
  }
  // N1: leo tổ tiên CHỈ dùng cho đường KIND. Nếu áp cho ratio/qty/dur thì span ratio nằm trong
  // tab/segment đang chọn (aria-selected=true) sẽ bị coi là "đã ON" ⇒ KHÔNG click ⇒ chạy SAI
  // tỷ lệ mà vẫn trả ok:true (lớp bug FIX-WIN cũ). Vì vậy isControlOn giữ STRICT như trước B2.
  const CONTROL_STATE_MAX_HOPS = 4; // ponytail: số hop hữu hạn, đủ cho cấu trúc CDK hiện tại (span > button > div[role=tab]); sâu hơn thì tăng hằng số
  const CONTROL_STATE_HOST_SEL = '[role="tab"], [role="radio"], [role="menuitem"], [role="button"], mat-button-toggle, button';
  function controlCarriesState(el) {
    if (!el || !el.getAttribute) return false;
    try {
      for (const a of ['data-state', 'aria-selected', 'aria-pressed', 'aria-checked']) {
        const v = el.getAttribute(a);
        if (v !== null && v !== undefined && v !== '') return true;
      }
    } catch (_) { return false; }
    const has = (c) => !!(el.classList && el.classList.contains && el.classList.contains(c));
    return has('on') || has('active') || has('selected') || has('mat-button-toggle-checked');
  }
  // C2: leo tối đa CONTROL_STATE_MAX_HOPS tổ tiên (dừng ở document.body/null) để tìm element
  // MANG state gần nhất. Không tìm thấy ⇒ trả el (giữ semantics cũ, không false-positive).
  function controlStateHost(el) {
    if (!el) return el;
    try {
      if (controlCarriesState(el)) return el;
      let cur = el;
      for (let i = 0; i < CONTROL_STATE_MAX_HOPS; i += 1) {
        const parent = (cur.closest && cur.closest(CONTROL_STATE_HOST_SEL)) || null;
        if (!parent || parent === cur || parent === document.body) break;
        if (controlCarriesState(parent)) return parent;
        cur = parent;
      }
    } catch (_) { /* bỏ qua */ }
    return el;
  }
  // Kiểm tra control như segmented đang ở trạng thái "đã chọn" — STRICT trên chính el.
  // FIX-WIN (luồng 2): Compact Picker dùng mat-button-toggle — state thật nằm ở
  // aria-checked (probe Windows Chrome 152: radio ratio/qty chỉ có aria-checked,
  // KHÔNG có data-state/aria-selected/aria-pressed) + class .mat-button-toggle-checked.
  // Dùng cho ratio / duration / qty / model / mọi caller cũ — KHÔNG leo tổ tiên (xem N1).
  function isControlOn(el) { return stateOnEl(el); }
  // Kind (Image/Video) trong Compact Picker: state có thể nằm ở tổ tiên (finder text thường trả
  // span con của div[role=tab]) — chỉ đường này mới leo, có giới hạn hop.
  function isKindControlOn(el) { return stateOnEl(controlStateHost(el)); }

  // ---------------------------------------------------------------------------
  // Media result selectors (P2 — phân biệt theo kind) + gating IDENTITY (M9).
  //   VIDEO xong  = thẻ <video> có src chứa media.getMediaUrlRedirect.
  //   ẢNH xong    = thẻ <img alt="Generated image"> có src chứa redirect
  //                 (thumbnail upload/ingredient có alt khác → không ăn nhầm).
  //   M9: không còn tin thứ tự DOM — Flow có thể PREPEND card mới hoặc chèn card
  //   của job khác giữa baseline và tick → DONE gating bằng ID:
  //   media id = uuid trong query 'name=' của URL redirect; element mới của job
  //   này = id KHÔNG nằm trong baselineIds (chụp ngay trước clickSend).
  // ---------------------------------------------------------------------------
  // src media THẬT trên UI: pattern CŨ (labs.google .../media.getMediaUrlRedirect?name=uuid)
  // + pattern MỚI (flow.google.com đã migrate — img src giờ là lh3.googleusercontent.com
  // /asb/..., KHÔNG còn media.getMediaUrlRedirect / không có uuid trong URL; media kết
  // quả sinh ra = flow-content.google/image|<video>/<uuid>?Expires=...).
  // isMediaSrc phủ cả 3 để mọi detection (baseline/uploadOneRef/dialog/chip) chạy được
  // trên UI mới.
  function isMediaSrc(s) {
    return /[?&]name=[0-9a-fA-F-]{36}/.test(s) || /\/asb\//.test(s) || /media\.getMediaUrlRedirect/.test(s) ||
      // UI mới: media kết quả + upload = flow-content.google/image/<uuid> | video/<uuid>
      /flow-content\.google\/(?:image|video)\/[0-9a-fA-F-]{36}/.test(s);
  }
  function mediaIdOf(url) {
    const s = String(url || '');
    const m = s.match(/[?&]name=([0-9a-fA-F-]{8,})/);
    if (m && m[1]) return m[1].toLowerCase();
    // UI mới (flow-content.google/image|video/<uuid>): lấy uuid sau image/video làm
    // id định danh. asb (lh3/flow.google.com) = media không uuid → '' (identity bằng src).
    const fc = s.match(/flow-content\.google\/(?:image|video)\/([0-9a-fA-F-]{36})/);
    if (fc && fc[1]) return fc[1].toLowerCase();
    if (/\/asb\//.test(s)) return '';
    const seg = s.split('/').pop().split('?')[0];
    if (seg && seg !== 'getMediaUrlRedirect') return seg;
    return s || null; // không bắt được uuid → nguyên URL vẫn phân biệt cũ/mới
  }
  // T42: identity asb/ = token TRƯỚC suffix stream '=mm,22,15'. Video tile lật giữa
  // <video src="asb/<token>=mm,.."> (stream) và <img src="asb/<token>"> (poster) —
  // cùng token → mediaToken() để so khớp cả 2 dạng (rename srcHint + poster fetch).
  function mediaToken(u) {
    return String(u || '').split('=')[0].trim();
  }
  // Video "chơi được" = đã có metadata/duration hoặc đang phát (không phải card trống).
  function isPlayableVideo(v) {
    if (v.error) return false;
    if (v.readyState >= 1) return true;
    if (Number.isFinite(v.duration) && v.duration > 0) return true;
    return !v.paused;
  }
  // UI mới (flow.google.com): video DONE hiện dưới dạng img.video-thumbnail (src
  // flow-content.google/image/<uuid>) — KHÔNG phải <video> element. Hai helper dưới
  // nhận diện "video kết quả ở dạng img" dùng chung countMedia/findNewMedia/
  // currentMediaIds: (a) img có class chứa 'video-thumbnail'; (b) img src
  // flow-content.google/video/ (poster/thumb của video).
  function isVideoThumbEl(i) {
    if (!i || i.tagName !== 'IMG') return false;
    if (/video-thumbnail/i.test(i.className || '')) return true;
    // UI mới THẬT (flow.google.com): video DONE hiện là <img class="thumbnail"
    // alt="Generated video thumbnail" src flow-content.google/image/<uuid> — KHÔNG
    // có class 'video-thumbnail', KHÔNG có src .../video/. Phân biệt với ảnh kết quả
    // (alt "Generated image" / "Tile displaying a user's image") bằng chữ "video" trong alt.
    return /video/i.test(i.alt || '');
  }
  function isVideoFlowSrc(s) {
    return /flow-content\.google\/video\//.test(s);
  }
  // Tập media id HIỆN TẠI (cùng bộ lọc kind như findNewMedia) — dùng cho baseline.
  function currentMediaIds(kind) {
    const ids = new Set();
    if (kind === 'vid') {
      for (const v of document.querySelectorAll('video')) {
        const s = v.currentSrc || v.src || '';
        if (isMediaSrc(s)) {
          const id = mediaIdOf(s);
          if (id) ids.add(id);
        }
        for (const src of v.querySelectorAll('source')) {
          if (isMediaSrc(src.src)) {
            const id = mediaIdOf(src.src);
            if (id) ids.add(id);
          }
        }
      }
      // UI mới: video done = img.video-thumbnail / img src flow-content video —
      // KHÔNG phải <video> element → thêm id của chúng vào baseline.
      for (const i of document.querySelectorAll('img')) {
        const s = i.currentSrc || i.src || '';
        if (!isMediaSrc(s)) continue;
        if (!isVideoThumbEl(i) && !isVideoFlowSrc(s)) continue;
        const id = mediaIdOf(s);
        if (id) ids.add(id);
      }
      return ids;
    }
    for (const i of document.querySelectorAll('img')) {
      const s = i.currentSrc || i.src || '';
      if (!isMediaSrc(s)) continue;
      // UI mới (flow-content/image/<uuid>): ảnh kết quả KHÔNG cần alt 'Generated
      // image' (đó là quy ước labs) — bản thân flow-content src là media thật.
      // Loại img.video-thumbnail / img src flow-content video (video done/poster,
      // không phải ảnh kết quả).
      if (/flow-content\.google\/(?:image|video)\//.test(s)) {
        if (!isVideoThumbEl(i) && !isVideoFlowSrc(s)) {
          const id = mediaIdOf(s);
          if (id) ids.add(id);
        }
        continue;
      }
      if (/generated\s*image/i.test(i.alt || '')) {
        const id = mediaIdOf(s);
        if (id) ids.add(id);
      }
    }
    return ids;
  }
  // Tập src media HIỆN TẠI (mọi img/video/<source> đang trên DOM, KHÔNG lọc) —
  // baseline identity cho UI MỚI (lh3/asb không uuid → mediaIdOf trả '' nên id
  // không phân biệt được media mới; phân biệt bằng src, giống baselineSrcSet
  // của uploadOneRef). So khớp chính xác chuỗi src → lọc thêm isMediaSrc không
  // cần thiết (diff chỉ xét src của element dạng media).
  function currentMediaSrcs(kind) {
    const srcs = new Set();
    if (kind === 'vid') {
      for (const v of document.querySelectorAll('video')) {
        const s0 = v.currentSrc || v.src || '';
        if (s0) srcs.add(s0);
        for (const src of v.querySelectorAll('source')) if (src.src) srcs.add(src.src);
      }
      // UI mới: video done = img.video-thumbnail / img src flow-content video —
      // thêm src của chúng làm baseline identity (UI mới không uuid → nhận diện
      // media mới bằng src).
      for (const i of document.querySelectorAll('img')) {
        const s = i.currentSrc || i.src || '';
        if (s && (isVideoThumbEl(i) || isVideoFlowSrc(s))) srcs.add(s);
      }
      return srcs;
    }
    for (const i of document.querySelectorAll('img')) {
      const s = i.currentSrc || i.src || '';
      if (s) srcs.add(s);
    }
    return srcs;
  }
  // FIX C: video preload=none — readyState 0 / duration NaN / paused:true khiến
  // isPlayableVideo chưa bao giờ đúng dù url là media kết quả THẬT. Ghi lại lần
  // đầu thấy id mới (không nằm trong baseline); sau 15s chấp nhận nguyên URL
  // thật từ chính element đó (KHÔNG bịa url). Log '✓ media xuất hiện (preload
  // none).' đúng 1 lần để khỏi spam mỗi tick poll.
  const pendingMediaIds = new Map(); // media id -> firstSeen (ms)
  let preloadNoneLogged = false;
  // FIX D: timestamp tạo media trong tên file thật, vd
  // 'Girl_in_pink_dress_spinning_202609032256.mp4' → '202609032256'
  // (chuỗi bắt đầu bằng 20 + ≥10 chữ số — đủ cho YYYYMMDDHHMM 12 chữ số của
  // tên thật; cũng ăn luôn YYYYMMDDHHMMSS 14 chữ số nếu có). Không có → null.
  function mediaTimestampOf(url) {
    const m = String(url || '').match(/(20\d{10,})/);
    return m && m[1] ? m[1] : null;
  }

  // Media MỚI của job này = id không nằm trong baselineIds → {url}; không có → null.
  // UI mới (lh3/asb, mediaIdOf trả ''): id không phân biệt được media → identity
  // qua src: src KHÔNG nằm trong baselineSrcs (param thứ 3 — mặc định rỗng nên
  // call site cũ chỉ truyền baselineIds vẫn chạy) = media mới {url: s, id: ''}.
  function collectMediaFrom(containerEl, baselineIds, baselineSrcs, requireUuid) {
    const candidates = [];
    for (const img of containerEl.querySelectorAll('img')) {
      const url = img.currentSrc || img.src || '';
      if (!isMediaSrc(url)) continue;
      const id = mediaIdOf(url);
      if (requireUuid && !/flow-content\.google\/image\/[0-9a-f-]{36}/i.test(url)) continue;
      if ((id && baselineIds.has(id)) || (!id && baselineSrcs.has(url))) continue;
      candidates.push({ url, id });
    }
    return candidates;
  }
  function findNewMedia(kind, baselineIds, baselineSrcs, opts) {
    const baseSrcs = baselineSrcs || new Set();
    const o = opts || {};
    const fresh = [];
    const push = (s) => {
      const id = mediaIdOf(s);
      if (!id || baselineIds.has(id)) return;
      fresh.push({ url: s, id });
    };
    if (kind === 'vid') {
      const now = Date.now();
      const seenIds = new Set(); // F3: id quan sát được trong lượt poll này
      for (const v of document.querySelectorAll('video')) {
        // src-resolution giống currentMediaIds: currentSrc||src + các <source> con
        const srcs = [];
        const s0 = v.currentSrc || v.src || '';
        if (s0) srcs.push(s0);
        for (const src of v.querySelectorAll('source')) if (src.src) srcs.push(src.src);
        for (const s of srcs) {
          if (!isMediaSrc(s)) continue;
          const id = mediaIdOf(s);
          if (!id) {
            // UI mới (lh3/asb, không uuid): KHÔNG chạy pending 15s (preload chỉ
            // áp khi id có thật) — src lạ baselineSrcs = media vừa generate.
            if (!baseSrcs.has(s)) fresh.push({ url: s, id: '' });
            continue;
          }
          if (baselineIds.has(id)) continue;
          seenIds.add(id);
          if (isPlayableVideo(v)) {
            pendingMediaIds.delete(id);
            fresh.push({ url: s, id });
            continue;
          }
          // chưa strict-playable (preload=none / còn tải) → nhớ lần đầu thấy;
          // sau 15s chấp nhận URL thật từ chính element này.
          if (!pendingMediaIds.has(id)) {
            pendingMediaIds.set(id, now);
            continue;
          }
          if (now - pendingMediaIds.get(id) >= 15000) {
            if (!preloadNoneLogged) {
              preloadNoneLogged = true;
              log('✓ media xuất hiện (preload none).');
            }
            fresh.push({ url: s, id });
            // F3: đã accept + push → xoá entry khỏi Map ngay (không để stale).
            pendingMediaIds.delete(id);
          }
        }
      }
      // F3: id pending không còn xuất hiện trên element nào (element bị gỡ /
      // đổi URL trong lượt poll sau) → xoá — tránh entry mồ côi nằm lại mãi.
      for (const pid of pendingMediaIds.keys()) {
        if (!seenIds.has(pid)) pendingMediaIds.delete(pid);
      }
      // UI mới (flow.google.com): video done = img.video-thumbnail (src
      // flow-content.google/image/<uuid>) hoặc img src flow-content video/<uuid> —
      // KHÔNG phải <video> element. src uuid LẠ khỏi baseline = video vừa tạo —
      // nhận NGAY (thumb đã là hình thật, không cần pending 15s preload).
      for (const i of document.querySelectorAll('img')) {
        const s = i.currentSrc || i.src || '';
        if (!isMediaSrc(s)) continue;
        if (!isVideoThumbEl(i) && !isVideoFlowSrc(s)) continue;
        const id = mediaIdOf(s);
        if (!id) {
          // UI mới nhánh không uuid (hiếm — flow-content luôn có uuid, lh3 không
          // phải video thumb): src lạ baselineSrcs = video mới.
          if (!baseSrcs.has(s)) fresh.push({ url: s, id: '' });
          continue;
        }
        if (baselineIds.has(id)) continue;
        seenIds.add(id);
        pendingMediaIds.delete(id); // thumb không cần window preload
        fresh.push({ url: s, id });
      }
    } else {
      for (const i of document.querySelectorAll('img')) {
        const s = i.currentSrc || i.src || '';
        if (!isMediaSrc(s)) continue;
        const id = mediaIdOf(s);
        if (!id) {
          // UI mới (lh3/asb, id ''): alt không đoán được → mọi img media là ứng
          // viên; phân biệt cũ/mới bằng src so baselineSrcs (như baselineSrcSet
          // của uploadOneRef).
          // G10-QA-B2: under o.requireUuid (the view-batch job) a uuid-less img must
          // NOT count as the result -- Flow's real media is always
          // flow-content.google/image/<uuid>.
          // PROVEN by the raw log: the poll reported a uuid-less /asb/ URL as the result
          // ~2s after Send, while the tiles that succeeded took 38-49s. A second tile
          // reported a URL that had already appeared in the earlier candidate list.
          // SUSPECTED (the log does not record which element it was, nor Flow's
          // generating state): the element was a preview thumb or an old media mounting
          // late, and the premature done let the batch send the next command while Flow
          // was still generating. Fix is the same either way.
          // Other jobs (normal scenes, legacy extract, bg) keep their old behaviour.
          if (!o.requireUuid && !baseSrcs.has(s)) fresh.push({ url: s, id: '' });
          continue;
        }
        // UI mới (flow-content.google/image/<uuid>): ảnh kết quả KHÔNG cần alt
        // 'Generated image' (quy ước labs) — bản thân flow-content src là media
        // thật. Loại img.video-thumbnail (video done, không phải ảnh kết quả) và
        // img src flow-content video/ (poster video).
        if (/flow-content\.google\/(?:image|video)\//.test(s)) {
          if (baselineIds.has(id)) continue;
          if (isVideoThumbEl(i) || isVideoFlowSrc(s)) continue;
          fresh.push({ url: s, id });
          continue;
        }
        // UI cũ (redirect?name=uuid): giữ lọc alt 'Generated image' + gate id.
        if (baselineIds.has(id)) continue;
        if (!/generated\s*image/i.test(i.alt || '')) continue;
        fresh.push({ url: s, id });
      }
    }
    if (!fresh.length) return null;
    const anyTs = fresh.length > 1 && fresh.some((f) => mediaTimestampOf(f.url));
    if (fresh.length > 1) {
      // FIX D: nhiều media mới (lạ khi đã ép x1, nhưng vẫn đề phòng) — ưu tiên
      // media có timestamp TẠO MUỘN NHẤT trong tên file. Không media nào có
      // timestamp → giữ DOM-order last-wins như cũ + log danh sách ứng viên.
      const tsOf = (f) => Number(mediaTimestampOf(f.url)) || 0;
      if (anyTs) {
        fresh.sort((a, b) => tsOf(b) - tsOf(a));
      } else {
        log('Nhiều media mới không có timestamp — giữ DOM order (cái cuối): ' +
            fresh.map((f) => f.url.slice(0, 90)).join(' | '));
      }
    }
    // FIX F4: sort giảm dần (newest-first) → fresh[0] là media TẠO MUỘN NHẤT;
    // trước đây return phần tử CUỐI (= cũ nhất sau sort) → rút đúng media.
    // Nhánh không timestamp giữ nguyên DOM-order last-wins (phần tử cuối).
    // fresh luôn non-empty tại đây (đã return null phía trên nếu rỗng).
    return anyTs ? fresh[0] : fresh[fresh.length - 1];
  }
  // G10-QA-B2 (S4): COMPLETE baseline for a batch job -- scroll the whole grid and
  // ACCUMULATE ids/srcs at EVERY step. Reading ONCE after scrolling to the bottom is
  // WRONG: cdk-virtual-scroll unmounts offscreen tiles, so images at the top of the list
  // vanish from the DOM exactly when we read. Includes the data-media-id of uuid-less
  // (asb) tiles -- a stable identity for the project. Always RESTORE the previous
  // scrollTop (try/finally) so the user's grid does not jump.
  // FAIL-CLOSED: this baseline is the yardstick separating NEW media from OLD. If it
  // cannot be enumerated (DOM error / scroll dispatch throws) return ok:false so the
  // caller ABORTS the job -- better to create nothing than to accept old media as the
  // result (the very bug being fixed).
  async function fullMediaBaseline(kind) {
    const ids = new Set();
    const srcs = new Set();
    const collect = () => {
      for (const id of currentMediaIds(kind)) ids.add(id);
      for (const s of currentMediaSrcs(kind)) srcs.add(s);
      for (const el of document.querySelectorAll('[data-media-id]')) {
        const dmid = (el.getAttribute && el.getAttribute('data-media-id')) || '';
        if (dmid) ids.add(String(dmid).toLowerCase());
      }
    };
    const vp = document.querySelector('cdk-virtual-scroll-viewport');
    const originalTop = vp ? vp.scrollTop : 0;
    let err = '';
    try {
      collect(); // current state (independent of whether the viewport can scroll at all)
      if (vp && vp.scrollHeight > vp.clientHeight) {
        const step = Math.max(300, Math.floor(vp.clientHeight * 0.8));
        const maxY = vp.scrollHeight - vp.clientHeight;
        for (let y = 0; y <= maxY; y += step) {
          vp.scrollTop = Math.min(y, maxY);
          vp.dispatchEvent(new Event('scroll', { bubbles: true }));
          await wait(220);
          collect(); // accumulate AT THIS STEP -- the tile unmounts on the next one
        }
        vp.scrollTop = maxY;
        vp.dispatchEvent(new Event('scroll', { bubbles: true }));
        await wait(220);
        collect();
      }
    } catch (e) {
      err = String((e && e.message) || e);
    } finally {
      if (vp) {
        try {
          vp.scrollTop = originalTop;
          vp.dispatchEvent(new Event('scroll', { bubbles: true }));
          await wait(120);
        } catch (_) { /* restore is best-effort -- a failure here does not change the verdict */ }
      }
    }
    if (err) return { ok: false, reason: 'baseline-enumeration-failed: ' + err, ids, srcs, count: ids.size };
    return { ok: true, ids, srcs, count: ids.size };
  }
  // M7: unified helper — reads JS property (currentSrc || src) for both baseline & poll.
  function countMedia(kind) {
    if (kind === 'vid') {
      let n = 0;
      for (const v of document.querySelectorAll('video')) {
        const s = v.currentSrc || v.src || '';
        if (isMediaSrc(s)) { n += 1; continue; }
        for (const src of v.querySelectorAll('source')) {
          if (isMediaSrc(src.src)) { n += 1; break; }
        }
      }
      // UI mới: video done = img.video-thumbnail / img src flow-content video —
      // KHÔNG phải <video> element → đếm thêm để count-fallback (M7 timeout/SWW
      // re-send) hoạt động trên UI mới.
      for (const i of document.querySelectorAll('img')) {
        const s = i.currentSrc || i.src || '';
        if (!isMediaSrc(s)) continue;
        if (isVideoThumbEl(i) || isVideoFlowSrc(s)) n += 1;
      }
      return n;
    }
    // UI mới (lh3/asb) KHÔNG đoán được alt → đếm thuần isMediaSrc (mọi img
    // media). BỎ filter alt 'Generated image' để count-fallback (M7 timeout/SWW
    // re-send) hoạt động trên UI mới; chấp nhận lẫn thumb ref nếu Flow dùng
    // img lh3 cho refs. (THAY ĐỔI so với cũ: filter alt đã bỏ.)
    // Loại img.video-thumbnail + img src flow-content video (video done/poster —
    // không tính vào ảnh) để video chạy song song không làm count ảnh tăng giả.
    return [...document.querySelectorAll('img')].filter(
      (i) => !isVideoThumbEl(i) && !isVideoFlowSrc(i.currentSrc || i.src || '') && isMediaSrc(i.currentSrc || i.src || '')
    ).length;
  }

  // ---------------------------------------------------------------------------
  // Radix Select: opens on pointerdown, NOT a bare .click().
  // ĐÃ verify live: modal tune Settings + compact picker popover + tab đều cần
  // pointer chain này (click trần KHÔNG mở/đổi được).
  // ---------------------------------------------------------------------------
  function radixOpen(el) {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }
  function closeRadix() {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true })
    );
    // click ngoài để đóng popover/dialog nếu Escape chưa đủ
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  }

  // ---------------------------------------------------------------------------
  // (P3a) DOWNLOAD AUTOMATION — hover card (CDP thật) → ⋮ kebab → Download
  // submenu (Radix submenu mở BẰNG HOVER, không click) → click menuitem đúng
  // chất lượng đã chọn. Ảnh: 1K Original size / 2K Upscaled / 4K Upscaled.
  // Video: 720p Original Size / 1080p Upscaled (free) / 4K Upscaled · 50 credits.
  // ---------------------------------------------------------------------------
  async function hoverCoord(x, y) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'cdp:hover', x, y });
      return !!(res && res.ok);
    } catch (_) {
      return false;
    }
  }

  function elCenter(el) {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }

  // ---------------------------------------------------------------------------
  // P2 (class bug stale-coordinate): đóng dấu element ĐÍCH bằng attribute riêng để
  // background kiểm tra `document.elementFromPoint(x, y)` có trỏ đúng nó (hoặc con
  // của nó) NGAY trước khi dispatch nút. Vì sao đóng dấu thay vì viết selector tay:
  // helper dùng chung phủ MỌI element mà không cần selector riêng từng site, và
  // `closest` chỉ khớp CÁ THỂ element đích (aria-label chung chung có thể khớp
  // element CÙNG LOẠI khác — ví dụ "More options" của tile khác → false-pass).
  // Angular re-render (xoá dấu) → background báo stale → retry (fail-closed).
  // ---------------------------------------------------------------------------
  let aimSeq = 0;
  function aimMark(el) {
    if (!el || !el.setAttribute) {
      // NIT-3: không đóng dấu được ⇒ guard stale-coordinate TẮT cho lần click này —
      // log để không im lặng (trước đây guard tự tắt mà log panel không có dấu vết).
      log('⚠ aimMark: element không đóng dấu được — lần click này KHÔNG có guard stale-coordinate.');
      return null;
    }
    try {
      aimSeq += 1;
      const tok = 'asf' + aimSeq.toString(36) + Date.now().toString(36);
      el.setAttribute('data-asf-aim', tok);
      return '[data-asf-aim="' + tok + '"]';
    } catch (_) {
      log('⚠ aimMark: setAttribute lỗi — lần click này KHÔNG có guard stale-coordinate.');
      return null;
    }
  }
  function aimUnmark(el) {
    try { if (el && el.removeAttribute) el.removeAttribute('data-asf-aim'); } catch (_) { /* bỏ qua */ }
  }

  // CONCERN-4: guard stale-coordinate chạy trong background (Runtime.evaluate). 'error'
  // = KHÔNG kết luận được (eval fail) → click vẫn đi tiếp (fail-open) — log 1 dòng để
  // biết guard có thật sự hoạt động (lần đầu repo dùng Runtime.evaluate).
  function logProbeError(res) {
    if (res && res.probe === 'error') {
      log('⚠ stale-coordinate guard: Runtime.evaluate lỗi — click đi tiếp KHÔNG kiểm tra toạ độ (guard tạm tắt cho lần này).');
    }
  }

  // Real-click qua CDP tại tâm element (elCenter + cdp:click) — element.click()
  // trần KHÔNG ăn Angular (flow.google.com Save button, verified CDP recon).
  // Fallback element.click() nếu CDP fail — nhánh labs cũ (Radix) vẫn OK với click
  // trần, nên hành vi cũ được giữ nguyên khi không có session CDP.
  // P2: tự đóng dấu data-asf-aim lên CHÍNH element đích (không nhận selector tay —
  // NIT-1: tham số `expect` trước đây không caller nào truyền, mà còn hazard: caller
  // truyền selector của element KHÁC thì aimUnmark(el) vẫn xoá dấu ngoài → stale giả).
  // Gặp 'stale-coordinate' (elementFromPoint lệch) → ĐO LẠI + thử lại 1 lần (tối đa
  // 2 lần gửi); hết lượt → false. Khi stale, TUYỆT ĐỐI KHÔNG dispatch theo TOẠ ĐỘ
  // (CDP Input.dispatchMouseEvent vào element đã rời chỗ vẫn có thể ăn ở Flow) —
  // fallback trần chỉ dành cho lỗi CDP KHÁC (ví dụ không có session debugger).
  // NGOẠI LỆ CHỦ Ý ở đường xoá deleteFlowProject (dưới): sau khi CDP click/timeout
  // không mở được dialog, nó gọi .click() TRÊN ELEMENT REFERENCE — .click() trên
  // reference không thể trúng element khác, tức KHÔNG phải dispatch theo toạ độ ⇒
  // không mâu thuẫn với luật trên. P2c: site đó nay CÓ truyền delBtn/confirmBtn làm
  // marker, nhưng marker chỉ chặn nhánh DISPATCH THEO TOẠ ĐỘ (clickCdpxy trả false) —
  // nhánh .click() trên reference giữ NGUYÊN nghĩa cũ, không phải "bấm bù".
  async function clickReal(el) {
    if (!el) return false;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const mark = aimMark(el);
      let stale = null;
      try {
        const c = elCenter(el);
        const res = await chrome.runtime.sendMessage({ type: 'cdp:click', x: c.x, y: c.y, expect: mark });
        logProbeError(res);
        if (res && res.ok) return true;
        if (res && res.reason === 'stale-coordinate') stale = res;
        else { el.click(); return true; }
      } catch (_) {
        try { el.click(); return true; } catch (_2) { return false; }
      } finally {
        aimUnmark(el);
      }
      log(`clickReal: toạ độ lệch (trúng ${JSON.stringify(stale && stale.at && stale.at.found)}) — đo lại + thử lại (lần ${attempt}).`);
      if (attempt < 2) await wait(200);
    }
    log('clickReal: vẫn lệch toạ độ sau 2 lần — KHÔNG bấm mù.');
    return false;
  }

  // clickRealVerified: click bền cho settings (FIX-WIN luồng 2 — root cause ảnh extract
  // 9:16 thay vì 16:9). Flow dịch vị ~56px (UI toggle container, KHÔNG thêm node DOM —
  // probe CDP live 2026-09-08) giữa lúc đo elCenter và lúc Input.dispatchMouseEvent tới
  // trang (200-800ms do SW wake + chrome.debugger.attach + bezier moveMouse) → click vào
  // tọa độ CŨ trượt (run thật trên Windows: 2/3 clickReal mở picker TRƯỢT → bước
  // Ratio/Qty chạy khi picker ĐÓNG → 'Ratio: fail' nhưng ok vẫn true → output sai ratio).
  // Pattern copy hotfix upload 7ca8f5b: scrollIntoView + đo NGAY trước cdp:click (không
  // await xen) + verify sau ≤1.5s (poll 200ms) → fail: TÌM LẠI element (ref cũ có thể
  // stale sau layout shift) + đo lại + click lại ≤ maxRetry.
  // - finder: Hàm trả element (tìm lại mỗi lần retry) hoặc element cố định.
  // - verifyFn: Hàm trả truthy khi đã ăn (isPickerOpen / isControlOn / validateModel...).
  async function clickRealVerified(finder, verifyFn, opts = {}) {
    const maxRetry = opts.maxRetry || 3;
    for (let attempt = 1; attempt <= maxRetry; attempt += 1) {
      let el = null;
      try { el = typeof finder === 'function' ? finder() : finder; } catch (_) { el = null; }
      if (!el) {
        if (attempt < maxRetry) await wait(400);
        continue;
      }
      let stale = null;
      try {
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        // đo NGAY + gửi ngay: KHÔNG được chèn await nào giữa elCenter và cdp:click
        const c = elCenter(el);
        // P2: đóng dấu element đích — background chặn dispatch khi elementFromPoint lệch
        // (stale-coordinate). NIT-1: KHÔNG nhận selector tay qua opts.expect (không caller
        // nào dùng, mà còn hazard: dấu đóng ở element khác trong khi aimUnmark xoá ở el).
        const mark = aimMark(el);
        const res = await chrome.runtime.sendMessage({ type: 'cdp:click', x: c.x, y: c.y, expect: mark });
        logProbeError(res);
        if (res && res.reason === 'stale-coordinate') {
          // P2: KHÔNG el.click() khi stale — verify bên dưới sẽ fail → attempt kế tìm
          // lại element (ref cũ có thể đã stale sau layout shift) + đo lại + click lại.
          stale = res;
        } else if (!res || !res.ok) {
          try { el.click(); } catch (_) {} // fallback synthetic khi CDP fail (lỗi khác)
        }
      } catch (_) {
        try { el.click(); } catch (_2) {}
      } finally {
        aimUnmark(el);
      }
      if (stale) log(`clickRealVerified: elementFromPoint lệch (trúng ${JSON.stringify(stale.at && stale.at.found)}) — không bấm, tìm lại element (lần ${attempt}/${maxRetry}).`);
      // verify sau click (poll ≤1.5s) — bỏ qua khi stale (biết chắc chưa bấm)
      const deadline = Date.now() + (stale ? 0 : 1500);
      let ok = false;
      while (Date.now() < deadline) {
        let v = false;
        try { v = verifyFn ? !!verifyFn() : true; } catch (_) { v = false; }
        if (v) { ok = true; break; }
        await wait(200);
      }
      if (ok) return { ok: true, attempts: attempt };
      if (attempt < maxRetry) {
        log(`clickRealVerified: click chưa ăn (lần ${attempt}) — đo lại tọa độ + click lại...`);
        await wait(300);
      }
    }
    return { ok: false, attempts: maxRetry };
  }

  // Media card = div[role=button] (hoặc closest[role=button]) CHỨA img/video có
  // src chứa getMediaUrlRedirect + cùng phần cuối path với url từ 'done'.
  // T74 (download chính xác): ưu tiên identity ỔN ĐỊNH — ẢNH theo data-media-id
  // (uuid từ sidepanel sceneImageMid), VIDEO theo mediaToken(asb) trong
  // flow-video-tile. Fallback "card MỚI NHẤT trên DOM" chỉ còn dùng khi không có
  // identity (KHÔNG pick nhầm media của scene khác — bug tải lệch ảnh/video).
  function mediaCardOf(el) {
    return el.closest('[role="button"]') || el.closest('div[class*="card" i]') || el.closest('[class*="tile" i]') || el.parentElement;
  }
  function findMediaCardByUrl(url, kind, mediaId, name) {
    const u = String(url || '');
    const seg = u.split('/').pop().split('?')[0]; // mediaId tận cùng path
    // (0c) VIDEO PRECISE theo scene NAME — aria-label="scene_<n>_video" trên
    // flow-grid-tile-container. Token asb XOAY (quan sát thực tế: token cũ ≠ token
    // tile hiện tại) nên KHÔNG tin token; name Flow render ổn định — đúng cách
    // player xác định tile. Ưu tiên cao nhất cho video.
    if (kind === 'vid' && name) {
      const want = String(name).toLowerCase().replace(/\s+/g, '');
      for (const el of document.querySelectorAll('[aria-label]')) {
        const al = String(el.getAttribute('aria-label') || '').toLowerCase().replace(/\s+/g, '');
        const hasMedia = el.querySelector && el.querySelector('img, video');
        if (!hasMedia) continue;
        if (al === want) return el;
        if (al && want && al.endsWith(want)) return el; // aria-label đôi khi dính icon (play_circle…)
      }
    }
    // (0) PRECISE image: data-media-id = uuid (ổn định) — khớp ĐÚNG tile của scene đó.
    const mid = String(mediaId || '').toLowerCase();
    if (mid) {
      const tile = document.querySelector('[data-media-id="' + mid + '"]');
      if (tile) return mediaCardOf(tile);
    }
    // (0b) PRECISE video: mediaToken(asb) ổn định trong flow-video-tile.
    if (kind === 'vid') {
      const want = mediaToken(u) || (u && !mid ? seg : '');
      if (want) {
        for (const vt of document.querySelectorAll('flow-video-tile')) {
          const v = vt.querySelector('video');
          const im = vt.querySelector('img');
          const s = (v && (v.currentSrc || v.src)) || (im && (im.currentSrc || im.src)) || '';
          const tk = mediaToken(s);
          if (s && tk && (tk === want || tk.includes(want) || want.includes(tk))) return mediaCardOf(vt);
        }
      }
    }
    const candidates = [...document.querySelectorAll('video, img')].filter((el) => {
      const s = el.currentSrc || el.src || '';
      return isMediaSrc(s) && seg && (s.includes(u) || s.includes(seg));
    });
    for (const el of candidates) {
      const card = mediaCardOf(el);
      if (card) return card;
    }
    // Fallback UI mới: url 'done' (src lh3/asb) không có uuid → nhánh seg ở trên
    // không khớp được; lấy card của img/video lh3 MỚI NHẤT trên DOM (media vừa
    // generate — baseline FIFO không có nên cuối DOM = mới nhất).
    const latest = [...document.querySelectorAll('video, img')].filter((el) => {
      const s = el.currentSrc || el.src || '';
      return /lh3\.googleusercontent\.com\/asb\//.test(s);
    });
    for (let k = latest.length - 1; k >= 0; k--) {
      const card = mediaCardOf(latest[k]);
      if (card) return card;
    }
    // Fallback UI mới 2: media flow-content — giữ media kết quả (img
    // video-thumbnail / image-thumbnail hoặc img src flow-content video) MỚI
    // NHẤT trên DOM.
    const fc = [...document.querySelectorAll('video, img')].filter((el) => {
      const s = el.currentSrc || el.src || '';
      if (!/flow-content\.google\//.test(s)) return false;
      if (el.tagName === 'VIDEO') return true;
      return /video-thumbnail|image-thumbnail/i.test(el.className || '') || isVideoFlowSrc(s);
    });
    for (let k = fc.length - 1; k >= 0; k--) {
      const card = mediaCardOf(fc[k]);
      if (card) return card;
    }
    log('Không tìm thấy media card cho url: ' + u.slice(0, 100));
    return null;
  }

  // Chất lượng sidepanel → key chuẩn (dùng để map sang menuitem).
  function qualityKey(kind, quality) {
    const q = String(quality || '').toUpperCase();
    if (kind === 'img') {
      if (/^1K/.test(q)) return '1K';
      if (q === '2K') return '2K';
      if (q === '4K') return '4K';
    } else {
      if (/720/.test(q)) return '720p';
      if (/1080/.test(q)) return '1080p';
      if (q === '4K') return '4K';
    }
    return null;
  }

  // T80 merge: chọn "Original size" (lossless, không tốn credit upscale). Nếu không có
  // item Original → fail rõ ràng để caller biết.
  function findOriginalItem(kind) {
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    const all = items.map((m) => norm(m.textContent) || '[icon]');
    const item = items.find((m) => /original/i.test(norm(m.textContent))) || null;
    return { item, q: 'Original', all };
  }

  // Tìm menuitem chất lượng khớp trong submenu Download (sau khi hover mở).
  // Không khớp → trả luôn danh sách option đang có để log + fail an toàn.
  function findQualityItem(kind, quality) {
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    const all = items.map((m) => norm(m.textContent) || '[icon]');
    const q = qualityKey(kind, quality);
    if (!q) return { item: null, q: null, all };
    const item = items.find((m) => {
      const n = norm(m.textContent);
      if (kind === 'img') {
        if (q === '1K') return n.startsWith('1K') || n.includes('1K'); // '1K Original size'
        if (q === '2K') return n.endsWith('2KUpscaled') || n.includes('2K'); // '2K Upscaled'
        return n.includes('4K'); // '4K Upscaled'
      }
      if (q === '720p') return n.includes('720p'); // '720p Original Size'
      if (q === '1080p') return n.includes('1080p'); // '1080p Upscaled'
      // 4K video PHẢI đi kèm credit/50 (tránh nhầm với item khác chứa chuỗi 4K)
      return n.includes('4K') && (n.includes('credit') || n.includes('50'));
    });
    return { item, q, all };
  }

  // UI mới (flow.google.com — Angular): download = RIGHT-CLICK media tile/card
  // (cdp:rightClick) → context menu (flow-*-context-menu-items > flow-menu-item >
  // button.flow-internal-menu-item[role=menuitem], text 'download Download') →
  // HOVER (KHÔNG click — click sẽ đóng) 'Download' để mở submenu chất lượng →
  // click menuitem chất lượng (findQualityItem giữ — khớp 1K/2K/4K/720p/1080p).
  // Trả {ok:true} | {ok:false, retryable:true} khi context menu KHÔNG mở được
  // (labs không có context menu → caller fallback kebab ⋮) | {ok:false,
  // retryable:false, reason} khi menu MỞ nhưng thất bại (không fallback).
  async function downloadViaContextMenu(card, kind, quality) {
    const label = kind === 'vid' ? 'video' : 'ảnh';
    // (1) media element trong card (img/video khớp src media) — right-click đúng
    // lên nó; card không chứa img/video → right-click tâm card.
    const mediaEl = [...card.querySelectorAll('img, video')].find((el) => {
      const s = el.currentSrc || el.src || '';
      return isMediaSrc(s);
    }) || [...card.querySelectorAll('img, video')][0] || card;
    // (2) right-click THẬT (cdp:rightClick — CDP executor background)
    const pt = elCenter(mediaEl);
    let res = null;
    try {
      res = await chrome.runtime.sendMessage({ type: 'cdp:rightClick', x: pt.x, y: pt.y });
    } catch (_) {
      res = null;
    }
    if (!res || !res.ok) return { ok: false, retryable: true, reason: 'cdp:rightClick fail' };
    await wait(600);
    // (3) chờ menuitem 'download Download' trong context menu mới mở
    const dlItem = await waitFor(() => {
      const scope = document.querySelector('[class*="context-menu" i]') || document;
      return [...scope.querySelectorAll('[role="menuitem"], button[role="menuitem"], [class*="menu-item" i]')]
        .find((m) => {
          const t = norm(m.textContent) + ' ' + norm((m.getAttribute && m.getAttribute('aria-label')) || '');
          return /download/i.test(t);
        });
    }, 2500);
    if (!dlItem) {
      closeRadix(); // dọn menu lỡ mở trước khi fallback kebab
      await wait(250);
      return { ok: false, retryable: true, reason: 'no context menu download item' };
    }
    // (4) HOVER (không click) lên 'Download' → submenu chất lượng mở
    const dpt = elCenter(dlItem);
    await hoverCoord(dpt.x, dpt.y);
    await wait(700);
    // (5) menuitem chất lượng khớp lựa chọn user — 'original' cho merge lossless
    const qName = qualityKey(kind, quality) || (kind === 'img' ? '1K' : '1080p');
    const qRes = String(quality || '') === 'original' ? findOriginalItem(kind) : findQualityItem(kind, qName);
    const { item, q, all } = qRes;
    if (!item) {
      log(`download: không thấy menuitem chất lượng "${qName}" trong submenu Download (${label}). Có: ${all.join(' | ')}.`);
      return { ok: false, retryable: false, reason: 'quality item not found', available: all };
    }
    // (6) click chất lượng → Flow bắt đầu tải/upscale
    radixOpen(item);
    await wait(450);
    log(`✓ Đã yêu cầu tải ${label} · chất lượng ${q} (context menu).`);
    return { ok: true, quality: q };
  }

  // --- Blob capture (Ghép video): MAIN-world hook (blob-capture.js) post Blob
  // video qua postMessage; content giữ queue, đợi blob MỚI sau khi click chất lượng,
  // đọc bytes trực tiếp từ Blob object (KHÔNG fetch URL — Flow revoke ngay). ---
  const capturedBlobs = [];
  const MAX_CAPTURED_BYTES = 300 * 1024 * 1024;
  window.addEventListener('message', (ev) => {
    const d = ev.data || {};
    if (!d || d.source !== 'asf-blob-capture') return;
    if (ev.source !== window) return;
    if (ev.origin !== location.origin) return;
    if (!d.blob || typeof d.blob !== 'object' || !d.blob.type) return;
    if (!/^video\//.test(d.blob.type)) return;
    if ((d.size || d.blob.size || 0) > MAX_CAPTURED_BYTES) return;
    capturedBlobs.push({ blob: d.blob, at: d.at || Date.now(), size: d.size || d.blob.size || 0 });
    if (capturedBlobs.length > 60) capturedBlobs.shift();
  });
  async function blobToBase64(blob) {
    const buf = await blob.arrayBuffer();
    const u8 = new Uint8Array(buf);
    const CHUNK = 0x8000;
    let bin = '';
    for (let i = 0; i < u8.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
      if (i % (CHUNK * 32) === 0) { await new Promise((r) => setTimeout(r, 0)); }
    }
    return btoa(bin);
  }
  function waitForCapturedBlob(timeoutMs, since) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const tick = () => {
        const fresh = capturedBlobs.filter((c) => c.at >= since && c.size > 0);
        if (fresh.length) {
          resolve(fresh[fresh.length - 1].blob);
          return;
        }
        if (Date.now() > deadline) { resolve(null); return; }
        setTimeout(tick, 300);
      };
      tick();
    });
  }

  async function downloadMedia({ url, kind, quality, mediaId, name, captureBytes }) {
    const label = kind === 'vid' ? 'video' : 'ảnh';
    try {
      const card = findMediaCardByUrl(url, kind, mediaId, name);
      if (!card) return { ok: false, reason: 'card not found' };
      // captureSince = mốc TRƯỚC khi click chất lượng — blob có thể về ngay khi click
      // (race: trước kia lấy startCount SAU click → bỏ sót blob đã về → treo 120s).
      const captureSince = captureBytes ? Date.now() : 0;

      // --- UI mới (flow.google.com): context menu (right-click) path — ưu tiên ---
      const ctx = await downloadViaContextMenu(card, kind, quality);
      if (ctx.ok) {
        if (!captureBytes) return ctx;
        return await captureVideoBlob(ctx, captureSince);
      }
      if (!ctx.retryable) {
        log(`downloadMedia: context menu đã mở nhưng thất bại (${ctx.reason}) — không fallback kebab.`);
        return ctx;
      }
      log(`downloadMedia: context menu không mở được (${ctx.reason}) — fallback kebab ⋮ (labs).`);

      // 1) hover THẬT lên card → kebab ⋮ hiện ra (eval mouseenter là không đủ)
      const cardPt = elCenter(card);
      await hoverCoord(cardPt.x, cardPt.y);
      await wait(400);

      // 2) kebab ⋮ trong card (icon more_vert / aria-label 'More')
      const kebab = [...card.querySelectorAll('button')].find((b) => {
        const t = norm(b.textContent);
        const al = b.getAttribute('aria-label') || '';
        const tt = b.title || '';
        return /more/i.test(t) || /^more(_vert)?$/i.test(al) || /more/i.test(tt) || /more_vert/.test(b.innerHTML);
      });
      if (!kebab) {
        log(`Không thấy nút kebab ⋮ trên media card (${label}) — hover có thể chưa kịp.`);
        return { ok: false, reason: 'no kebab' };
      }

      // 3) mở menu ⋮ — Radix cần pointer chain, .click() trần không mở được
      radixOpen(kebab);
      await wait(500);

      // 4) menuitem 'Download' trong menu (recon: text 'download Download' — icon + chữ)
      const downloadItem = [...document.querySelectorAll('[role="menuitem"]')].find((m) =>
        /download/i.test(norm(m.textContent))
      );
      if (!downloadItem) {
        log('Không thấy menuitem "Download" trong menu ⋮ — menu có thể chưa mở.');
        closeRadix();
        return { ok: false, reason: 'no download item' };
      }

      // 5) RADIX SUBMENU mở bằng HOVER (không click) — hover lên Download + đợi
      const itemPt = elCenter(downloadItem);
      await hoverCoord(itemPt.x, itemPt.y);
      await wait(600);

      // 6) menuitem chất lượng khớp lựa chọn user — 'original' cho merge lossless
      const qName = qualityKey(kind, quality) || (kind === 'img' ? '1K' : '1080p');
      const qRes = String(quality || '') === 'original' ? findOriginalItem(kind) : findQualityItem(kind, qName);
      const { item, q, all } = qRes;
      if (!item) {
        log(`Không tìm thấy menuitem chất lượng "${qName}" cho ${label}. Các option đang có: ${all.join(' | ')}.`);
        closeRadix();
        return { ok: false, reason: 'quality item not found', available: all };
      }

      // 7) click chất lượng → Flow bắt đầu download/upscale
      radixOpen(item);
      await wait(450);
      log(`✓ Đã yêu cầu tải ${label} · chất lượng ${q}.`);
      if (!captureBytes) return { ok: true, quality: q };
      return await captureVideoBlob({ ok: true, quality: q }, captureSince);
    } catch (err) {
      log('downloadMedia lỗi: ' + (err && err.message || err));
      return { ok: false, reason: String(err && err.message || err) };
    }
  }

  async function captureVideoBlob(ctx, since) {
    // captureBytes: chờ Flow tạo Blob video (downloadWillBegin) rồi đọc bytes trực tiếp.
    const blob = await waitForCapturedBlob(120000, since);
    if (!blob) return { ok: true, captured: false, reason: 'không bắt được blob video', ...ctx };
    const bytesBase64 = await blobToBase64(blob);
    return { ok: true, captured: true, bytesBase64, size: blob.size, ...ctx };
  }

  // T86 (root cause của "pick/chọn media xong không rename được"): tile trên home nằm
  // trong cdk-virtual-scroll-viewport → tile NGOÀI KHUNG NHÌN bị Angular UNMOUNT khỏi DOM.
  // listHomeMedia cuộn viewport để enumerate ra danh sách, nhưng MỌI thao tác theo identity
  // sau đó (rename/delete) lại querySelector trực tiếp ⇒ tile-not-found dù media có thật.
  // Vì vậy: tìm → chưa thấy thì CUỘN viewport và TÌM LẠI từng bước (findFn được gọi lại
  // mỗi bước để không giữ tham chiếu cũ đã bị tái sử dụng).
  async function findHomeTileScrolling(findFn) {
    let tile = findFn();
    if (tile) return tile;
    try {
      const vp = document.querySelector('cdk-virtual-scroll-viewport');
      if (vp && vp.scrollHeight > vp.clientHeight) {
        const step = Math.max(300, Math.floor(vp.clientHeight * 0.8));
        const maxY = vp.scrollHeight - vp.clientHeight;
        const originalTop = vp.scrollTop; // để trả lại vị trí user đang xem nếu không thấy gì
        for (let y = 0; y <= maxY; y += step) {
          vp.scrollTop = Math.min(y, maxY);
          vp.dispatchEvent(new Event('scroll', { bubbles: true }));
          await wait(220);
          tile = findFn();
          if (tile) return tile; // thấy rồi → giữ nguyên vị trí vừa cuộn tới (tile phải ở trong DOM)
        }
        // Bước CUỐI đúng maxY: vòng for ở trên nhảy theo `step` nên khi maxY không chia
        // hết cho step thì dải cuối cùng (tile nằm sát đáy) KHÔNG bao giờ được thử.
        vp.scrollTop = maxY;
        vp.dispatchEvent(new Event('scroll', { bubbles: true }));
        await wait(220);
        tile = findFn();
        if (tile) return tile;
        // Không thấy ở đâu → TRẢ LẠI đúng vị trí user đang xem (không để họ bị đẩy xuống đáy)
        // rồi thử lần cuối (DOM có thể đã đổi trong lúc cuộn).
        vp.scrollTop = originalTop;
        vp.dispatchEvent(new Event('scroll', { bubbles: true }));
        await wait(220);
        tile = findFn();
      }
    } catch (_) { /* không cuộn được → giữ kết quả tìm ban đầu */ }
    return tile || null;
  }

  // Tìm tile VIDEO theo token src (flow-video-tile KHÔNG có data-media-id). Tách ra để
  // dùng được làm findFn cho findHomeTileScrolling (phải TÌM LẠI mỗi bước cuộn).
  function findVideoTileByToken(want) {
    if (!want) return null;
    for (const vt of document.querySelectorAll('flow-video-tile')) {
      let hit = false;
      for (const el of vt.querySelectorAll('video, img')) {
        const s = mediaToken((el.currentSrc || el.src || '').trim());
        if (!s) continue;
        if (s === want || s.includes(want) || want.includes(s)) { hit = true; break; }
      }
      if (hit) return vt;
    }
    return null;
  }

  // Mở menu ⋮ "More options" của tile → click "Move to trash" → verify tile biến mất.
  // Dùng chung cho ẢNH (data-media-id) và VIDEO (flow-video-tile). KHÔNG navigate khi miss.
  // stillThereFn() trả TRUE khi tile còn hiện diện — requery mỗi lần attempt (video tile
  // bị virtual-scroll tái dùng nên phải soi lại bằng identity thật, không tin tham chiếu cũ).
  async function trashTile(tile, stillThereFn) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) {
        closeRadix(); // dọn menu lỡ mở từ lần thử trước
        await wait(250);
      }
      if (!stillThereFn()) return { ok: true }; // tile đã biến mất (lần thử trước xóa xong)
      tile.scrollIntoView({ block: 'center', inline: 'center' });
      await wait(250);
      const tilePt = elCenter(tile);
      try { await chrome.runtime.sendMessage({ type: 'cdp:hover', x: tilePt.x, y: tilePt.y }); } catch (_) { /* no bg */ }
      await wait(250);
      // UI MỚI mở menu bằng nút ⋮ "More options" (click TRÁI, .mat-mdc-menu-trigger),
      // KHÔNG phải right-click (probe CDP: right-click khiến menu rỗng → "no trash item").
      let card = tile;
      for (let i = 0; i < 6 && card.parentElement; i += 1) {
        card = card.parentElement;
        if (card.querySelector && card.querySelector('button[aria-label="More options"]')) break;
      }
      const moreBtn = (card.querySelector && (card.querySelector('button[aria-label="More options"]') || card.querySelector('.mat-mdc-menu-trigger'))) || null;
      if (!moreBtn) {
        closeRadix();
        await wait(200);
        return { ok: false, reason: 'no more-options button' };
      }
      const bpt = elCenter(moreBtn);
      const opened = await clickCdpxy(bpt.x, bpt.y, moreBtn);
      if (!opened) {
        // CONCERN-2: cú bấm bị CHẶN (guard stale-coordinate) / CDP fail ⇒ PHẢI nhường lượt 2
        // của vòng for ở trên (nó sinh ra đúng cho ca này: "click có thể nhầm khi menu chưa
        // mở"), lượt đó ĐO LẠI rect rồi bấm lại — trước đây return ngay nên vòng retry chết
        // cứng, đúng ca Flow dịch vị ~56px giữa lúc đo và dispatch là fail luôn. Hết 2 lượt
        // ⇒ rơi xuống đường fail cũ với reason 'tile-still-exist' (KHÔNG đổi contract).
        // Chỉ retry khi cú bấm KHÔNG ăn — đã ăn thì đi tiếp (tránh bấm đôi mở/đóng menu).
        closeRadix();
        await wait(250);
        continue;
      }
      await wait(800); // chờ menu render (MatMenu mở chậm hơn context-menu cũ)
      // scope: menu MatMenu render ở .cdk-overlay-container, KHÔNG nằm trong
      // [class*="context-menu"] (selector cũ cho labs) → dùng document quét menuitem.
      const trashItem = [...document.querySelectorAll('[role="menuitem"], button[role="menuitem"], [class*="menu-item" i]')]
        .find((m) => {
          const t = norm(m.textContent) + ' ' + norm((m.getAttribute && m.getAttribute('aria-label')) || '');
          return /movetotrash/i.test(t); // menuitem "deleteMove to trash" — icon delete + label 'Move to trash'
        });
      if (!trashItem) {
        closeRadix();
        await wait(200);
        return { ok: false, reason: 'no trash item' };
      }
      // real click tại tâm item — clickCdpxy (CDP trusted, ăn Angular); fallback radixOpen
      const tpt = elCenter(trashItem);
      const clicked = await clickCdpxy(tpt.x, tpt.y, trashItem);
      if (!clicked) radixOpen(trashItem);
      await wait(800); // chờ toast + tile gỡ khỏi gallery
      if (!stillThereFn()) return { ok: true };
      // vẫn còn → lần thử 2 (click có thể nhầm khi menu chưa mở)
    }
    closeRadix(); // dọn menu lỡ mở trước khi return fail
    return { ok: false, reason: 'tile-still-exist' };
  }

  // T63: xóa 1 ảnh role cũ trên project home theo mediaId (uuid). Không navigate khi
  // không thấy tile ({ok:false, reason:'tile-not-found'} → sidepanel bỏ qua nhẹ). Undo/Trash
  // tồn tại nên reversible.
  async function deleteAssetByMediaId(mediaId) {
    try {
      const mid = String(mediaId || '').toLowerCase();
      const sel = '[data-media-id="' + mid + '"]';
      // T86: tile có thể bị virtual-scroll unmount → cuộn rồi tìm lại trước khi kết luận.
      const tile = await findHomeTileScrolling(() => document.querySelector(sel));
      if (!tile) return { ok: false, reason: 'tile-not-found' }; // view không phải project home / không trong gallery — KHÔNG navigate, KHÔNG block
      const r = await trashTile(tile, () => !!document.querySelector(sel));
      if (r && r.ok) log(`✓ Đã xóa tile ảnh cũ khỏi project (media-id ${mid.slice(0, 8)}…).`);
      return r;
    } catch (err) {
      try { closeRadix(); } catch (_) { /* no menu */ }
      return { ok: false, reason: String(err && err.message || err) };
    }
  }
  // T74: xóa TILE VIDEO (flow-video-tile KHÔNG có data-media-id) — nhận diện theo
  // mediaToken(src) ổn định (giống renameAssetByMediaId / openVideoOnFlow). Dùng chung
  // trashTile với ảnh. KHÔNG navigate khi miss ({ok:false, reason:'tile-not-found'}).
  async function deleteVideoTileBySrc(src) {
    try {
      const want = mediaToken(String(src || '').trim());
      if (!want) return { ok: false, reason: 'no src identity' };
      const gone = () => !findVideoTileByToken(want);
      // T86: tile video cũng bị virtual-scroll unmount → cuộn rồi tìm lại.
      const tile = await findHomeTileScrolling(() => findVideoTileByToken(want));
      if (!tile) return { ok: false, reason: 'tile-not-found' };
      const r = await trashTile(tile, gone);
      if (r && r.ok) log('✓ Đã xóa tile video khỏi project.');
      return r;
    } catch (err) {
      try { closeRadix(); } catch (_) { /* no menu */ }
      return { ok: false, reason: String(err && err.message || err) };
    }
  }

  // T66: đổi tên media trên Flow home (tile [data-media-id]) — menu ⋮ → Rename →
  // popover input → đặt tên chuẩn role (character.png/product.png/background.png).
  // Dùng cho tách model/sản phẩm (KHÔNG upload lại = không tạo media trùng) + chọn
  // ảnh có sẵn trong Flow (adopt media với đúng tên role). KHÔNG navigate khi miss.
  async function renameAssetByMediaId(mediaId, newName, srcHint) {
    try {
      const mid = String(mediaId || '').toLowerCase();
      const name = String(newName || '').trim();
      if (!name) return { ok: false, reason: 'thiếu tên' };
      let tile = mid ? await findHomeTileScrolling(() => document.querySelector('[data-media-id="' + mid + '"]')) : null;
      if (!tile && srcHint) {
        // VIDEO tile (flow-video-tile) KHÔNG có data-media-id → tìm theo src media.
        // T46-FIX: chỉ match trong flow-video-tile — KHÔNG match img ảnh thường.
        // (Trước đây match video,img TOÀN CỤC → srcHint stale do virtual-scroll có
        // thể trỏ nhầm ảnh → rename ẢNH thành "scene_n_video" ⇒ mất tên ảnh.)
        // T86: bọc thêm findHomeTileScrolling — tile video cũng bị unmount ngoài khung nhìn.
        const want = mediaToken(String(srcHint).trim());
        tile = await findHomeTileScrolling(() => findVideoTileByToken(want));
      }
      if (!tile) return { ok: false, reason: mid ? 'tile-not-found' : 'video-tile-not-found' };
      // (1) HOVER tile để lộ nút ⋮ (giống delete) rồi mở menu "More options".
      tile.scrollIntoView({ block: 'center', inline: 'center' });
      await wait(250);
      const tilePt = elCenter(tile);
      try { await chrome.runtime.sendMessage({ type: 'cdp:hover', x: tilePt.x, y: tilePt.y }); } catch (_) { /* no bg */ }
      await wait(250);
      let card = tile;
      for (let i = 0; i < 6 && card.parentElement; i += 1) {
        card = card.parentElement;
        if (card.querySelector && card.querySelector('button[aria-label="More options"]')) break;
      }
      const moreBtn = (card.querySelector && card.querySelector('button[aria-label="More options"]')) || null;
      if (!moreBtn) return { ok: false, reason: 'no more-options button' };
      const mpt = elCenter(moreBtn);
      if (!(await clickCdpxy(mpt.x, mpt.y, moreBtn))) return { ok: false, reason: 'cdp:click more-options fail' };
      await wait(800);
      // (2) click "Rename" (menuitem "editRename")
      const renameItem = [...document.querySelectorAll('[role="menuitem"], button[role="menuitem"], [class*="menu-item" i]')]
        .find((m) => /rename/i.test((m.textContent || '') + ' ' + ((m.getAttribute && m.getAttribute('aria-label')) || '')));
      if (!renameItem) { closeRadix(); return { ok: false, reason: 'no rename item' }; }
      const rpt = elCenter(renameItem);
      if (!(await clickCdpxy(rpt.x, rpt.y, renameItem))) { closeRadix(); return { ok: false, reason: 'cdp:click rename fail' }; }
      await wait(800);
      // (3) popover rename: input.editable-text-input (aria "Editable text")
      const input = await waitFor(() => {
        const ov = document.querySelector('.rename-tile-overlay') || document.querySelector('.cdk-overlay-popover');
        return ov ? (ov.querySelector('input.editable-text-input, input[aria-label="Editable text"]') || null) : null;
      }, 4000);
      if (!input) return { ok: false, reason: 'no rename input' };
      // đặt tên mới — native setter + sự kiện để Angular ghi nhận (KHÔNG cần gõ thật)
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      if (setter) setter.call(input, name);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(300);
      // (4) click "Done" (button[aria-label="Done"])
      const doneBtn = document.querySelector('.rename-tile-overlay button[aria-label="Done"], .cdk-overlay-popover button[aria-label="Done"]');
      if (!doneBtn) return { ok: false, reason: 'no done button' };
      const dpt = elCenter(doneBtn);
      if (!(await clickCdpxy(dpt.x, dpt.y, doneBtn))) return { ok: false, reason: 'cdp:click done fail' };
      await wait(600);
      // G4/S4: HẬU KIỂM — cú bấm Done có thể không ăn (Angular chưa commit giá trị
      // input) mà overlay vẫn đóng ⇒ trước đây báo ok:true SAI ⇒ sidepanel ghi tên
      // mới vào state trong khi Flow giữ tên cũ (lệch vĩnh viễn). Đọc lại DOM: tile
      // phải CÒN và tên hiển thị phải KHỚP tên yêu cầu, nếu không ⇒ fail-closed.
      const readTileName = () => {
        const t2 = mid ? document.querySelector('[data-media-id="' + mid + '"]') : findVideoTileByToken(mediaToken(String(srcHint || '').trim()));
        if (!t2) return null;
        // CHỈ đọc footer trong phạm vi TILE: container tile (ảnh) hoặc chính tile
        // (video tile đọc footer trực tiếp — giống exportVideoData). KHÔNG leo
        // parentElement: parent có thể là grid chứa NHIỀU tile ⇒ querySelector(footer)
        // trả footer tile KHÁC ⇒ đọc nhầm tên ⇒ false-positive ok:true.
        const card2 = (t2.closest && t2.closest('flow-grid-tile-container')) || t2;
        const fl = (card2.querySelector && card2.querySelector('.footer-left, [class*="footer" i]')) || null;
        // LIVE DOM (probe 2026-09-24): .footer-left = <mat-icon>image</mat-icon>
        // <span class="footer-title">NAME</span> — mat-icon is a FONT-LIGATURE element,
        // its textContent ('image'/'video') leaks into fl.textContent, so an exact
        // `got === name` compare failed on a CORRECTLY renamed tile ("imagecharacter.png"
        // vs "character.png") → rename-not-verified → the sidepanel deleted the good
        // image. Read the dedicated name node (.footer-title) first; footer text is only
        // a fallback for DOM shapes without it.
        const tn = (card2.querySelector && card2.querySelector('.footer-title')) || fl;
        const txt = ((tn && tn.textContent) || '').replace(/\s+/g, ' ').trim();
        return txt || null;
      };
      // tile lazy re-render sau rename → poll ngắn (khác waitFor: cần đọc LẠI mỗi vòng).
      let applied = null;
      const verifyDeadline = Date.now() + 3000;
      while (Date.now() < verifyDeadline) {
        const got = readTileName();
        if (got === name) { applied = got; break; }
        await wait(300);
      }
      if (applied !== name) {
        const got = readTileName();
        log(`⚠ Đổi tên media ${mid.slice(0, 8)}… CHƯA xác minh được: Flow hiển thị ${got === null ? '(không đọc được tên tile)' : `"${got}"`}, yêu cầu "${name}".`);
        return { ok: false, reason: 'rename-not-verified' };
      }
      log(`✓ Đã đổi tên media ${mid.slice(0, 8)}… → "${name}".`);
      return { ok: true, mediaId: mid, name };
    } catch (err) {
      try { closeRadix(); } catch (_) { /* no menu */ }
      return { ok: false, reason: String(err && err.message || err) };
    }
  }

  // Poll until fn() returns a truthy value, or timeout.
  async function waitFor(fn, timeout = 4000, interval = 200) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const r = fn();
      if (r) return r;
      await wait(interval);
    }
    return null;
  }
  async function ensureAgentOff() {
    const toggle = findAgentToggle();
    if (!toggle) {
      if (findCompactPickerButton()) {
        log('Agent toggle không thấy nhưng Compact Picker có → Agent đã OFF.');
        return true;
      }
      log('Không tìm thấy nút Agent toggle — UI Flow không expose chế độ tắt Agent.');
      return false;
    }
    
    const isPressed = toggle.getAttribute('aria-pressed') === 'true';
    const isChecked = toggle.getAttribute('aria-checked') === 'true';
    // Angular Material switch dùng aria-checked, cũ dùng aria-pressed
    if (!isPressed && !isChecked) {
      log('Agent đã OFF (aria-pressed/checked = false).');
      return true;
    }
    
    // Agent đang ON → cần tắt bằng CDP real click (JS click KHÔNG ăn Angular toggle)
    log('Agent đang ON — tắt bằng CDP click...');
    for (let i = 0; i < 3; i++) {
      await clickReal(toggle);
      await wait(800);
      const t2 = findAgentToggle();
      if (t2) {
        const p2 = t2.getAttribute('aria-pressed') === 'true';
        const c2 = t2.getAttribute('aria-checked') === 'true';
        if (!p2 && !c2) {
          log('✓ Agent đã tắt thành công (CDP click).');
          return true;
        }
      }
      log(`⚠ Agent vẫn ON sau lần click ${i + 1} — thử lại...`);
    }
    log('❌ Không tắt được Agent sau 3 lần thử CDP click.');
    return false;
  }

  // ---------------------------------------------------------------------------
  // Tier từ danh sách tên model (menu video, đã labelTextOf) — THUẦN, test được
  // (xem .qa/detect-tier.test.mjs): 'ULTRA' khi có Lower Priority, 'normal' khi
  // menu video hợp lệ không có LP, null khi rỗng/toàn tên lạ (fail-closed — KHÔNG
  // gán 'normal' khi chưa chắc, tránh khoá Lower Priority sai trên ULTRA).
  // ---------------------------------------------------------------------------
  function tierFromModelNames(names) {
    if (!names || !names.length) return null;
    const knownVideo = names.some((n) => VIDEO_MODEL_NAMES.some((m) => modelKey(n) === modelKey(m)));
    if (!knownVideo) return null;
    return names.some((n) => modelKey(n) === modelKey(LOWER_PRIORITY)) ? 'ULTRA' : 'normal';
  }

  // ---------------------------------------------------------------------------
  // Tier detection: mở Compact Picker (Agent OFF) → tab Video → dropdown model
  // video → enumerate. Returns 'ULTRA' | 'normal', hoặc null khi KHÔNG chắc chắn
  // (fail-closed: KHÔNG gán 'normal' khi menu rỗng/nhầm — tránh khoá "Lower
  // Priority" sai trên tài khoản ULTRA).
  // ---------------------------------------------------------------------------
  async function detectAccount() {
    // T76.5: gỡ overlay "Rights to use this video" TRƯỚC — nó che nút Agent/Compact Picker
    // khiến ensureAgentOff tưởng "không thấy toggle" (false negative ở 18:40:26).
    await acceptRightsDialogIfPresent();
    // KHÔNG bật Agent — detect tier bằng Compact Picker (Agent OFF mode)
    if (!(await ensureAgentOff())) {
      log('Không tắt được Agent để detect tier.');
      return null;
    }
    log('Đang phát hiện loại tài khoản (qua Compact Picker, Agent OFF)...');

    const ocLive = () => document.querySelector('.cdk-overlay-container') || document;
    const menuItemsOf = () => [...ocLive().querySelectorAll(MENU_ITEMS_SEL)];

    // Đóng dropdown + picker an toàn — closeChain là helper CẤP MODULE (G9/S2 promote
    // từ chính hàm local này, hành vi không đổi) — xem khai báo cạnh isPickerOpen().
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      log(`--- Detect tier (lần ${attempt}/3) ---`);

      // Bước 1: mở Compact Picker — CDP thật + verify isPickerOpen (radixOpen
      // synthetic KHÔNG mở được trên UI hiện tại — xem applyConfigViaPicker).
      if (!isPickerOpen()) {
        const res = await clickRealVerified(findCompactPickerButton, () => isPickerOpen(), { maxRetry: 3 });
        if (!res.ok) {
          log(`⚠ Lần ${attempt}: Không mở được Compact Picker.`);
          await wait(500);
          continue;
        }
        await wait(300);
      }

      // Bước 2: chuyển sang tab Video + verify đã chọn — nếu còn ở tab Image,
      // dropdown sẽ là danh sách Nano Banana → false 'normal'.
      // Finder trả CONTROL PARENT (button/[role=tab]/mat-button-toggle), không trả
      // span con — state (aria-checked/.mat-button-toggle-checked) nằm trên parent.
      const videoTab = () => {
        const raw = [...ocLive().querySelectorAll('button, span')].find((e) => {
          const t = norm(e.textContent);
          return t === 'videocamVideo' || t === 'Video' || t === 'videocam';
        });
        if (!raw) return null;
        return raw.closest('button, [role="tab"], [role="button"], mat-button-toggle') || raw;
      };
      let videoOn = false;
      {
        const vBtn = videoTab();
        if (!vBtn) {
          log(`⚠ Lần ${attempt}: Không tìm thấy tab Video trong Compact Picker.`);
          await closeChain();
          continue;
        }
        try { videoOn = isControlOn(vBtn); } catch (_) { videoOn = false; }
        if (!videoOn) {
          const vr = await clickRealVerified(
            videoTab,
            () => { const b = videoTab(); return !!b && isControlOn(b); },
            { maxRetry: 2 }
          );
          videoOn = vr.ok;
        }
        if (!videoOn) {
          log(`⚠ Lần ${attempt}: Không chuyển được sang tab Video — bỏ qua (tránh đọc nhầm menu Image).`);
          await closeChain();
          continue;
        }
        await wait(300);
      }

      // Bước 3: mở dropdown model — LABEL-FIRST ('Select model family') + verify
      // menu items thực sự xuất hiện (menu Angular mount async, không wait cố định).
      const dropRes = await clickRealVerified(
        () => findModelTriggerInOverlay(ocLive()),
        () => menuItemsOf().length > 0,
        { maxRetry: 2 }
      );
      if (!dropRes.ok) {
        log(`⚠ Lần ${attempt}: dropdown model không mở được (không có menu item).`);
        await closeChain();
        continue;
      }
      await wait(300);

      // Bước 4: đọc menu item — so KHỚP chính xác modelKey === (labelTextOf đã bỏ
      // icon ligature như volume_up/arrow_drop_down khỏi text).
      const items = menuItemsOf();
      const names = items.map((b) => labelTextOf(b));
      log('Danh sách model: ' + names.join(' | '));

      // Quyết định tier — fail-closed (rỗng/nhầm menu → null, KHÔNG suy 'normal').
      const tier = tierFromModelNames(names);
      if (!tier) {
        log(`⚠ Lần ${attempt}: Menu model rỗng/không phải menu model video — không detect được tier.`);
        await closeChain();
        continue;
      }

      await closeChain();

      state.tier = tier;
      if (tier === 'ULTRA') {
        log('Phát hiện tài khoản ULTRA (có option "' + LOWER_PRIORITY + '").');
      } else {
        log('Phát hiện tài khoản thường (không có Lower Priority).');
      }
      return state.tier;
    }

    log('❌ Detect thất bại sau 3 lần — tier giữ nguyên hiện tại (fail-closed, không gán nhầm "normal").');
    return null;
  }

  // ---------------------------------------------------------------------------
  // NEW P2: Unified applyConfigViaPicker
  // Uses Compact Picker (Agent OFF) to set Model, Ratio, Duration, and Quantity.
  // ---------------------------------------------------------------------------
  async function applyConfigViaPicker(kind, config) {
    log(`Thiết lập cấu hình qua Compact Picker cho ${kind === 'vid' ? 'Video' : 'Ảnh'}...`);

    // 1. Đảm bảo Agent OFF
    if (!(await ensureAgentOff())) {
      return { ok: false, log: 'Không tắt được Agent — không thể mở Compact Picker.' };
    }

    // 2. Mở Compact Picker
    const picker = await waitFor(findCompactPickerButton, 4000);
    if (!picker) {
      return { ok: false, log: 'Không tìm thấy nút Compact Picker.' };
    }
    
    // Tối ưu: Đọc trạng thái từ nút picker
    const kindText = kind === 'vid' ? 'Video' : 'Image';
    const ratio = config.aspectRatio || '9:16';
    const dur = kind === 'vid' && config.videoDuration ? `${config.videoDuration}s` : '';
    const model = kind === 'vid' ? config.videoModel : config.imageModel;

    // FIX-WIN (luồng 2) fast-path: (a) trigger text thật hiển thị ratio bằng ICON
    // ligature 'crop_9_16' (gạch dưới), KHÔNG phải '9:16' (dấu hai chấm) →
    // includes(norm('9:16')) không bao giờ đúng → fast-path cũ không bao giờ khớp
    // (mở picker thừa). (b) img mode trigger KHÔNG chứa chữ 'Image' ('🍌 Nano
    // Banana Pro crop_9_16 x1') nhưng check cũ đòi includes('Image') → cũng không
    // bao giờ khớp. Sửa: so ratio qua icon 'crop_<w>_<h>', và chỉ khớp khi CÓ model
    // (model đủ xác định đúng kind + config đang áp). Model match qua includes là an
    // toàn: video mode hiện model video (Veo/Omni), không trùng model ảnh.
    const ratioIcon = ratio ? `crop_${String(ratio).replace(':', '_')}` : '';
    const pickerText = norm(picker.textContent) + ' ' + norm(picker.getAttribute('aria-label') || '');
    if (model && pickerText.includes(norm(model)) &&
        (!ratioIcon || pickerText.includes(ratioIcon)) &&
        (!dur || pickerText.includes(norm(dur)))) {
        log(`✓ Cấu hình ĐÃ KHỚP (${kindText}, ${ratio}, ${dur}, ${model}). Bỏ qua bước mở Picker.`);
        return { ok: true, log: 'already matched' };
    }

    // Lưu ý: Compact Picker có thể đã mở. Nếu chưa mở thì mới click.
    // T43: DÙNG clickReal (CDP thật) — synthetic radixOpen KHÔNG mở được Compact
    // Picker trên UI flow.google.com hiện tại (log "CẢNH BÁO: Popover không mở ra"
    // mỗi lần). CDP click = đúng ý định người dùng → picker mở ổn định.
    // FIX-WIN (luồng 2): clickReal thường vẫn dính stale-coordinate — run thật trên
    // Windows (log 18:18:46) 2 clickReal mở picker ĐỀU TRƯỢT → bước Ratio/Qty chạy khi
    // picker ĐÓNG → 'Ratio: fail (16:9) | Qty: fail' nhưng ok vẫn true → Flow giữ ratio
    // cũ 9:16 → ảnh extract ra 9:16 thay vì 16:9. Dùng clickRealVerified: tìm lại +
    // đo lại mỗi lần + verify isPickerOpen sau click + retry ≤3.
    if (!isPickerOpen()) {
      const res = await clickRealVerified(findCompactPickerButton, () => isPickerOpen(), { maxRetry: 3 });
      if (!res.ok) {
        // P1.4: KHÔNG mở được picker → trả ok:false NGAY. Trước đây chỉ log rồi đi tiếp →
        // kind/ratio/qty/model bấm vào pane đã đóng (hoặc overlay lạ) mà generate vẫn gửi
        // prompt → Flow chạy cấu hình cũ, tốn credit sai mode.
        log('⚠ Không mở được Compact Picker sau 3 lần clickRealVerified — HỦY thiết lập cấu hình.');
        return { ok: false, log: 'picker-not-opened' };
      }
    }
    await wait(200);

    // P1.2: mọi truy vấn trong picker đi qua findInPicker — scope = pane THẬT đang mở.
    // Gọi findPickerPane() mỗi lần (không cache) để không stale khi picker đóng/mở lại.
    const findInPicker = (textMatchers, role = null) => findInPopover(textMatchers, role, findPickerPane());
    // Model trigger trong overlay — dùng helper LABEL-FIRST cấp module
    // (aria-label 'Select model family', fallback aria-haspopup=menu).

    // FIX-WIN (luồng 2): fail-flag cho Ratio/Duration — trước đây chỉ modelFailed mới
    // làm return ok:false; ratio fail bị nuốt → output SAI ratio mà vẫn tốn credit.
    let ratioFailed = false;
    let durFailed = false;
    let kindFailed = false; // P1.3: không xác nhận được tab kind → ok:false (chặn gửi sai loại media)

    let logParts = [];

    // 3. Chọn Kind (Image / Video) — P1.3: KHÔNG click lại khi đã đúng kind (predicate gồm
    // aria-checked + class .mat-button-toggle-checked + nhánh cũ); phải click thì verify NGAY
    // sau click bằng chính predicate đó (poll ≤1.4s, retry ≤2) → fail = kindFailed.
    const kindTextBtn = kind === 'vid' ? 'Video' : 'Image';
    if (await selectKindControl(() => findInPicker([kindTextBtn]), kindTextBtn)) {
      logParts.push(`Type: ${kindTextBtn}`);
    } else {
      kindFailed = true;
      logParts.push(`Type: fail (${kindTextBtn})`);
    }

    // 4. Chọn Ratio — FIX-WIN: verify-after-click (isControlOn giờ check cả aria-checked
    // của mat-button-toggle). Trước đây .click() thuần KHÔNG verify → click fail bị nuốt
    // → log 'Ratio: ok' nhưng Flow giữ ratio cũ (9:16) → ảnh extract sai tỷ lệ. Fail 3
    // lần → ratioFailed=true → return ok:false (fail-closed; generate hủy tạo).
    {
      let ratioOk = false;
      for (let attempt = 1; attempt <= 3 && !ratioOk; attempt += 1) {
        const rBtn = findInPicker([ratio], 'radio') || findInPicker([ratio]);
        if (!rBtn) {
          log(`Ratio: không tìm thấy control "${ratio}" (lần ${attempt}/3).`);
          await wait(400);
          continue;
        }
        let cur = false;
        try { cur = isControlOn(rBtn); } catch (_) { cur = false; }
        if (!cur) {
          try { rBtn.click(); } catch (_) {}
          await wait(300);
          try { cur = isControlOn(rBtn); } catch (_) { cur = false; }
        }
        if (!cur) {
          // JS click không ăn/nhả → fallback CDP (tìm lại + đo lại + verify)
          const fb = await clickRealVerified(
            () => findInPicker([ratio], 'radio') || findInPicker([ratio]),
            () => { const b = findInPicker([ratio], 'radio') || findInPicker([ratio]); return !!b && isControlOn(b); },
            { maxRetry: 2 }
          );
          ratioOk = fb.ok;
        } else {
          ratioOk = true;
        }
        if (!ratioOk) log(`⚠ Ratio "${ratio}" chưa chọn được (lần ${attempt}/3).`);
      }
      if (ratioOk) logParts.push(`Ratio: ${ratio}`);
      else { ratioFailed = true; logParts.push(`Ratio: fail (${ratio}) sau 3 lần`); }
    }

    // 5. Chọn Duration (chỉ Video) — verify-after-click (cùng pattern ratio luồng 2)
    if (kind === 'vid' && config.videoDuration) {
      const dur = `${config.videoDuration}s`;
      let durOk = false;
      for (let attempt = 1; attempt <= 3 && !durOk; attempt += 1) {
        const durBtn = findInPicker([dur], 'radio') || findInPicker([dur]);
        if (!durBtn) {
          log(`Dur: không tìm thấy control "${dur}" (lần ${attempt}/3).`);
          await wait(400);
          continue;
        }
        let cur = false;
        try { cur = isControlOn(durBtn); } catch (_) { cur = false; }
        if (!cur) {
          try { durBtn.click(); } catch (_) {}
          await wait(300);
          try { cur = isControlOn(durBtn); } catch (_) { cur = false; }
        }
        if (!cur) {
          const fb = await clickRealVerified(
            () => findInPicker([dur], 'radio') || findInPicker([dur]),
            () => { const b = findInPicker([dur], 'radio') || findInPicker([dur]); return !!b && isControlOn(b); },
            { maxRetry: 2 }
          );
          durOk = fb.ok;
        } else {
          durOk = true;
        }
        if (!durOk) log(`⚠ Duration "${dur}" chưa chọn được (lần ${attempt}/3).`);
      }
      if (durOk) logParts.push(`Dur: ${dur}`);
      else { durFailed = true; logParts.push(`Dur: fail (${dur}) sau 3 lần`); }
    }

    // 6. Chọn Quantity (x1) — verify-after-click; x1 là mặc định Flow nên qty fail chỉ
    // ghi vào log (KHÔNG abort — tránh chặn tạo khi Flow vốn đã đúng x1, probe Windows).
    {
      let qtyOk = false;
      for (let attempt = 1; attempt <= 3 && !qtyOk; attempt += 1) {
        const qBtn = findInPicker(['x1', '1x'], 'radio') || findInPicker(['x1', '1x']);
        if (!qBtn) {
          log(`Qty: không tìm thấy control x1 (lần ${attempt}/3).`);
          await wait(400);
          continue;
        }
        let cur = false;
        try { cur = isControlOn(qBtn); } catch (_) { cur = false; }
        if (!cur) {
          try { qBtn.click(); } catch (_) {}
          await wait(300);
          try { cur = isControlOn(qBtn); } catch (_) { cur = false; }
        }
        if (!cur) {
          const fb = await clickRealVerified(
            () => findInPicker(['x1', '1x'], 'radio') || findInPicker(['x1', '1x']),
            () => { const b = findInPicker(['x1', '1x'], 'radio') || findInPicker(['x1', '1x']); return !!b && isControlOn(b); },
            { maxRetry: 2 }
          );
          qtyOk = fb.ok;
        } else {
          qtyOk = true;
        }
        if (!qtyOk) log(`⚠ Qty x1 chưa chọn được (lần ${attempt}/3).`);
      }
      if (qtyOk) logParts.push('Qty: x1');
      else logParts.push(`Qty: fail${isPickerOpen() ? '' : ' (picker đóng)'}`);
    }

    // 7. Chọn Model — dùng CDP real click + retry + validate
    // Chỉ validate/chọn model nếu có truyền explicitly trong config. 
    // Nếu undefined, skip bước này (chỉ switch mode/ratio/duration).
    const modelName = kind === 'vid' ? config.videoModel : config.imageModel;
    let modelFailed = false; // T43: đánh dấu để trả ok:false (chặn tạo SAI model) khi không set được

    if (!modelName) {
      logParts.push('Model: giữ nguyên hiện tại');
    } else {
      const MAX_MODEL_ATTEMPTS = 4;
      let modelOk = false;

    // Đọc model hiện tại từ nút model dropdown trigger trong overlay
    // (Video mode KHÔNG hiện model trên Settings trigger trên trang chính, chỉ hiện trong overlay)
    const readCurrentModelFromTrigger = () => {
      // Ưu tiên đọc từ overlay (nếu picker đang mở)
      const oc = document.querySelector('.cdk-overlay-container');
      if (oc) {
        const modelBtn = findModelTriggerInOverlay(oc); // LABEL-FIRST: aria-label 'Select model family'
        if (modelBtn && modelBtn.offsetWidth > 0) {
          return labelTextOf(modelBtn); // T43: bỏ icon arrow_drop_down
        }
      }
      // Fallback: Settings trigger trên trang chính (chỉ đúng cho Image mode)
      const trigBtn = document.querySelector('button[aria-label="Settings trigger"]');
      if (trigBtn) return labelTextOf(trigBtn);
      return '(không tìm thấy trigger)';
    };

    // Validate: đọc model từ dropdown trigger trong overlay — so KHỚP CHÍNH XÁC
    // (modelKey ===, không substring) để KHÔNG nhận nhầm "Lite" ↔ "Lite [Lower
    // Priority]" / "Nano Banana 2" ↔ "Nano Banana 2 Lite" thành đúng.
    const validateModel = () => {
      const cur = readCurrentModelFromTrigger();
      if (!cur || cur.startsWith('(không')) return false;
      return modelKey(cur) === modelKey(modelName);
    };

      // Đọc trước
      const beforeModel = readCurrentModelFromTrigger();
      log(`Model hiện tại trên Flow: "${beforeModel}" — cần đổi sang: "${modelName}"`);

      if (validateModel()) {
        logParts.push(`Model: ${modelName} (giữ nguyên)`);
        modelOk = true;
        log(`✓ Model đã đúng, không cần đổi.`);
      } else {
        for (let attempt = 1; attempt <= MAX_MODEL_ATTEMPTS && !modelOk; attempt++) {
          log(`--- Thử chọn model "${modelName}" (lần ${attempt}/${MAX_MODEL_ATTEMPTS}) ---`);

          // Bước A: Đảm bảo picker đang mở (có thể đã bị đóng sau retry trước) — FIX-WIN:
          // clickRealVerified (tìm lại + đo lại + verify isPickerOpen) thay clickReal
          if (!isPickerOpen()) {
            log(`Picker đã đóng — mở lại...`);
            const res = await clickRealVerified(findCompactPickerButton, () => isPickerOpen(), { maxRetry: 3 });
            if (!res.ok) {
              log(`⚠ Không mở lại được picker — bỏ qua lần ${attempt}.`);
              continue;
            }
            await wait(300);
          }

          // Bước B: Chuyển sang tab đúng (Image/Video) trong picker — P1.3: dùng CHUNG
          // selectKindControl (không click lại khi đã đúng kind + verify sau click).
          const kindTextBtn = kind === 'vid' ? 'Video' : 'Image';
          if (!(await selectKindControl(() => findInPicker([kindTextBtn]), kindTextBtn))) {
            log(`⚠ Lần ${attempt}: chưa xác nhận được tab ${kindTextBtn} trong picker — thử lại.`);
            continue;
          }

        // Bước C: Tìm model trigger trong overlay — LABEL-FIRST (aria-label 'Select model
        // family', fallback aria-haspopup=menu — user yêu cầu label-first)
        const oc = document.querySelector('.cdk-overlay-container') || document;
        const modelTrigger = findModelTriggerInOverlay(oc);
        if (!modelTrigger) {
          log(`⚠ Lần ${attempt}: Không tìm thấy model trigger (label 'Select model family'/aria-haspopup=menu) trong overlay.`);
          await wait(500);
          continue;
        }
        log(`Lần ${attempt}: Tìm thấy trigger: "${modelTrigger.textContent.replace(/\s+/g,' ').trim()}" — CDP click...`);

        // Bước D: Click trigger — clickRealVerified (tìm lại + đo lại + verify menu items
        // xuất hiện) thay clickReal + wait cố định; label-first theo Bước C
        const dres = await clickRealVerified(
          () => findModelTriggerInOverlay(document.querySelector('.cdk-overlay-container') || document),
          () => [...(document.querySelector('.cdk-overlay-container') || document).querySelectorAll(MENU_ITEMS_SEL)].length > 0,
          { maxRetry: 2 }
        );
        await wait(500);
        if (!dres.ok) {
          log(`⚠ Lần ${attempt}: dropdown model không mở được sau click.`);
          await wait(500);
          continue;
        }

        // Bước E: Tìm option trong dropdown
        const menuItems = [...oc.querySelectorAll(MENU_ITEMS_SEL)];
        log(`Lần ${attempt}: Tìm thấy ${menuItems.length} menu items: ${menuItems.map(b => b.textContent.replace(/\s+/g,' ').trim()).join(' | ')}`);

        const targetOption = menuItems.find(btn => modelKey(labelTextOf(btn)) === modelKey(modelName));

        if (!targetOption) {
          log(`⚠ Lần ${attempt}: Không tìm thấy option "${modelName}" — đóng dropdown.`);
          document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
          await wait(800);
          continue;
        }

        log(`Lần ${attempt}: Tìm thấy option "${targetOption.textContent.replace(/\s+/g,' ').trim()}" — CDP click...`);
        // Bước E (click): clickRealVerified với verify = validateModel (đọc lại model từ
        // trigger sau click) — thay clickReal không verify
        const ores = await clickRealVerified(
          () => [...(document.querySelector('.cdk-overlay-container') || document).querySelectorAll(MENU_ITEMS_SEL)]
            .find(btn => modelKey(labelTextOf(btn)) === modelKey(modelName)),
          () => validateModel(),
          { maxRetry: 2 }
        );
        await wait(500);

        // Bước F: VALIDATE — đọc lại Settings trigger trên trang chính (clickRealVerified
        // đã verify validateModel; đọc lại chỉ để ghi log theo dõi)
        const afterModel = readCurrentModelFromTrigger();
        log(`Lần ${attempt} VALIDATE: TRƯỚC="${beforeModel}" → SAU="${afterModel}" — mong đợi chứa "${modelName}"`);

        if (ores.ok) {
          modelOk = true;
          logParts.push(`Model: ${modelName}`);
          log(`✓ VALIDATE OK: Model đã đổi thành công sang "${modelName}" (lần ${attempt}).`);
        } else {
          log(`❌ VALIDATE FAIL: Settings trigger vẫn là "${afterModel}", chưa đổi sang "${modelName}".`);
          // Đóng dropdown nếu còn mở, KHÔNG đóng picker (để retry không cần mở lại)
          const menuStillOpen = oc.querySelectorAll('flow-menu-item').length > 0;
          if (menuStillOpen) {
            document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
            await wait(500);
          }
        }
      }

      if (!modelOk) {
        modelFailed = true;
        logParts.push(`Model: FAIL sau ${MAX_MODEL_ATTEMPTS} lần (${modelName})`);
        log(`❌ THẤT BẠI HOÀN TOÀN: Không thể chọn model "${modelName}" sau ${MAX_MODEL_ATTEMPTS} lần thử.`);
      }
    }
    }

    // Đóng Compact Picker an toàn
    if (isPickerOpen()) {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
      await wait(300);
      if (isPickerOpen()) {
        const backdrop = document.querySelector('.cdk-overlay-backdrop');
        if (backdrop) backdrop.click();
        else await clickReal(picker);
      }
    }
    await wait(300);

    const finalLog = `Cấu hình: ${logParts.join(' | ')}`;
    log(((modelFailed || ratioFailed || durFailed || kindFailed) ? '⚠ ' : '✓ ') + finalLog);
    // T43: model được yêu cầu nhưng KHÔNG set chính xác được → trả ok:false để
    // caller (generate/applySettingsNow) HỦY tạo, tránh chạy SAI model tốn credit.
    // FIX-WIN (luồng 2): ratio fail cũng phải ok:false — trước đây chỉ model mới fail,
    // ratio fail bị nuốt → Flow giữ ratio cũ (9:16) → ảnh extract ra SAI tỷ lệ mà vẫn
    // tốn credit. dur/qty chỉ ghi vào log (qty x1 là mặc định Flow; dur fail nhẹ hơn).
    // P1.3: kind (Image/Video) không xác nhận được cũng fail-closed — gửi prompt khi
    // UI còn ở kind kia = tạo SAI loại media.
    // RC-6 (#24): durFailed trước đây bị THIẾU ở đây — bằng chứng live 20/9 20:20:11:
    // log 'Dur: fail (8s) sau 3 lần' mà vẫn trả ok:true ⇒ Flow chạy sai thời lượng mà
    // caller không hề biết. Duration fail giờ fail-closed như ratio/kind/model.
    return { ok: !modelFailed && !ratioFailed && !kindFailed && !durFailed, log: finalLog };
  }

  // -------------------------------------------------------------------------
  // G9/S2 (#24) — CHUẨN HOÁ nhãn control đã ON sang dạng so sánh được với config:
  // Flow render ratio bằng ICON ligature 'crop_16_9' (probe: trigger '... crop_9_16 x1'),
  // duration '8s', quantity 'x1' (kiểu cũ '1x' cũng chấp nhận). Trả null khi nhãn KHÔNG
  // thuộc loại — nhờ vậy control '720p' (độ phân giải, cũng là radio ON) không lẫn vào
  // ratio/dur/qty. KHÔNG hard-code tập giá trị: quét control ON thật trong pane.
  // -------------------------------------------------------------------------
  function ratioFromControlLabel(t) {
    const s = String(t || '').trim();
    const m = s.match(/^(?:crop_(\d+)_(\d+)|(\d+)\s*[:x]\s*(\d+))$/i);
    if (!m) return null;
    return `${m[1] || m[3]}:${m[2] || m[4]}`;
  }
  function durFromControlLabel(t) {
    const m = /^(\d+)\s*s$/i.exec(String(t || '').trim());
    return m ? `${m[1]}s` : null;
  }
  function qtyFromControlLabel(t) {
    const m = /^(?:x(\d+)|(\d+)x)$/i.exec(String(t || '').trim());
    return m ? `x${m[1] || m[2]}` : null;
  }
  // Danh sách control ĐANG ON trong scope (pane picker) + label SẠCH của chúng.
  // isControlOn STRICT trên chính element (N1) — span con của radio ON không bị tính,
  // state radio nằm ngay trên button[role=radio] (probe mat-button-toggle).
  function readOnControlLabels(scope) {
    let els = [];
    try { els = scope ? [...scope.querySelectorAll('[role="radio"], [role="button"], mat-button-toggle, button, span')] : []; } catch (_) { els = []; }
    const out = [];
    for (const el of els) {
      if (!el) continue;
      if (!(el.offsetWidth > 0 && el.offsetHeight > 0)) continue; // control ẩn = pane khác
      let on = false;
      try { on = isControlOn(el); } catch (_) { on = false; }
      if (!on) continue;
      let label = '';
      try { label = labelTextOf(el); } catch (_) { label = ''; }
      if (!label) { try { label = el.getAttribute ? (el.getAttribute('aria-label') || '') : ''; } catch (_) { /* bỏ qua */ } }
      out.push(label);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // G9/S2 (#24): ĐỌC lại cấu hình THẬT đang ON trong Compact Picker (RC-3, RC-5).
  // Thuần ĐỌC — không bấm sang control nào; nguồn là state DOM sau cùng, KHÔNG phải
  // lệnh đã gửi (đó là điểm khác biệt với verify trong applyConfigViaPicker, vốn chỉ
  // đúng TẠI LÚC CLICK, trong overlay — RC-3). Bắt buộc MỞ picker từng kind vì Video
  // model KHÔNG hiện trên Settings trigger trang chính, chỉ trong overlay (RC-5).
  // Trả { ok:true, values:{type,ratio,dur,qty,model} } (null = ô không đọc được) hoặc
  // { ok:false, reason }. MỌI đường thoát đều ĐÓNG picker qua closeChain (finally).
  // ---------------------------------------------------------------------------
  async function readFlowSettingsFromPicker(kind) {
    const kindText = kind === 'vid' ? 'Video' : 'Image';
    if (!(await ensureAgentOff())) return { ok: false, reason: 'agent-on' };
    const picker = await waitFor(findCompactPickerButton, 4000);
    if (!picker) return { ok: false, reason: 'no-compact-picker-button' };
    if (!isPickerOpen()) {
      const res = await clickRealVerified(findCompactPickerButton, () => isPickerOpen(), { maxRetry: 3 });
      if (!res.ok) return { ok: false, reason: 'picker-not-opened' };
      await wait(200);
    }
    let values = null;
    try {
      const findInPicker = (textMatchers, role = null) => findInPopover(textMatchers, role, findPickerPane());
      // Đúng kind trước khi đọc — nếu còn ở kind kia thì mọi ô đọc được là CỦA kind khác.
      if (!(await selectKindControl(() => findInPicker([kindText]), kindText))) {
        return { ok: false, reason: 'kind-not-confirmed' };
      }
      const pane = findPickerPane();
      if (!pane) return { ok: false, reason: 'picker-closed' };
      const onLabels = readOnControlLabels(pane);
      const firstOn = (conv) => {
        for (const l of onLabels) { const v = conv(l); if (v) return v; }
        return null;
      };
      const kindHost = () => {
        const raw = findInPicker([kindText]);
        if (!raw || !raw.closest) return raw || null;
        return raw.closest('button, [role="tab"], [role="button"], mat-button-toggle') || raw;
      };
      const kb = kindHost();
      let typeOn = false;
      try { typeOn = !!kb && isKindControlOn(kb); } catch (_) { typeOn = false; }
      // Model: đọc từ trigger trong overlay (label hiện chính model đang chọn) —
      // LABEL-FIRST qua findModelTriggerInOverlay, KHÔNG mở menu model (chỉ đọc).
      const oc = document.querySelector('.cdk-overlay-container') || document;
      let modelTrigger = null;
      try { modelTrigger = findModelTriggerInOverlay(oc); } catch (_) { modelTrigger = null; }
      let model = null;
      if (modelTrigger && modelTrigger.offsetWidth > 0) {
        try { model = labelTextOf(modelTrigger) || null; } catch (_) { model = null; }
      }
      // Dur fallback (G9 closeout, live 21/9): model Veo trên Flow KHÔNG expose control
      // duration trong pane (probe: 'Dur: không tìm thấy control "8s"' ×3 trong khi
      // ratio/qty/model đọc OK) ⇒ dur ONLY khả dụng ở dòng trigger chính
      // 'Video · 720p · 8s crop_9_16 x1'. Chỉ tin trigger khi nó XÁC NHẬN đúng kind
      // (chứa token Video/Image tương ứng) — trigger là composer-state đang áp dụng,
      // tức chính là thứ modal cần chứng minh. Không có cả hai nguồn → null (bad thật,
      // không bịa).
      let durVal = null;
      if (kind === 'vid') {
        durVal = firstOn(durFromControlLabel);
        if (!durVal) {
          const trigEl = findCompactPickerButton();
          const trigTxt = trigEl ? labelTextOf(trigEl) : '';
          const trigIsKind = /video/i.test(trigTxt);
          if (trigIsKind) {
            const m = /\b(\d+)\s*s\b/i.exec(trigTxt);
            if (m) durVal = m[1] + 's';
          }
        }
      }
      values = {
        type: typeOn ? (labelTextOf(kb) || kindText) : null,
        ratio: firstOn(ratioFromControlLabel),
        dur: durVal,
        qty: firstOn(qtyFromControlLabel),
        model,
        // G9/S2 (advisory review): Flow đọc label THÔ (vd "🍌 Nano Banana Pro").
        // S3 so khớp bằng modelKey CANONICAL (nguồn duy nhất = modelKey đầu file này,
        // semantics T43: bỏ emoji/dash/bracket, lowercase) — tránh substring 'Lite' ↔
        // 'Lite [Lower Priority]'. expected.{img,vid}.modelKey cũng được content canonical
        // hoá ở handler; label thô vẫn giữ để modal IN ra cho user.
        modelKey: model ? modelKey(model) : null,
      };
    } catch (err) {
      return { ok: false, reason: 'read-exception: ' + String((err && err.message) || err) };
    } finally {
      await closeChain(); // G9/S2 readback finally
      if (isPickerOpen()) log('⚠ readFlowSettingsFromPicker: closeChain KHÔNG đóng được Compact Picker — overlay còn mở.');
    }
    return { ok: true, values };
  }

  async function applySettings(config) {
    return { ok: true, log: 'Bỏ qua applySettings (đã gộp vào generate qua Compact Picker)' };
  }

  async function setDurationNative(seconds, videoModel) {
    return { ok: true, actual: seconds };
  }

  // ---------------------------------------------------------------------------
  // Best-effort: ensure the chosen model is selected in tune Settings. [P0]
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Best-effort: ensure the chosen model is selected. [P0]
  // ---------------------------------------------------------------------------
  async function ensureModel(modelLabel) {
    // Trỏ về logic mới dùng Compact Picker
    const { ok, log: msg } = await applyConfigViaPicker('vid', { videoModel: modelLabel });
    if (!ok) log(`CẢNH BÁO ensureModel: ${msg}`);
    return ok;
  }

  // ---------------------------------------------------------------------------
  // Composer: CDP trusted input (Slate.js CHỈ nhận real typing).
  // ---------------------------------------------------------------------------
  // T-fix: Cmd/Ctrl+C → Cmd/Ctrl+V qua CDP KHÔNG tạo được paste bản địa cho
  // ProseMirror (CDP-verified: Meta+V không chèn gì). Gõ bằng Input.insertText
  // MỘT LẦN toàn bộ prompt — ProseMirror xử lý beforeinput insertText → chèn đủ
  // (kể cả tiếng Việt + xuống dòng). KHÔNG dùng typeHuman chunk (lỗi lung tung).
  async function typePrompt(text) {
    const composer = findComposer();
    if (!composer) {
      log('Không tìm thấy composer (div contenteditable role=textbox).');
      return false;
    }
    log(`typePrompt: gõ ${text.length} ký tự. Đầu: "${text.slice(0, 80)}..." Cuối: "...${text.slice(-40)}"`);
    const r = composer.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const insRes = await chrome.runtime.sendMessage({ type: 'cdp:typeText', text, x, y }).catch(() => null);
    if (!(insRes && insRes.ok)) {
      log('⚠ typePrompt: gõ prompt (Input.insertText) thất bại.');
      return false;
    }
    // Verify: đọc lại nội dung composer
    await wait(350);
    const composerText = composer.textContent || '';
    log(`typePrompt: INSERT OK. Composer chứa ${composerText.length} ký tự.`);
    if (composerText.length < text.length * 0.8) {
      log(`⚠ typePrompt: Composer chỉ có ${composerText.length}/${text.length} ký tự — có thể bị cắt!`);
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Image upload: set files via DataTransfer and dispatch change. [P0]
  // ---------------------------------------------------------------------------
  function uploadImage(file) {
    const input = findUploadInput();
    if (!input) {
      log('Không tìm thấy input[type="file"] để upload ảnh.');
      return false;
    }
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    log(`Đã đính kèm ảnh "${file.name}".`);
    return true;
  }

  // ---------------------------------------------------------------------------
  // UI mới (flow.google.com — Angular Material): upload 1 ảnh ref khi KHÔNG có
  // input[type=file] tĩnh (labs). Flow bắt buộc qua add-ref dialog:
  //   mở dialog (findAddDialogTrigger — aria 'Add ingredients to the prompt box')
  //   → tab Uploads (mat-mdc-list-item) → nút 'Upload media' (mdc-button 'upload
  //   Upload media') → input[type=file] Ẩn MỚI TẠO (dưới body) → set file +
  //   dispatch change → poll asset MỚI trong list Uploads (src lạ / tên file)
  //   → chọn asset item + 'Add to prompt' → dialog đóng, chip ref trong composer.
  // Trả {ok:true, url} (url src asset mới) | {ok:false, reason}. HÀM MỚI — nhánh
  // uploadImage (input tĩnh labs) giữ nguyên, không đụng nhau.
  // ---------------------------------------------------------------------------
  // UI mới flow.google.com: dialog add-ref = .cdk-overlay-pane (Angular), KHÔNG [role=dialog].
  // labs cũ dùng [role=dialog]. Trả root dialog tìm được (element) hoặc null.
  function findAddDialogRoot() {
    const d = document.querySelector('[role="dialog"]');
    if (d) return d;
    const panes = [...document.querySelectorAll('.cdk-overlay-pane')];
    return panes.find((p) => {
      const r = p.getBoundingClientRect();
      if (r.width < 300 || r.height < 300) return false;
      const t = (p.textContent || '');
      return /add to prompt|uploads|upload media/i.test(t);
    }) || null;
  }

  // Root of the add-ref dialog that ACTUALLY carries asset identity ([data-media-id]).
  // MUST be scoped to the dialog element `dlg` the caller already opened: a SIBLING
  // overlay (project popover, model menu, another pane with media ids) scanned
  // document-wide can be mistaken for the Uploads asset list, and its ids would then
  // pass as "our upload". Checks dlg's own subtree only; a tighter descendant pane
  // wins when it carries the ids. NEVER falls back to a document-wide scan. Defensive:
  // without dlg, the scope is findAddDialogRoot() (still no document-wide id hunt).
  function findAddDialogIdRoot(dlg) {
    const scope = dlg || findAddDialogRoot();
    if (!scope) return null;
    const hasIds = (el) => {
      try {
        return !!(el.querySelector && el.querySelector('[data-media-id]')) ||
          !!((el.querySelectorAll && el.querySelectorAll('[data-media-id]') || []).length);
      } catch (_) { return false; }
    };
    if (!hasIds(scope)) return null;
    const inner = [...scope.querySelectorAll('[role="dialog"], .cdk-overlay-pane, [class*="overlay-pane" i]')]
      .filter((r) => r !== scope)
      .find(hasIds);
    return inner || scope;
  }

  // Mở add-ref dialog BỀN — dùng chung (uploadImageViaDialog + attachRefsByDialog).
  // FIX-WIN stale-coordinate (root cause "upload fail chỉ trên Windows" + lỗi
  // extractModel 'dialog không mở sau 5s' 2026-09-08): Flow dịch vị ~56px giữa lúc đo
  // elCenter và lúc Input.dispatchMouseEvent tới trang (200-800ms do SW wake +
  // chrome.debugger.attach + bézier moveMouse) → click tọa độ CŨ trượt. Semantics giữ
  // Y HỆT vòng retry uploadImageViaDialog (7ca8f5b): scrollIntoView + đo NGAY trước
  // cdp:click (không await xen) + waitFor(findAddDialogRoot, waitMs) → chưa mở:
  // pre-check dialog TRƯỚC khi click lại (tránh click trúng backdrop làm đóng) →
  // re-measure + re-click ≤ maxAttempts.
  // Trả { dlg, clickFailed }: dlg = dialog element | null (chưa mở sau retry);
  // clickFailed = true khi cdp:click chính nó fail (caller phân biệt reason như cũ).
  async function openAddRefDialogWithRetry(trigger, opts = {}) {
    const maxAttempts = opts.maxAttempts || 3;
    const waitMs = opts.waitMs || 1500;
    const prefix = opts.prefix || 'add-ref dialog';
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (attempt > 1) {
        // dialog có thể vừa mở trễ từ click trước (lazy render) — check TRƯỚC khi click
        // lại, tránh click trúng backdrop của dialog đang mở làm nó đóng.
        const pre = findAddDialogRoot();
        if (pre) return { dlg: pre, clickFailed: false };
        log(`${prefix}: chưa mở trong ${waitMs}ms (lần ${attempt - 1}) — đo lại tọa độ + click lại (stale-coordinate fix)...`);
      }
      try { trigger.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (_) {}
      // đo NGAY + gửi ngay: KHÔNG được chèn await nào giữa elCenter và cdp:click
      const tc = elCenter(trigger);
      if (!(await clickCdpxy(tc.x, tc.y, trigger))) {
        return { dlg: null, clickFailed: true };
      }
      const dlg = await waitFor(() => findAddDialogRoot(), waitMs);
      if (dlg) return { dlg, clickFailed: false };
    }
    return { dlg: null, clickFailed: false };
  }

  // G10-QA-D (live incident 2026-09-23, "upload chưa xong => chọn ảnh bậy bạ"):
  // The old asset detection was provably unsafe — baselineSrcs was captured BEFORE the
  // dialog mounted (every lazily-rendered OLD thumb looked "new"), and the name-only
  // match re-fires on a stale same-name item forever. Neither can tell the just-uploaded
  // asset from an existing one. These three helpers replace that chain on the
  // addToPrompt path with an ID-authoritative contract: snapshot every media identity the
  // dialog list can show BEFORE the upload starts, accept ONLY an id that newly appears
  // AFTER it, select the item BY that id, and require the composer chip to carry the
  // same id. Any unverifiable step => {ok:false} BEFORE Send. Name is NEVER proof.

  // 36-char uuid form (flow-content/<uuid> | ?name=<uuid>) — the only src-derived id
  // trusted as identity (mediaIdOf's last-segment fallback is noise for other URLs).
  function isUuidMediaId(d) {
    return !!d && d.length === 36 && /^[0-9a-f-]+$/i.test(d);
  }

  // Collect media identities visible under `root`: every [data-media-id] (home tiles,
  // dialog asset items) + every uuid-form id from media img srcs.
  function collectDialogAssetIdsInto(root, ids) {
    if (!root) return;
    for (const el of root.querySelectorAll('[data-media-id]')) {
      const d = String((el.getAttribute && el.getAttribute('data-media-id')) || '').toLowerCase();
      if (d) ids.add(d);
    }
    for (const im of root.querySelectorAll('img')) {
      const s = im.currentSrc || im.src || '';
      if (!isMediaSrc(s)) continue;
      const d = String(mediaIdOf(s) || '').toLowerCase();
      if (isUuidMediaId(d)) ids.add(d);
    }
  }

  // Full snapshot of the dialog's asset list BEFORE the upload can create anything.
  // Includes one pass through the dialog virtual list (items below the fold are
  // unmounted; if they mount later their OLD ids would look "new" — enumerate them now).
  // Scroll position is restored. A throw => ok:false (caller fail-closes: an incomplete
  // snapshot cannot separate new media from old, the exact incident being fixed).
  async function snapshotDialogAssetIds(dlg) {
    const ids = new Set();
    try {
      // Dialog scope = `dlg` + its descendants ONLY. The old `|| findAddDialogRoot()`
      // fallback scanned document-wide on a pane TEXT heuristic ('uploads' / 'add to
      // prompt') — a SEMANTIC sibling overlay (e.g. another 'Uploads' pane carrying
      // media ids) could be selected whenever dlg's subtree had no [data-media-id]
      // yet, and its ids would pass as OUR upload (review finding on a24c00c). Banned
      // here: when dlg is null/closed, root is null and the fail-closed paths below
      // handle it.
      const rootOf = () => findAddDialogIdRoot(dlg) || dlg;
      const root = rootOf();
      if (!root) return { ok: false, reason: 'dialog không còn mở' };
      collectDialogAssetIdsInto(root, ids);
      const vp = root.querySelector('cdk-virtual-scroll-viewport, [class*="virtual-scroll" i]');
      if (vp && vp.scrollHeight > vp.clientHeight) {
        const originalTop = vp.scrollTop;
        const step = Math.max(200, Math.floor(vp.clientHeight * 0.7));
        const maxY = vp.scrollHeight - vp.clientHeight;
        for (let y = step; y <= maxY + step; y += step) {
          vp.scrollTop = Math.min(y, maxY);
          vp.dispatchEvent(new Event('scroll', { bubbles: true }));
          await wait(250);
          collectDialogAssetIdsInto(rootOf(), ids);
        }
        vp.scrollTop = originalTop;
        vp.dispatchEvent(new Event('scroll', { bubbles: true }));
        await wait(200);
      }
    } catch (e) {
      return { ok: false, reason: 'snapshot lỗi: ' + String((e && e.message) || e) };
    }
    return { ok: true, ids };
  }

  // Poll the dialog asset list for a media id NOT in `beforeIds` = the asset this very
  // upload created (upload completion is proven by the id appearing, not by the input's
  // reply). Returns {id, el} (el = element carrying the id), 'unusual', 'ambiguous', or
  // null on timeout. Dialog-scoped only — an id appearing elsewhere (home lazy remount)
  // is not evidence of our upload.
  // GAP A (review): the FIRST unseen id is not proof — a concurrent job / another tab /
  // a Flow remount can surface a SECOND id right after. Contract: exactly ONE fresh id
  // ever seen, or abort. Once one id is found, a bounded settle window keeps scanning;
  // >=2 distinct ids at any point => 'ambiguous' (fail closed, nothing gets clicked).
  async function pollDialogNewAssetId(dlg, beforeIds, timeoutMs, unusualBaseline) {
    const SETTLE_MS = 1800;
    const deadline = Date.now() + (timeoutMs || 20000);
    const scanNew = () => {
      const out = [];
      // Same ban as snapshotDialogAssetIds: NEVER resolve the scan root document-wide
      // (findAddDialogRoot's text heuristic can pick a semantic sibling overlay whose
      // ids are not this upload). dlg subtree only; null dlg/no ids => scan nothing.
      const root = findAddDialogIdRoot(dlg) || dlg;
      if (!root) return out;
      for (const el of root.querySelectorAll('[data-media-id]')) {
        const d = String((el.getAttribute && el.getAttribute('data-media-id')) || '').toLowerCase();
        if (d && !beforeIds.has(d)) out.push({ id: d, el });
      }
      for (const im of root.querySelectorAll('img')) {
        const s = im.currentSrc || im.src || '';
        if (!isMediaSrc(s)) continue;
        const d = String(mediaIdOf(s) || '').toLowerCase();
        if (isUuidMediaId(d) && !beforeIds.has(d)) {
          const host = (im.closest && im.closest('button.asset-item, [role="option"]')) || im;
          out.push({ id: d, el: host });
        }
      }
      return out;
    };
    const fresh = new Map(); // id -> latest element carrying it (never shrinks)
    const absorb = () => { for (const c of scanNew()) fresh.set(c.id, c.el); return fresh.size; };
    while (Date.now() < deadline) {
      if (unusualNotiCount() > (unusualBaseline || 0)) return 'unusual';
      if (absorb() >= 2) return 'ambiguous';
      if (fresh.size === 1) {
        const settleUntil = Date.now() + SETTLE_MS;
        while (Date.now() < settleUntil) {
          if (unusualNotiCount() > (unusualBaseline || 0)) return 'unusual';
          await wait(300);
          if (absorb() >= 2) return 'ambiguous';
        }
        const [only] = [...fresh.entries()];
        return { id: only[0], el: only[1] };
      }
      await wait(400);
    }
    return null;
  }

  // The composer chip that provably references `id`: ONLY the approved identity forms —
  // chip host [data-media-id] == id, or chip img src whose UUID-form media id == id.
  // GAP B (review): an lh3 thumbnail token match is NOT authoritative identity (two
  // uploads of the same image, or size-suffix stripping, can collide) — no token
  // fallback. A chip that exposes neither form yields null => caller aborts BEFORE Send.
  function findComposerChipForId(id, itemSrc) {
    const want = String(id || '').toLowerCase();
    if (!want) return null;
    const hosts = [...document.querySelectorAll('button.chip-container, [aria-label="Ingredient"], button[data-card-open]')];
    for (const chipImg of document.querySelectorAll('img.chip-image, .flow-ingredient-bar img')) {
      const h = (chipImg.closest && chipImg.closest('button.chip-container, [aria-label="Ingredient"], button[data-card-open]')) || chipImg;
      if (!hosts.includes(h)) hosts.push(h);
    }
    for (const h of hosts) {
      const idNodes = [h, ...(h.querySelectorAll ? [...h.querySelectorAll('[data-media-id]')] : [])];
      for (const a of idNodes) {
        if (String((a.getAttribute && a.getAttribute('data-media-id')) || '').toLowerCase() === want) return h;
      }
      const imgs = h.querySelectorAll ? [...h.querySelectorAll('img')] : [];
      if (h.tagName === 'IMG') imgs.push(h);
      for (const im of imgs) {
        const s = im.currentSrc || im.src || '';
        if (!s) continue;
        if (String(mediaIdOf(s) || '').toLowerCase() === want) return h;
      }
    }
    return null;
  }
  async function uploadImageViaDialog(file, opts = {}) {
    // baseline src TRƯỚC khi set file — nhận asset mới sau upload bằng src lạ
    const baselineSrcs = new Set(
      [...document.querySelectorAll('img')].map((i) => i.currentSrc || i.src || '')
    );
    // (FIX 3) baseline unusual notice TRƯỚC khi upload — nếu "unusual activity" dialog
    // xuất hiện trong lúc chờ asset → fail sớm thay vì chờ 15s timeout vô ích.
    const unusual0 = unusualNotiCount();

    // (1) mở add-ref dialog (CDP click — giống attachRefsByDialog).
    // FIX-WIN: stale-coordinate click (root cause "upload fail chỉ trên Windows").
    // Trên Windows, composer/nút add-ref có thể DỊCH VỊ (~56px — Flow UI toggle state
    // container, KHÔNG thêm node DOM, KHÔNG scroll viewport — probe CDP live 2026-09-08)
    // giữa lúc đo elCenter và lúc Input.dispatchMouseEvent tới trang (200-800ms do SW
    // wake + chrome.debugger.attach + bézier moveMouse). Click vô tọa độ CŨ → trượt
    // xuống tiles-container → dialog không mở. Fix: scrollIntoView + đo NGAY trước mỗi
    // click (không await giữa elCenter và sendMessage) + khi dialog chưa mở trong 1.5s
    // thì ĐO LẠI + click lại (tối đa 3 lần) thay vì chờ 1 lần 5s rồi bỏ cuộc.
    const trigger = findAddDialogTrigger();
    if (!trigger) {
      log('upload dialog: không tìm thấy nút mở add-ref dialog (aria "Add ingredients to the prompt box").');
      return { ok: false, reason: 'no add-ref trigger' };
    }
    // Mở dialog bằng helper dùng chung openAddRefDialogWithRetry — semantics giữ Y HỆT
    // vòng retry 7ca8f5b (scrollIntoView + đo NGAY trước click + retry ≤3 + pre-check
    // dialog trước khi click lại). Contract fail giữ nguyên ('cdp:click add-ref thất
    // bại' / 'add-ref dialog không mở').
    let dlg = null;
    {
      const r = await openAddRefDialogWithRetry(trigger, { prefix: 'upload dialog' });
      if (r.clickFailed) {
        log('upload dialog: cdp:click nút add-ref thất bại.');
        return { ok: false, reason: 'cdp:click add-ref thất bại' };
      }
      dlg = r.dlg;
    }
    if (!dlg) return { ok: false, reason: 'add-ref dialog không mở' };

    // (2) tab Uploads (mat-mdc-list-item text 'Uploads' — 7 tabs dọc trái)
    const uploadsTab = await waitFor(() => {
      const scope = findAddDialogRoot() || dlg;
      return [...scope.querySelectorAll('mat-mdc-list-item, mat-list-item, [role="tab"], [role="listitem"]')]
        .find((t) => /^uploads$/i.test(norm(t.textContent)) ||
          /^uploads$/i.test(norm((t.getAttribute && t.getAttribute('aria-label')) || '')));
    }, 4000);
    if (uploadsTab) {
      const uc = elCenter(uploadsTab);
      if (!(await clickCdpxy(uc.x, uc.y, uploadsTab))) log('upload dialog: cdp:click tab Uploads thất bại — thử thẳng nút Upload media.');
      await wait(400);
    } else {
      log('upload dialog: không thấy tab Uploads — thử trực tiếp nút "Upload media".');
    }

    // (3) nút 'Upload media' (mdc-button text 'upload Upload media')
    const uploadBtn = await waitFor(() => {
      const scope = findAddDialogRoot() || dlg;
      return [...scope.querySelectorAll('button, [role="button"]')].find((b) => {
        const t = norm(b.textContent);
        const al = (b.getAttribute && b.getAttribute('aria-label')) || '';
        return (/upload/.test(t) && /media/i.test(t)) || /upload.*media/i.test(al);
      });
    }, 4000);
    if (!uploadBtn) return { ok: false, reason: 'không thấy nút "Upload media"' };

    // G10-QA-D: ID-authoritative contract (addToPrompt path only). Snapshot EVERY media
    // identity that could show up as a dialog item BEFORE the upload can create one:
    // dialog-list ids (incl. one scroll pass for below-the-fold items) UNION the home
    // grid via fullMediaBaseline (the proven scroll-accumulate diff mechanism). Taken
    // before the chooser is opened and before `change` is dispatched — nothing between
    // here and then can create media. An un-enumerable snapshot => {ok:false} BEFORE
    // upload (fail closed: cannot tell new from old without a complete before-set).
    let beforeIds = null;
    if (opts.addToPrompt) {
      const dlgIds = await snapshotDialogAssetIds(dlg);
      if (!dlgIds.ok) {
        log(`upload dialog: ${dlgIds.reason} — HỦY trước upload (không chốt được danh sách media cũ).`);
        return { ok: false, reason: 'snapshot dialog asset thất bại' };
      }
      const base = await fullMediaBaseline('img');
      if (!base.ok) {
        log(`upload dialog: ${base.reason} — HỦY trước upload (không chốt được baseline media).`);
        return { ok: false, reason: 'baseline media thất bại' };
      }
      beforeIds = new Set([...dlgIds.ids, ...base.ids]);
    }

    // (P-fix) BẬT CDP intercept file chooser TRƯỚC cdp:click 'Upload media':
    // Page.setInterceptFileChooserDialog (background) chặn native file browser
    // (window treo lên màn hình user) — file vẫn set qua DataTransfer như cũ.
    // Chrome 151 chỉ mở chooser khi có user activation — cdp:click dùng
    // Input.dispatchMouseEvent (trusted click) nên đủ. Background cũ không có
    // handler → resolve undefined → bỏ qua, native window có thể pop (fallback).
    let interceptOn = false;
    try {
      const r = await chrome.runtime.sendMessage({ type: 'cdp:interceptChooserOn' });
      interceptOn = !!(r && r.ok);
    } catch (_) {
      // background cũ / lỗi — vẫn click tiếp
    }
    // P2 (stale-coordinate): cdp:interceptChooserOn ở TRÊN là 1 await (SW wake +
    // attach + Page.enable ≈ 200-800ms) → toạ độ đo TRƯỚC await đó đã cũ. Đo LẠI
    // ngay trước click (dialog không re-render trong lúc bật intercept) và truyền
    // uploadBtn làm marker → background chặn dispatch nếu elementFromPoint lệch.
    const bc = elCenter(uploadBtn);
    if (!(await clickCdpxy(bc.x, bc.y, uploadBtn))) {
      // (P-fix) click fail → thả session chooser (không để debugger giữ tab)
      try { await chrome.runtime.sendMessage({ type: 'cdp:interceptChooserOff' }); } catch (_) {}
      log('upload dialog: cdp:click "Upload media" thất bại.');
      return { ok: false, reason: 'cdp:click Upload media thất bại' };
    }

    // (4) input[type=file] Ẩn MỚI TẠO (Angular render dưới body sau khi click
    // 'Upload media') — chọn input mới nhất vừa xuất hiện (bỏ input cũ do chính
    // automation tạo ở lần upload trước — data-flow-auto-upload); set file bằng
    // DataTransfer + change (cùng cơ chế uploadImage).
    const input = await waitFor(() => {
      const inputs = [...document.querySelectorAll('input[type="file"]')].filter(
        (i) => !i.disabled && !i.dataset.flowAutoUpload
      );
      return inputs.length ? inputs[inputs.length - 1] : null;
    }, 5000);
    if (!input) {
      // (P-fix) click rồi mà input mới không xuất hiện → thả session chooser
      try { await chrome.runtime.sendMessage({ type: 'cdp:interceptChooserOff' }); } catch (_) {}
      return { ok: false, reason: 'không thấy input[type=file] mới' };
    }
    input.dataset.flowAutoUpload = '1'; // đánh dấu — upload kế phải mở dialog mới
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    log(`upload dialog: đã set file "${file.name}" vào input upload mới.`);

    // (P-fix) TẮT intercept NGAY sau khi set file xong (set qua DataTransfer trong trang,
    // không cần chooser) — trả lại hành vi native cho user. PHẢI tắt TRƯỚC mọi early-return
    // phía sau (rights consent) để không rò debugger/session.
    let interceptOff = false;
    try {
      const r2 = await chrome.runtime.sendMessage({ type: 'cdp:interceptChooserOff' });
      interceptOff = !!(r2 && r2.ok);
    } catch (_) {
      // bỏ qua — không làm hỏng flow chính
    }
    if (!interceptOn && !interceptOff) {
      log('upload dialog: không intercept được file chooser (background cũ?) — native window có thể pop lên khi click "Upload media".');
    }

    // T76.5: chọn FILE VIDEO (MIME hoặc đuôi) → Flow hiện "Rights to use this video" ngay
    // SAU change — overlay riêng (ngoài add-ref dialog) chặn commit asset. Gỡ rồi CHỜ add-ref
    // dialog ổn định (rights modal đóng có thể remount overlay) trước khi poll asset mới.
    const looksVideo = /^video\//i.test(file.type || '') || /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file.name || '');
    if (looksVideo) {
      const cleared = await acceptRightsDialogIfPresent({ waitMs: 4000 });
      if (!cleared) return { ok: false, reason: 'rights consent blocked', commitMayExist: true };
      await waitFor(() => findAddDialogRoot(), 5000);
    }

    // (5) Wait for the NEW asset in the Uploads list.
    if (opts.addToPrompt) {
      // G10-QA-D (ID-authoritative — replaces the old name/src heuristics, RC-1/RC-2):
      // the upload counts as finished ONLY when a media id absent from beforeIds
      // APPEARS IN THE DIALOG LIST and stays the ONLY fresh id through a settle window.
      // Never trust the input's reply, never match by name, never count unseen srcs.
      // Timeout / no id surfacing / >=2 distinct fresh ids = {ok:false} BEFORE Send.
      const found = await pollDialogNewAssetId(dlg, beforeIds, 20000, unusual0);
      if (found === 'unusual') {
        log('⚠ Phát hiện nghi "unusual activity" khi upload: ' + unusualNotiText() + ' — HỦY upload (media chưa chắc đã lên).');
        return { ok: false, reason: 'unusual-activity', commitMayExist: true };
      }
      if (found === 'ambiguous') {
        log('⚠ upload dialog: NHIỀU media id mới cùng xuất hiện sau upload (job khác đang ghi chồng / dialog nhiều media lạ) — KHÔNG chắc id nào là ảnh vừa gửi. HỦY trước khi bấm "Add to Prompt".');
        return { ok: false, reason: 'nhiều media id mới xuất hiện sau upload', commitMayExist: true };
      }
      if (!found || !found.id) {
        log('upload dialog: sau 20s KHÔNG thấy media id MỚI trong danh sách — upload chưa xong hoặc dialog không expose identity. HỦY trước khi gửi (không chọn theo tên).');
        return { ok: false, reason: 'không xác định được media id mới sau upload', commitMayExist: true };
      }
      const newId = found.id;
      const itemHost = (found.el.closest && found.el.closest('button.asset-item, [role="option"]')) || found.el;
      const itemImg = (itemHost.tagName === 'IMG' ? itemHost : itemHost.querySelector && itemHost.querySelector('img')) || found.el;
      const assetUrl = (itemImg && (itemImg.currentSrc || itemImg.src)) || '';
      log(`upload dialog: ✓ xác nhận media id MỚI ${newId.slice(0, 8)}… sau upload (diff identity, không theo tên).`);
      // (6) Select EXACTLY the item carrying that id — never by name, count, or unseen src.
      if (!dialogItemSelected(itemHost)) {
        const ic = elCenter(itemHost);
        if (!(await clickCdpxy(ic.x, ic.y, itemHost))) {
          log('upload dialog: cdp:click item ref thất bại trước Add to Prompt.');
          return { ok: false, reason: 'cdp:click item ref thất bại', commitMayExist: true };
        }
        await wait(300);
      }
      const addBtn = await waitFor(() => findAddToPromptButton(findAddDialogRoot() || dlg), 2000);
      if (!addBtn) {
        log('upload dialog: không thấy nút "Add to Prompt" sau upload — HỦY (không có chip ref).');
        return { ok: false, reason: 'không thấy Add to Prompt sau upload', commitMayExist: true };
      }
      const chipsBefore = countComposerChips(); // #33-live: baseline TRƯỚC click — chip phải là chip MỚI
      const ac = elCenter(addBtn);
      if (!(await clickCdpxy(ac.x, ac.y, addBtn))) {
        log('upload dialog: cdp:click "Add to Prompt" thất bại.');
        return { ok: false, reason: 'cdp:click Add to Prompt thất bại', commitMayExist: true };
      }
      await wait(500);
      if (countComposerChips() <= chipsBefore) {
        await waitFor(() => countComposerChips() > chipsBefore, 3000);
      }
      if (countComposerChips() <= chipsBefore) {
        log('⚠ upload dialog: đã bấm "Add to Prompt" nhưng không thấy chip ref MỚI (chip cũ không tính).');
        return { ok: false, reason: 'chip ref mới không xuất hiện sau Add to Prompt', commitMayExist: true };
      }
      // G10-QA-D (RC-3): the chip MUST carry the verified id — a count increase proves
      // nothing about WHICH image entered the prompt. Chip matching the new item's
      // id/src => OK; anything else = ref to the WRONG media => remove chips, abort
      // BEFORE Send (zero-credit).
      const chipHost = await waitFor(() => findComposerChipForId(newId, assetUrl), 3000);
      if (!chipHost) {
        await removeAllChips();
        log(`⚠ upload dialog: chip tạo ra KHÔNG mang media id ${newId.slice(0, 8)}… (ref sai media) — gỡ chip, HỦY trước khi gửi.`);
        return { ok: false, reason: 'chip ref không khớp media id vừa upload', commitMayExist: true };
      }
      log(`upload dialog: asset đã upload + Add to Prompt → chip ref KHỚP id ${newId.slice(0, 8)}… (đã xác minh identity).`);
      return { ok: true, url: assetUrl, mediaId: newId, chip: true };
    }
    // Upload-only (uploadAssetMedia — old heuristic path kept as-is: ESC closes the
    // dialog, no chip). Wait for the new asset in the Uploads list by name/unseen src.
    const stem = (file.name || '').toLowerCase().replace(/\.[a-z0-9]+$/i, '');
    const fullName = (file.name || '').toLowerCase();
    const assetImg = await waitFor(() => {
      // (FIX 3) "unusual activity" dialog/banner xuất hiện trong lúc upload → dừng sớm
      // (sentinel 'unusual' — caller phân biệt với null/timeout).
      if (unusualNotiCount() > unusual0) return 'unusual';
      const scope = findAddDialogRoot() || document;
      // (a) match theo TÊN FILE (full name) trong textContent asset-item — ĐÁNG TIN:
      // dialog asset-item = '<filename>Image', KHÔNG có data-media-id + img src là
      // lh3/asb (không uuid). Phải match TÊN, không được "img src lạ" (bắt nhầm tile
      // home lazy flow-content → upload trả STALE mediaId → đính ref sai media).
      if (fullName) {
        for (const el of scope.querySelectorAll('[class*="asset-item" i]')) {
          if (norm(el.textContent || '').includes(fullName)) return (el.querySelector('img') || el);
        }
        if (stem && stem.length >= 3) {
          for (const el of scope.querySelectorAll('[class*="asset-item" i]')) {
            if (norm(el.textContent || '').includes(stem)) return (el.querySelector('img') || el);
          }
        }
      }
      // (b) fallback: img src MỚI CHỈ trong dialog (KHÔNG rơi xuống document/home tile).
      const dlgOnly = findAddDialogRoot();
      if (dlgOnly) {
        for (const i of dlgOnly.querySelectorAll('img')) {
          const s = i.currentSrc || i.src || '';
          if (!s || baselineSrcs.has(s)) continue;
          if (isMediaSrc(s)) return i;
        }
      }
      return null;
    }, 15000);
    if (assetImg === 'unusual') {
      log('⚠ Phát hiện nghi "unusual activity" khi upload: ' + unusualNotiText() + ' — HỦY upload (media chưa chắc đã lên).');
      return { ok: false, reason: 'unusual-activity', commitMayExist: true };
    }
    if (!assetImg) return { ok: false, reason: 'asset mới không xuất hiện trong Uploads sau 15s', commitMayExist: true };
    const assetUrl = assetImg.currentSrc || assetImg.src || '';

    // (6) Mặc định (uploadAssetMedia — upload-only): Đóng dialog bằng ESC (phím THẬT
    // qua cdp:key), KHÔNG bấm "Add to Prompt" (thao tác sau dính ref sai vì để lại chip
    // ref không mong muốn). Upload ĐÃ XONG khi assetImg xuất hiện trong list Uploads
    // (media đã persist vào project); chỉ cần đóng dialog, KHÔNG select item, KHÔNG add
    // chip. (Đường REF có chip đã chuyển lên nhánh ID-authoritative phía trên.)
    log('upload dialog: asset đã upload xong — đóng dialog bằng ESC (không Add to Prompt → không để lại chip ref).');
    await chrome.runtime.sendMessage({ type: 'cdp:key', key: 'Escape', code: 'Escape', keyCode: 27 }).catch(() => null);
    await wait(400);
    let closed = await waitFor(() => !findAddDialogRoot(), 4000);
    if (!closed) {
      log('upload dialog: ESC chưa đóng — thử click ngoài overlay (backdrop).');
      closeRadix();
      await wait(300);
      closed = await waitFor(() => !findAddDialogRoot(), 3000);
      if (!closed) log('⚠ upload dialog: vẫn chưa đóng sau ESC + click ngoài (media đã upload, chỉ thừa dialog).');
    }
    return { ok: true, url: assetUrl };
  }

  // Reconstruct a File from a data URL (files can't cross chrome.tabs.sendMessage).
  function dataUrlToFile(dataUrl, name) {
    try {
      const [meta, b64] = dataUrl.split(',');
      const mime = (meta.match(/data:(.*?);base64/) || [])[1] || 'image/png';
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      return new File([bytes], name || 'image.png', { type: mime });
    } catch (_) {
      return null;
    }
  }

  // Ingredient có thể đến dạng {url} (fetch trong page) hoặc {dataUrl}.
  async function imageToFile(ingredient) {
    if (!ingredient) return null;
    if (ingredient.dataUrl) return dataUrlToFile(ingredient.dataUrl, ingredient.name);
    if (ingredient.url) {
      try {
        const res = await fetch(ingredient.url);
        if (!res.ok) return null;
        const blob = await res.blob();
        return new File([blob], ingredient.name || 'ingredient.png', { type: blob.type || 'image/png' });
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  // Upload + xác nhận ĐÚNG MỘT ảnh ref (thứ tự indexRef/1-based). Trả {ok, url} —
  // url = url card/thumb media MỚI xác nhận được (T40 item 8: caller lấy
  // mediaIdOf(url) làm id định danh); {ok:false} = HỦY (gọi giảm xuống). Giữ cơ
  // chế race-free cũ: baseline (identity + count) TRƯỚC mỗi uploadImage.
  // addToPrompt: đường REF cần chip trong prompt box — truyền true để
  // uploadImageViaDialog bấm "Add to Prompt" (uploadAssetMedia giữ upload-only).
  async function uploadOneRef(file, indexRef, retriesLeft, addToPrompt = false) {
    let baseline = new Set();
    let baselineSrcSet = new Set();
    let baselineCount = 0;
    for (const i of document.querySelectorAll('img')) {
      const s = i.src || '';
      baselineSrcSet.add(s);
      if (!isMediaSrc(s)) continue;
      baselineCount += 1;
      const id = mediaIdOf(s);
      if (id) baseline.add(id);
    }
    // FIX-2: uploadImage FAIL cũng đi qua cơ chế retry (cùng retriesLeft) —
    // trước đây văng false NGAY dù còn lượt thử. Lần đệ quy tới tự chụp baseline
    // MỚI ở đầu hàm (đúng yêu cầu: baseline mới trước lần thử 2); chỉ trả false
    // sau khi ĐÃ hết lượt retry.
    // UI mới (flow.google.com — Angular): KHÔNG có input[type=file] tĩnh → upload
    // qua add-ref dialog (uploadImageViaDialog — tab Uploads → 'Upload media' →
    // input mới → Add to prompt). Hàm đó đã xác nhận asset + đóng dialog nên trả
    // luôn {ok, url} — không rơi xuống waitFor card bên dưới. Nhánh cũ labs
    // (input tĩnh) giữ nguyên toàn bộ.
    if (!findUploadInput()) {
      const up = await uploadImageViaDialog(file, { addToPrompt });
      // G10-QA-D: mediaId = identity VERIFIED inside the dialog (only the addToPrompt
      // path has it; upload-only returns empty) — forward it for caller log/compare.
      if (up && up.ok) return { ok: true, url: up.url || '', mediaId: up.mediaId || '' };
      if (retriesLeft > 0 && !(up && up.commitMayExist)) {
        log(`Reference ảnh ${indexRef + 1}: upload qua dialog chưa xong (${(up && up.reason) || 'không rõ'}) — thử lại lần 2 với baseline mới...`);
        await wait(800); // cho DOM/UI kịp trả lại dialog/input
        return uploadOneRef(file, indexRef, retriesLeft - 1, addToPrompt);
      }
      log(`LỖI: Reference ảnh ${indexRef + 1} không upload được qua dialog add-ref — HỦY upload refs (thứ tự #${indexRef + 1} không xác nhận được).`);
      return { ok: false, reason: (up && up.reason) || 'upload dialog failed', commitMayExist: !!(up && up.commitMayExist) };
    }
    if (!uploadImage(file)) {
      if (retriesLeft > 0) {
        log(`Reference ảnh ${indexRef + 1}: CHƯA đính kèm được (input không khả dụng) — thử lại lần 2 với baseline mới...`);
        await wait(800); // cho DOM/UI kịp trả lại input hiển thị
        return uploadOneRef(file, indexRef, retriesLeft - 1, addToPrompt);
      }
      log(`LỖI: Reference ảnh ${indexRef + 1} không đính kèm được sau 2 lần thử — HỦY upload refs (thứ tự #${indexRef + 1} không xác nhận được).`);
      return { ok: false };
    }
    let foundUrl = ''; // T40: url của card/thumb MỚI xác nhận được — trả cho caller
    const card = await waitFor(() => {
      let n = 0;
      for (const i of document.querySelectorAll('img')) {
        const s = i.src || '';
        if (isMediaSrc(s)) {
          n += 1;
          const id = mediaIdOf(s);
          if (id && !baseline.has(id)) { foundUrl = s; return true; } // card MỚI (identity lạ)
        }
      }
      if (n > baselineCount) {
        // hoặc tổng count tăng — UI mới (lh3/asb) không có uuid → mediaIdOf trả ''
        // nên id không phân biệt được media mới: ưu tiên src LẠ so baseline
        // (baselineSrcSet), rồi mới tới nhánh id cũ (UI cũ media.getMediaUrlRedirect).
        for (const i of document.querySelectorAll('img')) {
          const s = i.src || '';
          if (isMediaSrc(s) && !baselineSrcSet.has(s)) { foundUrl = s; break; }
        }
        if (!foundUrl) {
          for (const i of document.querySelectorAll('img')) {
            const s = i.src || '';
            if (isMediaSrc(s) && !baseline.has(mediaIdOf(s))) { foundUrl = s; break; }
          }
        }
        if (foundUrl) {
          log('uploadOneRef: card mới xác nhận bằng count tăng + src LẠ khỏi baseline (UI mới không uuid — baseline identity thay bằng baselineSrcSet).');
          return true;
        }
        // không rút được url media mới — rơi xuống ITEM 10 chip/thumb fallback
      }
      // ITEM 10 fallback: ref hiển thị kiểu chip/thumb local (blob:/data:) —
      // img MỚI (src lạ so baseline) có tên file vừa upload trong metadata.
      const stem = (file.name || '').toLowerCase().replace(/\.[a-z0-9]+$/i, '');
      if (stem) {
        for (const i of document.querySelectorAll('img')) {
          if (baselineSrcSet.has(i.src || '')) continue;
          const meta = norm(
            (i.alt || '') + ' ' + (i.title || '') + ' ' + (i.getAttribute('aria-label') || '')
          ).toLowerCase();
          if (meta && meta.includes(stem)) { foundUrl = i.src || ''; return true; }
        }
      }
      return null;
    }, 12000);
    if (card) return { ok: true, url: foundUrl };
    if (retriesLeft > 0) {
      log(`Reference ảnh ${indexRef + 1} chưa xác nhận trong 12s (lần thử đầu) — thử lại lần 2 với baseline mới...`);
      return uploadOneRef(file, indexRef, retriesLeft - 1, addToPrompt);
    }
    log(`LỖI: Reference ảnh ${indexRef + 1} không lên media card sau 2 lần thử — HỦY upload refs (thứ tự #${indexRef + 1} không xác nhận được).`);
    return { ok: false };
  }

  // T76.5: Flow hiện dialog "Rights to use this video" ("I agree, do not show again")
  // khi tạo project mới / upload video — overlay này CHẶN mọi dialog/Agent phía sau, khiến
  // uploadAssetMedia/ensureSceneMediaPresent fail hoài ("upload thất bại"). Ưu tiên nút
  // "do not show again" (tắt vĩnh viễn cho project → upload video sau không hiện lại).
  // opts.waitMs = thời gian POLL chờ dialog nở (0 = quét 1 lần, fast-path cho precheck;
  // dùng ~4s ngay sau video change / điều hướng project mới). Nếu ĐÃ thấy dialog → bắt buộc
  // chờ nó biến mất hẳn trước khi trả về. Best-effort: never throw.
  function findRightsAgreeBtn() {
    for (const dlg of document.querySelectorAll('mat-dialog-container, [role="dialog"], .cdk-overlay-pane')) {
      const txt = (dlg.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/Rights to use this|necessary rights|Prohibited Use Policy/i.test(txt)) continue;
      const btns = [...dlg.querySelectorAll('button')];
      const btn = btns.find((b) => /do\s*not\s*show\s*again/i.test((b.textContent || '').replace(/\s+/g, ' ')))
        || btns.find((b) => /i\s*agree/i.test((b.textContent || '').replace(/\s+/g, ' ')));
      if (btn) return btn;
    }
    return null;
  }
  async function acceptRightsDialogIfPresent(opts) {
    const waitMs = (opts && typeof opts.waitMs === 'number') ? Math.max(0, opts.waitMs) : 0;
    const deadline = Date.now() + waitMs;
    try {
      for (;;) {
        const btn = findRightsAgreeBtn();
        if (btn) {
          const r0 = btn.getBoundingClientRect();
          if (r0 && r0.width >= 2 && r0.height >= 2) {
            btn.scrollIntoView({ block: 'center', inline: 'center' });
            await wait(150);
            const c = elCenter(btn);
            const ok = await clickCdpxy(c.x, c.y, btn);
            // ĐÃ thấy dialog → BẮT BUỘC chờ biến mất hẳn, trả ĐÚNG trạng thái đã gỡ
            let disappeared = false;
            const goneDeadline = Date.now() + 8000;
            while (Date.now() < goneDeadline) {
              await wait(250);
              if (!btn.isConnected) { disappeared = true; break; }
              const n = btn.getBoundingClientRect();
              if (n.width < 2 || n.height < 2) { disappeared = true; break; }
              if (!findRightsAgreeBtn()) { disappeared = true; break; }
            }
            const cleared = ok && disappeared;
            log(cleared
              ? '✓ Đã bấm "I agree" (Rights to use this video).'
              : '⚠ Rights consent còn chặn — bấm "I agree" thất bại hoặc dialog chưa biến mất.');
            return cleared;
          }
          // thấy nút nhưng chưa visible → không chặn thao tác (coi như đã gỡ)
          if (Date.now() >= deadline) return true;
          await wait(300);
          continue;
        }
        // không thấy dialog — fast-path trả ngay khi waitMs=0, ngược lại đợi tới deadline
        if (Date.now() >= deadline) return true;
        await wait(300);
      }
    } catch (_) { /* bỏ qua */ }
    return true;
  }

  // T40 item 8: upload ĐÚNG MỘT ảnh tài nguyên vào project — dùng CHUNG pipeline
  // hiện có (imageToFile + uploadOneRef + findUploadInput), không duplicate logic.
  // Chỉ đọc state.busy (guard nhẹ — KHÔNG đụng busy lock: tránh đè/trộn số thứ tự
  // refs khi một scene đang tạo). Trả {ok, mediaId, url} — mediaId = mediaIdOf(url).
  async function uploadAssetMedia(asset) {
    if (state.busy) return { ok: false, reason: 'busy' };
    if (!asset || (!asset.dataUrl && !asset.url)) return { ok: false, reason: 'thiếu ảnh' };
    await acceptRightsDialogIfPresent(); // T76.5: gỡ overlay "Rights to use this video" nếu chặn upload
    const file = await imageToFile(asset);
    if (!file) return { ok: false, reason: 'không đọc được ảnh' };
    
    // Chụp baseline ĐẦY ĐỦ trước upload: mọi img src + mọi data-media-id (identity THẬT
    // của media project nằm ở data-media-id, KHÔNG chỉ chip). Trước đây baseline chỉ gồm
    // chip (.ProseMirror / button[data-card-open]) → quét "img mới" bắt nhầm chip
    // ingredient cũ (vd character) thành mediaId của product.
    const baselineSrcs = new Set();
    const baselineMediaIds = new Set();
    for (const i of document.querySelectorAll('img')) {
      const s = i.currentSrc || i.src || '';
      if (s) baselineSrcs.add(s);
      const hostEl = (i.closest && i.closest('[data-media-id]')) || i;
      const dmid = (hostEl.getAttribute && hostEl.getAttribute('data-media-id')) || '';
      if (dmid) baselineMediaIds.add(dmid.toLowerCase());
    }
    const r = await uploadOneRef(file, 0, asset.singleAttempt ? 0 : 1);
    if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || 'upload thất bại', commitMayExist: !!(r && r.commitMayExist) };

    // Cách 1 (nhanh): mediaId từ url. uploadImageViaDialog GIỜ KHÔNG "Add to Prompt"
    // (đóng bằng ESC → không chip) → url = thumb asb (không uuid) → thường null.
    // Sidepanel KHÔNG dùng res.mediaId nữa (poll listHomeMedia lấy đúng data-media-id),
    // nên đây chỉ là best-effort fallback.
    let url = r.url || '';
    let mid = url ? mediaIdOf(url) : null;
    
    // Cách 2: data-media-id MỚI (ưu tiên — identity thật của media vừa upload)
    if (!mid || mid === '') {
      await wait(800); // chờ tile/chip render
      for (const i of document.querySelectorAll('img')) {
        const hostEl = (i.closest && i.closest('[data-media-id]')) || i;
        const dmid = (hostEl.getAttribute && hostEl.getAttribute('data-media-id')) || '';
        if (dmid && !baselineMediaIds.has(dmid.toLowerCase())) {
          mid = dmid.toLowerCase();
          url = i.currentSrc || i.src || '';
          log(`uploadAssetMedia: tách mediaId từ data-media-id mới: ${mid}`);
          break;
        }
      }
    }
    
    // Cách 3: flow-content src MỚI (fallback — chỉ img src lạ khỏi baseline toàn bộ)
    if (!mid || mid === '') {
      for (const i of document.querySelectorAll('img')) {
        const s = i.currentSrc || i.src || '';
        if (!s || baselineSrcs.has(s)) continue;
        if (!isMediaSrc(s)) continue;
        const imgId = mediaIdOf(s);
        if (imgId && imgId !== '') {
          mid = imgId;
          url = s;
          log(`uploadAssetMedia: tách mediaId từ img mới trên page: ${mid}`);
          break;
        }
      }
    }
    
    if (!mid || mid === '') {
      log('uploadAssetMedia: upload OK nhưng không tách được mediaId — url: ' + url.slice(0, 100));
    }
    
    return { ok: true, mediaId: mid || null, url };
  }

  // FIX-4 (ITEM 10/11): attachment refs của job còn ĐỦ trên page hay không. Flow
  // render ref dạng chip/thumb img có TÊN FILE trong alt/title/aria (cùng nguồn
  // fallback của uploadOneRef) → so stem tên file. Trả danh sách stem THIẾU
  // (rỗng = còn đủ). Không lấy được tên file nào → [true] (không kiểm tra được
  // = coi như thiếu — an toàn: không bao giờ gửi prompt thiếu refs).
  function missingRefStems(images) {
    const stems = [...(images || [])]
      .filter((x) => x && typeof x.name === 'string' && x.name)
      .map((x) => x.name.toLowerCase().replace(/\.[a-z0-9]+$/i, ''));
    if (!stems.length) return [true];
    const found = new Set();
    for (const i of document.querySelectorAll('img')) {
      const meta = norm(
        (i.alt || '') + ' ' + (i.title || '') + ' ' + (i.getAttribute('aria-label') || '')
      ).toLowerCase();
      if (!meta) continue;
      for (const s of stems) if (meta.includes(s)) found.add(s);
      if (found.size === stems.length) break;
    }
    return stems.filter((s) => !found.has(s));
  }

  // ---------------------------------------------------------------------------
  // Đợt C: đính ref media CÓ SẴN mediaId bằng DIALOG add_2 (thay vì upload lại
  // file → không tạo media mới, không loạn project). Ground truth:
  // docs/recon/add2-dialog-*.json/.txt. Selector ổn định theo role/aria (KHÔNG
  // class hashed):
  //   - trigger : button[aria-haspopup=dialog][aria-controls^='radix-'] 'add_2Create'
  //     (có thể NHIỀU trên page — header 'Add Media' + composer → chọn cái GẦN
  //     composer nhất bằng getBoundingClientRect)
  //   - dialog  : [role=dialog]
  //   - item    : [role=dialog] [role=option] — mediaId = uuid trong img src
  //     'media.getMediaUrlRedirect?name=<uuid>' (mediaIdOf)
  //   - tab     : [role=dialog] [role=tab] 'Images' (media mới upload chưa vào
  //     grid 'All' → chuyển tab tìm lại)
  //   - add     : [role=dialog] button 'Add to Prompt' (item aria-selected=true
  //     rồi bấm; item ĐÃ selected sẵn → click LẠI chính item đó là đủ — recon:
  //     click item đang chọn = đóng dialog + add chip)
  //   - chip    : button[data-card-open] img src chứa name=<uuid> (nằm TRÊN
  //     textbox). Textarea KHÔNG bị chèn text — chip là nguồn ref DUY NHẤT.
  // Mỗi media xử lý TUẦN TỰ, mỗi lần MỞ LẠI dialog (recon: add 2 lần cùng 1
  // media = 2 chip, không dedupe → add 1 media rồi đóng/mở lại là an toàn nhất).
  // Trả {ok:true, count} | {ok:false, reason, count?}. KHÔNG gửi prompt thiếu ref.
  // ---------------------------------------------------------------------------
  function findAddDialogTrigger() {
    // Đợt C (FIX blocker 1): KHÔNG còn ép text 'add_2' + 'Create'. UI THẬT của
    // user (vision-verified /tmp/orca-shots/add2-user-2.png): trigger = nút 32x32
    // icon Material LƯỚI 2x2 (grid_view/apps — 4 ô vuông, KHÔNG phải '+'), KHÔNG
    // có text 'Create'/'add', nằm TRONG composer cạnh pill 'Agent'. Recon
    // (docs/recon/add2-dialog-summary.json): cùng nút có text 'add_2 Create' —
    // bản UI khác render thêm span nhãn (ẩn). Trình tự tìm:
    //   Cách 1 (recon): button[aria-haspopup=dialog] có text/icon chứa 'add_2'
    //     (textContent HOẶC descendant i.google-symbols) HOẶC icon lưới Material
    //     (grid_view/apps/add) — KHÔNG bắt buộc 'Create'.
    //   Cách 2 (UI user): nếu không có candidate 'add_2' → tìm nút dialog TRONG
    //     VÙNG composer (gần textbox 'What do you want to create?' hoặc cạnh nút
    //     'Agent'), visible, kích thước nhỏ (~24-40px), không disabled; ưu tiên
    //     icon Material bên trong; vẫn chấp nhận nút không có dấu hiệu nào nếu
    //     là nút dialog duy nhất gần composer.
    // Khi nhiều candidate (header 'add Add Media' + composer) → chọn cái THẤY
    // ĐƯỢC gần composer nhất (proximity cũ GIỮ NGUYÊN; bỏ ẩn header qua rect).
    const normT = (s) => norm(s || '');
    // UI mới (flow.google.com — Angular Material): trigger add-reference là
    // button[aria-haspopup="true"] (KHÔNG phải "dialog") BỌC mat-icon, với
    // aria-label 'Add ingredients to the prompt box' (có 's') → selector mở
    // rộng (T65), giữ button cũ labs.
    const ADD_DLG_SEL =
      'button[aria-haspopup="dialog"], mat-icon[aria-label*="ingredient" i], [role="button"][aria-haspopup="dialog"], [aria-label*="ingredient to the prompt box" i]' +
      // T65 fix: nút thật flow.google.com = button[aria-haspopup="true"] (Angular Material)
      // + aria-label 'Add ingredients to the prompt box' (có 's') — pattern cũ thiếu 's'
      ' , button[aria-haspopup="true"][aria-label*="prompt box" i]';
    // Glyph Material trong nút (google-symbols — ligature nằm chung textContent
    // nhưng có nút render icon RỜI, text 'apps'/'grid_view'/'add_2'/rỗng). Thêm
    // mat-icon / span.material-symbols cho UI mới (icon Angular Material).
    const materialIconText = (b) => {
      for (const ic of b.querySelectorAll('i.google-symbols, i[class*="symbols" i], mat-icon, span[class*="material-symbols" i]')) {
        const gt = normT(ic.textContent);
        if (gt) return gt;
      }
      // Chính element trigger LÀ mat-icon / span material-symbols (ligature nằm
      // trong textContent của chính nó, không phải descendant).
      const cls = (b.className || '') + '|' + (b.tagName || '');
      if (/mat-icon|material-symbols|google-symbols/i.test(cls)) {
        const gt = normT(b.textContent);
        if (gt) return gt;
      }
      return '';
    };
    const isAddLike = (b) => {
      const rawText = b.textContent || '';
      // UI mới: trigger = mat-icon icon:add + aria-label/label 'Add ingredients to
      // the prompt box' — test regex trên text THÔ (không norm, giữ space).
      if (/add ingredients to the prompt box/i.test(((b.getAttribute && b.getAttribute('aria-label')) || '') + ' ' + (b.title || '') + ' ' + rawText)) return true;
      if (normT(rawText).includes('add_2')) return true;
      const it = materialIconText(b);
      if (it === 'add_2' || it === 'grid_view' || it === 'apps' || it === 'add') return true;
      const aria = normT((b.getAttribute('aria-label') || '') + ' ' + (b.title || ''));
      return /add|media|image/i.test(aria);
    };
    // Nút thuộc VÙNG composer: visible, kích thước nhỏ, gần textbox (theo cạnh
    // TRÁI — nút icon nằm đầu thanh composer, có thể cách xa tâm textbox rộng)
    // hoặc liền kề nút 'Agent' (vision: grid button nằm NGAY TRÁI pill Agent).
    const isNearComposer = (b) => {
      if (b.disabled) return false;
      const r = b.getBoundingClientRect();
      if (!r.width || !r.height) return false; // ẩn (header) — bỏ qua
      if (r.width < 16 || r.height < 16 || r.width > 56 || r.height > 56) return false;
      const composer = findComposer();
      if (composer) {
        const cr = composer.getBoundingClientRect();
        const d = Math.abs(r.left - cr.left) + Math.abs(r.top + r.height / 2 - (cr.top + cr.height / 2));
        if (d < 220) return true;
      }
      const agent = findAgentToggle();
      if (agent) {
        const ar = agent.getBoundingClientRect();
        const d = Math.abs(r.left + r.width / 2 - (ar.left + ar.width / 2)) + Math.abs(r.top + r.height / 2 - (ar.top + ar.height / 2));
        if (d < 160) return true;
      }
      return false;
    };

    let candidates = [...document.querySelectorAll(ADD_DLG_SEL)].filter(isAddLike);
    // Chỉ giữ nút THẤY ĐƯỢC (bỏ ẩn header qua rect). Nếu mọi candidate cách 1
    // đều ẨN (header 'add_2 Create' giấu label — UI user render grid icon thuần)
    // → xuống cách 2 tìm nút thật gần composer.
    candidates = candidates.filter((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (!candidates.length) {
      // Cách 2 (UI user): nút dialog gần composer — có icon Material hoặc
      // aria-label/title 'add'/'media'/'image'.
      candidates = [...document.querySelectorAll(ADD_DLG_SEL)].filter((b) => {
        if (!isNearComposer(b)) return false;
        if (materialIconText(b)) return true;
        const aria = normT((b.getAttribute('aria-label') || '') + ' ' + (b.title || ''));
        return /add|media|image/i.test(aria);
      });
      if (!candidates.length) {
        // Nuốt case cuối: nút dialog KHÔNG có dấu hiệu nào (icon rỗng / không
        // aria) nhưng là nút duy nhất gần composer — vẫn nhận.
        candidates = [...document.querySelectorAll(ADD_DLG_SEL)].filter(isNearComposer);
      }
    }
    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0];
    const composer = findComposer();
    if (composer) {
      const cr = composer.getBoundingClientRect();
      const ccx = cr.left + cr.width / 2;
      const ccy = cr.top + cr.height / 2;
      let best = null;
      let bestD = Infinity;
      for (const b of candidates) {
        const br = b.getBoundingClientRect();
        const d = Math.abs(br.left + br.width / 2 - ccx) + Math.abs(br.top + br.height / 2 - ccy);
        if (d < bestD) {
          bestD = d;
          best = b;
        }
      }
      if (best) return best;
    }
    return candidates[0];
  }
  // Item ảnh trong dialog có img thumbnail src redirect + uuid === mediaId.
  // Fallback THEO TÊN khi uuid match fail: UI mới flow.google.com thumbnail là
  // lh3.googleusercontent.com/asb/... KHÔNG chứa uuid — chỉ match được bằng tên
  // file trong textContent ('product.pngImage') hoặc alt/title ('Preview of product.png').
  function dialogItemByMediaId(mediaId, name = '') {
    const want = String(mediaId || '').toLowerCase();
    const wantName = String(name || '').toLowerCase();
    const dlg = findAddDialogRoot();
    if (!dlg) return null;
    if (want) {
      // (a) data-media-id trực tiếp (element bất kỳ trong dialog)
      for (const el of dlg.querySelectorAll('[data-media-id]')) {
        if ((el.getAttribute('data-media-id') || '').toLowerCase() === want) return el;
      }
      // (b) img src flow-content/<uuid>
      for (const opt of dlg.querySelectorAll('button.asset-item, [role="option"]')) {
        for (const img of opt.querySelectorAll('img')) {
          const s = (img.currentSrc || img.src || '').toLowerCase();
          if (isMediaSrc(s) && mediaIdOf(s) === want) return opt;
          if (s.includes(want)) return opt;
        }
      }
    }
    // (c) Fallback THEO TÊN (UI flow.google.com thumbnail là lh3.googleusercontent.com/asb/...
    // KHÔNG chứa uuid trong src) → match theo .asset-title, textContent, hoặc img alt/title
    if (wantName) {
      for (const opt of dlg.querySelectorAll('button.asset-item, [role="option"]')) {
        const titleEl = opt.querySelector('.asset-title');
        const title = (titleEl ? titleEl.textContent : '').trim().toLowerCase();
        if (title && (title === wantName || title.startsWith(wantName) || wantName.startsWith(title))) {
          return opt;
        }
      }
      for (const opt of dlg.querySelectorAll('button.asset-item, [role="option"]')) {
        const txt = (opt.textContent || '').trim().toLowerCase();
        if (txt.includes(wantName)) return opt;
      }
      for (const opt of dlg.querySelectorAll('button.asset-item, [role="option"]')) {
        for (const img of opt.querySelectorAll('img')) {
          const alt = (img.getAttribute('alt') || img.getAttribute('title') || '').toLowerCase();
          if (alt.includes(wantName)) return opt;
        }
      }
    }
    return null;
  }
  function dialogItemSelected(item) {
    if (!item) return false;
    // Labs cũ: item [role=option] set aria-selected='true' khi được chọn.
    if (item.getAttribute('aria-selected') === 'true') return true;
    // UI mới flow.google.com (project view Agent-ON): asset item =
    // button.asset-item KHÔNG set aria-selected (mọi item luôn 'false' kể cả
    // item active); selected-state = class token 'asset-item-active' (ground truth CDP).
    return /(^|\s)asset-item-active(\s|$)/.test(item.className || '');
  }
  function findDialogTab(dlg, label) {
    const scope = dlg || document.querySelector('[role="dialog"]');
    if (!scope) return null;
    const want = (norm(label || '') || '').toLowerCase();
    if (!want) return null;
    return [...scope.querySelectorAll('[role="tab"], mat-mdc-list-item')].find((t) => {
      const n = (norm(t.textContent) || '').toLowerCase();
      return n.includes(want);
    });
  }
  function findAddToPromptButton(dlg) {
    const scope = dlg || findAddDialogRoot();
    if (!scope) return null;
    return [...scope.querySelectorAll('button')].find((b) => norm(b.textContent).toLowerCase() === 'addtoprompt');
  }
  
  function countComposerChips() {
    const containers = document.querySelectorAll('button.chip-container, [aria-label="Ingredient"], button[data-card-open]');
    if (containers.length > 0) return containers.length;
    return document.querySelectorAll('img.chip-image, .flow-ingredient-bar img').length;
  }
  // Xóa MỌI chip ref còn sót trong composer (flow-ingredient-bar): upload "Add to
  // Prompt" (uploadImageViaDialog) để lại chip KHÔNG mong muốn → thao tác sau đính
  // THÊM lên chip cũ → tạo với ảnh tham chiếu sai. Gọi TRƯỚC mỗi attachRefsMixed.
  async function removeAllChips() {
    let removed = 0;
    let sawChip = false; // CONCERN-1: thấy chip mà xoá 0 ⇒ PHẢI log tổng kết (trước đây im lặng)
    let why = '';
    for (let g = 0; g < 24; g++) {
      const chips = [...document.querySelectorAll('img.chip-image, button[data-card-open]')];
      if (!chips.length) break;
      sawChip = true;
      const chip = chips[0];
      // NIT-6: marker đặt lên HOST (button bọc chip), KHÔNG phải mat-icon xBtn — mat-icon
      // thường có pointer-events:none ⇒ elementFromPoint trả về HOST ⇒ probeAt (chỉ matches
      // || closest ĐI LÊN) sẽ không thấy marker ở icon ⇒ CHẶN OAN cú bấm đúng. Marker ở tổ
      // tiên thì closest() phủ cả 2 chiều (point trả về icon con lẫn host). Toạ độ vẫn là
      // tâm xBtn. host KHÔNG null theo cấu trúc: closest(...) || parentElement || chip.
      const host = chip.closest('button.chip-container, [aria-label="Ingredient"], button[data-card-open]') || chip.parentElement || chip;
      const hr = host.getBoundingClientRect();
      if (hr.width > 0 && hr.height > 0) {
        try { await chrome.runtime.sendMessage({ type: 'cdp:hover', x: Math.round(hr.x + hr.width / 2), y: Math.round(hr.y + hr.height / 2) }); } catch (_) {}
        await wait(300);
      }
      const xBtn = [...host.querySelectorAll('mat-icon')].find((m) => /cancel|close/i.test((m.textContent || '').trim()));
      if (xBtn) {
        const xr = xBtn.getBoundingClientRect();
        if (xr.width > 0 && xr.height > 0) {
          const clicked = await clickCdpxy(Math.round(xr.x + xr.width / 2), Math.round(xr.y + xr.height / 2), host);
          await wait(250);
          if (!document.contains(chip)) removed++;
          else why = clicked ? 'bấm nút X nhưng chip vẫn còn trong DOM' : 'guard stale-coordinate đã CHẶN cú bấm nút X (toạ độ lệch)';
          continue;
        }
      }
      // Không có nút X (labs cũ) → bỏ qua, tránh loop vô hạn.
      log('removeAllChips: chip không có nút X — bỏ qua.');
      why = 'không tìm thấy nút X nào của chip';
      break;
    }
    if (removed) log(`removeAllChips: đã xóa ${removed} chip ref còn sót.`);
    // CONCERN-1: hết lượt mà vẫn còn chip ⇒ nói RÕ đã thất bại (nếu im lặng, caller — vốn
    // bỏ qua giá trị trả về — sẽ đính ref lên composer còn ref CŨ ⇒ media sai tham chiếu).
    else if (sawChip) log(`⚠ removeAllChips: còn chip ref nhưng KHÔNG xoá được chip nào (${why || 'không rõ lý do'}) — composer có thể vẫn còn ref CŨ; lần đính ref sau sẽ dính THÊM lên chip cũ.`);
    return removed;
  }
  // Tìm item dialog theo UUID hoặc Tên — tính cả scroll virtual list (item ẩn dưới fold).
  async function scrollFindDialogItem(dlg, mediaId, name = '') {
    let item = dialogItemByMediaId(mediaId, name);
    if (item) return item;
    const vp = dlg.querySelector('cdk-virtual-scroll-viewport, [class*="virtual-scroll" i]');
    if (vp && vp.scrollHeight > vp.clientHeight) {
      const step = Math.max(200, Math.floor(vp.clientHeight * 0.7));
      const maxY = vp.scrollHeight - vp.clientHeight;
      for (let y = step; y <= maxY + step; y += step) {
        vp.scrollTop = Math.min(y, maxY);
        vp.dispatchEvent(new Event('scroll', { bubbles: true }));
        await wait(250);
        item = dialogItemByMediaId(mediaId, name);
        if (item) return item;
      }
    }
    return item;
  }
  async function attachRefsByDialog(medias) {
    const list = (medias || []).filter((m) => m && (m.mediaId || m.name));
    if (!list.length) {
      log('Đính ref qua dialog: không có media nào — bỏ qua.');
      return { ok: false, reason: 'không có media', count: 0 };
    }
    let count = 0;
    for (const media of list) {
      const mediaId = String(media.mediaId || '');
      const mediaName = String(media.name || '');
      // (a) Mở dialog add_2 (CDP click giống clickSend — rect center)
      log(`Đính ref qua dialog: Mở dialog add ảnh (name: "${mediaName}", mediaId: ${mediaId ? mediaId.slice(0, 8) + '…' : 'none'})...`);
      const trigger = findAddDialogTrigger();
      if (!trigger) {
        log('Đính ref qua dialog: không tìm thấy nút add dialog.');
        return { ok: false, reason: 'không tìm thấy nút add_2', count };
      }
      // FIX-WIN: mở dialog bằng helper retry bền (stale-coordinate — extractModel fail
      // 'dialog không mở sau 5s' 18:58:41: pattern cũ đo elCenter 1 lần → cdp:click →
      // waitFor 5000 MỘT LẦN → bỏ cuộc; Flow dịch vị ~56px giữa đo và click → trượt).
      // Helper = scrollIntoView + đo NGAY trước click + retry ≤3 + pre-check dialog.
      // Contract reason giữ nguyên ('cdp:click add_2 thất bại' / 'dialog không mở').
      const r = await openAddRefDialogWithRetry(trigger, { prefix: 'Đính ref qua dialog' });
      if (r.clickFailed) {
        log('Đính ref qua dialog: cdp:click nút add_2 thất bại.');
        return { ok: false, reason: 'cdp:click add_2 thất bại', count };
      }
      const dlg = r.dlg;
      if (!dlg) {
        log('Đính ref qua dialog: dialog không mở sau 3 lần retry.');
        return { ok: false, reason: 'dialog không mở', count };
      }
      // (b) Tìm item theo UUID hoặc Tên — quét tab hiện hành + scroll, rồi MỌI tab
      let item = await scrollFindDialogItem(dlg, mediaId, mediaName);
      if (!item) {
        for (const lbl of ['uploads', 'images', 'scenes', 'characters', 'avatars', 'all']) {
          const tab = findDialogTab(dlg, lbl);
          if (!tab) continue;
          log(`Đính ref qua dialog: media "${mediaName || mediaId}" chưa thấy — thử tab "${lbl}".`);
          const tabc = elCenter(tab);
          await clickCdpxy(tabc.x, tabc.y, tab);
          await wait(450);
          item = await scrollFindDialogItem(dlg, mediaId, mediaName);
          if (item) break;
        }
      }
      if (!item) {
        log(`Đính ref qua dialog: KHÔNG tìm thấy media "${mediaName || mediaId}" trong dialog.`);
        // Đóng dialog bằng ESC để không treo UI
        try { await chrome.runtime.sendMessage({ type: 'cdp:key', key: 'Escape', code: 'Escape', keyCode: 27 }); } catch (_) {}
        return { ok: false, reason: `không tìm thấy media "${mediaName || mediaId}" trong dialog`, count };
      }
      // (c) Chọn item → 'Add to Prompt'
      if (dialogItemSelected(item)) {
        log(`Đính ref qua dialog: item "${mediaName || mediaId.slice(0, 8)}" đã selected sẵn — click nút Add to Prompt.`);
        const addBtn = await waitFor(() => findAddToPromptButton(dlg), 2000);
        if (addBtn) {
          const ac = elCenter(addBtn);
          if (!(await clickCdpxy(ac.x, ac.y, addBtn))) {
            return { ok: false, reason: 'cdp:click Add to Prompt thất bại', count };
          }
        } else {
          const ic = elCenter(item);
          // CONCERN-2: PHẢI đọc return — guard stale chặn / CDP fail mà rơi thẳng xuống
          // khối verify (chỉ wait + count += 1 + log "thành công") = báo thành công GIẢ.
          if (!(await clickCdpxy(ic.x, ic.y, item))) {
            return { ok: false, reason: 'cdp:click item thất bại', count };
          }
        }
      } else {
        try { item.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (_) {}
        const ic = elCenter(item);
        if (!(await clickCdpxy(ic.x, ic.y, item))) {
          return { ok: false, reason: 'cdp:click item thất bại', count };
        }
        await wait(300);
        const addBtn = await waitFor(() => findAddToPromptButton(dlg), 2000);
        if (addBtn) {
          const ac = elCenter(addBtn);
          if (!(await clickCdpxy(ac.x, ac.y, addBtn))) {
            return { ok: false, reason: 'cdp:click Add to Prompt thất bại', count };
          }
        } else {
          const ic2 = elCenter(item);
          if (!(await clickCdpxy(ic2.x, ic2.y, item))) {
            return { ok: false, reason: 'cdp:click item thất bại', count };
          }
        }
      }
      // (d) Verify chip ref sau khi dialog đóng
      await wait(500);
      count += 1;
      log(`Đính ref qua dialog: Đã thêm ref "${mediaName || mediaId.slice(0, 8)}" thành công (chip #${count}).`);
      await wait(400); // chờ UI ổn định
    }
    return { ok: true, count };
  }

  // attachRefsMixed(images) — FIX blocker 2: xử lý TỪNG ingredient theo đúng
  // thứ tự mảng (#1 model, #2 product, #3 bg), KHÔNG còn all-or-nothing:
  //   - ingredient ĐÃ có mediaId (media upload-once sẵn trong project) → đính qua
  //     dialog add_2 (chip ref, KHÔNG upload lại file → không tạo media mới).
  //   - ingredient CHƯA có mediaId (dataUrl/url) → uploadOneRef(addToPrompt:true):
  //     upload asset vào project RỒI bấm "Add to Prompt" ngay trong dialog → chip
  //     ref THẬT (upload-only dành cho uploadAssetMedia, giữ nguyên ESC). count chỉ
  //     tăng khi uploadOneRef ok — caller còn fail-closed bằng countComposerChips().
  // Lỗi ở bất kỳ ingredient nào → trả {ok:false} (caller HỦY, KHÔNG gửi prompt
  // thiếu refs); hết mảng không lỗi → {ok:true, count}. Trả {ok:true, count:0}
  // khi mảng rỗng/null (caller hiểu là không có ref để xử lý).
  // G10-QA-E (user requirement): refIds = các media id THỰC SỰ được lượt này tiêu thụ —
  // (a) id asset upload MỚI bởi uploadOneRef (dialog-diff verify trong
  // uploadImageViaDialog, content.js:2824) + (b) mediaId CỦA CHÍNH ingredient được đính
  // qua attachRefsByDialog trong lượt này (origin đã có mediaId cùng project = đúng ảnh
  // chip user chọn). KHÔNG bao giờ gồm media không đính lượt này. Trường THÔNG TIN
  // thuần: scene flow bỏ qua; extractModel dọn SAU khi rename verified.
  async function attachRefsMixed(images) {
    // Dọn chip ref còn sót TRƯỚC khi đính ref mới — composer chỉ chứa ĐÚNG ref của
    // thao tác hiện tại.
    await removeAllChips();
    // #33-live (fail-closed): sau khi dọn, composer PHẢI trống. Chip cũ còn sót sẽ làm
    // đường addToPrompt báo "thành công" nhờ đếm CHIP CŨ (giả dương) — chặn trước khi
    // đính bất kỳ ref nào.
    if (countComposerChips() > 0) {
      log(`⚠ attachRefsMixed: composer vẫn còn ${countComposerChips()} chip ref sau removeAllChips — HỦY (không đính ref lên ref cũ).`);
      return { ok: false, reason: 'composer còn chip ref cũ (removeAllChips không sạch)', count: 0 };
    }
    const list = (images || []).filter(Boolean);
    if (!list.length) return { ok: true, count: 0 };
    let count = 0;
    const refIds = []; // G10-QA-E: media ids ACTUALLY consumed by this call (fresh uploads + attached pre-existing ids)
    // (mục 8) video giờ gửi scene + 3 assets → 4 refs; img vẫn 3: model/product/bg.
    // roleNames chỉ dùng cho LOG (tên thân thiện của từng ref).
    const roleNames = list.length > 3
      ? ['scene image', 'model (character)', 'product', 'background']
      : ['model (character)', 'product', 'background'];
    for (let i = 0; i < list.length; i++) {
      const ing = list[i];
      const role = roleNames[i] || `ref #${i + 1}`;
      // G10-fix/#30 (P0): CHỈ mediaId mới đi dialog — name KHÔNG phải bằng chứng media đã
      // upload. Trước đây `|| ing.name` đẩy {dataUrl,name} (ảnh gốc local của batch tách)
      // vào attachRefsByDialog → "không tìm thấy media" → chết mọi ô. {dataUrl}/{url} →
      // uploadOneRef bên dưới, đúng doc-comment.
      if (ing.mediaId) {
        log(`Đính ref ${role}: name="${ing.name || ''}", mediaId=${String(ing.mediaId).slice(0, 8)}…`);
        const ar = await attachRefsByDialog([ing]);
        if (!ar || !ar.ok) {
          log(`⚠ Đính ref ${role}: dialog thất bại (${(ar && ar.reason) || 'không rõ'})`);
          return { ok: false, reason: `lỗi đính ref ${role}: ${(ar && ar.reason) || 'thất bại'}`, count };
        }
        count += (ar.count || 1);
        // G10-QA-E (point 1): a pre-existing project media attached BY THIS RUN is
        // exactly the selected origin chip — it counts as consumed (caller may clean
        // it after a verified extraction). Failure paths above return WITHOUT pushing.
        refIds.push(String(ing.mediaId));
      } else if (ing.dataUrl || ing.url) {
        const file = await imageToFile(ing);
        if (!file) {
          log(`⚠ Ref ${role} không đọc được ảnh.`);
          return { ok: false, reason: `ref ${role} không đọc được ảnh`, count };
        }
        // Live G10-QA-C #33 (Flow mới): uploadOneRef(addToPrompt:true) vừa upload asset
        // vừa bấm "Add to Prompt" ngay trong dialog → CHIP REF thật trong prompt box.
        // count chỉ tăng khi up.ok (chip đã được xác nhận trong hàm đó); caller vẫn
        // fail-closed bằng countComposerChips() — không count bừa khi chip vắng mặt.
        const up = await uploadOneRef(file, i, 1, true);
        if (up && up.ok) {
          count += 1;
          // G10-QA-E: fresh upload — id verified by dialog diff inside
          // uploadImageViaDialog (content.js:2824) → forwarded by uploadOneRef.
          if (up.mediaId) refIds.push(String(up.mediaId));
          log(`Đính ref ${role}: upload ảnh → chip thành công.`);
        } else {
          log(`⚠ Ref ${role}: upload thất bại (${(up && up.reason) || 'không rõ'})`);
          return { ok: false, reason: `lỗi upload ref ${role}`, count };
        }
      } else {
        log(`⚠ Ref ${role} không có dữ liệu.`);
        return { ok: false, reason: `ref ${role} không có dữ liệu`, count };
      }
    }
    return { ok: true, count, refIds };
  }

  // ---------------------------------------------------------------------------
  // Send + result polling (per kind). [P0 giữ + mở rộng kind/sceneIdx]
  // ---------------------------------------------------------------------------
  // CDP trusted click tại toạ độ (x, y) — dùng chung (clickSend + attachRefsByDialog).
  // P2: aimEl (tuỳ chọn) = element ĐÍCH → tự đóng dấu + background pre-check
  // elementFromPoint. KHÔNG retry trong hàm này: không có finder nên "bấm lại" là bấm
  // lại đúng toạ độ cũ (vô nghĩa), và bấm lại đích destructive mà chưa chắc trượt là
  // rủi ro double-action. Caller nào đã có vòng retry riêng thì vẫn hưởng.
  // P2c — PHẠM VI: MỌI call site clickCdpxy có element handle THẬT tại chỗ đều đã truyền
  // aimEl (20/20: moreBtn/trashItem/renameItem/doneBtn/trigger/uploadsTab/uploadBtn/backBtn/
  // btn quyền-video/host chip/tab+item+addBtn dialog/btn tile-fail/delBtn+confirmBtn
  // xoá project) + clickNewProject (raw cdp:click, tự đóng dấu + stale-retry 1 lần).
  // NIT-7 (vá P2c): playBtn preview (raw cdp:click) NAY CŨNG mang marker element đích — mọi
  // đường raw cdp:click đều đã có guard (clickReal, clickRealVerified, clickCdpxy, clickSend,
  // clickNewProject, playBtn). Không còn site dispatch toạ độ nào thiếu marker.
  // Guard = CHẶN cú bấm sai, KHÔNG phải "bấm bù": ngoài clickNewProject (có đo lại rect)
  // không site nào được thêm retry khi chưa có bằng chứng trượt.
  async function clickCdpxy(x, y, aimEl) {
    try {
      // Không aimEl (đa số caller) ⇒ KHÔNG gọi aimMark: tránh log cảnh báo vô nghĩa và giữ
      // nguyên hành vi cũ (background bỏ qua pre-check khi expect null).
      const expect = aimEl ? aimMark(aimEl) : null;
      const res = await chrome.runtime.sendMessage({ type: 'cdp:click', x, y, expect });
      logProbeError(res);
      if (res && res.reason === 'stale-coordinate') {
        log(`clickCdpxy: stale-coordinate — (${x},${y}) elementFromPoint trúng ${JSON.stringify(res.at && res.at.found)} — BỎ QUA click.`);
        return false;
      }
      return !!(res && res.ok);
    } catch (_) {
      return false;
    } finally {
      aimUnmark(aimEl);
    }
  }

  // P2: text THẬT của composer (bỏ placeholder — UI mới đặt .prosemirror-placeholder
  // cùng container nên không thể chỉ đọc textContent). Dùng cho verify-after-click
  // của clickSend: composer rỗng = Flow đã nhận prompt.
  function composerHasText() {
    const c = findComposer();
    if (!c) return false;
    try {
      const clone = c.cloneNode(true);
      clone.querySelectorAll('.prosemirror-placeholder, [class*="placeholder" i]').forEach((n) => n.remove());
      return norm(clone.textContent || '').length > 0;
    } catch (_) {
      return norm(c.textContent || '').length > 0;
    }
  }

  async function clickSend() {
    // P2 verify-after-click: res.ok của CDP chỉ nghĩa "đã dispatch 2 event tại toạ độ",
    // KHÔNG phải "Flow đã nhận lệnh gửi" (đo ở content → dispatch trong background sau
    // 200-800ms; click trượt vẫn ok:true). Tín hiệu verify: composer RỖNG ***và trước send
    // nó CÓ text*** (preHadText — đọc rỗng ngay từ đầu là lỗi đọc composer,
    // không phải bằng chứng đã gửi) HOẶC có nút 'stop Stop' (flowIsGenerating).
    // Bấm lại TỐI ĐA 2 lần và CHỈ khi trạng thái TRƯỚC-send còn NGUYÊN (composer còn
    // prompt + Flow chưa chạy + nút Send còn enabled) — tránh double-submit (2 job =
    // 2x credit). KHÔNG xác nhận được và trạng thái đã khác → fail-closed, KHÔNG bấm lại.
    const preHadText = composerHasText();
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      // MỘT try/finally bọc TRỌN thân mỗi attempt: mọi đường thoát (verify OK /
      // verify-fail / stale-coordinate / lỗi CDP / throw / continue) đều gỡ dấu ở
      // finally — không rải aimUnmark ở từng nhánh return (dễ rò marker lên DOM Flow).
      let btn = null;
      try {
        btn = findSendButton();
        if (!btn || btn.disabled) {
          log('Không tìm thấy nút Send khả dụng ("arrow_forward Create").');
          return false;
        }
        const mark = aimMark(btn);
        const r = btn.getBoundingClientRect();
        const x = Math.round(r.left + r.width / 2);
        const y = Math.round(r.top + r.height / 2);
        let res = null;
        try {
          res = await chrome.runtime.sendMessage({ type: 'cdp:click', x, y, expect: mark });
        } catch (_) { res = null; }
        logProbeError(res);
        if (res && res.reason === 'stale-coordinate') {
          log(`clickSend: nút Send lệch toạ độ (trúng ${JSON.stringify(res.at && res.at.found)}) — đo lại + thử lại (lần ${attempt}).`);
          if (attempt < 2) { await wait(200); continue; }
          log('❌ clickSend: nút Send lệch toạ độ sau 2 lần — KHÔNG bấm mù.');
          return false;
        }
        if (!(res && res.ok)) {
          log('Lỗi khi bấm Send qua CDP: ' + (res && res.error ? res.error : 'không rõ.'));
          return false;
        }
        // verify: lần 1 chờ 6s, lần 2 (retry) chờ 2.5s. Vì sao 6s (CONCERN-1): Flow thật
        // có ca UI phản hồi ~3s > cửa sổ 2.5s cũ ⇒ lần 1 bị coi là "chưa xác nhận" OAN ⇒
        // retry = gửi lần 2 trong khi lần 1 ĐÃ ăn = double-submit (2 job = 2x credit).
        // Cửa sổ rộng hơn cắt lớp nhiễu đó; trần vẫn ≤2 lần gửi, không bao giờ bấm lần 3.
        const verifyMs = attempt === 1 ? 6000 : 2500;
        if (await waitFor(() => (preHadText && !composerHasText()) || flowIsGenerating(), verifyMs, 250)) {
          log('Đã bấm Send — verify OK (composer rỗng / Flow đang chạy). Bắt đầu theo dõi kết quả.');
          return true;
        }
        const unchanged = preHadText && composerHasText() && !flowIsGenerating();
        log(`⚠ clickSend: chưa xác nhận được đã gửi (lần ${attempt}) — composer ${composerHasText() ? 'còn text' : 'đã khác'}, Flow ${flowIsGenerating() ? 'đang chạy' : 'chưa chạy'}.`);
        if (unchanged && attempt < 2) {
          log('⚠ clickSend: trạng thái TRƯỚC-send còn NGUYÊN — bấm lại lần 2 (kiểm tra có job trùng trên Flow!).');
          continue;
        }
        log('❌ clickSend: KHÔNG bấm lại (tránh gửi trùng) — kiểm tra trạng thái trên trang Flow.');
        return false;
      } finally {
        aimUnmark(btn);
      }
    }
    return false;
  }

  // ITEM 11: KHÔNG còn dùng nút 'Try again' của Flow — thay bằng TỰ GỬI LẠI ĐẦY
  // ĐỦ (xem startPolling: typePrompt lại + re-upload refs nếu thiếu + clickSend
  // lại, backoff 2s/4s/8s, tối đa 3 lần). Hàm cũ bị bỏ hẳn (không còn caller).

  let pollTimer = null;
  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function emit(type, payload) {
    try {
      if (chrome.runtime && chrome.runtime.id) {
        chrome.runtime.sendMessage({ type, ...payload });
      }
    } catch (_) {
      // no panel to notify
    }
    // G5/S3: MỌI lỗi job đi qua đúng một cửa này (4 callsite emit('fail') ở
    // failDisconnect / timeout / 2 nhánh unusual-activity) ⇒ hook ở đây phủ đủ,
    // không phải sửa từng callsite và không thể lệch khi thêm đường fail mới.
    if (type === 'fail') {
      try {
        const reason = (payload && payload.reason) || 'other';
        const notis = unusualNotiEls();
        emitErrorRecord({
          source: 'job',
          reason,
          sceneIdx: payload ? payload.sceneIdx : null,
          kind: payload ? payload.kind : null,
          model: (activeJob && activeJob.model) || null,
          projectId: projectIdFromHref(location.href),
          promptSent: (activeJob && activeJob.prompt) || null,
          dom: dumpEl(latestFailedTile()),
          notice: dumpEl(notis[0] || null),
          recentLogs: [],   // sidepanel enrich (content không có #log)
        });
        markErrorsSeen();
      } catch (_) { /* chẩn đoán best-effort — KHÔNG được làm hỏng job */ }
    }
  }

  // ITEM 11 (1): đếm số bubble lỗi "Something went wrong" trong body.innerText —
  // regex normalize bao biến thể ('Something went wrong.' / 'Please try again.' /
  // 'went wrong while ...'); popup message (role=alert/aria-live/.toast) cũng
  // nằm TRONG body (recon: Flow shadowHosts = 0) nên quét body là đủ. Dùng count
  // (không phải boolean) vì session panel GIỮ bubble lỗi cũ của scene/run trước
  // trong DOM → phải phát hiện bubble MỚI bằng count > baseline (chụp ngay
  // TRƯỚC clickSend trong generate), tránh SWW stale gây gửi lại vô nghĩa.
  // ---- FAIL TILE (Flow render lỗi generation dưới dạng <flow-error-tile>) ----
  // "Failed + unusual activity / Help Center" KHÔNG khớp SWW_RE → phải detect bằng
  // tile riêng (flow-error-tile). Reason đọc từ .error-message-text.
  let errorTileBaseline = 0; // snapshot trước clickSend — để phát hiện tile fail MỚI
  let unusualBaseline = 0;   // (FIX 3) snapshot dialog/banner "unusual activity" trước clickSend
  let activeJob = null;      // {prompt, model} — read by the diagnostic dump + policy_blocked fail
  let policyTileBaseline = 0; // S2: snapshot of error-tile policies before send (§3.7)
  // S2 (issue #36) — receipt state: contentUuid captures from the submit response
  // of THIS VERY TAB (main-world hook posts via postMessage). Each run (runId)
  // keeps its capture list; the receipt gate settles ONLY when the DOM poster
  // uuid matches the contentUuid of THE run itself — any other uuid (another
  // run / asb / no-uuid) does NOT settle (keeps the old media). Capped at 8/run
  // (SWW retries ~3 max) to prevent unbounded growth.
  const runReceipts = new Map();
  const runResolved = new Set(); // (BLOCKER B) runIds whose submit response has been SEEN
  // (a capture arrived, or a parsed-ok no-idlike marker). Policy_blocked is classified
  // only for a resolved run without captures — an error tile alone is NOT proof of
  // a rejected submit (the capture may simply not have posted yet).
  let activeRunId = null;   // the run currently polling — captures arriving now attach to it
  let currentRunId = null;  // runId of the armed poll (bound from the generate dispatch)
  function receiptsFor(runId) {
    if (!runId) return [];
    const list = runReceipts.get(runId);
    return list || [];
  }
  function receiptMatches(runId, domUuid) {
    if (!runId || typeof domUuid !== 'string' || !domUuid) return false;
    const u = String(domUuid).toLowerCase();
    const list = receiptsFor(runId);
    if (!list.length) return false;
    return list.some((r) => r && r.contentUuid && String(r.contentUuid).toLowerCase() === u);
  }
  // (BLOCKER A) The run is armed (activeRunId) at generate BEFORE
  // clickSend — the submit response can arrive while clickSend is still verifying
  // (up to 6s first attempt) but AFTER the POST; if activeRunId were armed only
  // inside startPolling, the bridge (`if (!activeRunId) return;`) would drop that
  // early capture → receipt gate never settles → false-fail + wasted credit.
  function armRun(runId) {
    currentRunId = runId;
    if (runId) activeRunId = runId;
  }
  function disarmRun(runId) {
    if (currentRunId === runId) currentRunId = null;
    if (activeRunId === runId) activeRunId = null;
  }
  function clearRunState(runId) {
    if (runId) { runReceipts.delete(runId); runResolved.delete(runId); }
    if (activeRunId === runId) activeRunId = null;
  }
  // Bridge MAIN→isolated (pattern blob-capture.js:1241): source + origin +
  // source-window check. A capture attaches ONLY while a run is active (the busy
  // lock serializes runs — a capture from a PREVIOUS run arriving LATE after the
  // run has finished can never attach to the next run because activeRunId is
  // already null).
  window.addEventListener('message', (ev) => {
    const d = ev.data || {};
    if (!d || d.source !== 'asf-receipt-capture') return;
    if (ev.source !== window) return;
    if (ev.origin !== location.origin) return;
    if (d.rpcId !== 'YhhmEf' && d.rpcId !== 'ogiZ0b') return;
    if (!activeRunId) return;
    // (BLOCKER B) parsed-ok no-idlike marker: the run resolved WITHOUT a capture —
    // record it so the policy gate may classify, but do NOT fabricate a uuid.
    if (d.noIdlike === true) {
      runResolved.add(activeRunId);
      log(`S2 resolved (no-idlike): run ${activeRunId} ← {${d.rpcId}} — no capture, policy may classify.`);
      return;
    }
    if (typeof d.contentUuid !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(d.contentUuid)) return;
    runResolved.add(activeRunId);
    const list = runReceipts.get(activeRunId) || [];
    if (list.length >= 8) list.shift(); // bounded per run
    list.push({ rpcId: d.rpcId, jobId: d.jobId || null, contentUuid: d.contentUuid.toLowerCase(), at: d.at || Date.now() });
    runReceipts.set(activeRunId, list);
    log(`S2 capture: run ${activeRunId} ← {${d.rpcId}, ${String(d.contentUuid).slice(0, 8)}…}`);
  });
  // G5/S3: tile/notice lỗi ĐÃ báo cáo (job hoặc observer). Dùng WeakSet theo
  // reference: Flow virtual-scroll unmount tile cũ ⇒ đếm count sẽ báo lỗi giả.
  const seenErrors = new WeakSet();
  function failedTiles() {
    return [...document.querySelectorAll('flow-error-tile')];
  }

  // G5/S4: observer ngoài job. Bắt tile/notice lỗi MỚI khi KHÔNG có job đang chạy.
  // KHÔNG debounce: MutationObserver callback đã được browser gom theo microtask;
  // thêm timer chỉ mở rộng cửa sổ race.
  let errorObserver = null;
  function failedTilesIn(node) {
    if (!node || node.nodeType !== 1) return [];
    return failedTiles().filter((el) => el === node || (node.contains && node.contains(el)));
  }
  function unusualNotiElsIn(node) {
    if (!node || node.nodeType !== 1) return [];
    return unusualNotiEls().filter((el) => el === node || (node.contains && node.contains(el)));
  }
  function stopErrorObserver() {
    if (errorObserver) { errorObserver.disconnect(); errorObserver = null; }
  }
  function startErrorObserver() {
    // Guard: môi trường không có MutationObserver (vm harness, ngữ cảnh bị hạn chế)
    // ⇒ bỏ qua observer thay vì ném ở boot và giết cả content script.
    if (typeof MutationObserver === 'undefined') return;
    stopErrorObserver();
    // Baseline: mọi lỗi đang có trên DOM coi như đã biết ⇒ không phát lại.
    markErrorsSeen();
    errorObserver = new MutationObserver((records) => {
      // Trong job: KHÔNG phát (S3 là nguồn phát), nhưng ĐÁNH DẤU NGAY các node lỗi
      // vừa thêm — nếu để callback chạy sau khi state.busy về false thì tile của job
      // sẽ bị coi là lỗi ngoài job ⇒ trùng.
      if (state.busy) {
        for (const r of records) for (const n of (r.addedNodes || [])) {
          for (const el of failedTilesIn(n)) seenErrors.add(el);
          for (const el of unusualNotiElsIn(n)) seenErrors.add(el);
        }
        return;
      }
      for (const t of failedTiles()) {
        if (seenErrors.has(t)) continue;
        seenErrors.add(t);
        emitErrorRecord({
          source: 'observer',
          reason: failedTileReason(t) || 'other',
          sceneIdx: null, kind: null, model: null, projectId: null, promptSent: null,
          dom: dumpEl(t), notice: null, recentLogs: [],
        });
      }
      for (const n of unusualNotiEls()) {
        if (seenErrors.has(n)) continue;
        seenErrors.add(n);
        emitErrorRecord({
          source: 'observer',
          reason: 'unusual-activity',
          sceneIdx: null, kind: null, model: null, projectId: null, promptSent: null,
          dom: null, notice: dumpEl(n), recentLogs: [],
        });
      }
    });
    errorObserver.observe(document.body, { childList: true, subtree: true });
  }
  // Q7: tắt khi tab ẩn (tiết kiệm CPU); hiện lại thì baseline lại rồi observe.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopErrorObserver();
    else startErrorObserver();
  });

  // G5/S3: element → object chẩn đoán. Cap để 1 tile khổng lồ không làm phình storage.
  function dumpEl(el) {
    if (!el) return null;
    try {
      const attrs = {};
      for (const a of (el.attributes || [])) attrs[a.name] = a.value;
      const chain = [];
      let p = el.parentElement, hops = 0;
      while (p && hops < 6) {
        chain.push(p.tagName ? p.tagName.toLowerCase() : '?');
        p = p.parentElement; hops++;
      }
      return {
        tag: (el.tagName || '').toLowerCase(),
        attributes: attrs,
        classes: el.className != null ? String(el.className) : '',
        text: (el.textContent || '').slice(0, 2000),
        outerHTML: (el.outerHTML || '').slice(0, 20000),
        ancestorChain: chain,
      };
    } catch (_) {
      return null;
    }
  }

  // G5/S3: phát BROADCAST errorRecord. sendMessage trả Promise ⇒ try/catch KHÔNG
  // bắt rejection; phải .catch. background.js cũng nhận nhưng bỏ qua type này.
  function emitErrorRecord(entry) {
    try {
      const p = chrome.runtime.sendMessage(Object.assign({ type: 'errorRecord' }, entry));
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) { /* extension context invalidated */ }
  }

  // G5/S3: đánh dấu mọi tile/notice lỗi hiện có là ĐÃ báo cáo — để observer (S4)
  // không phát trùng cho lỗi của job.
  function markErrorsSeen() {
    for (const t of failedTiles()) seenErrors.add(t);
    for (const n of unusualNotiEls()) seenErrors.add(n);
  }

  // (FIX 3) "unusual activity" có thể hiện DIALOG/BANNER/TOAST (mat-dialog, snackbar,
  // banner notice) thay vì flow-error-tile — quét các container overlay + text khớp.
  // Trả danh sách element KHỚP (rỗng = không có) — dùng count>baseline để detect MỚI.
  function unusualNotiEls() {
    const sel = 'mat-dialog-container, [role="dialog"], [role="alert"], .cdk-overlay-pane, [class*="snackbar" i], [class*="toast" i], [class*="banner" i], [class*="notice" i]';
    const out = [];
    for (const el of document.querySelectorAll(sel)) {
      const t = norm((el && el.textContent) || '');
      if (!t) continue;
      if (!/unusual\s*activity|suspicious\s*activity|pattern\s*detected|unusual\b/i.test(t)) continue;
      out.push(el);
    }
    return out;
  }
  function unusualNotiCount() {
    return unusualNotiEls().length;
  }
  // Text ngắn để log khi có unusual (dòng đầu text của element đầu tiên).
  function unusualNotiText() {
    const els = unusualNotiEls();
    if (!els.length) return '';
    const t = norm(els[0].textContent || '').replace(/\s+/g, ' ');
    return t.length > 160 ? t.slice(0, 160) + '…' : t;
  }
  function failedTileCount() {
    return failedTiles().length;
  }
  function failedTileReason(tile) {
    const t = norm((tile && tile.textContent) || '');
    if (/unusual\s*activity/i.test(t)) return 'unusual-activity';
    if (/something\s*went\s*wrong|try\s*again/i.test(t)) return 'something-went-wrong';
    return 'generation-failed';
  }
  function latestFailedTile() {
    const arr = failedTiles();
    return arr[arr.length - 1] || null;
  }
  // S2 policy-block (§3.7 PRD): Flow shows an error tile with this exact text
  // when a submit is policy-rejected (R6 observation — flow-error-tile OR the
  // failure branch of flow-image-tile). The UI text may wrap → compare
  // normalized.
  const POLICY_TILE_TEXT = 'Failed This generation might violate our policies. Please try a different prompt';
  function policyTileCount() {
    const want = norm(POLICY_TILE_TEXT);
    let n = 0;
    for (const el of document.querySelectorAll('flow-error-tile, flow-image-tile, flow-video-tile')) {
      if (norm(el.textContent || '').includes(want)) n += 1;
    }
    return n;
  }
  async function clipRegistryHasNullClip() {
    // Best-effort, read-only, returns null when IndexedDB is unavailable (seam
    // test, private mode, page blocks it). PRECEDENCE (§3.7): error tile + submit
    // response WITH NO idlike (⇒ this run has no capture) is ENOUGH to classify
    // policy_blocked; a clipRegistry {clipId:null} entry is only CONFIRMATION —
    // when absent, still classify by tile + no-idlike (best-effort must never
    // block classification).
    try {
      if (typeof indexedDB === 'undefined' || typeof indexedDB.open !== 'function') return null;
      const db = await new Promise((resolve, reject) => {
        let rq = null;
        try { rq = indexedDB.open('SceneEditorStorage'); } catch (e) { reject(e); return; }
        rq.onsuccess = () => resolve(rq.result);
        rq.onerror = () => reject(rq.error || new Error('idb open fail'));
      });
      try {
        if (!db || !db.objectStoreNames || !db.objectStoreNames.contains('clipRegistry')) return null;
        const rows = await new Promise((resolve, reject) => {
          const tx = db.transaction('clipRegistry', 'readonly');
          const req = tx.objectStore('clipRegistry').getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error || new Error('idb read fail'));
        });
        return Array.isArray(rows) && rows.some((r) => r && typeof r === 'object' && ('clipId' in r) && (r.clipId === null || r.clipId === undefined));
      } finally {
        try { db.close(); } catch (_) {}
      }
    } catch (_) { return null; }
  }
  const SWW_RE = /somethingwentwrong|pleasetryagain|wentwrong(?:while|when)/gi; // /g: đếm MỌI bubble (match không có /g chỉ trả match đầu)
  let swwBaseline = -1; // baseline count chụp trước lần clickSend đầu — set ở generate()
  function swwCount() {
    const m = norm(document.body.innerText || '').match(SWW_RE);
    return m ? m.length : 0;
  }
  function swwFresh() {
    if (swwBaseline < 0) return false; // chưa có baseline → chưa thể khẳng định
    return swwCount() > swwBaseline;
  }
  // Recon: khi đang generate/queue, nút 'arrow_forward Create' thay bằng 'stop Stop'.
  // Dùng làm cờ "Flow đang chạy" — KHÔNG retrigger SWW retry trong lúc chạy.
  function flowIsGenerating() {
    return [...document.querySelectorAll('button')].some((b) => {
      const t = norm(b.textContent);
      return t === 'stopStop' || (t.includes('stop') && t.endsWith('Stop'));
    });
  }
  // T-stop: nút 'stop Stop' của Flow khi đang generate/queue — bấm để HỦY thật
  // (dừng GPU/credit). Giống flowIsGenerating: text là 'stop Stop' (icon + nhãn).
  function findFlowStopButton() {
    return [...document.querySelectorAll('button')].find((b) => {
      const t = norm(b.textContent);
      return t === 'stopStop' || (t.includes('stop') && t.endsWith('Stop'));
    }) || null;
  }
  async function clickFlowStop() {
    if (!findFlowStopButton()) {
      log('T-stop: không thấy nút Stop của Flow (chưa generate?).');
      return false;
    }
    // FIX (luồng 5): dùng clickRealVerified — pattern cũ (elCenter → clickCdpxy single
    // attempt) dính stale-coordinate Windows (Flow dịch vị ~56px giữa đo và click, class
    // bug đã chứng minh) → nút 'stop Stop' trượt → Flow TIẾP TỤC chạy job tốn credit.
    // clickRealVerified: tìm lại + đo lại mỗi lần + verify = flowIsGenerating() hết
    // (nút stop biến mất = job đã dừng) + retry ≤3.
    const res = await clickRealVerified(findFlowStopButton, () => !flowIsGenerating(), { maxRetry: 3 });
    if (res.ok) {
      log('T-stop: đã bấm Stop trên Flow — job đã dừng.');
      return true;
    }
    log('⚠ T-stop: Flow VẪN đang chạy sau 3 lần bấm Stop — bấm dừng thủ công trên trang Flow.');
    return false;
  }

  // G10-QA-B2 (S2): wait for Flow to be idle (no 'stop Stop' button) before sending a
  // new command. The cap is finite; on expiry return false so the caller fails closed
  // instead of sending on top of a running job.
  async function probeVirtualGridEnd(scan) {
    const vp = document.querySelector('cdk-virtual-scroll-viewport');
    if (!vp || vp.scrollHeight <= vp.clientHeight) return scan();
    const originalTop = vp.scrollTop;
    try {
      vp.scrollTop = vp.scrollHeight - vp.clientHeight;
      vp.dispatchEvent(new Event('scroll', { bubbles: true }));
      await wait(220);
      return scan(vp);
    } finally {
      vp.scrollTop = originalTop;
      vp.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
  }
  async function probeVirtualGridStart(scan) {
    const vp = document.querySelector('cdk-virtual-scroll-viewport');
    if (!vp || vp.scrollHeight <= vp.clientHeight) return scan();
    const originalTop = vp.scrollTop;
    try {
      vp.scrollTop = 0;
      vp.dispatchEvent(new Event('scroll', { bubbles: true }));
      await wait(220);
      return scan(vp);
    } finally {
      vp.scrollTop = originalTop;
      vp.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
  }
  async function collectOffscreenMedia(baselineIds, baselineSrcs, requireUuid) {
    const scan = (vp) => collectMediaFrom(vp, baselineIds, baselineSrcs, requireUuid);
    const bottom = await probeVirtualGridEnd(scan);
    const top = await probeVirtualGridStart(scan);
    return bottom.concat(top);
  }
  async function waitFlowIdle(maxMs) {
    if (!flowIsGenerating()) return true;
    const t0 = Date.now();
    log('Flow đang generate — chờ rảnh trước khi gửi lệnh mới (tránh chồng lấn)...');
    while (Date.now() - t0 < maxMs) {
      await wait(FLOW_IDLE_POLL_MS);
      if (!flowIsGenerating()) {
        log(`Flow đã rảnh sau ${Math.round((Date.now() - t0) / 1000)}s — gửi tiếp.`);
        return true;
      }
    }
    log(`⚠ Flow vẫn đang generate sau ${Math.round(maxMs / 1000)}s — HỦY gửi để tránh chồng lấn.`);
    return false;
  }

  function startPolling(kind, sceneIdx, baseline, baselineIds, baselineSrcs, prompt, refsOpts, opts, refUploadIdsIn) {
    const refUploadIds = Array.isArray(refUploadIdsIn) ? refUploadIdsIn : [];
    stopPolling();
    // G10-QA-B2 (S1): requireUuid = a view-batch job -> accept uuid results only.
    const requireUuid = !!(opts && opts.requireUuid);
    // S2: this poll's runId (bound from generate via currentRunId).
    // activeRunId = the run currently polling — a submit capture arriving in
    // this window attaches to EXACTLY this run.
    const runId = currentRunId || null;
    if (runId) activeRunId = runId;
    let receiptMissLogged = false; // S2: log once when a media item fails the receipt match
    const start = Date.now();
    const startTs = Date.now();
    const maxMs = kind === 'vid' ? POLL_MAX_VIDEO_MS : requireUuid ? POLL_MAX_EXTRACT_MS : POLL_MAX_IMAGE_MS;
    pollHealth = { active: true, ticks: 0, startedAt: startTs, maxMs };
    let pollTicks = 0;

    // ITEM 11 (2): SWW → TỰ GỬI LẠI ĐẦY ĐỦ thay cho 'click Try again 1 lần'.
    // composer mất text sau SWW → typePrompt LẠI toàn bộ prompt; re-upload refs
    // nếu đợt đầu upload fail (ITEM 10 — video thiếu refs được chữa ở lượt retry);
    // clickSend lại; sau mỗi lần vẫn poll. N=3, backoff 2s/4s/8s, cooldown sau
    // mỗi lần gửi để gen chạy (không retrigger vội). Hết lượt/cả maxMs →
    // fail 'SWW retry exhausted' + release busy (đường thoát busy lock).
    const SWW_MAX_RETRIES = 3;
    const SWW_BACKOFF_MS = [2000, 4000, 8000];
    const SWW_COOLDOWN_MS = 8000;
    let swwAttempts = 0;
    let swwActive = false;   // đang trong lúc chờ backoff / gửi lại — không retrigger
    let swwCoolUntil = 0;    // vùng im lặng sau khi bấm Send lại
    let swwFirstSeen = 0;
    let queuedLogged = false; // (fix) the tick uses this var but it was never declared → ReferenceError on every tick reaching the queue check

    const failDisconnect = (reason) => {
      stopPolling();
      state.busy = false;
      clearRunState(runId);
      emit('fail', { sceneIdx, kind, reason, runId });
      pollHealth = null;
    };

    const resendNow = async () => {
      if (state.abortRequested) return false; // T-stop: hủy trước khi gửi lại
      // (a) FIX-4: job này CÓ yêu cầu refs (needRefs giờ là bool ĐỘC LẬP với kết
      // quả upload đợt đầu — trước đây 'needRefs && !uploaded' → luôn false khi
      // poll bắt đầu vì uploaded=true → nhánh re-upload DEAD PATH → Flow xóa
      // attachment sau "Something went wrong" thì gửi lại THIẾU refs). Kiểm tra
      // chip/thumb ref còn đủ trên page; THIẾU → upload LẠI ĐẦY ĐỦ refs trước
      // khi gõ prompt + send (log rõ bước re-upload).
      if (refsOpts && refsOpts.needRefs && Array.isArray(refsOpts.images) && refsOpts.images.some(Boolean)) {
        const missing = missingRefStems(refsOpts.images);
        if (!missing.length) {
          log('M2 retry: attachment refs còn đầy đủ trên page — không upload lại.');
        } else {
          const detail = missing.length === 1 && missing[0] === true
            ? 'không kiểm tra được (thiếu tên file)'
            : `thiếu ${missing.length}/${refsOpts.images.filter(Boolean).length} ref`;
          log(`M2 retry: attachment refs ${detail} — đính LẠI refs (lần retry ${swwAttempts + 1}/${SWW_MAX_RETRIES})...`);
          // Đợt C (FIX blocker 2): xử lý TỪNG ingredient theo thứ tự — đã có
          // mediaId → đính lại qua dialog add_2 (chip, không tạo media mới);
          // chưa có mediaId → upload đường cũ. KHÔNG còn all-or-nothing
          const ar = await attachRefsMixed(refsOpts.images);
          const up = !!(ar && ar.ok);
          if (up && Array.isArray(ar.refIds)) {
            for (const id of ar.refIds) {
              if (id && !refUploadIds.includes(id)) refUploadIds.push(id);
            }
          }
          if (!up) {
            log('M2 retry: đính/upload lại refs vẫn thất bại — HỦY retry, emit fail.');
            return false;
          }
          log('M2 retry: refs đã đính lại thành công.');
        }
      }
      // (b) không gửi prompt trống
      if (!prompt) {
        log('M2 retry: prompt trống — không gửi lại, emit fail.');
        return false;
      }
      // (c) composer mất text sau SWW → gõ LẠI TOÀN BỘ prompt
      if (!(await typePrompt(prompt))) {
        log('M2 retry: gõ lại prompt thất bại — HỦY retry, emit fail.');
        return false;
      }
      await wait(1200);
      // FIX-6 (ITEM 11): check LẠI flowIsGenerating() NGAY TRƯỚC clickSend —
      // Flow có thể bật 'stop Stop' trong lúc gõ prompt (gen mới bắt đầu sau
      // backoff) → resend lúc này = đè/submit song song. Chờ tối đa 6s cho gen
      // hiện tại xong; vẫn generating → HOÃN (trả 'deferred': caller KHÔNG tăng
      // swwAttempts, KHÔNG fail — tick kế tái lập lịch).
      let waitSend = 0;
      while (flowIsGenerating() && waitSend < 6000) {
        await wait(500);
        waitSend += 500;
      }
      if (flowIsGenerating()) {
        log('M2: Flow đang generate ngay trước Send — hoãn gửi lại (không tăng lượt, chờ lượt kế).');
        return 'deferred';
      }
      // (d) bấm Send lại (baseline/DONE-gate giữ nguyên: refs chỉ là ảnh thumb,
      //     không lọt identity gate img/video của media kết quả)
      if (state.abortRequested) return false; // T-stop: hủy ngay trước khi Send lại
      if (!(await clickSend())) {
        log('M2 retry: bấm Send lại thất bại — HỦY retry, emit fail.');
        return false;
      }
      return true;
    };

    pollTimer = setInterval(async () => {
      if (pollHealth) {
        pollHealth.ticks++;
        if (pollHealth.ticks % 10 === 0) log('poll tick #' + pollHealth.ticks + ' — elapsed ' + Math.round((Date.now() - startTs)/1000) + 's / max ' + Math.round(maxMs/1000) + 's');
      }
      // T-stop: user bấm Dừng khẩn cấp → dừng poll ngay (không emit gì — sidepanel
      // đã tự settle). busy do abortGeneration handler thả.
      if (state.abortRequested) {
        stopPolling();
        state.busy = false;
        return;
      }
      // FIX-5 (ITEM 11): timeout-guard đặt ĐẦU tick — kể cả khi phần sau liên tục
      // throw, tick KẾ vẫn kịp fail đúng maxMs → busy lock LUÔN có đường thoát.
      if (Date.now() - start >= maxMs) {
        log(`Hết thời gian chờ ${maxMs / 60000} phút — chưa thấy kết quả ${kind === 'vid' ? 'video' : 'ảnh'}` +
            ` (count hiện tại: ${countMedia(kind)}, baseline: ${baseline}).`);
        pollHealth = null;
        stopPolling();
        state.busy = false;
        clearRunState(runId);
        emit('fail', { sceneIdx, kind, reason: 'timeout', runId });
        return;
      }
      try {
        // M9: DONE gated theo IDENTITY — chỉ chấp nhận media có id KHÔNG nằm trong
        // baselineIds (mới sinh từ lần bấm này). Không còn dựa (count>baseline)
        // hay thứ tự DOM (Flow prepend card / chèn card lạ giữa baseline-tick).
        const offscreen = requireUuid && ++pollTicks % 4 === 0
          ? await collectOffscreenMedia(baselineIds, baselineSrcs, requireUuid)
          : [];
        const mounted = findNewMedia(kind, baselineIds, baselineSrcs, { requireUuid });
        const fresh = offscreen.find((candidate) => candidate.id) || mounted;
        if (fresh) {
          const url = fresh.url;
          // S2 receipt gate (PRD §3.4): settle ONLY when the DOM poster uuid EXACTLY
          // matches the captured contentUuid of THIS run. asb / no-uuid / uuid of
          // another run / no capture yet → do NOT settle (keep the old media),
          // keep polling until the real uuid (or a fail-closed timeout).
          const domUuid = mediaIdOf(url);
          if (runId && receiptMatches(runId, domUuid)) {
            log(`DONE — ${kind === 'vid' ? 'video' : 'ảnh'} sẵn sàng: ${url.slice(0, 100)}`);
            log(`S2 receipt khớp — contentUuid=${domUuid} (run ${runId}).`);
            stopPolling();
            state.busy = false; // release busy lock khi có kết quả
            clearRunState(runId);
            emit('done', { url, sceneIdx, kind, runId, mediaId: domUuid, ...(refUploadIds && refUploadIds.length ? { refUploadIds } : {}) });
            return;
          }
          if (!receiptMissLogged) {
            receiptMissLogged = true;
            log(`S2 poll: media không khớp receipt run ${runId || '(none)'} — giữ media cũ, chờ contentUuid của chính run (${url.slice(0, 60)}…).`);
          }
        }

        // S2 policy-block detector (PRD §3.7): an error tile with the EXACT
        // policies text + a submit response that RESOLVED WITH NO idlike (⇒ this run
        // has no capture) → classify 'policy_blocked' instead of a generic fail; do
        // NOT self-retry at content (S3 revises the prompt and re-creates). A
        // clipRegistry clipId null is only CONFIRMATION (best-effort, read-only):
        // if unreadable, STILL classify by tile + resolved-no-idlike (precedence —
        // clipRegistryHasNullClip returns null).
        // (BLOCKER B) An error tile alone is NOT proof of a rejected submit: the hook
        // posts a capture ONLY after the page consumes res.text()/loadend, and an error
        // tile can mount BEFORE that (Flow's own load handlers run first). So for a run
        // WITH a runId we classify policy_blocked ONLY when the run is RESOLVED (a
        // capture OR a no-idlike marker arrived) and has NO capture; while UNRESOLVED we
        // KEEP POLLING (bounded by maxMs) and log a deferral — never false-positive.
        // The legacy `!runId` branch (pre-S3 path never carries a runId) keeps its
        // original tile-only behavior unchanged.
        if (policyTileCount() > policyTileBaseline) {
          // (BLOCKER B supplement) Resolve the best-effort clipRegistry FIRST and
          // ONLY THEN evaluate the decisive gate — a submit capture can ARRIVE while
          // this await is pending (the hook posts just after the tile mounts), making
          // receiptsFor(runId) non-empty / the run resolved. Re-checking AFTER the
          // await means such a capture is seen: the run must NOT be classified
          // policy_blocked. Evaluating the gate BEFORE the await would commit to
          // policy_blocked even though a real capture landed mid-await (race → false
          // positive survives). Legacy `!runId` branch keeps tile-only behavior.
          const clip = await clipRegistryHasNullClip();
          const runHasId = !!runId;
          const runIsResolved = runId && runResolved.has(runId);
          if (!runHasId || (runIsResolved && !receiptsFor(runId).length)) {
            const clipNote = clip === null
              ? ' (IndexedDB không đọc được — vẫn phân loại theo tile + no-idlike)'
              : (clip ? ' + clipRegistry clipId null' : '');
            log(`S2: error tile policies + không có capture (no-idlike)${clipNote} — emit fail policy_blocked (không tự retry tại content).`);
            stopPolling();
            state.busy = false;
            clearRunState(runId);
            emit('fail', { sceneIdx, kind, reason: 'policy_blocked', runId, prompt: (activeJob && activeJob.prompt) || prompt });
            return;
          }
          if (runHasId && !runIsResolved) {
            if (!receiptMissLogged) {
              receiptMissLogged = true;
              log(`S2: policy tile thấy nhưng run ${runId} CHƯA resolved (capture/no-idlike chưa về — tile có thể mount trước hook post) — defer classification, tiếp tục poll.`);
            }
          }
        }

        // FAIL TILE MỚI với reason "unusual activity" (KHÔNG khớp SWW_RE, là flag rủi ro
        // account) → dừng poll NGAY, emit fail để sidepanel hiện modal CHO USER CHỌN.
        // KHÔNG auto-retry. Lỗi "something went wrong" vẫn để SWW M2 auto-retry xử lý.
        if (failedTileCount() > errorTileBaseline) {
          const ft = latestFailedTile();
          if (failedTileReason(ft) === 'unusual-activity') {
            log('Flow báo "Failed: unusual activity" — dừng poll, emit fail (không auto-retry).');
            stopPolling();
            state.busy = false;
            clearRunState(runId);
            emit('fail', { sceneIdx, kind, reason: 'unusual-activity', runId });
            return;
          }
        }

        // (FIX 3) "unusual activity" DIALOG/BANNER/TOAST mới (không phải flow-error-tile) —
        // Flow chặn generation bằng notice overlay (banner dưới composer hoặc snackbar).
        // Không có tile fail → poll cũ chờ tới timeout 180s vô ích. Count > baseline =
        // notice MỚI xuất hiện từ job này → fail sớm reason chuẩn (KHÔNG gắn nhầm ảnh,
        // sidepanel dừng loop + hướng dẫn retry thủ công — không tự tốn credit).
        if (unusualNotiCount() > unusualBaseline) {
          log('⚠ Phát hiện nghi "unusual activity" (dialog/banner): ' + unusualNotiText() + ' — dừng poll, emit fail (không auto-retry).');
          stopPolling();
          state.busy = false;
          clearRunState(runId);
          emit('fail', { sceneIdx, kind, reason: 'unusual-activity', runId });
          return;
        }

        // M2 (v2): phát hiện SWW BUBBLE MỚI (count > baseline chụp trước send) →
        // lên lịch TỰ GỬI LẠI ĐẦY ĐỦ
        const now = Date.now();
        if (
          !swwActive &&
          swwAttempts < SWW_MAX_RETRIES &&
          now >= swwCoolUntil &&
          !flowIsGenerating() &&
          swwFresh()
        ) {
          swwActive = true;
          if (!swwFirstSeen) swwFirstSeen = now;
          const delayMs = SWW_BACKOFF_MS[Math.min(swwAttempts, SWW_BACKOFF_MS.length - 1)];
          const attempt = swwAttempts + 1;
          log(`M2: Flow báo "Something went wrong" — đợi ${delayMs / 1000}s rồi TỰ GỬI LẠI toàn bộ prompt (lần ${attempt}/${SWW_MAX_RETRIES})...`);
          setTimeout(async () => {
            // FIX-5: async callback bắt buộc try/catch — exception giữa chừng
            // (DOM/CDP hỏng) KHÔNG được bỏ mất đường thoát: catch gọi
            // failDisconnect (stopPolling + busy=false + emit fail ĐÚNG 1 lần).
            // Trước đây exception → swwActive kẹt true + busy giữ vô hạn.
            try {
              if (!pollTimer) return; // poll đã dừng (done/fail/timeout) — không gửi trễ
              // FIX-6: check LẠI flowIsGenerating() NGAY TRƯỚC khi bắt đầu
              // resendNow — sau backoff 2/4/8s Flow có thể ĐANG generate (nút
              // 'stop Stop' xuất hiện sau khi lên lịch). Chờ tối đa 10s cho đợt
              // gen hiện tại xong; hết 10s vẫn generating → HOÃN retry (KHÔNG
              // tăng swwAttempts), tick kế sẽ tái lập lịch.
              let waitGen = 0;
              while (flowIsGenerating() && pollTimer && waitGen < 10000) {
                await wait(1000);
                waitGen += 1000;
              }
              if (!pollTimer) return;
              if (flowIsGenerating()) {
                log('M2: Flow vẫn đang generate khi đến giờ gửi lại — HOÃN retry (không tăng lượt, tick kế thử lại).');
                swwActive = false;
                return;
              }
              const ok = await resendNow();
              if (!pollTimer) return; // poll dừng trong lúc await — không emit fail trùng
              if (ok === 'deferred') {
                // FIX-6: resendNow hoãn vì Flow bật generate đúng lúc gõ/send.
                log('M2: hoãn gửi lại (Flow đang generate) — không tăng lượt, tick kế thử lại.');
                swwActive = false;
                return;
              }
              if (!ok) {
                log('M2: retry không hoàn tất được — emit fail (SWW retry exhausted).');
                failDisconnect('SWW retry exhausted');
                return;
              }
              swwAttempts += 1;
              swwActive = false;
              swwCoolUntil = Date.now() + SWW_COOLDOWN_MS;
              log(`M2: đã tự gửi lại lần ${swwAttempts}/${SWW_MAX_RETRIES} — tiếp tục theo dõi kết quả.`);
            } catch (err) {
              if (!pollTimer) return; // không emit fail trùng sau done/fail/timeout
              log('M2: ngoại lệ khi gửi lại — emit fail (SWW retry exhausted): ' + (err && err.message || err));
              failDisconnect('SWW retry exhausted');
            }
          }, delayMs);
        }

        // ITEM 11 (2/3): hết lượt retry mà lỗi vẫn còn (và Flow không đang chạy) →
        // fail + release busy. Timeout-guard đầu tick vẫn là đường thoát cứng cho
        // busy lock trong maxMs kể cả khi không detect được SWW.
        if (
          swwFirstSeen &&
          !swwActive &&
          now >= swwCoolUntil &&
          swwAttempts >= SWW_MAX_RETRIES &&
          !flowIsGenerating() &&
          swwFresh()
        ) {
          log('M2: đã gửi lại đủ 3 lần mà Flow vẫn báo lỗi — emit fail (SWW retry exhausted).');
          failDisconnect('SWW retry exhausted');
          return;
        }

        if (!queuedLogged && QUEUE_RE.test(document.body.innerText || '')) {
          queuedLogged = true;
          log('đang chờ hàng đợi (queue)...');
        }
      } catch (err) {
        // FIX-5: tick throw không được "chết im lặng" — log + bỏ qua để tick kế
        // vẫn chạy (timeout-guard đầu tick bảo vệ busy lock).
        log('Poll tick lỗi (tick kế sẽ thử lại): ' + (err && err.message || err));
      }
    }, POLL_INTERVAL_MS);
    pollHealth.startedAt = startTs;
    log('poll bắt đầu — tick 2.5s, maxMs=' + maxMs + 'ms');
    log(`Bắt đầu poll ${kind === 'vid' ? 'video' : 'ảnh'}: mỗi ${POLL_INTERVAL_MS / 1000}s, tối đa ${maxMs / 60000} phút.`);
  }

  // ---------------------------------------------------------------------------
  // generate(kind, {prompt, image, sceneIdx, videoModel}) — pipeline chính.
  // ---------------------------------------------------------------------------
async function generate(kind, opts) {
    if (state.busy) {
      log('Đang chạy tác vụ khác, hãy đợi (busy lock).');
      return { ok: false, reason: 'busy' };
    }
    // B1: kiểm tra prompt TRƯ0C khi set busy — tránh kẹt lock khi prompt trống
    if (!opts.prompt) {
      log('Prompt trống — không làm gì.');
      return { ok: false, reason: 'empty prompt' };
    }
    state.busy = true;
    state.abortRequested = false; // T-stop: mỗi lần generate mới bắt đầu sạch cờ cancel cũ
    const sceneIdx = opts.sceneIdx ?? 0;
    let refUploadIds = [];
    let pollingStarted = false; // B2: per-run flag; the poller releases busy once polling starts
    // S2: outer copy of the runId — runId itself is a `const` declared INSIDE the
    // try, so the sibling `finally` cannot read it (ReferenceError). cancelRunId is
    // the single pre-poll cleanup hook: every exit BEFORE the poll owns the run
    // (send-failed, cancelled, any exception between armRun and pollingStarted)
    // must clear the arm AND the run's receipts/resolution.
    let cancelRunId = null;
    // S2 (invoke-token): outer copy of myRun (const INSIDE the same try). The
    // finally only cleans up while THIS invocation is still the latest
    // (state.runSeq === cancelMyRun) — a SUPERSEDED run (a newer generate started,
    // e.g. abort released busy and the user re-ran) must not clear the arm:
    // its runId may be caller-supplied and REUSED by the new run (S1 run-exists
    // only blocks ids still in the LIVE registry; an aborted run's record is gone),
    // so unmasked cleanup would wipe the NEW run's arm/receipts.
    let cancelMyRun = 0;
    try {
      const label = kind === 'vid' ? 'video' : 'ảnh';
      // T39 item 8: sceneIdx có thể là sentinel 'extract' (tách sản phẩm) — chỉ để log/nhãn.
      const where = typeof sceneIdx === 'number' ? `scene #${sceneIdx + 1}` : sceneIdx;
      log(`=== Bắt đầu tạo ${label} (${where}) ===`);
      log(`Prompt: "${opts.prompt.slice(0, 80)}${opts.prompt.length > 80 ? '...' : ''}"`);
      // M1: bump runSeq each time generate starts — myRun marks this run; an
      // abort/new run advances runSeq, so abort checks compare runSeq !== myRun.
      // Placed at the VERY TOP of the try (BEFORE any earlyFail/await) so
      // cancelMyRun already carries the token when ANY early-exit runs (incl.
      // flow-tab-not-home): the invocation-owned busy release guard depends on it.
      const myRun = ++state.runSeq;
      cancelMyRun = myRun; // S2: outer copy so the finally can guard cleanup by invocation token

      // Runs on a pre-poll error — busy must be handed back.
      const earlyFail = (reason) => {
        // busy is owned by the LATEST invocation (the one running): release only
        // while state.runSeq === cancelMyRun. An OLD (superseded — after abort +
        // a new generate started) invocation must NOT clear the new run's busy
        // lock, else generate C could enter mid-B → concurrent submits.
        // cancelMyRun is assigned at the top of the try, so flow-tab-not-home
        // (the earliest early-exit) still releases correctly.
        if (state.runSeq === cancelMyRun) state.busy = false;
        return { ok: false, reason };
      };

      // P0.4 (defense in depth — chốt cuối; sidepanel P0.2 đã kéo tab về home trước khi gửi):
      // tab phải ở Flow project HOME. Nếu đang ở /edit/<uuid> hoặc /tool/… thì MỌI selector
      // settings/composer trong file này là TOÀN TRANG (document.querySelector) → nhắm element
      // của trang chỉnh sửa đó → click sai, mở sai picker, gửi prompt với cấu hình cũ.
      // Fail-closed: chưa gửi gì lên Flow = 0 credit.
      function isOnFlowProjectHome() {
        let u;
        try { u = new URL(location.href); } catch (_) { return false; }
        const m = u.pathname.match(/\/project\/([0-9a-fA-F-]{36})(\/.*)?$/);
        if (!m) return false;
        return !m[2] || m[2] === '/';
      }
      if (!isOnFlowProjectHome()) {
        log('⚠ Tab Flow đang ở trang khác (chỉnh sửa/tool) — HỦY tạo để tránh click nhầm element. Mở lại Flow home rồi thử lại.');
        return earlyFail('flow-tab-not-home');
      }

      // M1 comment moved to the top of the try — myRun is constructed BEFORE any
      // earlyFail/await so the invoke-token is always available.
      // S2 (P2 PRD): a unique runId for this turn — the sidepanel MAY pass one (P2
      // routing); if absent, content generates its own. Every done/fail echoes
      // this runId verbatim NEXT TO the original sceneIdx; this tab's submit
      // captures attach to that runId.
      const runId = typeof opts.runId === 'string' && opts.runId
        ? opts.runId
        : `run-${myRun}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      cancelRunId = runId; // S2: outer copy so the finally (sibling of this try) can clean up on any pre-poll exit

      // T76.5: gỡ overlay "Rights to use this video" TRƯỚC — nó che Agent/Compact Picker,
      // khiến ensureAgentOff tưởng "không thấy toggle" (false negative).
      await acceptRightsDialogIfPresent();
      // Đảm bảo Agent OFF trước mọi thao tác
      if (!(await ensureAgentOff())) {
        log('⚠ Không tắt được Agent — tiếp tục nhưng có thể gặp lỗi.');
      }

      // Đọc mode hiện tại từ nút trigger trên trang chính (Agent OFF)
      let currentMode = '';
      const trigBtn = document.querySelector('button[aria-label="Settings trigger"]');
      if (trigBtn) {
        const txt = trigBtn.textContent.replace(/\s+/g, ' ').trim().toLowerCase();
        // Nếu chứa "video", "veo" -> đang ở Video mode.
        // Ngược lại thường là Image mode ("nano banana", "image", v.v.)
        if (txt.includes('video') || txt.includes('veo') || txt.includes('omni')) {
          currentMode = 'vid';
        } else {
          currentMode = 'img';
        }
      }

      // CHỈ mở Compact Picker khi:
      // 1. Scene có "Ghi đè Model" KHÁC với CÀI ĐẶT EXTENSION (overrideModel != null)
      // 2. HOẶC UI đang ở sai mode (Ví dụ: bấm Tạo ảnh nhưng UI đang ở Video mode)
      const overrideModel = kind === 'img' ? opts.overrideImageModel : opts.overrideVideoModel;
      const overrideAspectRatio = opts.aspectRatio || '';
      const needsModeSwitch = currentMode && currentMode !== kind;
      // FIX (bug "giữ cấu hình gần nhất"): payload giờ gửi kèm config extension FRESH
      // (aspectRatio/videoDuration/imageModel/videoModel — sidepanel sceneAction syncGear
      // + collectConfig ngay lúc bấm). Đối chiếu VỚI trạng thái Flow hiện tại (nút
      // Settings trigger hiển thị model + ratio icon "crop_16_9" + x1): nếu model/ratio/
      // dur LỆCH → mở Compact Picker đồng bộ TRƯỚC khi tạo (tránh media ra sai tỷ lệ);
      // nếu KHỚP → không đụng picker (giữ optimization cũ). Trước đây payload không
      // mang config → overrideAspectRatio = '' với scene thường → chưa bao giờ sync →
      // Flow giữ config áp lần trước. Video mode: trigger trang chính không hiện model
      // video (chỉ trong overlay picker) → cfgMatched=false với vid → picker mở để
      // validate model (đúng), so khớp ratio/dur qua icon thật.
      const cfgModel = kind === 'vid' ? opts.videoModel : opts.imageModel;
      const cfgDur = kind === 'vid' && opts.videoDuration ? `${opts.videoDuration}s` : '';
      const cfgRatioIcon = overrideAspectRatio ? `crop_${String(overrideAspectRatio).replace(':', '_')}` : '';
      const pickerTriggerText = (() => {
        const t = document.querySelector('button[aria-label="Settings trigger"]');
        return t ? norm(t.textContent) + ' ' + norm(t.getAttribute('aria-label') || '') : '';
      })();
      const cfgMatched = !!(cfgModel && cfgRatioIcon && pickerTriggerText
        && pickerTriggerText.includes(norm(cfgModel))
        && pickerTriggerText.includes(cfgRatioIcon)
        && (!cfgDur || pickerTriggerText.includes(norm(cfgDur))));
      
      if (overrideModel || needsModeSwitch || !cfgMatched) {
        if (!cfgMatched && (opts.imageModel || opts.videoModel)) {
          log(`Cấu hình extension khác Flow hiện tại (model/ratio/dur) — đồng bộ Compact Picker...`);
        } else if (overrideAspectRatio) {
          log(`Ghi đè tỷ lệ khung: "${overrideAspectRatio}" — điều chỉnh Compact Picker...`);
        } else if (overrideModel) {
          log(`Scene ghi đè model ${kind === 'img' ? 'ảnh' : 'video'}: "${overrideModel}" — điều chỉnh Compact Picker...`);
        } else {
          log(`UI đang ở mode ${currentMode === 'vid' ? 'Video' : 'Ảnh'}, cần chuyển sang mode ${kind === 'img' ? 'Ảnh' : 'Video'} — mở Compact Picker...`);
        }
        const pickerCfg = {};
        if (kind === 'vid') {
          pickerCfg.videoModel = overrideModel || opts.videoModel || undefined;
          if (opts.videoDuration) pickerCfg.videoDuration = opts.videoDuration;
        } else {
          pickerCfg.imageModel = overrideModel || opts.imageModel || undefined;
        }
        if (overrideAspectRatio) pickerCfg.aspectRatio = overrideAspectRatio;
        const setupRes = await applyConfigViaPicker(kind, pickerCfg);
        if (!setupRes.ok) {
          // T43: KHÔNG set được model/config chính xác → HỦY TẠO (tránh chạy SAI
          // model tốn credit). Chỉ HỦY khi có model override/bắt buộc — không kẹt
          // trường hợp chỉ chuyển mode.
          // FIX-WIN (luồng 2): mở rộng abort cho overrideAspectRatio — trước đây ratio
          // fail chỉ log ⚠ → ảnh extract ra 9:16 thay vì 16:9 (vẫn tốn credit).
          if (overrideModel) {
            log(`❌ HỦY tạo: không thiết lập được model "${overrideModel}" trên Flow — ${setupRes.log}`);
            return earlyFail('model-not-set: ' + (setupRes.log || overrideModel));
          }
          if (overrideAspectRatio) {
            log(`❌ HỦY tạo: không thiết lập được ratio "${overrideAspectRatio}" trên Flow — ${setupRes.log}`);
            return earlyFail('ratio-not-set: ' + (setupRes.log || overrideAspectRatio));
          }
          // P1.5: MỌI trường hợp còn lại (!setupRes.ok) đều HỦY — trước đây chỉ log ⚠ rồi
          // đi tiếp tới typePrompt/clickSend ⇒ gửi prompt với cấu hình CHƯA set (picker
          // không mở / kind fail / qty fail) = tốn credit sai mode (incident 2026-09-09).
          log(`❌ HỦY tạo: không thiết lập được cấu hình Compact Picker — ${setupRes.log}`);
          return earlyFail('picker-config-failed: ' + (setupRes.log || ''));
        }
      } else {
        log('Scene dùng model giống CÀI ĐẶT EXTENSION và UI đã đúng mode — không đụng Compact Picker.');
      }

      // (a) composer sẵn sàng — TRƯỚC TIÊN đóng settings panel nếu đang mở (nếu
      // settings mở, ProseMirror 0×0 → findComposer trả null → fail 'no composer'
      // mơ hồ; hơn nữa add-ref/nút send cũng ẩn). ensurePromptBoxVisible trả false
      // = đã thử 2 lần đóng Back mà không được → HỦY với reason rõ ràng.
      if (!(await ensurePromptBoxVisible())) {
        log('Settings panel không đóng được — composer ẩn; HỦY tạo.');
        return earlyFail('no composer (settings mở)');
      }
      const composer = await waitFor(findComposer, 5000);
      if (!composer) {
        log('Không thấy composer sau 5s.');
        return earlyFail('no composer');
      }

      // (b) Đính reference ảnh (item 7: mảng #1 model, #2 product, #3 bg)
      // KHÔNG upload lại — chỉ đính qua dialog bằng mediaId/tên
      const expectedRefs = (opts.images || []).filter(Boolean);
      const expectedCount = expectedRefs.length;
      if (expectedCount > 0) {
        log(`Bắt đầu đính ${expectedCount} ảnh tham chiếu vào prompt box...`);
        const ar = await attachRefsMixed(expectedRefs);
        refUploadIds = (ar && ar.ok && Array.isArray(ar.refIds)) ? ar.refIds : [];
        const refCount = (ar && ar.count) || 0;
        const actualChips = countComposerChips();
        log(`Kết quả đính ref: ${refCount}/${expectedCount} thành công (hiện có ${actualChips} chip trong prompt).`);

        // KIỂM TRA BẮT BUỘC: Nếu không đính đủ ảnh tham chiếu vào prompt box -> DỪNG NGAY, KHÔNG SUBMIT!
        if (!ar || !ar.ok || refCount < expectedCount || actualChips < expectedCount) {
          log(`❌ LỖI BẮT BUỘC: Không thể đính đủ ${expectedCount} ảnh tham chiếu vào prompt box (chỉ có ${actualChips} chip). HỦY submit cảnh #${sceneIdx + 1} để tránh tạo ảnh/video sai không tham chiếu.`);
          await removeAllChips(); // dọn sạch chip lỗi còn sót
          return earlyFail(`thiếu ảnh tham chiếu (${actualChips}/${expectedCount} chip)`);
        }
        log(`✓ Đã xác nhận đủ ${actualChips}/${expectedCount} ảnh tham chiếu trong prompt box.`);
      }
      await wait(500);

      // (c) typePrompt CDP
      if (!(await typePrompt(opts.prompt))) return earlyFail('type failed');
      await wait(1200);
      if (state.abortRequested || state.runSeq !== myRun) return earlyFail('cancelled'); // T-stop: hủy trước Send

      // G10-QA-B2 (S2): a batch view job must NOT send a new prompt while Flow is still
      // generating -- otherwise Flow queues several images at once (bit for real: a false
      // done made the batch fire the next tile while the previous image was still being
      // created -> 2-3 overlapping images, pool in disarray). Applies to batch jobs
      // (requireUuid) ONLY, so normal scene flow is unchanged. The cap is finite -> on
      // expiry we fail closed and never click Send blindly.
      // A1 (user-approved): wait for idle BEFORE capturing the baseline -- the baseline
      // must reflect the DOM IMMEDIATELY BEFORE clickSend. Capturing before the wait
      // window lets the PREVIOUS job's media (finishing during the wait) mount AFTER the
      // baseline -> it is claimed as "new" for this job = the stale-DONE bug all over again.
      if (opts.requireUuid && !(await waitFlowIdle(FLOW_IDLE_WAIT_MS))) return earlyFail('flow-busy');
      if (state.abortRequested || state.runSeq !== myRun) return earlyFail('cancelled'); // T-stop: cancelled while waiting

      // M6: baseline IMMEDIATELY BEFORE clickSend (after typePrompt/upload) -- countMedia (M7)
      // + M9: baselineIds (tập media id hiện tại) để gate DONE theo IDENTITY,
      // không phụ thuộc thứ tự DOM (Flow có thể prepend card mới / chèn card lạ).
      // G10-QA-B2 (S4): a batch job (requireUuid) captures the COMPLETE baseline --
      // scrolling the whole grid and ACCUMULATING ids/srcs at every step, so old media
      // mounting late is never claimed as "new". Other jobs keep the fast path (no
      // scrolling) so normal flow behaviour/perf is unchanged.
      let baseline, baselineIds, baselineSrcs;
      if (opts.requireUuid) {
        const full = await fullMediaBaseline(kind);
        // FAIL-CLOSED: an un-enumerable baseline cannot separate new media from old =>
        // abort the job instead of degrading silently (accepting old media is the very
        // bug being fixed).
        if (!full.ok) return earlyFail(full.reason || 'baseline-enumeration-failed');
        baseline = full.count; baselineIds = full.ids; baselineSrcs = full.srcs;
        log(`Baseline đầy đủ: ${full.ids.size} id + ${full.srcs.size} src (đã cuộn hết grid, khôi phục vị trí).`);
      } else {
        baseline = countMedia(kind);
        baselineIds = currentMediaIds(kind);
        baselineSrcs = currentMediaSrcs(kind);
      }

      // (d) clickSend CDP — ITEM 11: chụp baseline SWW NGAY TRƯỚC send để chỉ
      // nhận bubble lỗi MỚI (bubble cũ của scene/run trước trong session panel
      // không gây retrigger).
      swwBaseline = swwCount();
      errorTileBaseline = failedTileCount(); // baseline fail-tile TRƯỚC send (detect Fail mới trong poll)
      unusualBaseline = unusualNotiCount();  // (FIX 3) baseline dialog/banner "unusual activity" TRƯỚC send
      // S2: snapshot the error-tile policies BEFORE send — detects a NEW policy-block
      // tile during the poll; binds currentRunId so the submit captures (arriving
      // ~5s after POST) attach to EXACTLY this run.
      policyTileBaseline = policyTileCount();
      // (BLOCKER A) Arm the run (currentRunId + activeRunId) BEFORE clickSend: the
      // submit response can arrive while clickSend is still verifying (up to 6s first
      // attempt) but AFTER the POST marker — if activeRunId were only set inside
      // startPolling, the bridge (`if (!activeRunId) return;`) would DROP that early
      // capture → receipt gate never settles → false-fail + wasted credit. startPolling
      // re-arms (idempotent, harmless).
      armRun(runId);
      if (!(await clickSend())) {
        // Cleanup (disarm + clear receipts) happens in the finally — the ONLY
        // pre-poll cleanup point, guarded by the invocation token (state.runSeq ===
        // cancelMyRun) so a superseded invocation can never clobber a REUSED runId
        // that a newer run already armed. A branch-local disarm call here would run
        // UNGUARDED (before the finally) and could wipe the new run's arm.
        return earlyFail('send failed');
      }
      if (state.abortRequested || state.runSeq !== myRun) {
        // Same: no branch-local disarm — cleanup lives only in the finally; see above.
        return earlyFail('cancelled'); // T-stop: hủy ngay sau Send (chưa poll)
      }

      // (e) poll — ITEM 11: truyền prompt + refsOps để SWW retry TỰ GỬI LẠI ĐẦY ĐỦ
      pollingStarted = true; // B2: đánh dấu poll đã bắt đầu — poller tự release busy
      const needRefs = Boolean(opts.images && opts.images.some(Boolean));
      activeJob = { prompt: opts.prompt, model: kind === 'vid' ? opts.videoModel : opts.imageModel };
      startPolling(kind, sceneIdx, baseline, baselineIds, baselineSrcs, opts.prompt, {
        images: opts.images,
        needRefs, // FIX-4: không còn 'needRefs && !uploaded' (luôn false khi poll bắt đầu → nhánh re-upload chết)
      }, { requireUuid: !!opts.requireUuid }, refUploadIds); // G10-QA-B2 (S1): batch view accepts uuid results only
      return { ok: true, sceneIdx, refUploadIds };
    } finally {
      // B2: nếu poll chưa bắt đầu (exception ở bất kỳ bước nào) → release busy
      if (!pollingStarted) {
        // busy release is INVOCATION-OWNED: a SUPERSEDED invocation (newer generate
        // started after abort — runSeq advanced) must NOT clear the newer run's
        // busy lock (else a third generate C could enter mid-B → concurrent
        // submits). Only the LATEST invocation releases busy; abort itself has
        // already cleared it (abortGeneration: state.busy = false), and a newer
        // generate owns its own busy=true from its start.
        if (state.runSeq === cancelMyRun) state.busy = false;
        // S2: single cleanup point for EVERY pre-poll exit (send-failed, cancelled,
        // or an exception between armRun and pollingStarted) — clear the arm AND the
        // run's receipts/resolution (a capture may have landed in the arm window;
        // cancel means the run is dead, stale state must not poison a reused runId).
        // No-op once polling owns the run (poller releases busy / clears its own
        // state on done/fail).
        // Invocation-token guard: a SUPERSEDED run (state.runSeq !== cancelMyRun —
        // a newer generate started, e.g. abort released busy and the user re-ran)
        // must NOT clear the arm/receipts: its runId may be caller-supplied and
        // REUSED by the new run (S1 run-exists only blocks ids still in the LIVE
        // registry; an aborted run's record is gone), so cleanup here would wipe
        // the NEW run's arm/receipts. Unique-per-turn runId is the contract (PRD
        // P2); this guard is the fail-closed backstop regardless.
        if (cancelRunId && state.runSeq === cancelMyRun) {
          disarmRun(cancelRunId);
          clearRunState(cancelRunId);
        }
      }
    }
  }


  // ---------------------------------------------------------------------------
  // P3b: fetch clip bytes (page-context, cùng cơ chế fetch ingredient) → data URL.
  // Giới hạn 40MB — payload chrome.tabs.sendMessage không nên quá lớn.
  // ---------------------------------------------------------------------------
  async function urlToDataUrl(url) {
    try {
      if (!url) return { ok: false, reason: 'thiếu url' };
      const res = await fetch(url);
      if (!res.ok) return { ok: false, reason: 'fetch HTTP ' + res.status };
      const blob = await res.blob();
      if (blob.size > 40 * 1024 * 1024) return { ok: false, reason: 'clip quá lớn' };
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ ok: true, dataUrl: reader.result });
        reader.onerror = () => resolve({ ok: false, reason: 'FileReader lỗi' });
        reader.readAsDataURL(blob);
      });
    } catch (err) {
      return { ok: false, reason: String(err && err.message || err) };
    }
  }

  // T77: kiểm byte dataUrl THẬT SỰ là video (MP4 `ftyp` / WebM `EBML`) — content script
  // cần validate độc lập (sidepanel cũng có hàm tương tự nhưng không dùng chéo được).
  function dataUrlLooksLikeVideo(dataUrl) {
    try {
      const b64 = String(dataUrl || '').split(',')[1] || '';
      const bin = atob(b64.slice(0, 40));
      if (bin.length >= 8 && bin.slice(4, 8) === 'ftyp') return true; // MP4/MOV
      return bin.charCodeAt(0) === 0x1A && bin.charCodeAt(1) === 0x45 && bin.charCodeAt(2) === 0xDF && bin.charCodeAt(3) === 0xA3; // WebM/EBML
    } catch (_) { return false; }
  }

  // ---------------------------------------------------------------------------
  // T39 items 3.1/5/6 — Flow project helpers (home 'New project' btn + project id).
  // Additive-only: không đụng busy-lock / poll / done-signal machinery hiện có.
  // ---------------------------------------------------------------------------
  // Domain-agnostic: /project/<uuid> ở flow.google.com lẫn labs.google/fx/tools/flow
// (kể cả suffix /edit/<session>). Regex cứng labs.google cũ làm projectIdFromHref()
// LUÔN null trên tab flow.google.com → clickNewProject poll 30s rồi fail dù đã click đúng.
const FLOW_PROJECT_RE = /\/project\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i;

  // Project id từ url hiện tại (kể cả suffix /edit/<session-uuid>), null nếu không ở project.
  function projectIdFromHref(href) {
    const m = FLOW_PROJECT_RE.exec(String(href || ''));
    return m ? m[1] : null;
  }

  // F2 (fail-closed): chỉ bấm "New project" khi tab KHÔNG ở trong project nào (url không có
  // id project — null/rỗng). Có id (đang trong project) → click không tạo project mới, mà
  // vòng poll dưới sẽ nhận luôn uuid cũ.
  function canClickNewProject(beforeId) {
    return !beforeId;
  }

  // F2 (fail-closed): "Tạo mới" chỉ hợp lệ khi url đổi sang project id mới — id trùng
  // beforeId nghĩa là vẫn ở project cũ (click không tạo gì / poll ăn uuid cũ) → trả null.
  function acceptNewProjectId(beforeId, afterId) {
    return (afterId && afterId !== beforeId) ? afterId : null;
  }

  // Tìm nút 'New project' trên trang home. Text truy cập là 'New project' (icon Material
  // 'add_2' là ligature nằm CHUNG textContent với nhãn nút). Ưu tiên button/a/[role=button];
  // fallback div/span chứa đúng chuỗi (lọc phần tử không chứa nút bên trong để tránh container cha).
  function findNewProjectBtn() {
    const primary = [...document.querySelectorAll('button, a, [role="button"], [role="link"]')].find((el) => {
      const aria = (el.getAttribute && el.getAttribute('aria-label')) || '';
      const t = norm(el.textContent) + norm(aria);
      return t.includes('Newproject');
    });
    if (primary) return primary;
    const fallback = [...document.querySelectorAll('div, span')]
      .filter((d) => {
        const t = norm(d.textContent);
        return t.includes('Newproject') && d.querySelectorAll('button, a, [role="button"]').length === 0;
      })
      .sort((a, b) => a.textContent.length - b.textContent.length);
    return fallback[0] || null;
  }

  // Rect trung tâm của nút (scrollIntoView trước rồi mới đọc getBoundingClientRect).
  function newProjectBtnRect() {
    const btn = findNewProjectBtn();
    if (!btn) return null;
    try { btn.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) { /* bỏ qua */ }
    const r = btn.getBoundingClientRect();
    if (!r || r.width < 2 || r.height < 2) return null;
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  }

  // Bấm 'New project' → chờ url chuyển sang /project/<uuid> → {ok, projectId}.
  // Chạy TRONG content context để chrome.runtime.sendMessage(cdp:click) có sender.tab
  // = tab Flow (background CDP executor bắt buộc sender.tab.id).
  async function clickNewProject() {
    // (0) F2 fail-closed: đang trong 1 project thì KHÔNG click — bấm nút "New project" từ
    // trang project không tạo project mới, mà vòng poll dưới sẽ nhận luôn uuid CŨ → "Tạo
    // mới" giả (return id cũ) ⇒ sidepanel pin vĩnh viễn vào project đó.
    const beforeId = projectIdFromHref(location.href);
    if (!canClickNewProject(beforeId)) {
      return { ok: false, error: 'Tab đang ở project ' + beforeId + ' — cần ở trang home Flow.' };
    }
    // (i) chờ nút render trên home (React app vẽ sau document load)
    let rect = null;
    const btnDeadline = Date.now() + 20000;
    while (Date.now() < btnDeadline) {
      rect = newProjectBtnRect();
      if (rect) break;
      await wait(500);
    }
    if (!rect) return { ok: false, error: 'Không tìm thấy nút "New project" trên trang home sau 20s.' };
    // (ii) RE-MEASURE sát thời điểm dispatch + verify elementFromPoint là chính nút (hoặc con
    // của nút). Click CDP chạy qua background (đường chuột Bézier + jitter) nên rect đo trước
    // đó dễ trượt vào project card trên lưới home → Flow mở project CÓ SẴN (id lạ ≠ beforeId,
    // vẫn lọt). Lệch → đo lại, tối đa 3 lần; hết 3 lần → fail, KHÔNG click mù.
    // (ii-P2c) guard stale-coordinate tầng background: đo trước dispatch KHÔNG đủ — cửa sổ
    // moveMouse + jitter vẫn mở lại khoảng lệch (đúng class bug 56px). Marker element ĐÍCH
    // (aimMark) để background tự kiểm elementFromPoint NGAY trước khi dispatch; trả
    // 'stale-coordinate' ⇒ ĐO LẠI (rect mới) + bấm lại ĐÚNG 1 lần. Lần 2 vẫn stale ⇒
    // log + fail (KHÔNG bấm mù, KHÔNG vòng lặp vô hạn — bấm bù ở đây = tạo project lạc).
    let aim = null;       // rect đã verify elementFromPoint
    let aimBtn = null;    // element đích của rect đó (đóng dấu guard)
    let res = null;
    for (let pass = 1; pass <= 2; pass += 1) {
      aim = null;
      aimBtn = null;
      for (let i = 0; i < 3 && !aim; i += 1) {
        const fresh = newProjectBtnRect();
        const btn = findNewProjectBtn();
        const hit = fresh ? document.elementFromPoint(fresh.x, fresh.y) : null;
        if (fresh && btn && hit && (hit === btn || btn.contains(hit))) { aim = fresh; aimBtn = btn; }
        else await wait(300);
      }
      if (!aim) return { ok: false, error: 'Không xác minh được nút "New project" tại điểm click (elementFromPoint lệch) — KHÔNG click mù.' };
      // (iii) click thật qua CDP (content context → sender.tab = tab Flow)
      const mark = aimMark(aimBtn);
      try {
        res = await chrome.runtime.sendMessage({ type: 'cdp:click', x: aim.x, y: aim.y, expect: mark });
      } catch (_) {
        res = null;
      } finally {
        aimUnmark(aimBtn);
      }
      logProbeError(res);
      if (res && res.reason === 'stale-coordinate') {
        log(`clickNewProject: stale-coordinate (trúng ${JSON.stringify(res.at && res.at.found)}) — đo lại + bấm lại lần ${pass + 1}.`);
        continue; // pass 2 vẫn stale ⇒ thoát vòng → fail bên dưới (KHÔNG bấm mù lần 3)
      }
      break;
    }
    if (res && res.reason === 'stale-coordinate') {
      return { ok: false, error: 'Nút "New project" lệch toạ độ ở cả 2 lần bấm (stale-coordinate) — KHÔNG bấm mù.' };
    }
    if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'cdp:click không phản hồi.' };
    // (iv) poll location.href tới khi có project id mới (khác beforeId — F2)
    const urlDeadline = Date.now() + 30000;
    while (Date.now() < urlDeadline) {
      const id = acceptNewProjectId(beforeId, projectIdFromHref(location.href));
      if (id) {
        // Flow hiện "Rights to use this video" ngay khi project mới nở — chặn mọi upload sau.
        await acceptRightsDialogIfPresent({ waitMs: 4000 });
        return { ok: true, projectId: id };
      }
      await wait(500);
    }
    return { ok: false, error: 'Đã bấm "New project" nhưng url chưa chuyển sang project mới sau 30s.' };
  }

  // ---------------------------------------------------------------------------
  // Message handler (driven by the side panel).
  // ---------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return undefined;

    if (msg.type === 'detect') {
      detectAccount().then((tier) => {
        const toggle = findAgentToggle();
        let agent = 'N/A';
        if (toggle) {
          const on = toggle.getAttribute('aria-pressed') === 'true' ||
            toggle.getAttribute('aria-checked') === 'true' ||
            toggle.getAttribute('aria-checked') === 'checked';
          agent = on ? 'BẬT' : 'TẮT';
        } else if (findTuneSettingsButton()) agent = 'BẬT';
        sendResponse({ tier, agent });
      }).catch((err) => sendResponse({ ok: false, reason: String(err && err.message || err) }));
      return true;
    }

    if (msg.type === 'applySettings') {
      applySettings(msg.config).then((r) => sendResponse(r)).catch((err) => sendResponse({ ok: false, reason: String(err && err.message || err) }));
      return true;
    }

    if (msg.type === 'applySettingsNow') {
      // Cấu hình tức thì (khi user bấm Lưu trên extension). Phải chạy cả Ảnh và Video.
      // G9/S2 (#24): sau apply, ĐỌC LẠI cấu hình THẬT đang ON trong picker từng kind
      // (RC-3/RC-5) và trả kèm `expected` dựng từ msg.config — sidepanel (S3) so
      // applied vs expected thay vì tin lệnh đã gửi. msg.config theo seam #23 = ĐÚNG
      // 4 field {aspectRatio, videoDuration, imageModel, videoModel}; model null =
      // 'giữ nguyên', KHÔNG phải lỗi.
      const cfg = msg.config || {};
      // expected LUÔN dựng được từ cfg — kể cả khi apply/readback ném (mọi đường
      // sendResponse phải có đủ key img,vid,expected). ĐỐI XỨNG 5 Ô với applied
      // (#25 so từng ô Type/Ratio/Dur/Qty/Model): type là literal kind (Ảnh section
      // ⇒ phải là 'Image'), dur img = null ⇒ modal render '—', không phải lệch.
      // modelKey canonical cùng nguồn với applied.modelKey (chống 🍌-prefix / substring).
      const expected = {
        img: { type: 'Image', ratio: cfg.aspectRatio || null, dur: null, model: cfg.imageModel || null, modelKey: cfg.imageModel ? modelKey(cfg.imageModel) : null, qty: 'x1' },
        vid: {
          type: 'Video',
          ratio: cfg.aspectRatio || null,
          model: cfg.videoModel || null,
          modelKey: cfg.videoModel ? modelKey(cfg.videoModel) : null,
          dur: cfg.videoDuration ? cfg.videoDuration + 's' : null,
          qty: 'x1',
        },
      };
      (async () => {
        const out = { img: null, vid: null };
        out.img = await applyConfigViaPicker('img', cfg);
        out.vid = await applyConfigViaPicker('vid', cfg);
        const rbImg = await readFlowSettingsFromPicker('img');
        const rbVid = await readFlowSettingsFromPicker('vid');
        out.img.applied = rbImg.ok ? rbImg.values : null;
        out.img.readbackOk = rbImg.ok;
        if (!rbImg.ok) out.img.readbackErr = rbImg.reason;
        out.vid.applied = rbVid.ok ? rbVid.values : null;
        out.vid.readbackOk = rbVid.ok;
        if (!rbVid.ok) out.vid.readbackErr = rbVid.reason;
        // PRD P4: expected per-kind (img:{...,expected}, vid:{...,expected}) — đường
        // chính; root `expected` giữ làm alias (S3 doc một trong hai, ưu tiên per-kind).
        out.img.expected = expected.img;
        out.vid.expected = expected.vid;
        out.expected = expected; // dựng từ cfg ở ngoài — S3 vẫn render khi readback chết
        sendResponse(out);
      })().catch(err => sendResponse({
        img: { ok: false, applied: null, readbackOk: false, readbackErr: 'apply-exception', expected: expected.img },
        vid: { ok: false, applied: null, readbackOk: false, readbackErr: 'apply-exception', expected: expected.vid },
        expected, ok: false, reason: String(err && err.message || err),
      }));
      return true;
    }

    if (msg.type === 'waitComposer') {
      // G9 closeout (#24): sau SPA nav về project, URL đúng nhưng Angular composer
      // (Settings trigger/Agent toggle) còn render trễ (live 21/9: apply chạy ngay sau
      // ensureFlowProject chết 'Không tìm thấy nút Agent toggle'). Chờ tới khi nút
      // Compact Picker xuất hiện (tối đa 15s) rồi sidepanel mới gửi applySettingsNow.
      (async () => {
        const btn = await waitFor(findCompactPickerButton, 15000);
        sendResponse({ ok: !!btn });
      })();
      return true;
    }

    if (msg.type === 'setDurationNative') {
      setDurationNative(msg.seconds, msg.videoModel).then((r) => sendResponse(r)).catch((err) => sendResponse({ ok: false, reason: String(err && err.message || err) }));
      return true;
    }

    if (msg.type === 'asf-poll-status') {
      sendResponse({ ok: true, pollHealth });
      return true;
    }
    if (msg.type === 'asf-version') {
      sendResponse({ ok: true, build: CONTENT_BUILD });
      return true;
    }
    if (msg.type === 'create' || msg.type === 'createImage') {
      const kind = msg.type === 'createImage' || msg.kind === 'img' ? 'img' : 'vid';
      generate(kind, {
        prompt: msg.prompt,
        image: msg.image,
        images: msg.images, // vid: 1 ref (scene_n_image); img: [model, product, bg] thứ tự upload #1 #2 #3
        sceneIdx: msg.sceneIdx,
        overrideImageModel: msg.overrideImageModel,
        overrideVideoModel: msg.overrideVideoModel,
        aspectRatio: msg.aspectRatio,
        // G4/S1: 3 trường dưới đây trước đây BỊ RƠI ở đây ⇒ generate() nhận
        // undefined ⇒ cfgModel/cfgDur rỗng ⇒ cfgMatched=false ⇒ log "giữ nguyên
        // hiện tại" (lỗi IM LẶNG: user chọn model, Flow vẫn dùng model cũ).
        videoDuration: msg.videoDuration,
        imageModel: msg.imageModel,
        videoModel: msg.videoModel,
        // G10-QA-B2: a view-batch job accepts uuid results only (Flow's real media
        // = flow-content.google/image/<uuid>); an asb/uuid-less img is not the result.
        requireUuid: !!msg.requireUuid,
        // S2 (P2 routing): the sidepanel MAY pass its own runId; if missing, generate() creates one.
        runId: typeof msg.runId === 'string' && msg.runId ? msg.runId : undefined,
      }).then((r) => sendResponse(r || { ok: false })).catch((err) => sendResponse({ ok: false, reason: String(err && err.message || err) }));
      return true;
    }

    // T-stop: Dừng khẩn cấp — chặn generate() (abortRequested) + dừng poll + thả
    // busy + bấm nút 'stop' của Flow (hủy thật) nếu đang generate. KHÔNG emit
    // 'done'/'fail' ở đây — sidepanel TỰ settle pendingScene (tránh signal trùng).
    if (msg.type === 'abortGeneration') {
      state.abortRequested = true;
      state.runSeq += 1; // invalidate run đang chạy (generate() còn lơ lửng sẽ thấy runSeq lệch)
      stopPolling();
      state.busy = false;
      if (activeRunId) { runReceipts.delete(activeRunId); runResolved.delete(activeRunId); } // S2: discard the aborted run's receipts + resolved state
      activeRunId = null;
      currentRunId = null;
      clickFlowStop().catch(() => {}); // fire-and-forget
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'setModel') {
      ensureModel(msg.model).then((ok) => sendResponse({ ok })).catch((err) => sendResponse({ ok: false, reason: String(err && err.message || err) }));
      return true;
    }

    if (msg.type === 'downloadMedia') {
      // P3a: tải media khi card DONE — hover → ⋮ → Download → chất lượng
      downloadMedia({ url: msg.url, kind: msg.kind, quality: msg.quality, mediaId: msg.mediaId, name: msg.name, captureBytes: !!msg.captureBytes })
        .then((r) => sendResponse(r || { ok: false }))
        .catch((err) => {
          log('downloadMedia lỗi: ' + err.message);
          sendResponse({ ok: false, reason: String(err && err.message || err) });
        });
      return true;
    }

    // T63: xóa ảnh role cũ (mediaId) trên project home — sidepanel gọi TRƯỚC khi
    // upload ảnh mới đè role (thay ảnh). tile-not-found = bỏ qua nhẹ (không navigate).
    if (msg.type === 'deleteAsset') {
      // T74: mediaId (ảnh) → deleteAssetByMediaId; KHÔNG có mediaId + có src (video tile
      // flow-video-tile không uuid) → deleteVideoTileBySrc(token asb).
      const p = msg.mediaId ? deleteAssetByMediaId(msg.mediaId) : deleteVideoTileBySrc(msg.src);
      p.then((r) => sendResponse(r || { ok: false, reason: 'không phản hồi' }))
        .catch((err) => {
          log('deleteAsset lỗi: ' + (err && err.message || err));
          sendResponse({ ok: false, reason: String(err && err.message || err) });
        });
      return true;
    }

    // T66: đổi tên media trên Flow home (tách model/sản phẩm + chọn ảnh có sẵn).
    // (FIX TASK A) rename đi qua chuỗi CDP (hover/menu/input qua background) — nếu bước
    // nào treo (SW wake / debugger session) renameAssetByMediaId không bao giờ resolve →
    // chrome.tabs.sendMessage của sidepanel giữ MÃI → pickSceneVid treo = "bấm không thấy
    // gì xảy ra" (log thật: rename src thật treo >20s, src rỗng settle 1.6s). Race 12s:
    // hết giờ vẫn sendResponse fail nhẹ → caller tiếp tục (không nuốt UI).
    if (msg.type === 'renameAsset') {
      const renameP = Promise.race([
        (async () => {
          const r = await renameAssetByMediaId(msg.mediaId, msg.name, msg.src);
          return r || { ok: false, reason: 'không phản hồi' };
        })(),
        new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason: 'rename timeout (12s)' }), 12000)),
      ]);
      renameP
        .then((r) => sendResponse(r || { ok: false, reason: 'không phản hồi' }))
        .catch((err) => sendResponse({ ok: false, reason: String(err && err.message || err) }));
      return true;
    }

    // T46: mở video trong trang EDIT của Flow (nơi có nút play thật) + TỰ BẤM PLAY.
    // Video home (asb stream `=mm,22,15`) KHÔNG phát được ở home — bấm tile → Flow
    // navigate SPA (cùng document, KHÔNG reload → context vẫn sống) sang
    // /project/<pid>/edit/<uuid> → đợi nút Play hiện → bấm luôn.
    if (msg.type === 'openVideoOnFlow') {
      (async () => {
        try {
          const want = mediaToken(String(msg.url || ''));
          let tile = [...document.querySelectorAll('flow-video-tile')].find((vt) => {
            const v = vt.querySelector('video');
            const im = vt.querySelector('img');
            const s = (v && (v.currentSrc || v.src)) || (im && (im.currentSrc || im.src)) || '';
            return !!s && mediaToken(s) === want;
          });
          if (!tile) tile = document.querySelector('flow-video-tile') || null; // fallback: video duy nhất
          if (!tile) { sendResponse({ ok: false, reason: 'no video tile on home' }); return; }
          tile.scrollIntoView({ block: 'center', inline: 'center' });
          await wait(350);
          const clicked = await clickReal(tile);
          if (!clicked) { sendResponse({ ok: false, reason: 'click tile fail' }); return; }
          // SPA navigate → đợi trang edit render + nút Play/Pause xuất hiện rồi bấm play.
          const started = Date.now();
          let playBtn = null;
          while (Date.now() - started < 9000) {
            await wait(350);
            playBtn = [...document.querySelectorAll('button')].find((b) => {
              const al = (b.getAttribute('aria-label') || '').trim();
              return /^(play|pause)$/i.test(al) && /play_arrow|play_circle|smart_display|ondemand_video/.test(b.innerHTML);
            }) || null;
            if (playBtn) break;
          }
          if (!playBtn) { sendResponse({ ok: false, reason: 'no play button on edit page', url: location.href }); return; }
          const isPause = /^pause$/i.test((playBtn.getAttribute('aria-label') || '').trim());
          let played = true;
          if (!isPause) {
            // Bấm play + retry: nút vừa render (SPA) có thể chưa ở vị trí cuối → đo lại
            // center mỗi lần + verify label đổi sang "Pause" (video đang chạy).
            played = false;
            for (let attempt = 0; attempt < 5; attempt++) {
              await wait(500);
              const pt = elCenter(playBtn);
              // NIT-7: mang marker element đích (aimMark) — background chặn dispatch nếu
              // elementFromPoint lệch (nút vừa render SPA có thể còn dời vị trí). Giữ NGUYÊN
              // vòng đo-lại 5 lượt + verify label đổi sang 'Pause' bên dưới: guard chỉ CHẶN
              // cú bấm lệch, KHÔNG thêm retry riêng. aimUnmark ở finally để không rò marker.
              const playMark = aimMark(playBtn);
              try {
                await chrome.runtime.sendMessage({ type: 'cdp:click', x: pt.x, y: pt.y, expect: playMark }).catch(() => null);
              } finally {
                aimUnmark(playBtn);
              }
              await wait(700);
              const nb = [...document.querySelectorAll('button')].find((b) => {
                const al = (b.getAttribute('aria-label') || '').trim();
                return /^(play|pause)$/i.test(al) && /play_arrow|play_circle|smart_display|ondemand_video|pause/.test(b.innerHTML);
              }) || null;
              if (nb && /^pause$/i.test((nb.getAttribute('aria-label') || '').trim())) { played = true; break; }
              if (nb) playBtn = nb;
            }
          }
          sendResponse({ ok: played, url: location.href, wasPaused: !isPause });
        } catch (err) { sendResponse({ ok: false, reason: String(err && err.message || err) }); }
      })();
      return true;
    }

    // T77: chụp bytes MP4 THẬT của video cảnh cho export base64. Tìm tile theo
    // mediaToken(src) HOẶC tên footer scene_<n>_video (KHÔNG fallback "bất kỳ video" —
    // tránh mở sai scene), click tile → SPA navigate sang /edit/<uuid> → đọc src
    // <video>/<source> THẬT → urlToDataUrl (40MB + FileReader) → validate video MIME+magic
    // → history.back() về home trong finally (MỌI nhánh lỗi cũng quay về).
    if (msg.type === 'exportVideoData') {
      (async () => {
        const prior = location.href;
        // Home = prior bỏ mọi suffix /edit/<uuid> (nếu prior vì lý do nào đó đã là edit, trả
        // tab về ĐÚNG home thay vì về trang trước đó không liên quan).
        const homeUrl = new URL(prior);
        homeUrl.pathname = homeUrl.pathname.replace(/\/edit\/[^/]+.*$/, '');
        homeUrl.search = ''; homeUrl.hash = '';
        const homeHref = homeUrl.href;
        let result = { ok: false, reason: 'unknown' };
        try {
          const want = mediaToken(String(msg.url || ''));
          const nm = String(msg.name || '').trim().toLowerCase();
          // Ứng viên CHÍNH XÁC: (a) flow-video-tile; (b) img video-thumbnail — UI mới biểu diễn
          // "video done" dạng <img alt*="video"> KHÔNG có flow-video-tile. Khớp theo token(src)
          // hoặc tên footer — KHÔNG fallback "bất kỳ video" (tránh mở sai scene).
          const cands = [];
          for (const vt of document.querySelectorAll('flow-video-tile')) {
            const v = vt.querySelector('video');
            const im = vt.querySelector('img');
            const s = (v && (v.currentSrc || v.src)) || (im && (im.currentSrc || im.src)) || '';
            const fl = vt.querySelector('.footer-left, [class*="footer" i]');
            cands.push({ el: vt, tok: mediaToken(s), name: (fl && (fl.textContent || '').trim().toLowerCase()) || '' });
          }
          for (const im of document.querySelectorAll('img')) {
            if (!isVideoThumbEl(im)) continue;
            const card = mediaCardOf(im);
            if (!card) continue;
            const fl = card.querySelector('.footer-left, [class*="footer" i]');
            const s = im.currentSrc || im.src || '';
            cands.push({ el: card, tok: mediaToken(s) || mediaIdOf(s) || '', name: (fl && (fl.textContent || '').trim().toLowerCase()) || '' });
          }
          let cand = null;
          if (want) cand = cands.find((c) => c.tok && c.tok === want) || null;
          if (!cand && nm) cand = cands.find((c) => c.name && c.name.includes(nm)) || null;
          if (!cand) throw new Error('tile-not-found');
          cand.el.scrollIntoView({ block: 'center', inline: 'center' });
          await wait(300);
          if (!(await clickReal(cand.el))) throw new Error('tile click fail');
          // Chờ SPA navigate sang /edit/<uuid> (href ĐỔI khỏi home) TRƯỚC khi quét <video> —
          // tránh bắt nhầm player cũ còn sót trên home (sai scene).
          {
            const navDeadline = Date.now() + 10000;
            while (Date.now() < navDeadline && location.href === prior) await wait(250);
            if (location.href === prior) throw new Error('no navigation to edit page');
          }
          const vidSrc = await waitFor(() => {
            for (const v of document.querySelectorAll('video')) {
              const s = v.currentSrc || v.src || '';
              if (s) return s;
              for (const sr of v.querySelectorAll('source')) if (sr.src) return sr.src;
            }
            return null;
          }, 15000, 300);
          if (!vidSrc) throw new Error('no video element on edit page');
          const r = await urlToDataUrl(vidSrc);
          if (!r || !r.ok || !r.dataUrl) throw new Error((r && r.reason) || 'fetch fail');
          if (!/^data:video\//i.test(r.dataUrl) || !dataUrlLooksLikeVideo(r.dataUrl)) throw new Error('non-video bytes');
          result = { ok: true, dataUrl: r.dataUrl };
        } catch (err) {
          result = { ok: false, reason: String(err && err.message || err) };
        } finally {
          // LUÔN trả về home TRƯỚC khi phản hồi — scene kế phải lookup tile trên HOME.
          // CHỈ history.back() (SPA — KHÔNG phá content-script context). KHÔNG hard `location.href=`
          // (reload giết context → timeout). Kẹt edit → báo needsHomeRestore cho sidepanel xử lý
          // chrome.tabs.update SAU KHI đã nhận result.
          if (location.href !== homeHref) {
            try {
              history.back();
              await waitFor(() => location.href === homeHref, 6000, 200);
            } catch (_) { /* SPA back lỗi — chuyển xuống flag bên dưới */ }
          }
          if (location.href !== homeHref) {
            result.needsHomeRestore = true;
            result.homeHref = homeHref;
          }
        }
        sendResponse(result);
      })();
      return true;
    }

    // T46: mở ẢNH trong trang EDIT của Flow (giống video — nhìn to/chuẩn bản gốc,
    // không dùng lightbox/zoom của ext). Ảnh tile CÓ data-media-id (uuid) → tìm trực
    // tiếp bằng uuid, click REAL tại tâm flow-image-tile → Flow navigate sang /edit/<uuid>.
    if (msg.type === 'openImageOnFlow') {
      (async () => {
        try {
          const mid = String(msg.mediaId || '').toLowerCase();
          let img = mid ? document.querySelector('img[data-media-id="' + mid + '"]') : null;
          if (!img) { sendResponse({ ok: false, reason: 'image tile not found (mediaId ' + mid + ')' }); return; }
          const tile = img.closest('flow-image-tile') || img.closest('flow-tile-container') || img;
          tile.scrollIntoView({ block: 'center', inline: 'center' });
          await wait(350);
          const ok = await clickReal(tile);
          sendResponse({ ok, url: location.href });
        } catch (err) { sendResponse({ ok: false, reason: String(err && err.message || err) }); }
      })();
      return true;
    }

    if (msg.type === 'fetchClip') {
      // P3b: lấy clip bytes (page-context fetch) → data URL cho sidepanel ghép video.
      urlToDataUrl(msg.url)
        .then((r) => sendResponse(r || { ok: false, reason: 'không phản hồi' }))
        .catch((err) => sendResponse({ ok: false, reason: String(err && err.message || err) }));
      return true;
    }

    // T69: chụp thumbnail media từ <img> ĐÃ TẢI trên home (canvas same-origin → dataUrl).
    // src flow.google.com/asb/<token> chỉ load được trong page Flow (có session), fetch
    // trực tiếp (kể cả trong content) trả 400 → không dùng urlToDataUrl. Canvas chụp <img>
    // đã render (naturalWidth>0) là cách duy nhất lấy được pixel.
    if (msg.type === 'captureThumb') {
      (async () => {
        try {
          const mid = String(msg.mediaId || '').toLowerCase();
          const tile = document.querySelector('[data-media-id="' + mid + '"]');
          const img = tile && (tile.tagName === 'IMG' ? tile : tile.querySelector('img'));
          if (!img) { sendResponse({ ok: false, reason: 'no tile img' }); return; }
          // chờ img tải xong (tối đa 3s)
          const deadline = Date.now() + 3000;
          while ((!img.naturalWidth || !img.complete) && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 200));
          }
          if (!img.naturalWidth) { sendResponse({ ok: false, reason: 'img chưa load' }); return; }
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.75);
          sendResponse({ ok: true, dataUrl });
        } catch (err) {
          sendResponse({ ok: false, reason: String(err && err.message || err) });
        }
      })();
      return true;
    }

    // T39 3.1: rect nút 'New project' trên trang home (dùng để debug / fallback).
    if (msg.type === 'getNewProjectBtn') {
      const rect = newProjectBtnRect();
      sendResponse(rect ? { ok: true, ...rect } : { ok: false, error: 'Không tìm thấy nút "New project".' });
      return true;
    }

    // T39 3.1 (preferred): tự tìm nút + CDP click (từ content) + poll url → projectId.
    if (msg.type === 'clickNewProject') {
      clickNewProject().then((r) => sendResponse(r)).catch((err) => sendResponse({ ok: false, reason: String(err && err.message || err) }));
      return true;
    }

    // T39 5/6: project id của tab hiện tại từ location.href (không đụng DOM).
    if (msg.type === 'getProjectId') {
      const id = projectIdFromHref(location.href);
      sendResponse(id ? { ok: true, projectId: id } : { ok: false, error: 'Chưa ở trang project.' });
      return true;
    }

    // T40 item 8: upload ảnh tài nguyên NGAY khi user chọn (sidepanel fire-and-forget)
    // → trả mediaId/mediaUrl để sidepanel lưu vào asset + dùng chung cho các lần tạo.
    if (msg.type === 'uploadAsset') {
      uploadAssetMedia(msg.asset)
        .then((r) => sendResponse(r || { ok: false, reason: 'không phản hồi' }))
        .catch((err) => {
          log('uploadAsset lỗi: ' + (err && err.message || err));
          // NÉM = không biết đã commit chưa → báo commitMayExist để sidepanel KHÔNG retry mù.
          sendResponse({ ok: false, reason: String(err && err.message || err), commitMayExist: true });
        });
      return true;
    }

    // T40 item 9: liệt kê ẢNH CÓ SẴN trong project hiện tại (media card img có alt
    // 'Generated image' — cùng bộ lọc kind như currentMediaIds/findNewMedia).
    if (msg.type === 'listProjectImages') {
      const items = [];
      const seen = new Set();
      for (const i of document.querySelectorAll('img')) {
        const s = i.currentSrc || i.src || '';
        if (!isMediaSrc(s)) continue;
        // GIỮ filter alt 'Generated image': chỉ liệt kê ảnh kết quả, tránh
        // nhiễu thumb refs. UI mới nếu alt khác sẽ miss — KHÔNG phá, chỉ thiếu
        // (log đã ghi rõ ở comment — chấp nhận cho giai đoạn này).
        if (!/generated\s*image/i.test(i.alt || '')) continue;
        const id = mediaIdOf(s); // lh3/asb → '' (không uuid trên UI mới)
        const key = id || s;     // UI mới: dùng chính src làm key hợp lệ
        if (!key || seen.has(key)) continue;
        seen.add(key);
        items.push({ id: id || s, url: s, name: i.alt || 'Generated image' });
      }
      sendResponse({ ok: true, images: items });
      return true;
    }

    if (msg.type === 'fetchMediaBytes') {
      (async () => {
        try {
          const res = await fetch(msg.url);
          if (!res.ok) { sendResponse({ ok: false, reason: 'http ' + res.status }); return; }
          const blob = await res.blob();
          const buf = await blob.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let bin = '';
          for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
          const b64 = btoa(bin);
          sendResponse({ ok: true, dataUrl: `data:${blob.type || 'image/png'};base64,${b64}`, mime: blob.type || 'image/png' });
        } catch (err) { sendResponse({ ok: false, reason: String(err && err.message || err) }); }
      })();
      return true;
    }

    // T42: chụp poster frame của VIDEO đang hiển thị trên Flow home (asb stream KHÔNG
    // fetch được + KHÔNG play được cross-origin → lấy 1 frame qua canvas same-origin làm
    // preview cho khung player sidepanel). Video preload=none/chưa tải → frame đen (best-effort).
    if (msg.type === 'captureVideoPoster') {
      (async () => {
        try {
          const want = String(msg.url || '');
          // T46-FIX: so khớp theo token asb (bỏ suffix stream =mm,22,15) — src form
          // 'asb/<token>' vs <video> 'asb/<token>=mm' lệch nhau → find bằng exact
          // trước đây fail → fallback QUÁ tay tới <video> đầu tiên (có thể sai card).
          const wt = mediaToken(want);
          let v = [...document.querySelectorAll('video')].find((e) => mediaToken(e.currentSrc || e.src) === wt);
          if (!v && /\/asb\//.test(want)) {
            const flowToken = mediaToken((document.querySelector('flow-video-tile video') || {}).currentSrc || document.querySelector('flow-video-tile video')?.src || '');
            if (mediaToken(flowToken) === wt) v = document.querySelector('flow-video-tile video') || null;
          }
          if (!v) v = document.querySelector('video');
          if (!v) { sendResponse({ ok: false, reason: 'no video element' }); return; }
          if (v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0) {
            try { v.currentTime = Math.min(0.5, Math.max(0, v.duration - 0.1)); } catch (_) { /* bỏ qua */ }
            await new Promise((r) => {
              let done = false;
              const fin = () => { if (!done) { done = true; r(); } };
              v.addEventListener('seeked', fin, { once: true });
              v.addEventListener('loadeddata', fin, { once: true });
              setTimeout(fin, 1600);
            });
          } else {
            await new Promise((r) => setTimeout(r, 800));
          }
          const w = v.videoWidth || 640;
          const h = v.videoHeight || 360;
          // frame đen hoàn toàn (preload=none) → không trả poster vô nghĩa
          if (v.readyState < 2 || !w || !h) { sendResponse({ ok: false, reason: 'no frame (preload none)' }); return; }
          const cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          const ctx = cv.getContext('2d');
          ctx.drawImage(v, 0, 0, w, h);
          const dataUrl = cv.toDataURL('image/jpeg', 0.8);
          sendResponse({ ok: true, dataUrl, width: w, height: h });
        } catch (err) { sendResponse({ ok: false, reason: String(err && err.message || err) }); }
      })();
      return true;
    }

    // TRACKER home: liệt kê TOÀN BỘ media đang có trên project home theo identity
    // CHUẨN = data-media-id (project media id — KHỚP mediaId lưu + selector xóa
    // `img.image[data-media-id=…]`). KHÔNG lọc alt (old labs 'Generated image' đã
    // lỗi thời — UI mới dùng "Tile displaying a user's image"). Dùng cho cả
    // extract (diff before/after → biết cutout mới tạo) lẫn verify/cleanup.
    if (msg.type === 'listHomeMedia') {
      (async () => {
        // cuộn home grid (virtual scroll) để render HẾT tile — DOM chỉ chứa khung nhìn
        // thấy; không cuộn thì media dưới fold bị thiếu → ensureAssetsPresent/cleanHome
        // tưởng "chưa có" → upload trùng / bỏ sót.
        try {
          const vp = document.querySelector('cdk-virtual-scroll-viewport');
          if (vp && vp.scrollHeight > vp.clientHeight) {
            const step = Math.max(300, Math.floor(vp.clientHeight * 0.8));
            const maxY = vp.scrollHeight - vp.clientHeight;
            for (let y = 0; y <= maxY; y += step) {
              vp.scrollTop = Math.min(y, maxY);
              vp.dispatchEvent(new Event('scroll', { bubbles: true }));
              await wait(220);
            }
          }
        } catch (_) { /* bỏ qua */ }
        const seen = new Set();
        const videoSeen = new Set();
        const media = [];
        const footerName = (card) => {
          const fl = (card && card.querySelector && card.querySelector('.footer-left, [class*="footer" i]')) || null;
          if (fl) { const t = labelTextOf(fl); if (t) return t; }
          return '';
        };
        for (const img of document.querySelectorAll('img')) {
          const host = (img.closest && img.closest('[data-media-id]')) || img;
          const dmid = (host.getAttribute && host.getAttribute('data-media-id')) || '';
          const s = img.currentSrc || img.src || '';
          const alt = (img.alt || '').trim();
          const card = (img.closest && img.closest('flow-grid-tile-container')) || img.parentElement;
          if (!dmid) continue; // video poster / avatar / ảnh không phải tài nguyên
          const id = dmid.toLowerCase();
          if (seen.has(id)) continue;
          seen.add(id);
          media.push({ id, kind: 'image', name: footerName(card) || alt || 'image', src: s });
        }
        // (T46) VIDEO tiles = flow-video-tile (KHÔNG data-media-id). Dùng <video> src
        // (token asb ỔN ĐỊNH) ưu tiên; fallback <img> poster. KHÔNG dùng alt heuristic
        // trên img thường — virtual-scroll tái sử dụng poster img → srcHint sai token
        // làm rename nhầm ảnh. Identity = mediaToken(src).
        for (const vt of document.querySelectorAll('flow-video-tile')) {
          const v = vt.querySelector('video');
          const im = vt.querySelector('img');
          const s = (v && (v.currentSrc || v.src)) || (im && (im.currentSrc || im.src)) || '';
          if (!isMediaSrc(s)) continue;
          const key = mediaToken(s) || s;
          if (videoSeen.has(key)) continue;
          videoSeen.add(key);
          media.push({ id: key, kind: 'video', name: footerName(vt) || 'video', src: s });
        }
        sendResponse({ ok: true, media, count: media.length });
      })();
      return true;
    }

    // CLEANUP home theo quy tắc đặt tên: giữ ĐÚNG 1 bản mỗi role (character.png /
    // product.png) + MỌI bối cảnh (background.png legacy + background_N.png pool)
    // + scene media (scene_<num>…), XÓA mọi thứ còn lại (rác / trùng char-prod /
    // cutout trung gian "Isolate product…"). Dựa identity data-media-id.
    // (mục 1) bg = COLLECTION: KHÔNG xóa trùng bg — 2 ảnh bg khác tên là hợp lệ;
    // xóa trùng CHỈ theo tên CHÍNH XÁC (background_3.png xuất hiện 2 lần → 1).
    if (msg.type === 'cleanHome') {
      (async () => {
        const ROLE_KEYS = ['character.png', 'product.png'];
        const BG_RE = /^background(?:_\d+)?\.png$/i; // legacy background.png + pool background_N.png
        const names = new Map(); // id -> name
        const seen = new Set();
        for (const img of document.querySelectorAll('img')) {
          const host = (img.closest && img.closest('[data-media-id]')) || img;
          const dmid = (host.getAttribute && host.getAttribute('data-media-id')) || '';
          if (!dmid) continue;
          const id = dmid.toLowerCase();
          if (seen.has(id)) continue;
          seen.add(id);
          const card = (img.closest && img.closest('flow-grid-tile-container')) || img.parentElement;
          let name = (img.alt || '').trim() || 'image';
          const fl = (card.querySelector && card.querySelector('.footer-left, [class*="footer" i]')) || null;
          if (fl) { const t = (fl.textContent || '').replace(/\s+/g, ' ').trim(); if (t) name = t; }
          names.set(id, name);
        }
        const roleFirst = {}; // roleKey -> id (giữ bản đầu, xóa bản trùng char/prod)
        const bgNames = new Map(); // tên bg chính xác -> id (giữ bản đầu, xóa trùng TÊN)
        const deleted = [];
        const kept = [];
        for (const [id, name] of names) {
          const n = String(name || '').toLowerCase().trim();
          const roleKey = ROLE_KEYS.find((r) => n.includes(r)) || null;
          if (/scene_\d+_(image|video)/i.test(n)) { kept.push(id); continue; } // scene media giữ
          if (BG_RE.test(n)) { // bối cảnh: định danh theo TÊN CHÍNH XÁC — giữ mọi tên khác nhau
            if (bgNames.has(n)) {
              const rs = await deleteAssetByMediaId(id);
              if (rs && rs.ok) deleted.push(id);
              continue;
            }
            bgNames.set(n, id);
            kept.push(id);
            continue;
          }
          if (!roleKey) { // rác (không khớp tên role) → xóa
            const rs = await deleteAssetByMediaId(id);
            if (rs && rs.ok) deleted.push(id);
            continue;
          }
          if (roleFirst[roleKey]) { // trùng role → xóa bản dư
            const rs = await deleteAssetByMediaId(id);
            if (rs && rs.ok) deleted.push(id);
            continue;
          }
          roleFirst[roleKey] = id;
          kept.push(id);
        }
        sendResponse({ ok: true, deleted, kept, keptById: roleFirst, bgById: Object.fromEntries(bgNames), total: names.size });
      })();
      return true;
    }

    // T82: xóa Flow project từ STORY ĐÃ LƯU — YÊU CẦU đang ở home (sidepanel đã navigate);
    // tìm card theo /project/<pid> → click "Delete project" (CDP trusted) → confirm → verify.
    if (msg.type === 'deleteFlowProject') {
      (async () => {
        const pid = String(msg.projectId || '');
        if (!pid) { sendResponse({ ok: false, reason: 'no pid' }); return; }
        try {
          if (!/^(?:https:\/\/flow\.google\.com|https:\/\/labs\.google\/fx\/tools\/flow)(?:[\/?#].*)?$/.test(location.href)) {
            sendResponse({ ok: false, reason: 'not on flow home' });
            return;
          }
          // (1) chờ card project xuất hiện (home cần scroll nếu có nhiều project)
          const card = await waitFor(() => {
            const link = document.querySelector('.project-card a[href*="/project/' + pid + '"]');
            if (!link) return null;
            const c = link.closest('.project-card');
            if (!c) return null;
            c.scrollIntoView({ block: 'center', inline: 'center' });
            return c;
          }, 10000);
          if (!card) {
            // Project không còn tồn tại trên Flow (đã xóa trước / orphan story) —
            // user chỉ muốn xóa dữ liệu trong STORY ĐÃ LƯU → coi như xong, không báo lỗi.
            sendResponse({ ok: true, resolved: 'not-found' });
            return;
          }
          await wait(600);
          // (2) nút Delete project trong card — CDP trusted click; nếu 3s chưa thấy
          // dialog (CDP click thất bại im lặng trên card này) → fallback .click() JS
          const delBtn = card.querySelector('button[aria-label="Delete project"], [aria-label*="Delete project" i]');
          if (!delBtn) { sendResponse({ ok: false, reason: 'no delete button' }); return; }
          const dpt = elCenter(delBtn);
          const clicked = await clickCdpxy(dpt.x, dpt.y, delBtn);
          let hasDialog = await waitFor(() => {
            return document.querySelector('[role="dialog"], .cdk-overlay-container [role="dialog"], mat-dialog-container');
          }, 3000, 250);
          if (!hasDialog) {
            // fallback JS click — Angular button ăn trusted click; đã verify mở dialog
            delBtn.click();
            hasDialog = await waitFor(() => {
              return document.querySelector('[role="dialog"], .cdk-overlay-container [role="dialog"], mat-dialog-container');
            }, 4000, 250);
          }
          if (!hasDialog) { sendResponse({ ok: false, reason: 'delete dialog not opened' + (clicked ? '' : ' (cdp click fail)') }); return; }
          // (3) dialog confirm: "…permanently deleted… Cancel | Delete project"
          const confirmBtn = await waitFor(() => {
            const dlg = document.querySelector('[role="dialog"], .cdk-overlay-container [role="dialog"], mat-dialog-container');
            if (!dlg) return null;
            const btns = [...dlg.querySelectorAll('button, [role="button"]')];
            return btns.find((b) => {
              const t = norm(b.textContent) + ' ' + norm((b.getAttribute && b.getAttribute('aria-label')) || '');
              return t.toLowerCase().includes('deleteproject') && !/cancel/i.test(t);
            }) || null;
          }, 8000);
          if (!confirmBtn) {
            // không thấy confirm → Escape đóng để không dở dang
            document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
            sendResponse({ ok: false, reason: 'no confirm button' });
            return;
          }
          const cpt = elCenter(confirmBtn);
          const clicked2 = await clickCdpxy(cpt.x, cpt.y, confirmBtn);
          // verify card biến mất; còn đó sau 4s → JS click fallback
          const gone0 = await waitFor(() => {
            return !document.querySelector('.project-card a[href*="/project/' + pid + '"]');
          }, 4000, 250);
          if (!gone0) {
            confirmBtn.click();
          }
          // (4) verify: card biến mất khỏi home
          const gone = await waitFor(() => {
            return !document.querySelector('.project-card a[href*="/project/' + pid + '"]');
          }, 15000);
          sendResponse({ ok: gone ? true : false, reason: gone ? undefined : 'project card still present after delete' + (!clicked2 ? ' (confirm cdp click fail)' : '') });
        } catch (err) {
          log('deleteFlowProject lỗi: ' + (err && err.message || err));
          sendResponse({ ok: false, reason: String(err && err.message || err) });
        }
      })();
      return true;
    }

    return undefined;
  });

  // G5/S4: bật observer lỗi ngoài job. Bắt đầu NGAY (baseline = mọi lỗi đang có),
  // tắt khi tab ẩn, bật lại + baseline lại khi tab hiện (xem visibilitychange).
  startErrorObserver();
})();
