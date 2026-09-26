// MAIN-world hook: bắt Blob video mà Flow tạo khi download (downloadWillBegin url=blob:...).
// Flow revoke URL ngay sau khi bắt đầu tải → không fetch lại URL được; giữ Blob OBJECT
// và post sang isolated-world content script qua postMessage (structured clone).
// Chỉ dùng cho video (type chứa video/mp4/quicktime); ảnh/thumb không bắt (vẫn để hoạt động bình thường).
(() => {
  'use strict';
  try {
    if (window.__asfBlobCaptureInstalled) return;
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = orig(blob);
      try {
        const t = (blob && blob.type) || '';
        if (t && /video|mp4|quicktime|octet-stream/i.test(t)) {
          window.__asfHookSeen = (window.__asfHookSeen || 0) + 1;
          window.__asfLastBlob = { size: blob.size, type: t, t: Date.now() };
          window.postMessage(
            { source: 'asf-blob-capture', blob, size: blob.size, type: t, at: Date.now() },
            '*'
          );
        }
      } catch (_) { /* giữ nguyên hành vi gốc */ }
      return url;
    };
    window.__asfBlobCaptureInstalled = true;
  } catch (_) { /* page có thể chặn override — tiếp tục không hook */ }
})();
