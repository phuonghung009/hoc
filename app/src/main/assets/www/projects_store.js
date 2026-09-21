// ============================================================
// PROJECTS_STORE.JS — Danh sách "Project ID" Firestore (dự phòng/failover)
// dùng CHUNG cho: room_admin.js (panel Quản trị) + 3 game nhiều người
// (Thoát Mê Cung / Bắn Máy Bay / Đấu Võ).
//
// TRƯỚC ĐÂY: mỗi game tự hardcode sẵn trong code (const PROJECTS=[...]).
// GIỜ: admin có thể tự NHẬP TAY thêm/xóa Project ID ngay trên panel Quản
// trị phòng — danh sách này được LƯU LẠI thành 1 file JSON thật
// (hub_failover_projects.json) NGAY TRONG một thư mục mà admin tự chọn
// (thường là thư mục cài đặt extension đã giải nén), để lần sau mở lại
// (dù ở trang Quản trị hay trong 1 trong 3 game) đều đọc lại đúng danh
// sách đó — KHÔNG cần sửa code nữa.
//
// CÁCH HOẠT ĐỘNG:
//   - Dùng File System Access API (showDirectoryPicker), giống hệt cơ chế
//     đã có sẵn trong sync.js / aims_api_key_accounts.json của project này.
//   - Quyền truy cập thư mục (FileSystemDirectoryHandle) được lưu trong
//     IndexedDB — vì mọi trang của extension (main.html, room_admin, và
//     cả 3 trang game) đều cùng 1 "origin" (chrome-extension://<id>/...)
//     nên CHỈ CẦN CHỌN THƯ MỤC 1 LẦN DUY NHẤT ở panel Quản trị, các trang
//     game khác sẽ tự đọc lại được cùng 1 file JSON đó (không cần chọn lại).
//   - Nếu trình duyệt không hỗ trợ, hoặc admin CHƯA chọn thư mục lần nào,
//     tự động dùng danh sách MẶC ĐỊNH (2 project cũ) để không làm gãy
//     game — đây chỉ là NÂNG CẤP, không phải yêu cầu bắt buộc.
// ============================================================

"use strict";

const ProjectsStore = (() => {

  const DEFAULT_PROJECTS = [
    { name: 'daiwa1', projectId: 'dethi-hub-game-4vyujdchtz' },
    { name: 'Rom', projectId: 'hubid-eb1ee' },
  ];

  const JSON_FILE_NAME = 'hub_failover_projects.json';
  const IDB_NAME = 'hub_projects_store_db';
  const IDB_STORE = 'handles';
  const IDB_KEY = 'projects_folder_handle';

  let dirHandle = null;
  let cache = DEFAULT_PROJECTS.slice();
  let loaded = false;
  let initPromise = null;
  const listeners = [];

  function log(...args) { console.log('[ProjectsStore]', ...args); }

  function isSupported() {
    return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
  }

  function openIdb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGetHandle() {
    try {
      const db = await openIdb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const rq = tx.objectStore(IDB_STORE).get(IDB_KEY);
        rq.onsuccess = () => resolve(rq.result || null);
        rq.onerror = () => reject(rq.error);
      });
    } catch (e) { log('Không đọc được IndexedDB:', e.message || e); return null; }
  }

  async function idbSetHandle(handle) {
    try {
      const db = await openIdb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(handle, IDB_KEY);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) { log('Không lưu được IndexedDB:', e.message || e); return false; }
  }

  async function verifyPermission(handle, mode) {
    const opts = { mode };
    try {
      if ((await handle.queryPermission(opts)) === 'granted') return true;
      // requestPermission cần user gesture — chỉ có tác dụng khi được gọi
      // trực tiếp từ 1 hành động bấm nút của admin (vd pickFolder()).
      if ((await handle.requestPermission(opts)) === 'granted') return true;
    } catch (e) { log('Lỗi kiểm tra quyền thư mục:', e.message || e); }
    return false;
  }

  async function tryRestoreFolder() {
    if (!isSupported()) return false;
    try {
      const handle = await idbGetHandle();
      if (!handle) return false;
      // Chỉ kiểm tra quyền hiện có (queryPermission) — KHÔNG gọi
      // requestPermission ở đây vì không có user gesture lúc khởi động
      // trang, tránh bị trình duyệt chặn với lỗi.
      const granted = (await handle.queryPermission({ mode: 'readwrite' }).catch(() => 'denied')) === 'granted';
      if (!granted) return false;
      dirHandle = handle;
      return true;
    } catch (e) { log('Không khôi phục được thư mục đã chọn trước đó:', e.message || e); return false; }
  }

  // Phải gọi từ 1 hành động bấm nút thật của admin (user gesture).
  async function pickFolder() {
    if (!isSupported()) throw Error('Trình duyệt không hỗ trợ chọn thư mục (File System Access API).');
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    if (!(await verifyPermission(handle, 'readwrite'))) {
      throw Error('Không được cấp quyền ghi vào thư mục đã chọn.');
    }
    dirHandle = handle;
    await idbSetHandle(handle);
    // Sau khi chọn thư mục: nếu đã có file JSON trong đó thì đọc lại
    // (ưu tiên dữ liệu có sẵn), ngược lại ghi luôn danh sách hiện tại vào.
    const fromFile = await readFileFromFolder();
    if (fromFile && fromFile.length) {
      cache = fromFile;
    } else {
      await writeFileToFolder(cache);
    }
    notify();
    return cache.slice();
  }

  async function readFileFromFolder() {
    if (!dirHandle) return null;
    try {
      const fh = await dirHandle.getFileHandle(JSON_FILE_NAME, { create: false });
      const file = await fh.getFile();
      const text = await file.text();
      const j = JSON.parse(text);
      if (Array.isArray(j.projects)) {
        return j.projects
          .filter(p => p && p.projectId)
          .map(p => ({ name: String(p.name || p.projectId), projectId: String(p.projectId) }));
      }
      return null;
    } catch (e) {
      if (e && e.name === 'NotFoundError') return null;
      log('Lỗi đọc file JSON:', e.message || e);
      return null;
    }
  }

  async function writeFileToFolder(list) {
    if (!dirHandle) return false;
    try {
      const fh = await dirHandle.getFileHandle(JSON_FILE_NAME, { create: true });
      const w = await fh.createWritable();
      await w.write(JSON.stringify({ savedAt: new Date().toISOString(), projects: list }, null, 2));
      await w.close();
      return true;
    } catch (e) { log('Lỗi ghi file JSON:', e.message || e); return false; }
  }

  function notify() { listeners.forEach(fn => { try { fn(cache.slice()); } catch (e) { /* bỏ qua */ } }); }
  function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }

  // Gọi 1 lần lúc khởi động trang (main.html hoặc trang game). Không cần
  // user gesture — chỉ khôi phục quyền ĐÃ CẤP từ trước, không tự xin mới.
  async function init() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      const restored = await tryRestoreFolder();
      if (restored) {
        const fromFile = await readFileFromFolder();
        if (fromFile && fromFile.length) cache = fromFile;
      }
      loaded = true;
      notify();
      return cache.slice();
    })();
    return initPromise;
  }

  function getProjects() { return cache.slice(); }
  function hasFolder() { return !!dirHandle; }
  function isLoaded() { return loaded; }

  async function addProject(name, projectId) {
    const id = String(projectId || '').trim();
    if (!id) throw Error('Project ID không được để trống.');
    if (cache.some(p => p.projectId === id)) throw Error('Project ID này đã có trong danh sách.');
    const nm = String(name || '').trim() || id;
    cache = [...cache, { name: nm, projectId: id }];
    if (dirHandle) await writeFileToFolder(cache);
    notify();
    return cache.slice();
  }

  async function removeProject(projectId) {
    if (cache.length <= 1) throw Error('Phải giữ lại ít nhất 1 Project ID.');
    cache = cache.filter(p => p.projectId !== projectId);
    if (dirHandle) await writeFileToFolder(cache);
    notify();
    return cache.slice();
  }

  return { init, getProjects, addProject, removeProject, pickFolder, isSupported, hasFolder, isLoaded, onChange };
})();
