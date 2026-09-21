// hub-lock-trigger.js — dùng chung cho MỌI Extension con trong Hub (trừ
// story_reader, đã tự có logic riêng loại trừ vùng đang đọc chữ).
// Bấm chuột 2 lần liên tiếp (double-click) ở bất kỳ đâu trong plugin này
// sẽ báo Hub (index.html/hub.js) khoá TOÀN BỘ app bằng màn đen + mật
// khẩu. Không kích hoạt khi double-click vào ô nhập liệu/vùng soạn thảo,
// để không phá thao tác chọn chữ/số bình thường khi gõ.
(function () {
  function isTypingTarget(el) {
    if (!el || !el.closest) return false;
    return !!el.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]');
  }
  function postToParent(msg) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(msg, location.origin);
      }
    } catch (e) { /* không nhúng trong Hub (mở lẻ file) thì bỏ qua */ }
  }
  document.addEventListener('dblclick', function (ev) {
    if (isTypingTarget(ev.target)) return;
    postToParent({ type: 'hub-lock-request' });
  });

  // ------------------------------------------------------------
  // Báo "còn đang thao tác" lên Hub ngoài cùng, để tính năng "tự khoá sau
  // N phút không làm gì" (xem hub.js) không tự khoá nhầm khi người dùng
  // vẫn đang di chuột/gõ phím/cuộn bên TRONG 1 Extension con — vì các sự
  // kiện chuột/phím trong iframe không tự nổi (bubble) lên tài liệu cha.
  // Gom bớt tần suất gửi (throttle 3s/lần) để không spam postMessage khi
  // rê chuột hoặc cuộn liên tục.
  // ------------------------------------------------------------
  let lastActivityPing = 0;
  function pingActivity() {
    const now = Date.now();
    if (now - lastActivityPing < 3000) return;
    lastActivityPing = now;
    postToParent({ type: 'hub-activity-ping' });
  }
  ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach(function (evt) {
    document.addEventListener(evt, pingActivity, { passive: true, capture: true });
  });
})();
