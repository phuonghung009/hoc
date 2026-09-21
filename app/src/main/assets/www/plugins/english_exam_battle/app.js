// ============================================================
// 📚 ĐỀ TIẾNG ANH LỚP 6 — CHA GIAO ĐỀ, CON LÀM BÀI (2 máy, qua mạng)
//
// Dùng LẠI đúng hạ tầng phòng Firestore (REST, không SDK, không đăng
// nhập) đã cấp phát sẵn cho ✈️ Bắn Máy Bay / 🥊 Đấu Võ / 🌀 Thoát Mê
// Cung: cùng FIXED_PROJECT_ID (+ dự phòng failover), cùng collection
// "rooms", cùng kiểu mã phòng tự nghĩ ra. Phần mềm này chỉ dùng riêng
// 1 nhánh dữ liệu "eng6" trong tài liệu phòng — không đụng tới nhánh
// của các trò chơi khác nên có thể dùng chung 1 mã phòng qua lại.
//
// Nguyên tắc chống ghi đè (giống các game kia): mỗi bên CHỈ ghi vào
// đúng phần dữ liệu của mình.
//   - CHA ghi:  eng6.exam, eng6.grading/result khi trả bài, và các
//               lần chuyển trạng thái do cha chủ động (giao đề / hủy /
//               ra đề mới).
//   - CON ghi:  eng6.submission, và trạng thái khi con bắt đầu / nộp.
// ============================================================

"use strict";
const $ = id => document.getElementById(id);

const FS_BASE = 'https://firestore.googleapis.com/v1';
const POLL_MS = 1500;
const VOICE_MSG_MAX_SEC = 60; // giới hạn ghi âm 1 tin nhắn thoại — tránh tài liệu phòng phình to quá nhanh
const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]; // dùng gọi thoại trực tiếp (WebRTC), xem khối cuối file
const STATE_STORAGE_KEY   = 'eng6_exam_state_v1';
const RECENT_ROOMS_KEY    = 'eng6_exam_recent_rooms_v1';
const DISPLAY_NAME_KEY    = 'eng6_exam_display_name_v1';
const ROLE_KEY            = 'eng6_exam_role_v1';
const SAVED_EXAMS_KEY     = 'eng6_exam_saved_templates_v1'; // thư viện đề đã lưu để dùng lại (lưu trên MÁY CHA, không đồng bộ qua phòng)
// Giọng đọc / tốc độ đọc cho nút "🔊 Nghe" (Web Speech API) — lưu RIÊNG trên
// TỪNG MÁY (không đồng bộ qua phòng), vì mỗi trình duyệt/thiết bị có sẵn 1
// danh sách giọng đọc khác nhau. Máy Cha và máy Con có thể chọn khác nhau.
const TTS_VOICE_KEY       = 'eng6_tts_voice_uri_v1';
const TTS_RATE_KEY        = 'eng6_tts_rate_v1';
const TTS_DEFAULT_RATE    = 0.92;
// Dùng CHUNG API Key / model / danh sách nhiều tài khoản với 🧩 AI Song
// Creator v3 — vì mọi trang trong extension đều cùng 1 origin nên
// localStorage dùng chung tự nhiên, không cần đồng bộ gì thêm. Cấu hình
// 1 lần ở đây hoặc ở AI Song Creator đều áp dụng cho cả 2 phần mềm.
const API_KEY_STORAGE_KEY          = 'aims_gemini_api_key';
const MODEL_STORAGE_KEY            = 'aims_gemini_model';
const API_KEY_ACCOUNTS_STORAGE_KEY = 'aims_gemini_api_key_accounts';
const DEFAULT_MODEL                = 'gemini-2.5-flash';

// Cùng dự án Firestore đã cấp phát sẵn cho các trò chơi trong Hub —
// dùng lại y nguyên, không tạo dự án riêng. Có thể bị ProjectsStore
// (../../projects_store.js) ghi đè nếu admin đã tự cấu hình danh sách
// Project ID riêng ở panel Quản trị phòng.
let PROJECTS = [
  { name: 'daiwa1', projectId: 'dethi-hub-game-4vyujdchtz' },
  { name: 'Rom', projectId: 'hubid-eb1ee' },
];
const FIXED_PROJECT_ID = PROJECTS[0].projectId;
(async () => {
  try {
    if (typeof ProjectsStore !== 'undefined') {
      const list = await ProjectsStore.init();
      if (Array.isArray(list) && list.length) PROJECTS = list;
    }
  } catch (e) { console.warn('[Đề Tiếng Anh 6] ProjectsStore lỗi, dùng danh sách mặc định:', e?.message || e); }
})();

const TOPICS = [
  'Từ vựng theo chủ đề (gia đình, trường học, sở thích, đồ vật...)',
  'Thì hiện tại đơn & hiện tại tiếp diễn',
  'Thì quá khứ đơn',
  'Thì tương lai đơn (will / be going to)',
  'Danh từ số ít – số nhiều, mạo từ a/an/the',
  'Tính từ, trạng từ & so sánh hơn/so sánh nhất',
  'Giới từ chỉ nơi chốn & thời gian (in/on/at...)',
  'Câu hỏi Yes/No & câu hỏi Wh- (What/Where/When/Who/Why/How)',
  'Đọc hiểu đoạn văn ngắn (reading comprehension)',
  'Nghe hiểu (listening comprehension) — nghe đoạn hội thoại/độc thoại ngắn rồi trả lời câu hỏi',
  'Viết câu / đoạn văn ngắn theo chủ đề (writing)',
  'Phát âm & trọng âm cơ bản (pronunciation & stress)',
];

// ============================================================
// THƯ VIỆN DỮ LIỆU: nội dung từ vựng/ngữ pháp trọng tâm của từng Unit
// trong SÁCH BÀI TẬP Tiếng Anh 6 — Global Success (Tập Một, Học kỳ 1).
// AI soạn "Đề Thi Học Kỳ" (tab 🎓) sẽ CHỈ được dùng từ vựng/ngữ pháp nằm
// trong phạm vi các Unit mà Cha chọn — không tự bịa ra ngoài chương trình.
// ============================================================
const SBT_UNITS = [
  {
    title: 'My New School',
    vocab: 'Đồ dùng học tập, môn học, hoạt động ở trường (do homework, have breaks, play team games, join clubs...)',
    grammar: 'Thì hiện tại đơn (cho thói quen/sự thật), trạng từ chỉ tần suất (always/usually/often/sometimes/never), câu hỏi Wh-',
  },
  {
    title: 'My House',
    vocab: 'Các kiểu nhà (stilt house, villa, flat, apartment, house in the countryside/city), đồ đạc & phòng trong nhà',
    grammar: 'There is/There are, giới từ chỉ vị trí (in, on, next to, near, behind, in front of, between)',
  },
  {
    title: 'My Friends',
    vocab: 'Tính từ miêu tả ngoại hình & tính cách bạn bè (tall, slim, funny, friendly, kind, hard-working...)',
    grammar: 'So sánh hơn của tính từ ngắn/dài (taller than, more intelligent than), cấu trúc "look like"',
  },
  {
    title: 'My Neighbourhood',
    vocab: 'Địa điểm trong khu phố (bakery, salon, stadium, bus stop, pharmacy...), chỉ đường',
    grammar: 'Động từ khiếm khuyết can/can\'t (khả năng, xin phép), câu mệnh lệnh (imperatives), hỏi đường "How can I get to...?"',
  },
  {
    title: 'Natural Wonders of Viet Nam',
    vocab: 'Địa danh & cảnh quan thiên nhiên (cave, waterfall, bay, island, mountain...), tính từ miêu tả thiên nhiên',
    grammar: 'So sánh nhất của tính từ ngắn/dài (the highest, the most beautiful)',
  },
  {
    title: 'Our Tet Holiday',
    vocab: 'Từ vựng ngày Tết (lucky money, peach blossom, banh chung, fireworks, New Year\'s Eve...)',
    grammar: 'Thì quá khứ đơn (động từ có quy tắc & bất quy tắc), câu hỏi/phủ định thì quá khứ đơn',
  },
];

// ---------- Đọc to tiếng Anh bằng Web Speech API (miễn phí, chạy ngay trong
// trình duyệt, không cần API key/gọi mạng) — dùng cho các câu "Nghe hiểu"
// (listening comprehension): thay vì hiện chữ, Con bấm nút để NGHE đoạn hội
// thoại/độc thoại, có thể bấm nghe lại nhiều lần. Gắn lên window vì các khối
// HTML dựng bằng chuỗi (in đề, khung kết quả...) cần gọi qua onclick="". ----------
function getTtsRatePref() {
  try { const v = parseFloat(localStorage.getItem(TTS_RATE_KEY)); return Number.isFinite(v) && v > 0 ? v : TTS_DEFAULT_RATE; }
  catch { return TTS_DEFAULT_RATE; }
}
function getTtsVoicePref() { try { return localStorage.getItem(TTS_VOICE_KEY) || ''; } catch { return ''; } }

// "opts" (tuỳ chọn) cho phép ghi đè tạm thời giọng/tốc độ đã LƯU — dùng cho
// nút "🔊 Nghe thử" ở khung Cài đặt giọng đọc, để nghe thử NGAY trước khi
// bấm Lưu. Không truyền "opts" thì dùng đúng giọng/tốc độ đã lưu (hoặc mặc
// định nếu chưa cài gì).
function speakEnglish(text, opts) {
  if (!text) return;
  try {
    if (!('speechSynthesis' in window)) throw new Error('no-tts');
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = (opts && Number.isFinite(opts.rate)) ? opts.rate : getTtsRatePref();
    const voiceURI = (opts && opts.voiceURI !== undefined) ? opts.voiceURI : getTtsVoicePref();
    if (voiceURI) {
      const v = (window.speechSynthesis.getVoices() || []).find(vv => vv.voiceURI === voiceURI);
      if (v) u.voice = v;
    }
    window.speechSynthesis.speak(u);
  } catch (e) {
    alert('⚠️ Trình duyệt này không hỗ trợ đọc bằng giọng nói (Web Speech API). Hãy thử bằng Chrome.');
  }
}
window.speakEnglish = speakEnglish;

// ---- Khung "🎧 Cài đặt giọng đọc" (cả Cha & Con, lưu riêng theo từng máy) ----
function populateTtsVoiceOptions() {
  const sel = $('ttsVoiceSelect'); if (!sel) return;
  const voices = (window.speechSynthesis && window.speechSynthesis.getVoices()) || [];
  if (!voices.length) {
    sel.innerHTML = '<option value="">⏳ Trình duyệt chưa nạp xong danh sách giọng — chờ 1-2 giây rồi mở lại khung này</option>';
    return;
  }
  const saved = getTtsVoicePref();
  const enVoices = voices.filter(v => /^en/i.test(v.lang));
  const otherVoices = voices.filter(v => !/^en/i.test(v.lang));
  const ordered = enVoices.concat(otherVoices);
  sel.innerHTML = '<option value="">(Giọng mặc định của trình duyệt)</option>' +
    ordered.map(v => '<option value="' + escapeHtml(v.voiceURI) + '"' + (v.voiceURI === saved ? ' selected' : '') + '>' +
      escapeHtml(v.name) + ' (' + escapeHtml(v.lang) + ')</option>').join('');
}
if ('speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = () => {
    const panel = $('ttsSettingsPanel');
    if (panel && panel.style.display !== 'none') populateTtsVoiceOptions();
  };
}
$('ttsSettingsBtn').addEventListener('click', () => {
  const panel = $('ttsSettingsPanel');
  const show = panel.style.display === 'none';
  panel.style.display = show ? 'block' : 'none';
  if (show) {
    populateTtsVoiceOptions();
    const rateSel = $('ttsSpeedSelect');
    if (rateSel) rateSel.value = String(getTtsRatePref());
    $('ttsSettingsStatus').textContent = '';
  }
});
$('ttsTestBtn').addEventListener('click', () => {
  const voiceURI = $('ttsVoiceSelect').value;
  const rate = parseFloat($('ttsSpeedSelect').value) || TTS_DEFAULT_RATE;
  speakEnglish('Hello! This is a test of the reading voice and speed. Can you hear me clearly?', { voiceURI, rate });
});
$('saveTtsSettingsBtn').addEventListener('click', () => {
  try {
    localStorage.setItem(TTS_VOICE_KEY, $('ttsVoiceSelect').value || '');
    localStorage.setItem(TTS_RATE_KEY, $('ttsSpeedSelect').value || String(TTS_DEFAULT_RATE));
    $('ttsSettingsStatus').textContent = '✅ Đã lưu — áp dụng ngay cho mọi nút "🔊 Nghe" trên máy này.';
    setTimeout(() => { $('ttsSettingsStatus').textContent = ''; }, 2500);
  } catch (e) { $('ttsSettingsStatus').textContent = '❌ Không lưu được: ' + (e?.message || e); }
});

// Sổ tra cứu text bài nghe theo "id" ngắn gọn (an toàn để nhét vào onclick=""
// của các khối HTML dựng bằng chuỗi — in đề, khung kết quả...) — tránh phải
// escape dấu nháy/dấu nháy đơn bên trong câu tiếng Anh (vd "don't", "it's").
window._listeningScripts = window._listeningScripts || {};
function speakEnglishById(id) { speakEnglish(window._listeningScripts[id] || ''); }
window.speakEnglishById = speakEnglishById;

// Trả về HTML 1 khối "🔊 Nghe" — dùng chung ở mọi nơi hiển thị câu Nghe hiểu.
// "label" tùy biến theo ngữ cảnh (Con làm bài / Cha xem lại...).
function listeningBoxHtml(listeningScript, label, qid) {
  if (!listeningScript) return '';
  const key = 'ls_' + (qid || uid());
  window._listeningScripts[key] = String(listeningScript);
  return '<div class="q-listening-box">' +
    '<button type="button" class="secondary small q-listen-btn" data-listen-key="' + key + '">🔊 ' + (label || 'Nghe đoạn hội thoại') + '</button>' +
    '</div>';
}
// QUAN TRỌNG: nút "🔊 Nghe" ở trên KHÔNG dùng onclick="" gắn thẳng trong
// chuỗi HTML — Chrome áp CSP mặc định của tiện ích Manifest V3 (chặn JS
// nội tuyến) lên CHÍNH TRANG của tiện ích này, nên onclick="" bị chặn ÂM
// THẦM (bấm không có phản ứng gì, không báo lỗi) y hệt vụ nút "In" đã gặp
// trước đây (xem ghi chú ở printExam()). Thay vào đó, gắn 1 listener DUY
// NHẤT lên toàn `document` bằng addEventListener ngay từ đầu — vẫn bắt
// được click dù nút "🔊 Nghe" được chèn vào bằng innerHTML ở bất kỳ đâu
// (khung soạn đề, màn Con làm bài, màn Cha chấm bài, màn kết quả...).
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.q-listen-btn');
  if (btn && btn.dataset.listenKey) speakEnglishById(btn.dataset.listenKey);
});

// Mức độ khó gửi kèm cho AI khi soạn đề / tạo lại từng câu
const DIFFICULTY_PROMPTS = {
  easy:      'DỄ (mức cơ bản, làm quen): từ vựng thông dụng, câu ngắn, cấu trúc ngữ pháp đơn giản, không đánh đố.',
  medium:    'VỪA (mức chuẩn theo chương trình): độ khó thông thường của 1 đề kiểm tra giữa kỳ/cuối kỳ.',
  hard:      'KHÓ (nâng cao): câu dài hơn, từ vựng phong phú hơn, có thể kết hợp 2 điểm ngữ pháp trong 1 câu, đoạn đọc hiểu dài hơn.',
  very_hard: 'RẤT KHÓ (phức tạp): kết hợp nhiều điểm ngữ pháp/từ vựng trong cùng 1 câu, đoạn văn dài, đòi hỏi suy luận ngữ cảnh, phù hợp học sinh khá giỏi muốn thử thách.',
};
function getDifficultyKey() { const el = $('aiDifficultySelect'); return (el && el.value) || 'medium'; }
function getDifficultyPromptText() { return DIFFICULTY_PROMPTS[getDifficultyKey()] || DIFFICULTY_PROMPTS.medium; }
function getCheckedTopics() { return Array.from(document.querySelectorAll('#topicChecklist input:checked')).map(c => c.value); }

// ---------- Chụp lại / phục hồi TOÀN BỘ khung soạn đề (đúng như lúc bấm
// "GIAO ĐỀ") — gồm tab đang mở (Tự soạn tay / Nhờ AI soạn đề), các chủ đề +
// kiểu hình đã tích, số câu trắc nghiệm/tự luận, mức độ khó, yêu cầu thêm —
// để khi bấm "✏️ Sửa lại đề này" / "Dùng để sửa" thì mở lại ĐÚNG cái form đã
// dùng để tạo ra đề đó (không phải luôn luôn nhảy về tab "Tự soạn tay" với
// danh sách câu phẳng như trước), Cha chỉ cần chỉnh số câu/loại câu rồi tạo
// lại là xong, không phải gõ lại từ đầu. Không lưu file mẫu đính kèm (ảnh/PDF)
// vì không thể lưu bền qua phòng/localStorage được. ----------
function getComposeSettingsSnapshot() {
  return {
    activeTab: $('tabAiBtn').classList.contains('active') ? 'ai' : 'manual',
    topics: getCheckedTopics(),
    mcqCount: parseInt($('aiMcqCountInput').value, 10) || 0,
    essayCount: parseInt($('aiEssayCountInput').value, 10) || 0,
    difficulty: getDifficultyKey(),
    extraPrompt: $('aiExtraPromptInput').value,
  };
}
function applyComposeSettingsSnapshot(s) {
  if (!s) { switchTab('manual'); return; }
  document.querySelectorAll('#topicChecklist input').forEach(cb => { cb.checked = (s.topics || []).includes(cb.value); });
  $('aiMcqCountInput').value = Number.isFinite(s.mcqCount) ? s.mcqCount : 5;
  $('aiEssayCountInput').value = Number.isFinite(s.essayCount) ? s.essayCount : 2;
  if ($('aiDifficultySelect')) $('aiDifficultySelect').value = s.difficulty || 'medium';
  $('aiExtraPromptInput').value = s.extraPrompt || '';
  switchTab(s.activeTab === 'ai' ? 'ai' : 'manual');
}

// Hướng dẫn định dạng lời giải/giải thích — dùng chung cho soạn đề & tạo lại
// từng câu, để phần giải thích (đáp án đúng câu trắc nghiệm, gợi ý chấm câu tự
// luận) trình bày rõ ràng, giúp phụ huynh không rành tiếng Anh vẫn chấm được.
const SOLUTION_STYLE_GUIDE =
  'Với "suggestedAnswer" của câu tự luận/viết (và phần giải thích "explanation" ở câu trắc ' +
  'nghiệm), hãy viết bằng TIẾNG VIỆT, trình bày THEO TỪNG BƯỚC rõ ràng, xuống dòng giữa các ' +
  'bước, theo phong cách:\n' +
  '"Đáp án gợi ý: <câu/đoạn tiếng Anh đúng>\\nGiải thích: <vì sao dùng cấu trúc/từ đó, dịch ' +
  'nghĩa tiếng Việt ngắn gọn>\\nLưu ý khi chấm: <những cách diễn đạt khác cũng được chấp nhận, ' +
  'nếu có>."\n' +
  'Với câu trắc nghiệm ngữ pháp, giải thích ngắn gọn quy tắc, ví dụ đúng phong cách:\n' +
  '"Đáp án đúng: (B) goes\\nGiải thích: Chủ ngữ \'She\' là ngôi thứ 3 số ít nên động từ thường ' +
  'ở thì hiện tại đơn phải thêm \'s/es\' → \'goes\'."\n' +
  'Xuống dòng bằng \\n giữa các phần để hiển thị đẹp, dễ nhìn.';

// Yêu cầu AI luôn kiểm tra chính tả, ngữ pháp và dấu câu tiếng Anh trong nội
// dung câu hỏi trước khi trả về — tránh lỗi hay gặp là AI tự soạn câu tiếng
// Anh bị sai ngữ pháp/chính tả cơ bản.
const GRAMMAR_CHECK_GUIDE =
  'BẮT BUỘC: mọi câu/đoạn tiếng Anh trong "prompt", "options" và "suggestedAnswer" phải đúng ' +
  'ngữ pháp, chính tả và dấu câu chuẩn — trước khi trả lời, hãy tự rà soát lại từng câu xem có ' +
  'lỗi gì không, sửa lại cho hoàn chỉnh rồi mới trả về. Nội dung phải phù hợp với học sinh lớp 6 ' +
  '(từ vựng và cấu trúc câu ở mức cơ bản đến trung bình, chủ đề gần gũi, trong sáng, phù hợp lứa tuổi).';

// Hướng dẫn riêng cho dạng câu NGHE HIỂU (listening comprehension) — Con sẽ
// KHÔNG đọc được đoạn hội thoại, chỉ bấm nút "🔊 Nghe" để nghe (đọc bằng máy),
// nên đoạn hội thoại phải nằm RIÊNG ở trường "listeningScript", KHÔNG được lặp
// lại trong "prompt" (nếu không Con vẫn đọc được chữ, mất tác dụng luyện nghe).
const LISTENING_GUIDE =
  'Nếu câu hỏi thuộc dạng NGHE HIỂU (listening comprehension): hãy viết 1 đoạn hội thoại hoặc ' +
  'độc thoại ngắn bằng tiếng Anh (4-8 câu, từ vựng/tốc độ phù hợp lớp 6) vào trường ' +
  '"listeningScript" — đây là đoạn Con sẽ NGHE (được đọc to lên bằng máy), KHÔNG phải đọc chữ. ' +
  'Trường "prompt" của câu đó CHỈ chứa câu hỏi kiểm tra khả năng nghe hiểu (vd "What does Anna ' +
  'plan to do this weekend?"), TUYỆT ĐỐI KHÔNG chép lại nội dung đoạn hội thoại vào "prompt". ' +
  'Với những câu KHÔNG phải dạng nghe hiểu, để "listeningScript" là chuỗi rỗng "".';

// ---------- Firestore REST helpers (giống hệt các game khác trong Hub) ----------
function toFsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFsValue) } };
  if (typeof v === 'object') return { mapValue: { fields: objToFsFields(v) } };
  return { stringValue: String(v) };
}
function fromFsValue(fv) {
  if (!fv) return null;
  if ('nullValue' in fv) return null;
  if ('booleanValue' in fv) return fv.booleanValue;
  if ('integerValue' in fv) return parseInt(fv.integerValue, 10);
  if ('doubleValue' in fv) return fv.doubleValue;
  if ('stringValue' in fv) return fv.stringValue;
  if ('arrayValue' in fv) return (fv.arrayValue.values || []).map(fromFsValue);
  if ('mapValue' in fv) return fsFieldsToObj(fv.mapValue);
  return null;
}
function fsFieldsToObj(doc) {
  return doc && doc.fields ? Object.fromEntries(Object.entries(doc.fields).map(([k, v]) => [k, fromFsValue(v)])) : {};
}
function objToFsFields(obj) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, toFsValue(v)]));
}
async function fsRequest(url, options = {}) {
  const r = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  if (r.status === 404) return null;
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    const msg = (Array.isArray(j) ? j[0]?.error?.message : j?.error?.message) || ('HTTP ' + r.status);
    const err = Error(msg); err.status = r.status; throw err;
  }
  return r.json();
}
function orderedProjectIds(preferred = null) {
  return preferred ? [preferred, ...PROJECTS.map(p => p.projectId).filter(id => id !== preferred)] : PROJECTS.map(p => p.projectId);
}
function isFailoverError(e) {
  const status = Number(e?.status || 0), msg = String(e?.message || e || '').toLowerCase();
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504 ||
    /resource.?exhausted|quota|rate.?limit|too many requests|temporarily unavailable|service unavailable/.test(msg);
}
function roomDocUrl(projectId, roomId) {
  return `${FS_BASE}/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/rooms/${encodeURIComponent(roomId)}`;
}
async function fsGetRoom(projectId, roomId) {
  const doc = await fsRequest(roomDocUrl(projectId, roomId));
  return doc ? fsFieldsToObj(doc) : null;
}
async function fsCreateRoom(projectId, roomId, fields) {
  const url = `${FS_BASE}/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/rooms` +
    `?documentId=${encodeURIComponent(roomId)}`;
  return fsRequest(url, { method: 'POST', body: JSON.stringify({ fields: objToFsFields(fields) }) });
}
async function fsPatchRoom(projectId, roomId, partial, fieldPaths) {
  const url = new URL(roomDocUrl(projectId, roomId));
  fieldPaths.forEach(p => url.searchParams.append('updateMask.fieldPaths', p));
  return fsRequest(url.toString(), { method: 'PATCH', body: JSON.stringify({ fields: objToFsFields(partial) }) });
}
async function withFailover(fn) {
  const ids = orderedProjectIds(state.projectId);
  let lastErr = null;
  for (const id of ids) {
    try { const result = await fn(id); state.projectId = id; return result; }
    catch (e) { lastErr = e; if (!isFailoverError(e)) throw e; }
  }
  throw lastErr;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
// Hiển thị nội dung câu hỏi/đáp án dạng chữ thường (tiếng Anh + tiếng Việt) —
// chỉ escape HTML rồi xuống dòng bằng <br>, không cần xử lý phân số/số mũ như
// bên môn Toán. Giữ tên hàm "mathHtml" để không phải sửa hàng loạt chỗ gọi
// nó ở khắp file (hiển thị bài làm, lời giải, đề in ra giấy...).
function mathHtml(str) {
  let s = escapeHtml(str);
  s = s.replace(/\n/g, '<br>');
  return s;
}
// ---------- Hiển thị bài làm của Con kiểu "cô giáo cầm bút đỏ chấm bài" ----------
// annotations: mảng {quote, comment, corrected} do AI chấm trả về — "quote" PHẢI
// là 1 đoạn trích NGUYÊN VĂN nằm trong rawText thì mới gạch chân/đánh dấu được
// (đoạn nào AI đưa "quote" không khớp y hệt thì bỏ qua, không gạch bừa).
// Mỗi đoạn khớp được vẽ gạch chân đỏ lượn sóng + 1 vòng tròn số nhỏ, bấm/rê
// chuột vào hiện bong bóng góp ý + cách sửa — giống hệt kiểu giáo viên phê tay
// trực tiếp lên bài rồi Con lật xem từng chỗ phê một.
function annotatedAnswerHtml(rawText, annotations) {
  const text = String(rawText || '');
  const notes = Array.isArray(annotations) ? annotations.filter(a => a && a.quote && text.includes(a.quote)) : [];
  if (!notes.length) return mathHtml(text);
  // Tìm vị trí xuất hiện của từng "quote" trong bài làm gốc, sắp theo thứ tự
  // xuất hiện trong bài, rồi bỏ những đoạn bị chồng lấn lên đoạn đã chọn trước.
  const found = [];
  notes.forEach(a => { const idx = text.indexOf(a.quote); if (idx >= 0) found.push({ start: idx, end: idx + a.quote.length, note: a }); });
  found.sort((x, y) => x.start - y.start);
  const clean = [];
  let lastEnd = -1;
  found.forEach(f => { if (f.start >= lastEnd) { clean.push(f); lastEnd = f.end; } });

  let html = '', pos = 0;
  clean.forEach((f, i) => {
    html += mathHtml(text.slice(pos, f.start));
    const num = i + 1;
    const comment = escapeHtml(f.note.comment || '');
    const corrected = f.note.corrected ? mathHtml(String(f.note.corrected)) : '';
    html += '<span class="teacher-mark" tabindex="0">' + mathHtml(text.slice(f.start, f.end)) +
      '<sup class="teacher-mark-badge">' + num + '</sup>' +
      '<span class="teacher-bubble">🖊️ ' + comment + (corrected ? '<br><b>Sửa lại cho đúng:</b> ' + corrected : '') + '</span>' +
      '</span>';
    pos = f.end;
  });
  html += mathHtml(text.slice(pos));
  return html;
}
// ---------- Khung "Cách làm đúng (từng bước)" — hiện khi Con làm sai / thiếu /
// chưa nộp, trình bày lại lời giải chuẩn theo từng bước như cách trình bày khi
// đi thi, để Con đọc là hiểu ngay cách làm đúng. ----------
function buildStepSolutionHtml(steps) {
  const list = Array.isArray(steps) ? steps.filter(Boolean) : [];
  if (!list.length) return '';
  return '<div class="step-solution-box"><div class="step-solution-title">📘 Cách làm đúng (từng bước):</div><ol>' +
    list.map(s => '<li>' + mathHtml(String(s)) + '</li>').join('') + '</ol></div>';
}
// ---------- Khung "Mẹo nhận biết / ghi nhớ" — 1 câu tổng quát (không nhắc lại
// nội dung câu hỏi cụ thể) giúp Con nhận ra dấu hiệu/quy tắc chung của dạng
// lỗi này, để lần sau gặp câu tương tự thì làm đúng ngay, không lặp lại lỗi. ----------
function buildTipHtml(tip) {
  const t = String(tip || '').trim();
  if (!t) return '';
  return '<div class="tip-box">💡 <b>Mẹo ghi nhớ (để lần sau không sai nữa):</b> ' + mathHtml(t) + '</div>';
}
function statusChipHtml(status) {
  const meta = {
    correct: { cls: 'st-correct', label: '✅ Đúng' },
    partial: { cls: 'st-partial', label: '🟡 Đúng một phần' },
    wrong: { cls: 'st-wrong', label: '❌ Chưa đúng' },
    unanswered: { cls: 'st-unanswered', label: '⬜ Chưa làm' },
  }[status];
  if (!meta) return '';
  return '<span class="status-chip ' + meta.cls + '">' + meta.label + '</span>';
}

function uid() { return 'q' + Math.random().toString(36).slice(2, 9); }

// ---------- localStorage tiện ích ----------
function loadRecentRooms() { try { const a = JSON.parse(localStorage.getItem(RECENT_ROOMS_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
function saveRecentRooms(list) { try { localStorage.setItem(RECENT_ROOMS_KEY, JSON.stringify(list.slice(0, 8))); } catch { } }
function rememberRoom(roomId) { let l = loadRecentRooms().filter(r => r.roomId !== roomId); l.unshift({ roomId }); saveRecentRooms(l); }
function getApiKey() { try { return localStorage.getItem(API_KEY_STORAGE_KEY) || ''; } catch { return ''; } }
function getModel() { try { return localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_MODEL; } catch { return DEFAULT_MODEL; } }
function loadApiKeyAccounts() {
  try { const a = JSON.parse(localStorage.getItem(API_KEY_ACCOUNTS_STORAGE_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}
// Gom key đang dùng + mọi tài khoản đã lưu bên AI Song Creator (nếu có)
// thành 1 danh sách để tự động thử key khác khi key đầu bị lỗi/hết hạn
// mức — y hệt cơ chế "tự chuyển tài khoản" của AI Song Creator.
function getAllUsableApiKeys() {
  const current = getApiKey();
  const list = current ? [{ label: 'Key đang dùng', key: current }] : [];
  loadApiKeyAccounts().forEach(acc => { if (acc && acc.key && acc.key !== current) list.push({ label: acc.label || 'Tài khoản khác', key: acc.key }); });
  return list;
}
function isKeyRotationWorthyError(status, msg) {
  if (status === 429 || status === 403 || status >= 500) return true;
  if (status === 400 && /api key not valid|api_key_invalid/i.test(msg || '')) return true;
  return false;
}

// ---------- Gọi Gemini (tự xoay vòng tài khoản, tự thử lại khi lỗi tạm thời) ----------
async function callGemini(parts, { expectJson = true } = {}) {
  const keys = getAllUsableApiKeys();
  if (!keys.length) throw Error('Chưa có Gemini API Key nào. Bấm ⚙️ Cài Gemini API (dùng chung với AI Song Creator) để nhập.');
  const model = getModel() || DEFAULT_MODEL;
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: expectJson ? { responseMimeType: 'application/json', temperature: 0.8 } : { temperature: 0.8 },
  };
  let lastErr = null;
  for (const acc of keys) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(acc.key)}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { const msg = j?.error?.message || ('HTTP ' + r.status); const err = Error(msg); err.status = r.status; throw err; }
        const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
        if (!text) throw Error('Gemini không trả về nội dung nào. Thử lại xem sao.');
        return text;
      } catch (e) {
        lastErr = e;
        const status = Number(e.status || 0);
        if (isKeyRotationWorthyError(status, e.message)) break; // đổi sang key khác ngay, khỏi thử lại cùng key
        const retriable = status === 500 || status === 502 || status === 503 || status === 504;
        if (!retriable || attempt === 1) break;
        await sleep(1200 * (attempt + 1));
      }
    }
  }
  throw lastErr;
}
function parseJsonLoose(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = t.indexOf('{');
  if (start < 0) return JSON.parse(t); // không có "{" nào — để lỗi gốc của JSON.parse hiện ra cho dễ biết
  // Quét từ dấu "{" đầu tiên, đếm độ sâu ngoặc { } (có để ý chuỗi "..." và
  // ký tự escape "\" bên trong chuỗi để không đếm nhầm dấu ngoặc nằm trong
  // text) — nhằm tìm ĐÚNG dấu "}" đóng khớp với dấu "{" mở đầu.
  // Cách cũ (indexOf "{" đầu + lastIndexOf "}" cuối) hay bị lỗi
  // "Unexpected non-whitespace character after JSON" mỗi khi AI lỡ in thêm
  // chữ hoặc 1 khối JSON khác phía sau: lastIndexOf lụm luôn dấu "}" của
  // phần thừa đó, kéo theo cả đoạn rác vào chuỗi JSON.
  let depth = 0, inString = false, escaping = false, closeIdx = -1;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inString) {
      if (escaping) escaping = false;
      else if (ch === '\\') escaping = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { closeIdx = i; break; } }
  }
  t = closeIdx >= 0 ? t.slice(start, closeIdx + 1) : t.slice(start);
  return JSON.parse(t);
}
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
function fileToText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = reject;
    r.readAsText(file);
  });
}

// ---------- State ----------
const state = {
  role: null,            // 'parent' | 'child'
  displayName: '',
  projectId: null,
  roomId: null,
  pollTimer: null,
  room: null,             // toàn bộ tài liệu phòng (mọi nhánh)
  draftQuestions: [],     // câu hỏi đang soạn nháp (chưa giao đề)
  aiSampleFile: null,
  semesterExam: null,    // đề thi học kỳ vừa AI tạo (1 đề + đáp án) — xuất PDF hoặc giao cho Con qua assignSemesterExam()
  _examPreviewConfirm: null, // callback thật sự ghi đề vào phòng, gọi khi Cha bấm xác nhận ở khung "👁 Xem trước đề"
  childAnswers: {},       // {questionId: selectedIndex|text} — bài đang làm dở
  examStartedLocalAt: null,
  timerInterval: null,
  lastRenderedStatus: null,
  submitting: false,
  gradingDetails: {},     // {questionId: {status, annotations, stepSolution, answerText}} — kết quả AI chấm chi tiết, dùng khi bấm "TRẢ BÀI CHO CON"
  quickChatLog: [],       // lịch sử chat nhanh với AI khi đang xem lại bài chấm (chỉ ở máy Cha, không đồng bộ)
  _resultRenderedFor: undefined, // chống vẽ lại toàn bộ khung kết quả mỗi lần poll (giữ trạng thái thu gọn/mở của Con)
  directChatSeenCount: { parent: 0, child: 0 }, // số tin nhắn "Nhắn cho Con/Cha" đã xem trên MÁY NÀY (để hiện chấm đỏ tin mới)
  // ---- Ghi âm tin nhắn thoại (xem startVoiceRecording/stopVoiceRecording) ----
  voiceRecorder: null, voiceRecordStartedAt: 0, voiceRecordTimerInt: null,
  // ---- Gọi thoại trực tiếp WebRTC (xem khối "GỌI THOẠI TRỰC TIẾP" cuối file) ----
  rtc: { pc: null, localStream: null, callId: null, isCaller: false, appliedRemoteDescription: false, appliedCandidateCount: 0, timerInt: null, startedAt: 0, muted: false },
};

// ---------- DOM refs ----------
const roleScreen = $('roleScreen'), joinScreen = $('joinScreen'), mainScreen = $('mainScreen');
const displayNameInput = $('displayNameInput'), roomCodeInput = $('roomCodeInput');
const joinBtn = $('joinBtn'), joinError = $('joinError'), savedRoomsBox = $('savedRoomsBox');
const roomLabel = $('roomLabel'), statusLabel = $('statusLabel'), leaveBtn = $('leaveBtn');
const settingsBtn = $('settingsBtn'), settingsPanel = $('settingsPanel');
const apiKeyInput = $('apiKeyInput'), modelInput = $('modelInput'), saveSettingsBtn = $('saveSettingsBtn'), settingsStatus = $('settingsStatus');
const parentView = $('parentView'), childView = $('childView');

// ============================================================
// MÀN HÌNH CHỌN VAI TRÒ
// ============================================================
(function initRoleScreen() {
  const savedRole = localStorage.getItem(ROLE_KEY);
  displayNameInput.value = localStorage.getItem(DISPLAY_NAME_KEY) || '';
  if (savedRole === 'parent' || savedRole === 'child') {
    state.role = savedRole;
    showJoinScreen();
  } else {
    roleScreen.style.display = 'block';
  }
  renderRecentRooms();
})();
$('roleParentBtn').addEventListener('click', () => { state.role = 'parent'; localStorage.setItem(ROLE_KEY, 'parent'); showJoinScreen(); });
$('roleChildBtn').addEventListener('click', () => { state.role = 'child'; localStorage.setItem(ROLE_KEY, 'child'); showJoinScreen(); });
$('backToRoleBtn').addEventListener('click', () => { joinScreen.style.display = 'none'; roleScreen.style.display = 'block'; });

function showJoinScreen() { roleScreen.style.display = 'none'; joinScreen.style.display = 'block'; }

function renderRecentRooms() {
  const list = loadRecentRooms();
  if (!list.length) { savedRoomsBox.style.display = 'none'; return; }
  savedRoomsBox.style.display = 'block';
  savedRoomsBox.innerHTML = '';
  const title = document.createElement('div'); title.className = 'hint'; title.textContent = 'Phòng đã dùng gần đây:';
  savedRoomsBox.appendChild(title);
  const row = document.createElement('div'); row.className = 'saved-rooms-row'; row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:6px';
  list.forEach(r => {
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'secondary small';
    btn.textContent = r.roomId;
    btn.addEventListener('click', () => { roomCodeInput.value = r.roomId; enterRoom(r.roomId); });
    row.appendChild(btn);
  });
  savedRoomsBox.appendChild(row);
}

// ============================================================
// VÀO PHÒNG
// ============================================================
joinBtn.addEventListener('click', () => enterRoom(roomCodeInput.value));
roomCodeInput.addEventListener('keydown', e => { if (e.key === 'Enter') enterRoom(roomCodeInput.value); });

function sanitizeRoomCode(code) { return String(code || '').trim().toUpperCase().slice(0, 24); }

async function enterRoom(rawCode) {
  const roomId = sanitizeRoomCode(rawCode);
  const name = displayNameInput.value.trim() || (state.role === 'parent' ? 'Cha' : 'Con');
  if (!roomId) { joinError.textContent = 'Hãy gõ 1 mã phòng trước đã.'; return; }
  joinError.textContent = '';
  joinBtn.disabled = true; joinBtn.textContent = 'Đang vào phòng...';
  try {
    localStorage.setItem(DISPLAY_NAME_KEY, name);
    state.displayName = name;
    state.roomId = roomId;
    await withFailover(async (projectId) => {
      let room = await fsGetRoom(projectId, roomId);
      if (!room) {
        await fsCreateRoom(projectId, roomId, { eng6: { status: 'idle' }, createdAt: Date.now(), updatedAt: Date.now() });
      } else if (!room.eng6) {
        await fsPatchRoom(projectId, roomId, { eng6: { status: 'idle' }, updatedAt: Date.now() }, ['eng6', 'updatedAt']);
      }
      return true;
    });
    rememberRoom(roomId);
    joinScreen.style.display = 'none';
    mainScreen.style.display = 'block';
    roomLabel.textContent = '🔑 Phòng: ' + roomId;
    parentView.style.display = state.role === 'parent' ? 'block' : 'none';
    childView.style.display = state.role === 'child' ? 'block' : 'none';
    settingsBtn.style.display = state.role === 'parent' ? 'inline-block' : 'none';
    // ---- Khung chat nổi: hiện ngay khi vào phòng (ở dạng bong bóng tròn thu
    // gọn sẵn), tiêu đề tự đổi theo vai trò — "Nhắn cho Con" (Cha) hoặc "Nhắn
    // cho Cha" (Con) — và luôn nằm trên màn hình dù đang chuyển qua lại giữa
    // các khung bên trong phòng, kéo-thả di chuyển được tự do. ----
    $('floatingChatBox').style.display = 'flex';
    $('floatingChatTitle').textContent = state.role === 'parent' ? 'Nhắn cho Con' : 'Nhắn cho Cha';
    if (state.role === 'parent') initParentUiOnce();
    startPolling();
  } catch (e) {
    joinError.textContent = '❌ Không vào được phòng: ' + (e?.message || e);
  } finally {
    joinBtn.disabled = false; joinBtn.textContent = '➡️ VÀO PHÒNG / TẠO PHÒNG MỚI';
  }
}

leaveBtn.addEventListener('click', () => {
  stopPolling();
  clearInterval(state.timerInterval);
  mainScreen.style.display = 'none';
  joinScreen.style.display = 'block';
  state.roomId = null; state.room = null;
  // Rời phòng thì ẩn luôn khung chat nổi (tránh còn sót lại trên màn hình
  // chờ vào phòng, nơi chưa có phòng nào để chat) và thu gọn lại từ đầu.
  $('floatingChatBox').style.display = 'none';
  setFloatingChatCollapsed(true);
  // Đang gọi thoại mà rời phòng thì dọn dẹp mic/kết nối cục bộ luôn — không
  // báo cho bên kia biết được nữa (đã rời phòng, hết quyền ghi vào phòng cũ)
  // nhưng ít nhất máy mình tắt mic/đóng kết nối ngay, không để lơ lửng.
  if (state.rtc.pc || state.rtc.localStream) rtcCleanup();
});

// ============================================================
// ⚙️ CÀI ĐẶT GEMINI (chỉ Cha)
// ============================================================
settingsBtn.addEventListener('click', () => {
  apiKeyInput.value = getApiKey();
  modelInput.value = getModel();
  settingsPanel.style.display = settingsPanel.style.display === 'none' ? 'block' : 'none';
});
saveSettingsBtn.addEventListener('click', () => {
  try {
    localStorage.setItem(API_KEY_STORAGE_KEY, apiKeyInput.value.trim());
    localStorage.setItem(MODEL_STORAGE_KEY, modelInput.value.trim() || DEFAULT_MODEL);
    settingsStatus.textContent = '✅ Đã lưu.';
    setTimeout(() => settingsStatus.textContent = '', 2000);
  } catch (e) { settingsStatus.textContent = '❌ Không lưu được: ' + e.message; }
});

// ============================================================
// POLLING PHÒNG
// ============================================================
function startPolling() { pollOnce(); state.pollTimer = setInterval(pollOnce, POLL_MS); }
function stopPolling() { clearInterval(state.pollTimer); state.pollTimer = null; }
async function pollOnce() {
  try {
    const room = await withFailover(pid => fsGetRoom(pid, state.roomId));
    if (room) { state.room = room; render(); }
  } catch (e) { statusLabel.textContent = '⚠️ Mất kết nối tạm thời: ' + (e?.message || e); }
}

function currentEng6() { return (state.room && state.room.eng6) || { status: 'idle' }; }

function render() {
  const m6 = currentEng6();
  statusLabel.textContent = statusText(m6.status);
  if (state.role === 'parent') renderParent(m6); else renderChild(m6);
  updateDirectChatUI();
  updateVoiceCallUI();
  renderScratchpadFromRoom(m6.whiteboard);
}
function statusText(status) {
  return ({
    idle: '😴 Chưa có đề nào',
    assigned: '📩 Đã giao đề — chờ con làm',
    in_progress: '✍️ Con đang làm bài',
    submitted: '📥 Con đã nộp — chờ chấm',
    returned: '✅ Đã trả bài',
  })[status] || status;
}

// ============================================================
// GIAO DIỆN CHA
// ============================================================
const composePanel = $('composePanel'), waitingChildPanel = $('waitingChildPanel'), gradingPanel = $('gradingPanel'), doneParentPanel = $('doneParentPanel');

function renderParent(m6) {
  composePanel.style.display = 'none'; waitingChildPanel.style.display = 'none';
  gradingPanel.style.display = 'none'; doneParentPanel.style.display = 'none';

  if (m6.status === 'idle') {
    composePanel.style.display = 'block';
  } else if (m6.status === 'assigned' || m6.status === 'in_progress') {
    waitingChildPanel.style.display = 'block';
    $('waitingChildText').textContent = `Đề "${m6.exam?.title || ''}" đã giao lúc ${fmtTime(m6.exam?.assignedAt)}. ` +
      (m6.status === 'in_progress' ? 'Con đang làm bài...' : 'Con chưa bắt đầu làm.');
  } else if (m6.status === 'submitted') {
    if (state.lastRenderedStatus !== 'submitted') renderGradingPanel(m6);
    gradingPanel.style.display = 'block';
  } else if (m6.status === 'returned') {
    doneParentPanel.style.display = 'block';
    const r = m6.result || {};
    $('doneParentSummary').textContent = `Điểm: ${r.totalScore ?? '?'}/${r.maxScore ?? '?'} — trả lúc ${fmtTime(r.deliveredAt)}.`;
  }
  state.lastRenderedStatus = m6.status;
}
function fmtTime(ts) { if (!ts) return ''; try { return new Date(ts).toLocaleString('vi-VN'); } catch { return ''; } }

// Đưa phòng về trạng thái "chưa có đề" (idle) — dùng chung cho "Hủy đề",
// "Ra đề mới", "Sửa lại đề đang giao" và "Dùng lại đề đã trả" (soạn đề mới).
async function resetRoomToIdle() {
  await withFailover(pid => fsPatchRoom(pid, state.roomId,
    { eng6: { status: 'idle', exam: null, submission: null, grading: null, result: null, directChat: null } },
    ['eng6.status', 'eng6.exam', 'eng6.submission', 'eng6.grading', 'eng6.result', 'eng6.directChat', 'updatedAt']));
  state.directChatSeenCount = { parent: 0, child: 0 };
}
$('cancelAssignBtn').addEventListener('click', async () => {
  if (!confirm('Hủy đề đang giao và soạn lại từ đầu?')) return;
  await resetRoomToIdle();
  pollOnce();
});
$('newExamBtn').addEventListener('click', async () => {
  await resetRoomToIdle();
  state.draftQuestions = [];
  renderDraftQuestions();
  pollOnce();
});

// ---- Lưu lại / sửa lại / in đề — dùng được ở BẤT KỲ giai đoạn nào của đề
// đang có trong phòng: lúc mới giao (chưa làm), lúc con đã nộp (đang chấm),
// hay lúc đã trả bài xong — không chỉ lúc mới soạn xong như trước. ----
$('editAssignedExamBtn').addEventListener('click', async () => {
  const m6 = currentEng6();
  if (!m6.exam) return;
  if (!confirm('Sửa lại đề này sẽ HỦY đề đang giao (Con sẽ không thấy đề cũ nữa) và mở lại khung soạn đề với đúng nội dung hiện tại để bạn chỉnh sửa. Tiếp tục?')) return;
  await resetRoomToIdle();
  loadExamIntoComposer(m6.exam);
  pollOnce();
});
$('printAssignedExamBtn').addEventListener('click', () => { const m6 = currentEng6(); if (m6.exam) printExam(m6.exam); });
$('saveSubmittedTemplateBtn').addEventListener('click', () => { const m6 = currentEng6(); if (m6.exam) saveExamAsTemplate(m6.exam); });
$('printSubmittedExamBtn').addEventListener('click', () => { const m6 = currentEng6(); if (m6.exam) printExam(m6.exam); });
// Thu hồi đề để sửa lại ngay cả khi con ĐÃ NỘP BÀI (đang chờ chấm) — dùng
// chung resetRoomToIdle() + loadExamIntoComposer() như "Sửa lại đề này" ở
// khung đang chờ con làm, chỉ đổi câu cảnh báo vì lúc này sẽ mất luôn bài
// con đã nộp (chứ không chỉ hủy đề chưa ai làm).
$('editSubmittedExamBtn').addEventListener('click', async () => {
  const m6 = currentEng6();
  if (!m6.exam) return;
  if (!confirm('Con ĐÃ NỘP bài này rồi. Thu hồi để sửa lại đề sẽ HỦY LUÔN bài con đã nộp (mất hết câu trả lời của con) và mở lại khung soạn đề với đúng nội dung hiện tại để bạn chỉnh sửa. Tiếp tục?')) return;
  await resetRoomToIdle();
  loadExamIntoComposer(m6.exam);
  pollOnce();
});
$('saveDoneTemplateBtn').addEventListener('click', () => { const m6 = currentEng6(); if (m6.exam) saveExamAsTemplate(m6.exam); });
$('reuseDoneExamBtn').addEventListener('click', async () => {
  const m6 = currentEng6();
  if (!m6.exam) return;
  await resetRoomToIdle();
  loadExamIntoComposer(m6.exam);
  pollOnce();
});

// ---------- Tabs soạn đề: tự soạn tay / nhờ AI ----------
function initParentUiOnce() {
  if (state._parentUiInit) return;
  state._parentUiInit = true;

  const topicBox = $('topicChecklist');
  TOPICS.forEach((t, i) => {
    const label = document.createElement('label'); label.className = 'topic-chip';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = t; cb.id = 'topic_' + i;
    label.appendChild(cb);
    const span = document.createElement('span'); span.textContent = t;
    label.appendChild(span);
    topicBox.appendChild(label);
  });

  $('tabManualBtn').addEventListener('click', () => switchTab('manual'));
  $('tabAiBtn').addEventListener('click', () => switchTab('ai'));
  $('tabSemesterBtn').addEventListener('click', () => switchTab('semester'));
  if ($('tabDubBtn')) $('tabDubBtn').addEventListener('click', () => switchTab('dub'));
  initDubUiOnce();

  const semesterUnitBox = $('semesterUnitChecklist');
  SBT_UNITS.forEach((u, i) => {
    const label = document.createElement('label'); label.className = 'topic-chip';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = String(i); cb.id = 'semUnit_' + i;
    cb.checked = true;
    label.appendChild(cb);
    const span = document.createElement('span'); span.textContent = 'Unit ' + (i + 1) + ': ' + u.title;
    label.appendChild(span);
    semesterUnitBox.appendChild(label);
  });
  $('semesterGenerateBtn').addEventListener('click', generateSemesterExam);
  $('semesterPrintBtn').addEventListener('click', () => { if (state.semesterExam) printSemesterExam(state.semesterExam); });
  $('semesterAssignBtn').addEventListener('click', assignSemesterExam);
  $('semesterDiscardBtn').addEventListener('click', () => {
    if (!confirm('Xoá đề thi học kỳ vừa tạo và làm lại từ đầu?')) return;
    state.semesterExam = null;
    $('semesterResultBox').style.display = 'none';
  });

  $('examModeSelect').addEventListener('change', updateModeVisibility);
  updateModeVisibility();

  $('addMcqBtn').addEventListener('click', () => { state.draftQuestions.push(newMcqDraft()); renderDraftQuestions(); });
  $('addEssayBtn').addEventListener('click', () => { state.draftQuestions.push(newEssayDraft()); renderDraftQuestions(); });

  $('aiSampleFileInput').addEventListener('change', () => {
    const f = $('aiSampleFileInput').files[0] || null;
    state.aiSampleFile = f;
    $('aiSampleFileName').textContent = f ? ('📎 ' + f.name) : '';
  });

  $('aiGenerateBtn').addEventListener('click', generateExamWithAI);
  $('assignBtn').addEventListener('click', assignExam);
  $('aiGradeBtn').addEventListener('click', gradeWithAI);
  $('returnBtn').addEventListener('click', returnToChild);
  // (Nút gửi "Hỏi AI" + tab chat giờ wiring chung cho cả 2 vai trò ở initFloatingChat())

  $('draftCollapseAllBtn').addEventListener('click', () => {
    const allCollapsed = state.draftQuestions.length > 0 && state.draftQuestions.every(q => q._collapsed);
    state.draftQuestions.forEach(q => { q._collapsed = !allCollapsed; });
    renderDraftQuestions();
  });

  // ---- "Đề đã lưu" (thư viện mẫu đề, xem loadSavedExams()) + Lưu đề đang
  // soạn / In đề đang soạn ra giấy ----
  $('savedExamsToggleBtn').addEventListener('click', () => {
    const box = $('savedExamsBox');
    const show = box.style.display === 'none';
    box.style.display = show ? 'block' : 'none';
    if (show) renderSavedExamsList();
  });
  $('saveDraftTemplateBtn').addEventListener('click', () => saveExamAsTemplate({
    title: $('examTitleInput').value.trim(), mode: $('examModeSelect').value,
    durationMinutes: parseInt($('examDurationInput').value, 10) || 30, questions: state.draftQuestions,
    composeSettings: getComposeSettingsSnapshot(),
  }));
  $('printDraftBtn').addEventListener('click', () => printExam({
    title: $('examTitleInput').value.trim(),
    durationMinutes: parseInt($('examDurationInput').value, 10) || 30, questions: state.draftQuestions,
  }));

  renderSavedExamsList();
  renderDraftQuestions();
}
function switchTab(which) {
  $('tabManualBtn').classList.toggle('active', which === 'manual');
  $('tabAiBtn').classList.toggle('active', which === 'ai');
  $('tabSemesterBtn').classList.toggle('active', which === 'semester');
  if ($('tabDubBtn')) $('tabDubBtn').classList.toggle('active', which === 'dub');
  $('manualTab').style.display = which === 'manual' ? 'block' : 'none';
  $('aiTab').style.display = which === 'ai' ? 'block' : 'none';
  $('semesterTab').style.display = which === 'semester' ? 'block' : 'none';
  if ($('dubTab')) $('dubTab').style.display = which === 'dub' ? 'block' : 'none';
  // Tab "Chấm lồng tiếng" không liên quan gì tới việc soạn đề nên ẩn hết
  // phần danh sách câu hỏi nháp + nút Lưu/In/Giao đề phía dưới cho đỡ rối.
  const composeOnly = which !== 'dub';
  ['draftStatsBox', 'draftCollapseAllBtn', 'draftQuestionsBox', 'assignBtn', 'assignError'].forEach(id => {
    const el = $(id); if (!el) return;
    if (!composeOnly) { el.dataset.dubHidden = '1'; el.style.display = 'none'; }
    else if (el.dataset.dubHidden) { delete el.dataset.dubHidden; el.style.display = ''; }
  });
}
function updateModeVisibility() {
  const mode = $('examModeSelect').value;
  $('addMcqBtn').style.display = mode === 'essay' ? 'none' : 'inline-block';
  $('addEssayBtn').style.display = mode === 'mcq' ? 'none' : 'inline-block';
  const mcqCountField = $('aiMcqCountInput'); const essayCountField = $('aiEssayCountInput');
  mcqCountField.parentElement.style.display = mode === 'essay' ? 'none' : 'block';
  essayCountField.parentElement.style.display = mode === 'mcq' ? 'none' : 'block';
  if (mode === 'essay') mcqCountField.value = 0;
  if (mode === 'mcq') essayCountField.value = 0;
}
// "source" đánh dấu câu hỏi do Cha tự gõ tay ('manual') hay do AI soạn/tạo lại
// ('ai') — dùng để thống kê xem AI tạo bao nhiêu câu hình học so với Cha tự soạn.
function newMcqDraft() { return { id: uid(), type: 'mcq', prompt: '', options: ['', '', '', ''], correctIndex: 0, points: 1, explanation: '', listeningScript: '', source: 'manual' }; }
function newEssayDraft() { return { id: uid(), type: 'essay', prompt: '', suggestedAnswer: '', points: 2, listeningScript: '', source: 'manual' }; }

// ---------- Thư viện "Đề đã lưu" — lưu trên MÁY CHA (localStorage, không
// đồng bộ qua phòng) để dùng lại/chỉnh sửa bất cứ lúc nào, không phụ thuộc
// đề đang giao trong phòng hiện tại đang ở trạng thái nào (soạn dở / đã
// giao / con đã nộp). Mỗi mẫu đặt tên tự động dạng
// "YYYY-MM-DD_STT_<tiêu đề>" (ngày + số thứ tự trong ngày) để xếp theo tên
// là ra đúng thứ tự ngày tháng, dễ nhìn, dễ tìm lại. ----------
function loadSavedExams() {
  try { const a = JSON.parse(localStorage.getItem(SAVED_EXAMS_KEY) || '[]'); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function writeSavedExams(list) {
  try { localStorage.setItem(SAVED_EXAMS_KEY, JSON.stringify(list)); } catch { }
}
function todayDateStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function nextSavedExamName(title) {
  const dateStr = todayDateStr();
  const list = loadSavedExams();
  const countToday = list.filter(r => r.name.startsWith(dateStr + '_')).length;
  const seq = String(countToday + 1).padStart(2, '0');
  return dateStr + '_' + seq + '_' + (title || 'Không tên');
}
// Lưu 1 bộ câu hỏi (đề đang soạn dở, đề đã giao, hay đề đã chấm xong) thành
// 1 mẫu MỚI trong thư viện — không đụng gì tới đề đang chạy trong phòng.
function saveExamAsTemplate({ title, mode, durationMinutes, questions, composeSettings }) {
  if (!questions || !questions.length) { alert('Đề đang trống, chưa có câu hỏi nào để lưu.'); return; }
  const list = loadSavedExams();
  list.push({
    id: uid(), name: nextSavedExamName(title), savedAt: Date.now(),
    title: title || '', mode: mode || 'both', durationMinutes: durationMinutes || 30,
    // Lưu luôn "composeSettings" (tab đang mở, chủ đề/kiểu hình đã tích, số
    // câu, mức độ khó, yêu cầu thêm) để lúc "Dùng để sửa" mở lại ĐÚNG khung
    // đã dùng để tạo mẫu này — không có thì thôi (mẫu cũ trước bản cập nhật
    // này, hoặc soạn hoàn toàn tay).
    composeSettings: composeSettings || null,
    // Bỏ các cờ chỉ dùng cho hiển thị lúc soạn (vd "_collapsed") — thư viện
    // chỉ cần giữ đúng dữ liệu câu hỏi thật.
    questions: questions.map(q => ({
      id: q.id, type: q.type, prompt: q.prompt, points: q.points, source: q.source || 'manual',
      listeningScript: q.listeningScript || '',
      ...(q.type === 'mcq' ? { options: q.options, correctIndex: q.correctIndex, explanation: q.explanation || '' } : { suggestedAnswer: q.suggestedAnswer }),
    })),
  });
  writeSavedExams(list);
  renderSavedExamsList();
  alert('✅ Đã lưu đề vào thư viện "📂 Đề đã lưu".');
}
// Nạp 1 mẫu đã lưu (hoặc đề đang có trong phòng) vào khung soạn để sửa —
// dùng chung cho cả "Dùng để sửa" (từ thư viện) lẫn "Sửa lại đề này" (từ đề
// đang giao) / "Dùng lại đề này" (từ đề đã trả). Giữ nguyên toàn bộ câu hỏi
// đã có (để không mất nội dung đã tạo), đồng thời phục hồi lại ĐÚNG khung
// (tab Tự soạn tay / Nhờ AI soạn đề, chủ đề, số câu, mức độ khó...) như lúc
// tạo ra đề này — nếu đề có lưu "composeSettings"; đề cũ không có thì mở về
// tab "Tự soạn tay" như hành vi cũ.
function loadExamIntoComposer({ title, mode, durationMinutes, questions, composeSettings }) {
  $('examTitleInput').value = title || '';
  $('examModeSelect').value = mode || 'both';
  $('examDurationInput').value = durationMinutes || 30;
  updateModeVisibility();
  state.draftQuestions = (questions || []).map(q => ({ ...q, id: q.id || uid(), _collapsed: false }));
  applyComposeSettingsSnapshot(composeSettings);
  renderDraftQuestions();
}
function renderSavedExamsList() {
  const list = loadSavedExams().slice().sort((a, b) => b.name.localeCompare(a.name)); // tên có ngày+STT ở đầu -> sắp theo tên là ra đúng thứ tự mới nhất lên trên
  $('savedExamsCount').textContent = String(list.length);
  const box = $('savedExamsBox');
  box.innerHTML = '';
  if (!list.length) {
    const hint = document.createElement('div'); hint.className = 'hint';
    hint.textContent = 'Chưa lưu đề nào. Soạn xong 1 đề rồi bấm "💾 Lưu đề này" để dùng lại về sau.';
    box.appendChild(hint);
    return;
  }
  list.forEach(rec => {
    const row = document.createElement('div'); row.className = 'saved-exam-row';
    const info = document.createElement('div'); info.className = 'saved-exam-info';
    info.innerHTML = '<div class="saved-exam-name">' + escapeHtml(rec.name) + '</div>' +
      '<div class="hint">' + (rec.questions?.length || 0) + ' câu · ' + modeLabel(rec.mode) + ' · ' + (rec.durationMinutes || '?') + ' phút</div>';
    const useBtn = document.createElement('button'); useBtn.type = 'button'; useBtn.className = 'secondary small'; useBtn.textContent = '✏️ Dùng để sửa';
    useBtn.addEventListener('click', () => { loadExamIntoComposer(rec); $('savedExamsBox').style.display = 'none'; });
    const delBtn = document.createElement('button'); delBtn.type = 'button'; delBtn.className = 'secondary small'; delBtn.textContent = '🗑';
    delBtn.title = 'Xóa mẫu đề này khỏi thư viện';
    delBtn.addEventListener('click', () => {
      if (!confirm('Xóa mẫu đề "' + rec.name + '" khỏi thư viện? Không thể hoàn tác.')) return;
      writeSavedExams(loadSavedExams().filter(r => r.id !== rec.id));
      renderSavedExamsList();
    });
    row.appendChild(info); row.appendChild(useBtn); row.appendChild(delBtn);
    box.appendChild(row);
  });
}

// ---------- Vẽ danh sách câu hỏi nháp (DOM thuần, tránh lỗi escape HTML) ----------
function renderDraftQuestions() {
  const box = $('draftQuestionsBox');
  box.innerHTML = '';
  if (!state.draftQuestions.length) {
    const hint = document.createElement('div'); hint.className = 'hint';
    hint.textContent = 'Chưa có câu hỏi nào. Thêm câu tự soạn, hoặc dùng tab "🤖 Nhờ AI soạn đề" bên trên.';
    box.appendChild(hint);
    updateDraftStats();
    updateCollapseAllBtnLabel();
    return;
  }
  state.draftQuestions.forEach((q, idx) => box.appendChild(buildQuestionCard(q, idx)));
  updateDraftStats();
  updateCollapseAllBtnLabel();
}
// Nút thu gọn/mở rộng NHANH toàn bộ danh sách câu hỏi cùng lúc (thay vì bấm
// từng câu) — bấm 1 lần: nếu đang có câu nào mở thì thu gọn HẾT; bấm lại lần
// nữa (khi đã thu gọn hết) thì mở rộng lại HẾT. Nhãn nút tự đổi theo trạng thái
// hiện tại, giống cơ chế nút "➖ Thu gọn" ở plugin 🧩 AI Song Creator.
function updateCollapseAllBtnLabel() {
  const btn = $('draftCollapseAllBtn');
  if (!btn) return;
  if (!state.draftQuestions.length) { btn.style.display = 'none'; return; }
  btn.style.display = 'inline-block';
  const allCollapsed = state.draftQuestions.every(q => q._collapsed);
  btn.textContent = allCollapsed ? '➕ Mở rộng tất cả câu' : '➖ Thu gọn tất cả câu';
}
// Đếm số câu do AI soạn / Cha tự soạn tay trong đề đang soạn — hiển thị ngay
// phía trên danh sách câu hỏi để Cha biết ai đang góp bao nhiêu câu vào đề.
function updateDraftStats() {
  const box = $('draftStatsBox');
  if (!box) return;
  let aiCount = 0, manualCount = 0;
  state.draftQuestions.forEach(q => { if (q.source === 'ai') aiCount++; else manualCount++; });
  const total = aiCount + manualCount;
  if (!total) { box.style.display = 'none'; box.textContent = ''; return; }
  box.style.display = 'block';
  box.textContent = `📊 Tổng số câu trong đề: ${total} câu — 🤖 AI soạn: ${aiCount} câu · ✍️ Cha tự soạn tay: ${manualCount} câu.`;
}
function buildQuestionCard(q, idx) {
  const card = document.createElement('div'); card.className = 'q-card';
  if (q._collapsed) card.classList.add('is-collapsed');
  const head = document.createElement('div'); head.className = 'q-card-head';
  const headLeft = document.createElement('div'); headLeft.className = 'q-card-head-left';
  // ---- Nút thu gọn / mở rộng riêng từng câu — bấm mũi tên để ẩn/hiện toàn bộ
  // phần soạn nội dung bên dưới, chỉ chừa lại dòng đầu + 1 dòng tóm tắt ngắn,
  // giống hệt cơ chế "step-block" ở plugin 🧩 AI Song Creator (mũi tên xoay,
  // class "is-collapsed" ẩn phần thân) để đồng bộ trải nghiệm giữa các phần
  // mềm trong Hub. ----
  const collapseBtn = document.createElement('button'); collapseBtn.type = 'button'; collapseBtn.className = 'q-card-collapse-btn';
  collapseBtn.title = 'Thu gọn / mở rộng câu này'; collapseBtn.textContent = '▾';
  collapseBtn.addEventListener('click', () => {
    q._collapsed = !q._collapsed;
    card.classList.toggle('is-collapsed', q._collapsed);
    updateCollapseAllBtnLabel();
  });
  const typeTag = document.createElement('span'); typeTag.className = 'q-type';
  typeTag.textContent = (idx + 1) + '. ' + (q.type === 'mcq' ? 'Trắc nghiệm' : 'Tự luận');
  headLeft.appendChild(collapseBtn); headLeft.appendChild(typeTag);
  const btnGroup = document.createElement('div'); btnGroup.className = 'q-head-btns';
  const regenBtn = document.createElement('button'); regenBtn.type = 'button'; regenBtn.className = 'q-regen-btn';
  regenBtn.textContent = '🔄 Tạo lại câu này (AI)';
  regenBtn.addEventListener('click', () => regenerateSingleQuestion(q, regenBtn));
  const delBtn = document.createElement('button'); delBtn.type = 'button'; delBtn.className = 'q-del-btn';
  delBtn.textContent = '🗑️ Xóa câu này';
  delBtn.addEventListener('click', () => { state.draftQuestions = state.draftQuestions.filter(x => x.id !== q.id); renderDraftQuestions(); });
  btnGroup.appendChild(regenBtn); btnGroup.appendChild(delBtn);
  head.appendChild(headLeft); head.appendChild(btnGroup);
  card.appendChild(head);

  // ---- Dòng tóm tắt ngắn — chỉ hiện khi câu đang bị thu gọn, để vẫn biết
  // sơ qua nội dung câu là gì mà không cần mở ra. ----
  const summaryLine = document.createElement('div'); summaryLine.className = 'q-card-summary';
  card.appendChild(summaryLine);

  // ---- Toàn bộ phần soạn nội dung (từ đây trở xuống) gom vào 1 khối riêng
  // để có thể ẩn/hiện gọn khi bấm nút thu gọn phía trên. ----
  const bodyWrap = document.createElement('div'); bodyWrap.className = 'q-card-body';
  card.appendChild(bodyWrap);

  const regenStatus = document.createElement('div'); regenStatus.className = 'hint'; regenStatus.style.display = 'none';
  bodyWrap.appendChild(regenStatus);

  const promptTa = document.createElement('textarea'); promptTa.rows = 2; promptTa.placeholder = 'Nội dung câu hỏi (tiếng Anh)...';
  promptTa.value = q.prompt;
  promptTa.addEventListener('input', () => { q.prompt = promptTa.value; refreshPreview(); });
  bodyWrap.appendChild(promptTa);

  // ---- Kịch bản bài NGHE (tùy chọn) — nếu có nội dung, Con sẽ thấy 1 nút
  // "🔊 Nghe" thay vì đọc chữ trực tiếp (đúng bản chất kỹ năng nghe). Cha có
  // thể tự gõ tay ở đây, hoặc để trống nếu câu này không phải dạng nghe hiểu.
  const listenLabel = document.createElement('div'); listenLabel.className = 'hint'; listenLabel.style.marginTop = '6px';
  listenLabel.textContent = '🎧 Kịch bản bài nghe (để trống nếu câu này KHÔNG phải dạng Nghe hiểu):';
  bodyWrap.appendChild(listenLabel);
  const listenRow = document.createElement('div'); listenRow.className = 'q-opt-row';
  const listenTa = document.createElement('textarea'); listenTa.rows = 3; listenTa.style.flex = '1';
  listenTa.placeholder = 'VD: A: Hi Anna, what are you doing this weekend? B: I\'m going to visit my grandparents...';
  listenTa.value = q.listeningScript || '';
  listenTa.addEventListener('input', () => { q.listeningScript = listenTa.value; refreshPreview(); });
  const listenTestBtn = document.createElement('button'); listenTestBtn.type = 'button'; listenTestBtn.className = 'secondary small';
  listenTestBtn.textContent = '🔊 Nghe thử'; listenTestBtn.style.alignSelf = 'flex-start';
  listenTestBtn.addEventListener('click', () => speakEnglish(q.listeningScript || ''));
  listenRow.appendChild(listenTa); listenRow.appendChild(listenTestBtn);
  bodyWrap.appendChild(listenRow);

  if (q.type === 'mcq') {
    q.options.forEach((opt, oi) => {
      const row = document.createElement('div'); row.className = 'q-opt-row';
      const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'correct_' + q.id;
      radio.checked = q.correctIndex === oi;
      radio.addEventListener('change', () => { q.correctIndex = oi; refreshPreview(); });
      const optIn = document.createElement('input'); optIn.type = 'text'; optIn.placeholder = 'Phương án ' + String.fromCharCode(65 + oi);
      optIn.value = opt; optIn.addEventListener('input', () => { q.options[oi] = optIn.value; refreshPreview(); });
      row.appendChild(radio); row.appendChild(optIn);
      bodyWrap.appendChild(row);
    });
    const hint = document.createElement('div'); hint.className = 'hint'; hint.textContent = 'Tích chọn ô tròn ở phương án đúng.';
    bodyWrap.appendChild(hint);
  } else {
    const sugg = document.createElement('textarea'); sugg.rows = 5; sugg.className = 'q-suggested'; sugg.placeholder = 'Gợi ý đáp án / giải thích (để đối chiếu khi chấm)...';
    sugg.value = q.suggestedAnswer || '';
    sugg.addEventListener('input', () => { q.suggestedAnswer = sugg.value; });
    bodyWrap.appendChild(sugg);
  }

  const ptsRow = document.createElement('div'); ptsRow.className = 'q-opt-row';
  const ptsLabel = document.createElement('label'); ptsLabel.textContent = 'Điểm câu này:'; ptsLabel.style.fontWeight = '400';
  const ptsIn = document.createElement('input'); ptsIn.type = 'text'; ptsIn.style.maxWidth = '70px'; ptsIn.value = q.points;
  ptsIn.addEventListener('input', () => q.points = parseFloat(ptsIn.value) || 0);
  ptsRow.appendChild(ptsLabel); ptsRow.appendChild(ptsIn);
  bodyWrap.appendChild(ptsRow);

  // ---- Khung xem trước: hiển thị đúng dạng Con sẽ thấy khi làm bài — để Cha
  // kiểm tra trước khi giao đề. ----
  const previewBox = document.createElement('div'); previewBox.className = 'q-preview-box';
  const previewLabel = document.createElement('div'); previewLabel.className = 'q-preview-label'; previewLabel.textContent = '👁 Xem trước (Con sẽ thấy):';
  const previewContent = document.createElement('div'); previewContent.className = 'q-preview-content';
  previewBox.appendChild(previewLabel); previewBox.appendChild(previewContent);

  function refreshPreview() {
    updateDraftStats();
    const shortText = (q.prompt || '').replace(/\s+/g, ' ').trim();
    summaryLine.textContent = (idx + 1) + '. ' + (shortText ? (shortText.length > 70 ? shortText.slice(0, 70) + '…' : shortText) : '(chưa có nội dung)') + (q.listeningScript ? ' 🎧' : '');
    let html = (q.listeningScript ? listeningBoxHtml(q.listeningScript, 'Nghe đoạn hội thoại', q.id) : '') +
      '<div class="q-run-prompt">' + mathHtml((idx + 1) + '. ' + (q.prompt || '(chưa có nội dung)')) + '</div>';
    if (q.type === 'mcq') {
      html += (q.options || []).map((opt, oi) =>
        '<div class="q-run-opt-preview">' + mathHtml(String.fromCharCode(65 + oi) + '. ' + opt) + (oi === q.correctIndex ? ' ✅' : '') + '</div>').join('');
    }
    previewContent.innerHTML = html;
  }

  bodyWrap.appendChild(previewBox);
  refreshPreview();

  return card;
}

// ---------- Nhờ AI soạn đề ----------
async function generateExamWithAI() {
  const btn = $('aiGenerateBtn'), statusEl = $('aiGenStatus');
  const topics = Array.from(document.querySelectorAll('#topicChecklist input:checked')).map(c => c.value);
  const mcqCount = parseInt($('aiMcqCountInput').value, 10) || 0;
  const essayCount = parseInt($('aiEssayCountInput').value, 10) || 0;
  const extra = $('aiExtraPromptInput').value.trim();
  const followSampleExactly = !!($('aiFollowSampleExactly') && $('aiFollowSampleExactly').checked && state.aiSampleFile);
  if (!followSampleExactly) {
    if (!topics.length) { statusEl.textContent = '⚠️ Hãy chọn ít nhất 1 nội dung/chủ đề.'; return; }
    if (mcqCount + essayCount <= 0) { statusEl.textContent = '⚠️ Số câu trắc nghiệm + tự luận phải lớn hơn 0.'; return; }
  } else if (!state.aiSampleFile) {
    statusEl.textContent = '⚠️ Hãy đính kèm file mẫu trước khi dùng chế độ "lấy y chang file mẫu".'; return;
  }

  btn.disabled = true; statusEl.textContent = '⏳ Đang nhờ AI soạn đề, vui lòng chờ...';
  try {
    const promptText = followSampleExactly
      ? (
        'Bạn là giáo viên Tiếng Anh lớp 6 tại Việt Nam (chương trình phổ thông hiện hành). ' +
        'Có 1 tài liệu/ảnh ĐỀ MẪU đính kèm bên dưới. Hãy soạn 1 đề kiểm tra Tiếng Anh lớp 6 MỚI, bám sát Y CHANG đề mẫu đó về: ' +
        'cấu trúc/bố cục, dạng bài (điền từ, chọn đáp án, đọc hiểu, viết lại câu...), thứ tự các phần, số lượng câu trắc nghiệm ' +
        'và số lượng câu tự luận, chủ đề từ vựng/ngữ pháp, mức độ khó. Chỉ thay đổi nội dung/câu chữ cụ thể để tạo bài mới, ' +
        'TUYỆT ĐỐI KHÔNG chép nguyên văn câu chữ của đề mẫu. Không cần thêm điều kiện nào khác ngoài việc bám sát đề mẫu.\n' +
        'CHỈ trả lời bằng JSON hợp lệ, không kèm giải thích, không dùng dấu ```.\n\n' +
        SOLUTION_STYLE_GUIDE + '\n' +
        GRAMMAR_CHECK_GUIDE + '\n' +
        'Với câu trắc nghiệm, thêm trường "explanation" (tiếng Việt, giải thích ngắn gọn vì sao đáp án đó đúng) — ' +
        'phần này Cha sẽ dùng để chấm/giải thích lại cho Con.\n' +
        'Nếu câu hỏi dựa trên 1 đoạn đọc hiểu (giống đề mẫu), hãy đưa đoạn văn tiếng Anh vào ngay đầu ' +
        '"prompt" của câu đó (xuống dòng bằng \\n trước khi tới câu hỏi), để mỗi câu tự chứa đủ ngữ cảnh.\n' +
        LISTENING_GUIDE + '\n' +
        '\nTrả về đúng cấu trúc JSON sau (không thêm trường nào khác):\n' +
        '{"title":"tên đề ngắn gọn","questions":[' +
        '{"type":"mcq","prompt":"...","options":["...","...","...","..."],"correctIndex":0,"points":1,"explanation":"...","listeningScript":""},' +
        '{"type":"essay","prompt":"...","suggestedAnswer":"đáp án gợi ý + giải thích để phụ huynh đối chiếu khi chấm","points":2,"listeningScript":""}' +
        ']}'
      )
      : (
        'Bạn là giáo viên Tiếng Anh lớp 6 tại Việt Nam (chương trình phổ thông hiện hành). ' +
        'Hãy soạn 1 đề kiểm tra Tiếng Anh lớp 6 theo yêu cầu sau và CHỈ trả lời bằng JSON hợp lệ, ' +
        'không kèm giải thích, không dùng dấu ```.\n\n' +
        'Nội dung/chủ đề cần ra đề: ' + topics.join(', ') + '\n' +
        'Số câu trắc nghiệm cần tạo: ' + mcqCount + ' (mỗi câu có đúng 4 phương án A/B/C/D, chỉ 1 đáp án đúng — ' +
        'có thể là câu hỏi ngữ pháp/từ vựng dạng điền chỗ trống, chọn từ đúng, hoặc câu hỏi dựa trên 1 đoạn đọc hiểu ngắn)\n' +
        'Số câu tự luận cần tạo: ' + essayCount + ' (có thể là viết lại câu, hoàn thành câu, trả lời câu hỏi về đoạn đọc, ' +
        'hoặc viết 2-4 câu/1 đoạn ngắn theo chủ đề)\n' +
        'Mức độ khó/phức tạp yêu cầu: ' + getDifficultyPromptText() + '\n' +
        'Yêu cầu thêm từ phụ huynh: ' + (extra || 'Không có, ra đề vừa sức học sinh lớp 6.') + '\n' +
        (state.aiSampleFile ? 'Có đính kèm 1 tài liệu/ảnh mẫu bên dưới — hãy tham khảo dạng bài, cách trình bày và mức độ khó của tài liệu đó để ra đề TƯƠNG TỰ, không chép nguyên văn.\n' : '') +
        SOLUTION_STYLE_GUIDE + '\n' +
        GRAMMAR_CHECK_GUIDE + '\n' +
        'Với câu trắc nghiệm, thêm trường "explanation" (tiếng Việt, giải thích ngắn gọn vì sao đáp án đó đúng) — ' +
        'phần này Cha sẽ dùng để chấm/giải thích lại cho Con.\n' +
        'Nếu câu hỏi dựa trên 1 đoạn đọc hiểu, hãy đưa đoạn văn tiếng Anh (3-6 câu, phù hợp lớp 6) vào ngay đầu ' +
        '"prompt" của câu đó (xuống dòng bằng \\n trước khi tới câu hỏi), để mỗi câu tự chứa đủ ngữ cảnh.\n' +
        LISTENING_GUIDE + '\n' +
        '\nTrả về đúng cấu trúc JSON sau (không thêm trường nào khác):\n' +
        '{"title":"tên đề ngắn gọn","questions":[' +
        '{"type":"mcq","prompt":"...","options":["...","...","...","..."],"correctIndex":0,"points":1,"explanation":"...","listeningScript":""},' +
        '{"type":"essay","prompt":"...","suggestedAnswer":"đáp án gợi ý + giải thích để phụ huynh đối chiếu khi chấm","points":2,"listeningScript":""}' +
        ']}'
      );
    const parts = [{ text: promptText }];
    if (state.aiSampleFile) {
      const f = state.aiSampleFile;
      if (/^text\//.test(f.type) || /\.txt$/i.test(f.name)) {
        const txt = await fileToText(f);
        parts.push({ text: 'Nội dung tài liệu tham khảo:\n' + txt.slice(0, 8000) });
      } else {
        const b64 = await fileToBase64(f);
        parts.push({ inlineData: { mimeType: f.type || 'application/octet-stream', data: b64 } });
      }
    }
    const raw = await callGemini(parts, { expectJson: true });
    const data = parseJsonLoose(raw);
    if (!data || !Array.isArray(data.questions) || !data.questions.length) throw Error('AI trả về dữ liệu không đúng định dạng mong đợi.');

    if (!$('examTitleInput').value.trim() && data.title) $('examTitleInput').value = data.title;
    data.questions.forEach(q => {
      if (q.type === 'mcq') {
        const opts = Array.isArray(q.options) ? q.options.slice(0, 4) : [];
        while (opts.length < 4) opts.push('');
        state.draftQuestions.push({ id: uid(), type: 'mcq', prompt: String(q.prompt || ''), options: opts, correctIndex: Number.isInteger(q.correctIndex) ? q.correctIndex : 0, points: Number(q.points) || 1, explanation: String(q.explanation || ''), listeningScript: String(q.listeningScript || ''), source: 'ai' });
      } else {
        state.draftQuestions.push({ id: uid(), type: 'essay', prompt: String(q.prompt || ''), suggestedAnswer: String(q.suggestedAnswer || ''), points: Number(q.points) || 2, listeningScript: String(q.listeningScript || ''), source: 'ai' });
      }
    });
    renderDraftQuestions();
    statusEl.textContent = `✅ AI đã soạn ${data.questions.length} câu — kiểm tra lại bên dưới trước khi giao đề (có thể sửa mọi câu).`;
  } catch (e) {
    statusEl.textContent = '❌ Lỗi: ' + (e?.message || e);
  } finally {
    btn.disabled = false;
  }
}

// ---------- Tạo lại 1 câu bằng AI (giữ nguyên vị trí/điểm, chỉ đổi nội dung) ----------
// ============================================================
// 🎓 ĐỀ THI HỌC KỲ — ra đề bám ĐÚNG FORM 1 đề thi cuối kỳ thật (mẫu
// Global Success): A.Listening/B.Phonetics/C.Language Focus/D.Reading/
// E.Writing/F.Speaking + đáp án, ra ĐÚNG 1 đề duy nhất (không tách chẵn/lẻ),
// nội dung giới hạn trong đúng phạm vi các Unit (SBT_UNITS) Cha chọn.
// Kết quả lưu ở state.semesterExam, KHÔNG đi qua state.draftQuestions cho
// tới khi Cha bấm giao đề (xem assignSemesterExam) — dùng để xuất PDF (xem
// printSemesterExam) hoặc giao cho Con làm ngay trong app.
// ============================================================
const SEMESTER_EXAM_SCHEMA_EXAMPLE =
  '{"titleLine":"ĐỀ THI CUỐI HỌC KỲ I – MÔN TIẾNG ANH 6","durationMinutes":45,' +
  '"sections":[' +
    '{"code":"A","name":"LISTENING","parts":[' +
      '{"label":"Question 1","instruction":"Listen to the conversation and tick (v) T (True) or F (False).","points":0.8,' +
        '"listeningScript":"đoạn hội thoại tiếng Anh 4-8 câu...",' +
        '"items":[{"num":1,"text":"câu phát biểu tiếng Anh...","answer":"T"}]},' +
      '{"label":"Question 2","instruction":"Listen and fill each gap with ONE word/number.","points":1,' +
        '"listeningScript":"đoạn hội thoại/độc thoại khác...",' +
        '"items":[{"num":5,"text":"câu có chỗ trống ..........","answer":"từ đáp án"}]}' +
    ']},' +
    '{"code":"B","name":"PHONETICS","parts":[' +
      '{"label":"I","instruction":"Choose the word whose underlined part is pronounced differently from the others.","points":0.3,' +
        '"items":[{"num":10,"options":["word1","word2","word3","word4"],"answer":"B"}]},' +
      '{"label":"II","instruction":"Find the word that has different stress pattern in each line.","points":0.2,' +
        '"items":[{"num":13,"options":["word1","word2","word3","word4"],"answer":"A"}]}' +
    ']},' +
    '{"code":"C","name":"LANGUAGE FOCUS","parts":[' +
      '{"label":"I","instruction":"Choose A, B, C or D for each gap in the following sentence.","points":1.2,' +
        '"items":[{"num":15,"text":"câu có chỗ trống ………………","options":["A option","B option","C option","D option"],"answer":"A"}]},' +
      '{"label":"II","instruction":"Word form.","points":0.3,' +
        '"items":[{"num":21,"text":"câu có chỗ trống ....................... (BASEWORD)","answer":"từ đúng dạng"}]},' +
      '{"label":"III","instruction":"Find the mistake (A, B, C or D).","points":0.2,' +
        '"items":[{"num":24,"text":"câu có 4 phần gạch chân đánh dấu A/B/C/D","answer":"B — sửa lại: ..."}]}' +
    ']},' +
    '{"code":"D","name":"READING","parts":[' +
      '{"label":"Question 1","instruction":"Choose the correct word to fill each blank in the following passage.","points":1,' +
        '"passage":"đoạn văn có chỗ trống (26) .......... (option1/option2/option3/option4) ...",' +
        '"items":[{"num":26,"options":["option1","option2","option3","option4"],"answer":"option2"}]},' +
      '{"label":"Question 2","instruction":"Read the passage carefully, and then answer the questions.","points":1,' +
        '"passage":"đoạn văn đọc hiểu 6-10 câu...",' +
        '"items":[{"num":31,"text":"câu hỏi tiếng Anh?","answer":"câu trả lời đầy đủ"}]}' +
    ']},' +
    '{"code":"E","name":"WRITING","parts":[' +
      '{"label":"I","instruction":"Rearrange the words to make meaningful sentences.","points":1,' +
        '"items":[{"num":36,"text":"từ1/ từ2/ từ3/.../","answer":"câu hoàn chỉnh."}]},' +
      '{"label":"II","instruction":"Rewrite the sentences, keeping the same meaning.","points":1,' +
        '"items":[{"num":41,"text":"câu gốc. (gợi ý: từ/cấu trúc cần dùng)","answer":"câu viết lại hoàn chỉnh."}]}' +
    ']},' +
    '{"code":"F","name":"SPEAKING","points":2,"note":"Kiểm tra nói riêng (không có nội dung viết trong đề)."}' +
  ']}';

async function generateSemesterExam() {
  const btn = $('semesterGenerateBtn'), statusEl = $('semesterGenStatus');
  const unitIdxs = Array.from(document.querySelectorAll('#semesterUnitChecklist input:checked')).map(c => parseInt(c.value, 10));
  if (!unitIdxs.length) { statusEl.textContent = '⚠️ Hãy chọn ít nhất 1 Unit.'; return; }
  const extra = ($('semesterExtraPromptInput').value || '').trim();
  const diffKey = ($('semesterDifficultySelect') && $('semesterDifficultySelect').value) || 'medium';
  const diffText = DIFFICULTY_PROMPTS[diffKey] || DIFFICULTY_PROMPTS.medium;
  const unitsText = unitIdxs.map(i => {
    const u = SBT_UNITS[i]; if (!u) return '';
    return 'Unit ' + (i + 1) + ' – ' + u.title + ':\n  + Từ vựng trọng tâm: ' + u.vocab + '\n  + Ngữ pháp trọng tâm: ' + u.grammar;
  }).filter(Boolean).join('\n');

  btn.disabled = true; statusEl.textContent = '⏳ Đang nhờ AI soạn đề thi học kỳ, có thể mất khoảng 20-40 giây...';
  try {
    const promptText =
      'Bạn là giáo viên Tiếng Anh lớp 6 tại Việt Nam (chương trình Global Success), đang ra ĐỀ THI CUỐI HỌC KỲ chính thức. ' +
      'CHỈ trả lời bằng JSON hợp lệ, không kèm giải thích, không dùng dấu ```.\n\n' +
      'BẮT BUỘC bám sát ĐÚNG CẤU TRÚC 1 đề thi học kỳ thật gồm các phần theo đúng thứ tự A→F sau (mỗi phần có ' +
      'số điểm CỐ ĐỊNH như dưới, tổng cộng đúng 10 điểm):\n' +
      'A. LISTENING (1.8đ): Question 1 - nghe 1 đoạn hội thoại ngắn rồi đánh dấu T/F cho 4 câu phát biểu (0.8đ); ' +
      'Question 2 - nghe 1 đoạn khác rồi điền 1 từ/số vào mỗi chỗ trống, 5 chỗ trống (1đ). ' +
      'Với mỗi Question, viết đoạn hội thoại/độc thoại tiếng Anh cần nghe vào trường "listeningScript" của part đó ' +
      '(4-8 câu, phù hợp lớp 6) — đây là đoạn học sinh sẽ NGHE (giáo viên đọc to hoặc mở file ghi âm), KHÔNG in ra ' +
      'thành đề cho học sinh đọc.\n' +
      'B. PHONETICS (0.5đ): I - chọn từ có phần gạch chân phát âm khác 3 từ còn lại, 3 câu (0.3đ); ' +
      'II - chọn từ có trọng âm khác 3 từ còn lại, 2 câu (0.2đ).\n' +
      'C. LANGUAGE FOCUS (1.7đ): I - chọn A/B/C/D điền vào chỗ trống, 6 câu (1.2đ); II - Word form (cho 1 từ gốc ' +
      'IN HOA, biến đổi đúng dạng để điền vào câu), 3 câu (0.3đ); III - tìm lỗi sai trong 4 phần gạch chân A/B/C/D ' +
      'của câu, 2 câu, ghi rõ đáp án là phần sai + sửa lại đúng (0.2đ).\n' +
      'D. READING (2đ): Question 1 - đoạn văn cloze có 5 chỗ trống, mỗi chỗ cho sẵn 4 lựa chọn trong ngoặc để chọn ' +
      '1 đáp án đúng (1đ); Question 2 - đoạn văn đọc hiểu (6-10 câu) rồi trả lời 5 câu hỏi Wh- về đoạn văn, câu trả ' +
      'lời đầy đủ (1đ).\n' +
      'E. WRITING (2đ): I - sắp xếp các từ cho sẵn thành câu có nghĩa, 5 câu (1đ); II - viết lại câu theo yêu cầu ' +
      '(giữ nguyên nghĩa, dùng cấu trúc/từ gợi ý như so sánh, câu điều kiện, câu bị động tuỳ mức độ khó, hoặc nối câu ' +
      'bằng liên từ), 5 câu (1đ).\n' +
      'F. SPEAKING (2đ): không có nội dung viết, chỉ ghi chú "Kiểm tra nói riêng".\n' +
      'Đánh số CÂU liên tục xuyên suốt cả đề (không đánh số lại từ 1 ở mỗi phần) — bắt đầu Listening Q1 từ câu 1, ' +
      'Listening Q2 từ câu 5, Phonetics I từ câu 10, Phonetics II từ câu 13, Language Focus I từ câu 15, II từ câu ' +
      '21, III từ câu 24, Reading Q1 từ câu 26, Q2 từ câu 31, Writing I từ câu 36, II từ câu 41 — giống hệt số thứ ' +
      'tự này. Chỉ ra ĐÚNG 1 đề duy nhất (không tách mã đề chẵn/lẻ).\n\n' +
      'Phạm vi từ vựng/ngữ pháp CHỈ được lấy trong đúng các Unit sau (thuộc Sách Bài Tập Tiếng Anh 6 – Global ' +
      'Success), KHÔNG dùng từ vựng/ngữ pháp ngoài phạm vi này:\n' + unitsText + '\n\n' +
      'Mức độ khó/phức tạp yêu cầu: ' + diffText + '\n' +
      'Yêu cầu thêm từ phụ huynh: ' + (extra || 'Không có.') + '\n' +
      GRAMMAR_CHECK_GUIDE + '\n\n' +
      'Trả về đúng cấu trúc JSON sau (không thêm trường nào khác, giữ nguyên tên các trường "num"/"text"/"options"/' +
      '"answer"/"passage"/"listeningScript"/"instruction"/"points"/"label"/"code"/"name"/"note"):\n' + SEMESTER_EXAM_SCHEMA_EXAMPLE;

    const raw = await callGemini([{ text: promptText }], { expectJson: true });
    const data = parseJsonLoose(raw);
    if (!data || !Array.isArray(data.sections)) {
      throw Error('AI trả về dữ liệu không đúng định dạng mong đợi. Hãy thử bấm tạo lại.');
    }
    state.semesterExam = data;
    $('semesterResultTitle').textContent = data.titleLine || 'Đề Thi Học Kỳ';
    $('semesterResultBox').style.display = 'block';
    statusEl.textContent = '✅ Đã tạo xong đề. Bấm "📄 Xuất PDF" để in, hoặc "📲 Giao Đề cho Con" (có xem trước trước khi giao thật).';
  } catch (e) {
    statusEl.textContent = '❌ Lỗi: ' + (e?.message || e);
  } finally {
    btn.disabled = false;
  }
}

// In / xuất PDF cho đề thi học kỳ — mở tab mới, layout đề rồi tới trang
// Đáp án, theo đúng bố cục đề thi giấy thật (có chỗ ghi trường/lớp/tên/điểm
// ở đầu đề). Dùng lại đúng cơ chế window.open + addEventListener (không
// dùng onclick inline) như printExam() ở trên, vì lý do CSP của tiện ích
// Manifest V3 đã ghi chú ở printExam().
function renderSemesterPart(part) {
  let html = '';
  if (part.listeningScript) {
    html += '<div class="p-listening-box">🎧 <i>Bài nghe (giáo viên đọc to hoặc mở file ghi âm cho học sinh nghe ' +
      '2 lần, không cho học sinh xem chữ này):</i><br>' + mathHtml(part.listeningScript) + '</div>';
  }
  html += '<div class="p-part-head">' + (part.label ? '<b>' + escapeHtml(part.label) + '.</b> ' : '') +
    '<i>' + mathHtml(part.instruction || '') + '</i>' +
    (part.points != null ? ' <span class="p-q-points">(' + part.points + ' pts)</span>' : '') + '</div>';
  if (part.passage) html += '<div class="p-q-prompt">' + mathHtml(part.passage) + '</div>';
  (part.items || []).forEach(it => {
    html += '<div class="p-sem-item"><b>' + (it.num != null ? it.num + '.' : '') + '</b> ' + mathHtml(it.text || '');
    if (Array.isArray(it.options) && it.options.length) {
      html += '<div class="p-mcq-options">' + it.options.map((opt, oi) =>
        '<span class="p-mcq-opt-inline">' + String.fromCharCode(65 + oi) + '. ' + mathHtml(opt) + '</span>').join('') + '</div>';
    } else {
      html += '<div class="p-line"></div>';
    }
    html += '</div>';
  });
  return html;
}
function renderSemesterVersion(version) {
  const secHtml = (version.sections || []).map(sec => {
    let inner = '<div class="p-sec-head"><b>' + escapeHtml(sec.code) + '. ' + escapeHtml(sec.name) + '</b>' +
      (sec.points != null && !sec.parts ? ' <span class="p-q-points">(' + sec.points + ' pts)</span>' : '') + '</div>';
    if (sec.note) inner += '<div class="p-q-prompt"><i>' + mathHtml(sec.note) + '</i></div>';
    (sec.parts || []).forEach(p => { inner += renderSemesterPart(p); });
    return '<div class="p-q-block">' + inner + '</div>';
  }).join('');
  return '<div class="p-sem-page"><div class="p-sem-header">' +
    '<div>PHÒNG GD &amp; ĐT ……………………</div><div>TRƯỜNG THCS ……………………</div></div>' +
    secHtml + '</div>';
}
function renderSemesterKeyItem(it) {
  return '<span class="p-key-item"><b>' + (it.num != null ? it.num + '.' : '') + '</b> ' +
    mathHtml(it.options ? (it.answer || '') : (it.answer || '')) + '</span>';
}
function renderSemesterKeyVersion(version) {
  const secHtml = (version.sections || []).map(sec => {
    let inner = '<div class="p-sec-head"><b>' + escapeHtml(sec.code) + '. ' + escapeHtml(sec.name) + '</b></div>';
    (sec.parts || []).forEach(p => {
      inner += '<div class="p-key-part">' + (p.label ? '<b>' + escapeHtml(p.label) + '.</b> ' : '') +
        (p.items || []).map(renderSemesterKeyItem).join('&nbsp;&nbsp;') + '</div>';
    });
    return inner;
  }).join('');
  return '<div class="p-q-block"><div class="p-sec-head"><b>ĐÁP ÁN</b></div>' + secHtml + '</div>';
}
function buildSemesterPrintableHtml(exam) {
  const body =
    renderSemesterVersion(exam) +
    '<div class="p-pagebreak"></div>' +
    renderSemesterKeyVersion(exam);
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' +
    escapeHtml(exam.titleLine || 'Đề Thi Học Kỳ') + '</title><style>' +
    '@page{size:A4;margin:14mm}body{font-family:"Times New Roman",serif;font-size:12.5pt;color:#111}' +
    '.p-sem-header{display:flex;justify-content:space-between;font-weight:bold;margin-bottom:4px}' +
    '.p-sem-titlebox{text-align:center;font-size:14pt;font-weight:bold;margin:6px 0 12px}' +
    '.p-sec-head{margin:10px 0 4px;font-size:13pt}' +
    '.p-part-head{margin:6px 0 4px}' +
    '.p-listening-box{margin:3px 0 6px;padding:4px 8px;border:1px dashed #999;font-size:11pt}' +
    '.p-q-prompt{margin:3px 0 6px}' +
    '.p-sem-item{margin:4px 0}' +
    '.p-mcq-options{margin-left:14px}' +
    '.p-mcq-opt-inline{display:inline-block;margin-right:16px}' +
    '.p-line{border-bottom:1px dotted #999;height:16px;margin:2px 40px 2px 14px}' +
    '.p-q-points{font-weight:normal;font-style:italic;font-size:10.5pt}' +
    '.p-key-part{margin:3px 0}.p-key-item{margin-right:14px;display:inline-block}' +
    '.p-pagebreak{page-break-before:always}' +
    '.toolbar{position:fixed;top:0;left:0;right:0;background:#222;color:#fff;padding:8px;display:flex;gap:10px;print-color-adjust:exact}' +
    '.toolbar button{padding:6px 14px;border-radius:6px;border:none;cursor:pointer;font-weight:bold}' +
    '@media print{.toolbar{display:none}body{margin-top:0}}' +
    '.p-sem-page{margin-top:46px}' +
    '</style></head><body>' +
    '<div class="toolbar"><button id="printExamBtn">🖨️ In / Lưu PDF</button><button id="closeExamBtn">✖ Đóng</button></div>' +
    body + '</body></html>';
}
// Suy ra index đáp án đúng (0-3) từ chữ cái A/B/C/D mà AI trả về trong
// "answer" (chấp nhận cả dạng "B", "b.", "B — sửa lại: ..." — chỉ lấy ký
// tự chữ cái đầu tiên). Không nhận diện được thì mặc định về đáp án đầu
// tiên (an toàn hơn là vứt bỏ cả câu hỏi).
function semesterAnswerLetterIndex(answer, optionsLen) {
  const m = String(answer == null ? '' : answer).trim().match(/^([A-Da-d])\b/);
  if (m) {
    const idx = m[1].toUpperCase().charCodeAt(0) - 65;
    if (idx >= 0 && idx < optionsLen) return idx;
  }
  return 0;
}

// Chuyển đề thi học kỳ thành mảng "questions" ĐÚNG
// ĐỊNH DẠNG mcq/essay mà toàn bộ hạ tầng có sẵn của app (giao đề — con
// làm bài — chấm tự động — xem kết quả — in lại) đang dùng, để KHÔNG
// phải xây riêng 1 bộ máy chấm bài mới cho từng dạng câu hỏi lạ (T/F,
// sắp xếp từ, tìm lỗi sai...): câu có "options" → mcq (tự chấm ngay,
// giống trắc nghiệm thường); câu không có "options" (điền từ, viết lại
// câu, trả lời câu hỏi đọc hiểu...) → essay (chấm bằng AI so với
// "suggestedAnswer", giống tự luận thường). Điểm mỗi câu = điểm của cả
// PHẦN (part.points) chia đều cho số câu trong phần đó. Phần F (Speaking)
// không có nội dung viết nên KHÔNG được đưa vào (đã loại từ khi soạn).
function semesterVersionToQuestions(version) {
  const out = [];
  (version.sections || []).forEach(sec => {
    (sec.parts || []).forEach(part => {
      const items = part.items || [];
      if (!items.length) return;
      const perPoints = part.points != null ? Math.round((part.points / items.length) * 100) / 100 : 1;
      const tag = '[' + sec.code + (part.label ? '.' + part.label : '') + '] ' + (part.instruction || '');
      const passageBlock = part.passage ? ('\n' + part.passage) : '';
      items.forEach(it => {
        const hasOptions = Array.isArray(it.options) && it.options.length >= 2;
        const bodyText = it.text ? it.text : ('Câu ' + (it.num != null ? it.num : ''));
        const prompt = tag + '\n' + bodyText + passageBlock;
        if (hasOptions) {
          out.push({
            id: uid(), type: 'mcq', prompt,
            options: it.options.slice(0, 4).concat(['', '', '', '']).slice(0, 4),
            correctIndex: semesterAnswerLetterIndex(it.answer, Math.min(4, it.options.length)),
            points: perPoints, explanation: part.instruction || '',
            listeningScript: part.listeningScript || '', source: 'ai',
          });
        } else {
          out.push({
            id: uid(), type: 'essay', prompt,
            suggestedAnswer: String(it.answer == null ? '' : it.answer),
            points: perPoints,
            listeningScript: part.listeningScript || '', source: 'ai',
          });
        }
      });
    });
  });
  return out;
}

// Giao đề thi học kỳ cho Con làm NGAY TRONG APP — nạp câu hỏi đã chuyển
// đổi vào state.draftQuestions rồi gọi LẠI đúng assignExam() sẵn có (không
// viết lại logic giao đề/validate/ghi Firestore), y hệt như khi Cha soạn
// tay hoặc nhờ AI soạn theo chủ đề. assignExam() giờ luôn mở khung "👁 Xem
// trước đề" trước — Cha xem lại lần cuối rồi mới bấm xác nhận giao thật.
function assignSemesterExam() {
  const exam = state.semesterExam;
  if (!exam) return;
  const ok = confirm(
    'Chuyển đề thi học kỳ này sang cho Con làm NGAY TRONG APP?\n\n' +
    'Lưu ý: câu hỏi sẽ được chuyển thành trắc nghiệm/tự luận để app tự chấm được — ' +
    'phần F. Speaking không có nội dung viết nên sẽ KHÔNG được đưa vào đề giao. ' +
    'Bước tiếp theo sẽ cho xem lại toàn bộ đề trước khi giao thật.'
  );
  if (!ok) return;
  const questions = semesterVersionToQuestions(exam);
  if (!questions.length) { alert('Không tạo được câu hỏi nào từ đề này — hãy thử tạo lại đề.'); return; }
  state.draftQuestions = questions;
  $('examTitleInput').value = exam.titleLine || 'Đề Thi Học Kỳ';
  $('examModeSelect').value = 'both';
  $('examDurationInput').value = exam.durationMinutes || 45;
  updateModeVisibility();
  switchTab('manual');
  renderDraftQuestions();
  assignExam();
}

function printSemesterExam(exam) {
  const w = window.open('', '_blank');
  if (!w) { alert('Trình duyệt vừa chặn cửa sổ in (pop-up). Hãy cho phép pop-up cho trang này rồi bấm lại.'); return; }
  w.document.open();
  w.document.write(buildSemesterPrintableHtml(exam));
  w.document.close();
  const printBtn = w.document.getElementById('printExamBtn');
  const closeBtn = w.document.getElementById('closeExamBtn');
  if (printBtn) printBtn.addEventListener('click', () => w.print());
  if (closeBtn) closeBtn.addEventListener('click', () => w.close());
}

async function regenerateSingleQuestion(q, btn) {
  const card = btn.closest('.q-card');
  const statusEl = card ? card.querySelector('.hint') : null;
  const topics = getCheckedTopics();
  const topicsText = topics.length ? topics.join(', ') : TOPICS.join(', ');
  btn.disabled = true;
  if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = '⏳ Đang nhờ AI tạo lại câu này...'; }
  try {
    const isMcq = q.type === 'mcq';
    const promptText =
      'Bạn là giáo viên Tiếng Anh lớp 6 tại Việt Nam. Hãy soạn LẠI (thay thế) đúng 1 câu hỏi ' +
      (isMcq ? 'trắc nghiệm (4 phương án A/B/C/D, chỉ 1 đáp án đúng)' : 'tự luận') +
      ' cho đề Tiếng Anh lớp 6, khác với câu hiện tại, và CHỈ trả lời bằng JSON hợp lệ, không kèm giải thích, không dùng dấu ```.\n\n' +
      'Nội dung/chủ đề có thể chọn (ưu tiên đúng chủ đề của câu cũ nếu suy ra được, không thì chọn phù hợp trong danh sách): ' + topicsText + '\n' +
      'Câu hỏi hiện tại (để tránh lặp lại y hệt): ' + (q.prompt || '(chưa có nội dung)') + '\n' +
      (q.listeningScript ? 'Câu cũ là dạng NGHE HIỂU, kịch bản nghe cũ: ' + q.listeningScript + ' — hãy soạn lại 1 đoạn hội thoại/độc thoại KHÁC.\n' : '') +
      'Mức độ khó/phức tạp yêu cầu: ' + getDifficultyPromptText() + '\n' +
      SOLUTION_STYLE_GUIDE + '\n\n' +
      GRAMMAR_CHECK_GUIDE + '\n\n' +
      LISTENING_GUIDE + '\n\n' +
      (isMcq
        ? 'Trả về đúng cấu trúc JSON sau (không thêm trường nào khác):\n' +
          '{"question":{"type":"mcq","prompt":"...","options":["...","...","...","..."],"correctIndex":0,"explanation":"...","listeningScript":""}}'
        : 'Trả về đúng cấu trúc JSON sau (không thêm trường nào khác):\n' +
          '{"question":{"type":"essay","prompt":"...","suggestedAnswer":"đáp án gợi ý + giải thích để phụ huynh đối chiếu khi chấm","listeningScript":""}}');
    const raw = await callGemini([{ text: promptText }], { expectJson: true });
    const data = parseJsonLoose(raw);
    const nq = data && data.question;
    if (!nq || !nq.prompt) throw Error('AI trả về dữ liệu không đúng định dạng mong đợi.');
    q.source = 'ai';
    q.listeningScript = String(nq.listeningScript || '');
    if (isMcq) {
      const opts = Array.isArray(nq.options) ? nq.options.slice(0, 4) : [];
      while (opts.length < 4) opts.push('');
      q.prompt = String(nq.prompt || '');
      q.options = opts;
      q.correctIndex = Number.isInteger(nq.correctIndex) ? nq.correctIndex : 0;
      q.explanation = String(nq.explanation || '');
    } else {
      q.prompt = String(nq.prompt || '');
      q.suggestedAnswer = String(nq.suggestedAnswer || '');
    }
    renderDraftQuestions();
  } catch (e) {
    if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = '❌ Lỗi: ' + (e?.message || e); }
    btn.disabled = false;
  }
}

// ---------- 👁 Xem trước đề trước khi giao thật cho Con ----------
// BẮT BUỘC đi qua bước này trước khi ghi đề vào phòng — dùng CHUNG cho cả
// đề tự soạn tay, đề AI soạn, lẫn đề thi học kỳ (xem assignExam() bên dưới
// và assignSemesterExam()). Hiển thị lại đúng nội dung sẽ giao (kể cả nút
// "🔊 Nghe" cho câu Nghe hiểu, và đáp án đúng/gợi ý để Cha soát lại) — Cha
// bấm "✅ Xác nhận, giao đề cho Con" thì mới thật sự ghi vào phòng.
function renderExamPreviewQuestions(questions) {
  return (questions || []).map((q, idx) => {
    let html = '<div class="q-run">';
    if (q.listeningScript) html += listeningBoxHtml(q.listeningScript, 'Nghe đoạn hội thoại', 'preview_' + (q.id || idx));
    html += '<div class="q-run-prompt">' + mathHtml((idx + 1) + '. ' + (q.prompt || '') + `  (${q.points} điểm)`) + '</div>';
    if (q.type === 'mcq') {
      html += (q.options || []).map((opt, oi) =>
        '<div class="q-run-opt-preview' + (oi === q.correctIndex ? ' is-correct' : '') + '">' +
        mathHtml(String.fromCharCode(65 + oi) + '. ' + opt) + (oi === q.correctIndex ? ' ✅' : '') + '</div>'
      ).join('');
    } else {
      html += '<div class="q-preview-suggested">💡 <i>Gợi ý đáp án (để Cha đối chiếu khi chấm):</i><br>' +
        mathHtml(q.suggestedAnswer || '(chưa có gợi ý)') + '</div>';
    }
    html += '</div>';
    return html;
  }).join('');
}
function openExamPreview({ title, durationMinutes, questions }, onConfirm) {
  $('examPreviewTitle').textContent = '👁 Xem trước: ' + (title || '(chưa đặt tên)');
  $('examPreviewMeta').textContent = `⏱ Thời gian làm bài: ${durationMinutes} phút · 📋 Tổng số câu: ${(questions || []).length} câu — kiểm tra kỹ trước khi giao cho Con.`;
  $('examPreviewQuestionsBox').innerHTML = renderExamPreviewQuestions(questions);
  $('examPreviewModal').style.display = 'flex';
  state._examPreviewConfirm = onConfirm;
}
function closeExamPreview() { $('examPreviewModal').style.display = 'none'; state._examPreviewConfirm = null; }
$('examPreviewCloseBtn').addEventListener('click', closeExamPreview);
$('examPreviewBackBtn').addEventListener('click', closeExamPreview);
$('examPreviewConfirmBtn').addEventListener('click', async () => {
  const fn = state._examPreviewConfirm;
  const btn = $('examPreviewConfirmBtn');
  btn.disabled = true;
  try { if (fn) await fn(); } finally { btn.disabled = false; }
  closeExamPreview();
});

// ---------- Giao đề ----------
// Kiểm tra/đóng gói đề xong thì KHÔNG ghi thẳng vào phòng nữa — mở khung
// "👁 Xem trước đề" (xem ở trên) để Cha soát lại lần cuối, bấm xác nhận
// trong đó mới thật sự gọi doAssignExam() để ghi vào phòng cho Con.
function assignExam() {
  const title = $('examTitleInput').value.trim();
  const mode = $('examModeSelect').value;
  const durationMinutes = parseInt($('examDurationInput').value, 10) || 30;
  const errEl = $('assignError'); errEl.textContent = '';

  if (!title) { errEl.textContent = '⚠️ Hãy đặt tiêu đề cho đề bài.'; return; }
  if (!state.draftQuestions.length) { errEl.textContent = '⚠️ Đề đang trống, hãy thêm ít nhất 1 câu hỏi.'; return; }
  for (const q of state.draftQuestions) {
    if (!q.prompt.trim()) { errEl.textContent = '⚠️ Có câu hỏi chưa nhập nội dung.'; return; }
    if (q.type === 'mcq' && q.options.some(o => !o.trim())) { errEl.textContent = '⚠️ Có câu trắc nghiệm chưa nhập đủ 4 phương án.'; return; }
  }

  const questions = state.draftQuestions.map(q => q.type === 'mcq'
    ? { id: q.id, type: 'mcq', prompt: q.prompt, options: q.options, correctIndex: q.correctIndex, points: q.points, explanation: q.explanation || '', listeningScript: q.listeningScript || '', source: q.source || 'manual' }
    : { id: q.id, type: 'essay', prompt: q.prompt, suggestedAnswer: q.suggestedAnswer, points: q.points, listeningScript: q.listeningScript || '', source: q.source || 'manual' });

  const exam = { title, mode, durationMinutes, questions, assignedAt: Date.now(), composeSettings: getComposeSettingsSnapshot() };
  openExamPreview(exam, () => doAssignExam(exam));
}

async function doAssignExam(exam) {
  const errEl = $('assignError'); errEl.textContent = '';
  try {
    await withFailover(pid => fsPatchRoom(pid, state.roomId,
      { eng6: { status: 'assigned', exam, submission: null, grading: null, result: null } },
      ['eng6.status', 'eng6.exam', 'eng6.submission', 'eng6.grading', 'eng6.result', 'updatedAt']));
    state.draftQuestions = [];
    renderDraftQuestions();
    $('examTitleInput').value = '';
    pollOnce();
  } catch (e) { errEl.textContent = '❌ Không giao được đề: ' + (e?.message || e); }
}

// ---------- In đề ra giấy / Xuất PDF — mở 1 tab mới với bản đề trình bày
// theo kiểu đề kiểm tra thật (khổ A4, có chỗ ghi tên/lớp/điểm, mỗi câu ghi
// rõ số điểm, câu tự luận chừa sẵn dòng kẻ chấm để viết bài), rồi để phụ
// huynh tự bấm "In / Lưu thành PDF" — Chrome sẽ cho chọn máy in hoặc chọn
// "Lưu dưới dạng PDF" ngay trong hộp thoại in, không cần cài thêm gì. Dùng
// được cho CẢ đề đang soạn dở, đề đã giao, lẫn đề đã chấm xong — chỉ cần
// truyền đúng {title, durationMinutes, questions}. ----------
function printExam(examLike) {
  const { title, durationMinutes, questions } = examLike || {};
  if (!questions || !questions.length) { alert('Đề đang trống, chưa có câu hỏi nào để in.'); return; }
  const w = window.open('', '_blank');
  if (!w) { alert('Trình duyệt vừa chặn cửa sổ in (pop-up). Hãy cho phép pop-up cho trang này rồi bấm lại.'); return; }
  w.document.open();
  w.document.write(buildPrintableExamHtml({ title, durationMinutes, questions }));
  w.document.close();
  // QUAN TRỌNG: KHÔNG dùng onclick="..." (hay <script> chèn thẳng) trong HTML
  // viết ra ở trên — Chrome áp Content-Security-Policy mặc định của tiện ích
  // Manifest V3 (chặn JS nội tuyến) lên CẢ cửa sổ "about:blank" mới mở này
  // (nó kế thừa CSP từ đúng trang tiện ích đã mở ra nó), nên trước đây bấm
  // nút "In"/"Đóng" không có phản ứng gì — bị chặn ÂM THẦM, không hiện lỗi gì
  // cho biết cả. Thay vào đó, gắn sự kiện bấm nút bằng addEventListener ngay
  // TỪ SCRIPT của tiện ích (file này) — cách này không bị CSP chặn.
  const printBtn = w.document.getElementById('printExamBtn');
  const closeBtn = w.document.getElementById('closeExamBtn');
  if (printBtn) printBtn.addEventListener('click', () => w.print());
  if (closeBtn) closeBtn.addEventListener('click', () => w.close());
}
// Ước lượng số dòng kẻ chấm để chừa chỗ viết cho câu tự luận — ưu tiên dựa
// theo số BƯỚC trong "gợi ý đáp án" (mỗi dòng gợi ý ứng với khoảng 1 dòng
// trình bày của Con, cộng thêm dư ra vài dòng), vì đó là ước lượng SÁT THỰC
// TẾ nhất cho độ dài lời giải — số điểm chỉ dùng làm phương án dự phòng khi
// câu đó chưa có gợi ý đáp án. Trước đây chỉ tính theo điểm số (tối đa 8
// dòng) nên với câu có lời giải nhiều bước (như câu tìm x qua 5-6 bước biến
// đổi phân số) thường bị THIẾU chỗ viết rõ rệt.
function estimateEssayLineCount(q) {
  const stepLines = String(q.suggestedAnswer || '').split('\n').filter(l => l.trim()).length;
  const byPoints = Math.round(Number(q.points) || 2) + 3;
  return Math.max(5, Math.min(14, Math.max(stepLines + 3, byPoints)));
}
function buildPrintableExamHtml({ title, durationMinutes, questions }) {
  const qHtml = questions.map((q, i) => {
    const n = i + 1;
    let inner = '<div class="p-q-head"><span>Câu ' + n + '.</span><span class="p-q-points">(' + (q.points ?? '?') + ' điểm)</span></div>' +
      (q.listeningScript ? '<div class="p-listening-box">🎧 <i>Bài nghe (phụ huynh/giáo viên đọc to cho học sinh nghe, không cho học sinh xem chữ này):</i><br>' + mathHtml(q.listeningScript) + '</div>' : '') +
      '<div class="p-q-prompt">' + mathHtml(q.prompt || '') + '</div>';
    if (q.type === 'mcq') {
      inner += '<div class="p-mcq-options">' + (q.options || []).map((opt, oi) =>
        '<div class="p-mcq-opt"><span class="p-mcq-letter">' + String.fromCharCode(65 + oi) + '.</span> ' + mathHtml(opt || '') + '</div>').join('') + '</div>';
    } else {
      const lineCount = estimateEssayLineCount(q);
      inner += '<div class="p-essay-lines">' + Array.from({ length: lineCount }, () => '<div class="p-line"></div>').join('') + '</div>';
    }
    return '<div class="p-q-block">' + inner + '</div>';
  }).join('');
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + escapeHtml(title || 'Đề Tiếng Anh lớp 6') + ' — In đề</title><style>' +
    // Khổ A4 chuẩn (@page), font chữ kiểu bài kiểm tra thường in ở trường
    // (Times New Roman), ẩn thanh nút "In/Đóng" khi thật sự in ra giấy.
    '@page{size:A4;margin:16mm 14mm}*{box-sizing:border-box}' +
    'body{font-family:"Times New Roman",Times,serif;font-size:13pt;color:#000;margin:0}' +
    '.p-toolbar{position:sticky;top:0;background:#fff;padding:10px;text-align:center;border-bottom:1px solid #ccc}' +
    '.p-toolbar button{font-size:14px;padding:6px 16px;margin:0 4px;cursor:pointer}' +
    '@media print{.p-toolbar{display:none}}' +
    '.p-page{max-width:190mm;margin:0 auto;padding:6px 2px}' +
    '.p-top-row{display:flex;justify-content:space-between;font-size:12pt;margin-bottom:4px}' +
    '.p-dotted{border-bottom:1px dotted #000;display:inline-block;min-width:150px}' +
    '.p-title{text-align:center;font-size:16pt;font-weight:700;text-transform:uppercase;margin:6px 0 2px}' +
    '.p-subtitle{text-align:center;font-size:12pt;font-style:italic;margin-bottom:6px}' +
    '.p-score-row{display:flex;justify-content:space-between;margin:10px 0 16px;font-size:12pt}' +
    '.p-q-block{margin-bottom:14px;page-break-inside:avoid}' +
    '.p-q-head{display:flex;justify-content:space-between;font-weight:700}' +
    '.p-q-points{font-weight:400;font-style:italic}' +
    '.p-q-prompt{margin:3px 0 6px}' +
    '.p-listening-box{margin:3px 0 6px;padding:4px 8px;border:1px dashed #999;font-size:11pt}' +
    '.p-mcq-options{display:grid;grid-template-columns:1fr 1fr;gap:3px 22px;margin:4px 0 0 10px}' +
    '.p-mcq-letter{font-weight:700}' +
    '.p-essay-lines{margin:6px 0 0 10px}' +
    '.p-line{border-bottom:1px dotted #666;height:24px}' +
    'sup{font-size:0.7em}' +
    '</style></head><body>' +
    '<div class="p-toolbar"><button id="printExamBtn" type="button">🖨️ In / Lưu thành PDF</button><button id="closeExamBtn" type="button">✖ Đóng</button></div>' +
    '<div class="p-page">' +
    '<div class="p-top-row"><span>Họ và tên: <span class="p-dotted"></span></span><span>Lớp: <span class="p-dotted" style="min-width:60px"></span></span></div>' +
    '<div class="p-title">Đề kiểm tra Tiếng Anh lớp 6</div>' +
    '<div class="p-subtitle">' + escapeHtml(title || '') + ' — Thời gian làm bài: ' + (durationMinutes || '?') + ' phút</div>' +
    '<div class="p-score-row"><span>Điểm: <span class="p-dotted" style="min-width:60px"></span></span><span>Nhận xét: <span class="p-dotted" style="min-width:250px"></span></span></div>' +
    qHtml +
    '</div></body></html>';
}

// ---------- Chấm bài ----------
// ---- Nút "➖ Thu gọn tất cả câu" dùng chung cho nhiều danh sách khác nhau
// (xem lại bài nộp / sửa điểm chấm / kết quả cho Con) — mỗi danh sách tự
// truyền vào mảng "items" (mỗi item có cờ "_collapsed" + tham chiếu "_cardEl")
// và nút bấm riêng của mình, cùng cơ chế y hệt nút thu gọn ở khung soạn đề. ----
function wireCollapseAllBtn(btn, getItems) {
  function updateLabel() {
    const items = getItems();
    if (!items.length) { btn.style.display = 'none'; return; }
    btn.style.display = 'inline-block';
    const allCollapsed = items.every(it => it._collapsed);
    btn.textContent = allCollapsed ? '➕ Mở rộng tất cả câu' : '➖ Thu gọn tất cả câu';
  }
  btn.onclick = () => {
    const items = getItems();
    const allCollapsed = items.length > 0 && items.every(it => it._collapsed);
    items.forEach(it => { it._collapsed = !allCollapsed; if (it._cardEl) it._cardEl.classList.toggle('is-collapsed', it._collapsed); });
    updateLabel();
  };
  updateLabel();
  return updateLabel;
}
function addCollapseHead(card, headLeft, typeLabel, summaryText, item) {
  const collapseBtn = document.createElement('button'); collapseBtn.type = 'button'; collapseBtn.className = 'q-card-collapse-btn';
  collapseBtn.title = 'Thu gọn / mở rộng câu này'; collapseBtn.textContent = '▾';
  const tag = document.createElement('span'); tag.className = 'q-type'; tag.textContent = typeLabel;
  headLeft.appendChild(collapseBtn); headLeft.appendChild(tag);
  const summaryLine = document.createElement('div'); summaryLine.className = 'q-card-summary'; summaryLine.textContent = summaryText;
  return { collapseBtn, summaryLine };
}

function renderGradingPanel(m6) {
  const exam = m6.exam || { questions: [] };
  const sub = m6.submission || { answers: [] };
  $('submissionSummary').textContent = `Học sinh: ${sub.studentName || 'Con'} — nộp lúc ${fmtTime(sub.submittedAt)}.`;

  $('submissionReview').style.display = 'flex';
  const reviewBox = $('submissionReview'); reviewBox.innerHTML = '';
  const reviewItems = [];
  exam.questions.forEach((q, idx) => {
    const ans = (sub.answers || []).find(a => a.id === q.id) || {};
    const card = document.createElement('div'); card.className = 'q-card';
    const item = { _collapsed: false, _cardEl: card };
    const head = document.createElement('div'); head.className = 'q-card-head';
    const headLeft = document.createElement('div'); headLeft.className = 'q-card-head-left';
    const shortText = (q.prompt || '').replace(/\s+/g, ' ').trim();
    const summary = (idx + 1) + '. ' + (shortText.length > 70 ? shortText.slice(0, 70) + '…' : shortText);
    const { collapseBtn, summaryLine } = addCollapseHead(card, headLeft,
      (idx + 1) + '. ' + (q.type === 'mcq' ? 'Trắc nghiệm' : 'Tự luận') + ` (${q.points} điểm)`, summary, item);
    collapseBtn.addEventListener('click', () => { item._collapsed = !item._collapsed; card.classList.toggle('is-collapsed', item._collapsed); reviewCollapseAllUpdate(); });
    head.appendChild(headLeft); card.appendChild(head); card.appendChild(summaryLine);

    const bodyWrap = document.createElement('div'); bodyWrap.className = 'q-card-body';
    card.appendChild(bodyWrap);
    if (q.listeningScript) {
      const listenBox = document.createElement('div'); listenBox.className = 'hint';
      listenBox.innerHTML = listeningBoxHtml(q.listeningScript, 'Nghe lại', q.id) +
        '<div style="margin-top:4px">🎧 Transcript (chỉ Cha thấy, Con lúc làm bài không thấy chữ): ' + mathHtml(q.listeningScript) + '</div>';
      bodyWrap.appendChild(listenBox);
    }
    const p = document.createElement('div'); p.innerHTML = mathHtml(q.prompt); p.style.marginBottom = '6px';
    bodyWrap.appendChild(p);
    if (q.type === 'mcq') {
      const chosen = document.createElement('div'); chosen.className = 'hint';
      const correct = ans.selectedIndex === q.correctIndex;
      chosen.innerHTML = mathHtml(`Con chọn: ${q.options[ans.selectedIndex] ?? '(không trả lời)'} — Đáp án đúng: ${q.options[q.correctIndex]} ${correct ? '✅' : '❌'}`);
      bodyWrap.appendChild(chosen);
    } else {
      const txt = document.createElement('div'); txt.className = 'hint';
      txt.innerHTML = mathHtml('Bài làm của con: ' + (ans.text || '(không trả lời)'));
      bodyWrap.appendChild(txt);
      if (q.suggestedAnswer) {
        const sug = document.createElement('div'); sug.className = 'hint'; sug.style.marginTop = '4px';
        sug.innerHTML = mathHtml('Gợi ý đáp án: ' + q.suggestedAnswer);
        bodyWrap.appendChild(sug);
      }
    }
    reviewBox.appendChild(card);
    reviewItems.push(item);
  });
  const reviewCollapseAllUpdate = wireCollapseAllBtn($('reviewCollapseAllBtn'), () => reviewItems);

  $('gradeEditBox').style.display = 'none'; $('gradeEditBox').innerHTML = '';
  $('gradeCollapseAllBtn').style.display = 'none';
  $('totalScoreRow').style.display = 'none'; $('overallCommentLabel').style.display = 'none';
  $('overallCommentInput').style.display = 'none'; $('returnBtn').style.display = 'none';
  $('quickChatLog').innerHTML = ''; $('quickChatSuggestions').innerHTML = '';
  state.gradingDetails = {}; state.quickChatLog = [];
  $('aiGradeStatus').textContent = '';
}

async function gradeWithAI() {
  const m6 = currentEng6();
  const exam = m6.exam || { questions: [] };
  const sub = m6.submission || { answers: [] };
  const statusEl = $('aiGradeStatus'); const btn = $('aiGradeBtn');
  btn.disabled = true; statusEl.textContent = '⏳ Đang chấm bài, vui lòng chờ...';
  try {
    const mcqQs = exam.questions.filter(q => q.type === 'mcq');
    const essayQs = exam.questions.filter(q => q.type === 'essay');
    const mcqResults = mcqQs.map(q => {
      const ans = (sub.answers || []).find(a => a.id === q.id) || {};
      const correct = ans.selectedIndex === q.correctIndex;
      return {
        id: q.id, type: 'mcq', score: correct ? q.points : 0, maxScore: q.points, correct,
        status: correct ? 'correct' : 'wrong',
        feedback: correct ? 'Chọn đúng ✅' : `Chưa đúng — đáp án đúng là: ${q.options[q.correctIndex]}`,
        annotations: [], stepSolution: [], tip: '',
      };
    });
    const mcqScoreSum = mcqResults.reduce((s, r) => s + r.score, 0);
    const mcqMaxSum = mcqQs.reduce((s, q) => s + q.points, 0);

    // ---- Câu trắc nghiệm làm SAI (hoặc bỏ trống): nhờ AI giải thích rõ vì sao
    // đáp án Con chọn là sai, và viết lại cách làm đúng từng bước theo đúng
    // chuẩn trình bày bài thi — thay vì chỉ báo cụt lủn "đáp án đúng là: X"
    // như trước, để Con đọc vào hiểu được TẠI SAO sai và cách làm lại cho đúng. ----
    const mcqWrong = mcqQs.filter(q => (mcqResults.find(r => r.id === q.id) || {}).correct === false);
    if (mcqWrong.length) {
      try {
        const mcqPayload = mcqWrong.map(q => {
          const ans = (sub.answers || []).find(a => a.id === q.id) || {};
          const chosen = (typeof ans.selectedIndex === 'number' && q.options[ans.selectedIndex] !== undefined)
            ? q.options[ans.selectedIndex] : '(không chọn đáp án nào)';
          return { id: q.id, prompt: q.prompt, options: q.options, correctAnswer: q.options[q.correctIndex], studentChose: chosen };
        });
        const mcqPromptText =
          'Bạn là một giáo viên Tiếng Anh lớp 6 người Việt Nam, tận tâm và ấm áp, đang chữa bài trắc nghiệm ' +
          'cho học sinh vừa chọn SAI đáp án. Với MỖI câu dưới đây, hãy làm đủ 3 việc sau:\n' +
          '1) "why": giải thích ngắn gọn (1-2 câu, bằng tiếng Việt) CHÍNH XÁC chỗ học sinh hiểu sai/nhầm lẫn nào ' +
          '(ngữ pháp, từ vựng, hay hiểu sai ngữ cảnh) đã dẫn đến việc chọn nhầm đáp án "studentChose" — không chỉ ' +
          'nói chung chung "sai rồi" mà phải chỉ rõ quy tắc/điểm ngữ pháp nào bị nhầm.\n' +
          '2) "stepSolution": viết một MẢNG các bước giải thích đầy đủ, rõ ràng, dễ hiểu, bằng tiếng Việt (có thể ' +
          'trích câu tiếng Anh đúng khi cần), để học sinh lớp 6 đọc vào là hiểu ngay vì sao đáp án đúng ' +
          '"correctAnswer" là đúng.\n' +
          '3) "tip": viết 1 câu "mẹo nhận biết" NGẮN GỌN, TỔNG QUÁT (không nhắc lại nội dung câu hỏi cụ thể) giúp ' +
          'học sinh nhận ra DẤU HIỆU/TỪ KHÓA của dạng ngữ pháp hoặc điểm kiến thức này (vd từ nhận biết thời gian, ' +
          'cấu trúc câu, quy tắc chia động từ...), để LẦN SAU gặp câu tương tự thì làm đúng ngay từ đầu, không lặp ' +
          'lại lỗi sai này nữa.\n\n' +
          'Danh sách câu (JSON): ' + JSON.stringify(mcqPayload) + '\n\n' +
          'Chỉ trả về JSON đúng cấu trúc: {"mcqExplain":[{"id":"...","why":"...","stepSolution":["...","..."],"tip":"..."}]}';
        const mcqRaw = await callGemini([{ text: mcqPromptText }], { expectJson: true });
        const mcqData = parseJsonLoose(mcqRaw);
        const mcqExplainList = Array.isArray(mcqData.mcqExplain) ? mcqData.mcqExplain : [];
        mcqExplainList.forEach(ex => {
          const r = mcqResults.find(x => x.id === ex.id); if (!r) return;
          const why = String(ex.why || '').trim();
          r.feedback = r.feedback + (why ? ' — ' + why : '');
          r.stepSolution = Array.isArray(ex.stepSolution) ? ex.stepSolution.map(String).filter(Boolean) : [];
          r.tip = String(ex.tip || '').trim();
        });
      } catch (e) {
        // AI giải thích thêm bị lỗi (vd mất mạng) thì vẫn giữ nguyên kết quả chấm
        // đúng/sai + feedback cụt lủn cũ, không chặn cả quá trình chấm bài.
      }
    }

    let essayResults = [];
    let overallComment = '';

    if (essayQs.length) {
      const essayPayload = essayQs.map(q => {
        const ans = (sub.answers || []).find(a => a.id === q.id) || {};
        return { id: q.id, prompt: q.prompt, suggestedAnswer: q.suggestedAnswer || '', maxScore: q.points, studentAnswer: ans.text || '(không trả lời)' };
      });
      const promptText =
        'Bạn là một giáo viên Tiếng Anh lớp 6 người Việt Nam, tận tâm và ấm áp, đang chấm bài tự luận/viết cho học sinh. ' +
        'Với MỖI câu dưới đây, dựa vào gợi ý đáp án, hãy làm đủ các việc sau:\n' +
        '1) Chấm điểm "score": số thực từ 0 đến điểm tối đa của câu, có thể cho điểm từng phần nếu làm đúng một phần ' +
        '(vd đúng ý nhưng sai ngữ pháp/chính tả nhỏ vẫn được điểm phần lớn).\n' +
        '2) Xác định "status": "unanswered" nếu studentAnswer là "(không trả lời)"; "wrong" nếu sai gần như hoàn toàn ' +
        '(nghĩa sai, ngữ pháp sai nặng, hoặc không liên quan câu hỏi); "partial" nếu đúng một phần / còn lỗi ngữ pháp-chính tả / ' +
        'chưa đủ ý; "correct" nếu làm đúng và diễn đạt tốt.\n' +
        '3) "stepSolution": nếu status KHÔNG PHẢI "correct", viết một MẢNG các bước giải thích bằng tiếng Việt, dễ hiểu, ' +
        'nêu rõ câu/đoạn tiếng Anh đúng nên viết là gì và vì sao — dựa theo gợi ý đáp án. ' +
        'Nếu status là "correct" thì để "stepSolution" là mảng rỗng [].\n' +
        '4) "annotations": CHỈ khi studentAnswer có nội dung thật (khác "(không trả lời)") VÀ có chỗ sai hoặc diễn đạt ' +
        'chưa tốt, trả về một mảng tối đa 4 phần tử, mỗi phần tử gồm 3 trường: ' +
        '"quote" (COPY NGUYÊN VĂN — giống hệt từng ký tự — một đoạn ngắn khoảng 2-10 từ TỪ CHÍNH studentAnswer, ' +
        'đúng chỗ bị sai ngữ pháp/chính tả/dùng từ; nếu không chắc chắn copy được y hệt thì bỏ qua, đừng đoán), ' +
        '"comment" (1 câu ngắn bằng tiếng Việt, giọng giáo viên phê tay bên lề bài, chỉ rõ vì sao chỗ đó chưa ổn), ' +
        'và "corrected" (viết lại ngắn gọn đúng đoạn tiếng Anh đó cho chuẩn). ' +
        'Nếu bài làm không có gì để chê thì để "annotations" là mảng rỗng [].\n' +
        '5) "feedback": 1-2 câu nhận xét riêng cho câu đó, giọng ấm áp, khích lệ, chỉ rõ chỗ cần cải thiện nếu có.\n' +
        '6) "tip": nếu status KHÔNG PHẢI "correct", viết 1 câu "mẹo ghi nhớ" NGẮN GỌN, TỔNG QUÁT (không nhắc lại nội ' +
        'dung câu hỏi cụ thể) nêu rõ QUY TẮC/DẤU HIỆU chung của lỗi này (vd quy tắc chia động từ, cách dùng giới từ, ' +
        'trật tự từ...), để lần sau Con viết câu tương tự thì tự nhớ mà tránh lặp lại lỗi. Nếu status là "correct" ' +
        'thì để "tip" là chuỗi rỗng "".\n\n' +
        'Sau đó viết thêm 1 lời phê CHUNG (2-4 câu) tổng kết cả bài làm, có nhắc tới điểm trắc nghiệm cho sẵn dưới đây ' +
        'nếu có, giọng văn ấm áp của giáo viên chủ nhiệm, động viên là chính.\n\n' +
        (mcqQs.length ? `Điểm trắc nghiệm học sinh đã đạt: ${mcqScoreSum}/${mcqMaxSum}\n` : '') +
        'Danh sách câu tự luận (JSON): ' + JSON.stringify(essayPayload) + '\n\n' +
        'Chỉ trả về JSON đúng cấu trúc: {"essayResults":[{"id":"...","score":số,' +
        '"status":"unanswered|wrong|partial|correct","feedback":"...",' +
        '"annotations":[{"quote":"...","comment":"...","corrected":"..."}],"stepSolution":["...","..."],"tip":"..."}],' +
        '"overallComment":"..."}';
      const raw = await callGemini([{ text: promptText }], { expectJson: true });
      const data = parseJsonLoose(raw);
      essayResults = (data.essayResults || []).map(r => {
        const q = essayQs.find(x => x.id === r.id) || {};
        const ans = (sub.answers || []).find(a => a.id === r.id) || {};
        const answerText = ans.text || '';
        const rawAnnotations = Array.isArray(r.annotations) ? r.annotations : [];
        // Chỉ giữ lại annotation nào "quote" khớp NGUYÊN VĂN trong bài làm gốc —
        // AI có thể chép sai/diễn giải lại, khớp không đúng thì bỏ, tránh gạch bừa.
        const annotations = rawAnnotations
          .filter(a => a && a.quote && answerText.includes(a.quote))
          .slice(0, 6)
          .map(a => ({ quote: String(a.quote), comment: String(a.comment || ''), corrected: String(a.corrected || '') }));
        const validStatuses = ['unanswered', 'wrong', 'partial', 'correct'];
        const status = validStatuses.includes(r.status) ? r.status : (answerText ? 'partial' : 'unanswered');
        return {
          id: r.id, type: 'essay',
          score: Math.max(0, Math.min(Number(r.score) || 0, q.points || 0)),
          maxScore: q.points || 0,
          status,
          feedback: String(r.feedback || ''),
          annotations,
          stepSolution: status === 'correct' ? [] : (Array.isArray(r.stepSolution) ? r.stepSolution.map(String).filter(Boolean) : []),
          tip: status === 'correct' ? '' : String(r.tip || '').trim(),
          answerText,
        };
      });
      overallComment = String(data.overallComment || '');
    } else {
      const promptText = `Viết 1 lời phê ngắn (2-3 câu) bằng tiếng Việt cho một học sinh lớp 6 vừa làm bài trắc nghiệm Tiếng Anh, ` +
        `đạt ${mcqScoreSum}/${mcqMaxSum} điểm. Giọng văn ấm áp, động viên là chính, có góp ý ngắn nếu điểm chưa cao. ` +
        `Chỉ trả về JSON: {"overallComment":"..."}`;
      const raw = await callGemini([{ text: promptText }], { expectJson: true });
      const data = parseJsonLoose(raw);
      overallComment = String(data.overallComment || '');
    }

    const perQuestion = exam.questions.map(q => (mcqResults.find(r => r.id === q.id) || essayResults.find(r => r.id === q.id) ||
      { id: q.id, type: q.type, score: 0, maxScore: q.points, status: 'unanswered', feedback: '', annotations: [], stepSolution: [], tip: '' }));
    // Lưu lại phần chi tiết (status/annotations/stepSolution/tip/answerText) — các ô
    // điểm/nhận xét thì Cha sửa được trên form, còn phần này chỉ AI tạo ra, cần
    // giữ lại để lúc bấm "TRẢ BÀI CHO CON" gói kèm theo, và để khung chat nhanh
    // bên dưới có ngữ cảnh để trả lời khi Cha hỏi thêm.
    state.gradingDetails = {};
    perQuestion.forEach(r => { state.gradingDetails[r.id] = { status: r.status, annotations: r.annotations || [], stepSolution: r.stepSolution || [], tip: r.tip || '', answerText: r.answerText }; });
    state.quickChatLog = [];
    renderGradeEditBox(perQuestion, overallComment);
    statusEl.textContent = '✅ AI đã chấm xong — kiểm tra/sửa lại bên dưới rồi bấm "TRẢ BÀI CHO CON".';
  } catch (e) {
    statusEl.textContent = '❌ Lỗi khi chấm bài: ' + (e?.message || e);
  } finally {
    btn.disabled = false;
  }
}

function renderGradeEditBox(perQuestion, overallComment) {
  const box = $('gradeEditBox'); box.innerHTML = ''; box.style.display = 'flex';
  const exam = (currentEng6().exam) || { questions: [] };
  // Sau khi AI chấm xong, gộp hết vào 1 khung duy nhất (khỏi phải nhìn 2 danh
  // sách trùng nội dung) — ẩn khung "xem lại bài nộp" thô ở trên đi.
  $('submissionReview').style.display = 'none';

  const gradeItems = [];
  perQuestion.forEach((r, idx) => {
    const q = exam.questions.find(x => x.id === r.id) || {};
    const detail = state.gradingDetails[r.id] || { status: r.status, annotations: r.annotations || [], stepSolution: r.stepSolution || [], tip: r.tip || '', answerText: r.answerText };
    const card = document.createElement('div'); card.className = 'q-card';
    const item = { _collapsed: false, _cardEl: card };
    const head = document.createElement('div'); head.className = 'q-card-head';
    const headLeft = document.createElement('div'); headLeft.className = 'q-card-head-left';
    const shortText = (q.prompt || '').replace(/\s+/g, ' ').trim();
    const summary = (idx + 1) + '. ' + (shortText.length > 60 ? shortText.slice(0, 60) + '…' : shortText) + ` — ${r.score}/${r.maxScore} điểm`;
    const { collapseBtn, summaryLine } = addCollapseHead(card, headLeft, (idx + 1) + '. ' + (q.prompt || '').slice(0, 60), summary, item);
    collapseBtn.addEventListener('click', () => { item._collapsed = !item._collapsed; card.classList.toggle('is-collapsed', item._collapsed); gradeCollapseAllUpdate(); });
    if (detail.status) { const chip = document.createElement('span'); chip.innerHTML = statusChipHtml(detail.status); if (chip.firstChild) headLeft.appendChild(chip.firstChild); }
    head.appendChild(headLeft); card.appendChild(head); card.appendChild(summaryLine);

    const bodyWrap = document.createElement('div'); bodyWrap.className = 'q-card-body';
    card.appendChild(bodyWrap);

    const p = document.createElement('div'); p.innerHTML = mathHtml(q.prompt || ''); p.style.marginBottom = '6px';
    bodyWrap.appendChild(p);

    if (q.type === 'essay') {
      // ---- Bài làm của Con, gạch chân/đánh dấu chỗ sai kiểu cô giáo cầm bút đỏ ----
      const ansBox = document.createElement('div'); ansBox.className = 'hint'; ansBox.style.marginTop = '4px';
      ansBox.innerHTML = '📝 Bài làm của con: ' + (detail.answerText ? annotatedAnswerHtml(detail.answerText, detail.annotations) : '<i>(không trả lời)</i>');
      bodyWrap.appendChild(ansBox);
      // ---- Cách làm đúng từng bước — chỉ hiện khi chưa "correct" ----
      if (detail.stepSolution && detail.stepSolution.length) {
        const stepBox = document.createElement('div'); stepBox.innerHTML = buildStepSolutionHtml(detail.stepSolution);
        bodyWrap.appendChild(stepBox);
      } else if (detail.status === 'correct') {
        const ok = document.createElement('div'); ok.className = 'answer-ok-note'; ok.textContent = '✅ Con làm đúng và trình bày tốt, không cần chữa gì thêm.';
        bodyWrap.appendChild(ok);
      }
      if (detail.tip) {
        const tipBox = document.createElement('div'); tipBox.innerHTML = buildTipHtml(detail.tip);
        bodyWrap.appendChild(tipBox);
      }
      if (q.suggestedAnswer) {
        const sug = document.createElement('div'); sug.className = 'hint'; sug.style.marginTop = '6px';
        sug.innerHTML = mathHtml('Gợi ý đáp án gốc (Cha soạn): ' + q.suggestedAnswer);
        bodyWrap.appendChild(sug);
      }
    } else if (q.type === 'mcq') {
      const sub2 = (currentEng6().submission) || { answers: [] };
      const ans2 = (sub2.answers || []).find(a => a.id === q.id) || {};
      const chosen = document.createElement('div'); chosen.className = 'hint';
      chosen.innerHTML = mathHtml(`Con chọn: ${q.options?.[ans2.selectedIndex] ?? '(không trả lời)'} — Đáp án đúng: ${q.options?.[q.correctIndex]}`);
      bodyWrap.appendChild(chosen);
      // ---- Cách làm đúng từng bước — chỉ hiện khi Con chọn SAI (giống hệt
      // khung "Cách làm đúng" bên câu tự luận), để Con hiểu vì sao sai và
      // cách làm lại cho đúng, thay vì chỉ biết mỗi đáp án đúng là gì. ----
      if (detail.stepSolution && detail.stepSolution.length) {
        const stepBox = document.createElement('div'); stepBox.innerHTML = buildStepSolutionHtml(detail.stepSolution);
        bodyWrap.appendChild(stepBox);
      }
      if (detail.tip) {
        const tipBox = document.createElement('div'); tipBox.innerHTML = buildTipHtml(detail.tip);
        bodyWrap.appendChild(tipBox);
      }
    }

    const scoreRow = document.createElement('div'); scoreRow.className = 'q-opt-row'; scoreRow.style.marginTop = '8px';
    const scoreLabel = document.createElement('label'); scoreLabel.textContent = 'Điểm:'; scoreLabel.style.fontWeight = '400';
    const scoreIn = document.createElement('input'); scoreIn.type = 'text'; scoreIn.style.maxWidth = '70px'; scoreIn.value = r.score;
    scoreIn.dataset.qid = r.id; scoreIn.className = 'grade-score-input';
    scoreIn.addEventListener('input', recomputeTotalScore);
    const maxLabel = document.createElement('span'); maxLabel.className = 'hint'; maxLabel.textContent = ' / ' + r.maxScore;
    scoreRow.appendChild(scoreLabel); scoreRow.appendChild(scoreIn); scoreRow.appendChild(maxLabel);
    bodyWrap.appendChild(scoreRow);

    const fbTa = document.createElement('textarea'); fbTa.rows = 2; fbTa.value = r.feedback || ''; fbTa.placeholder = 'Lời nhận xét cho câu này...';
    fbTa.dataset.qid = r.id; fbTa.className = 'grade-feedback-input';
    bodyWrap.appendChild(fbTa);
    box.appendChild(card);
    gradeItems.push(item);
  });
  const gradeCollapseAllUpdate = wireCollapseAllBtn($('gradeCollapseAllBtn'), () => gradeItems);

  $('totalScoreRow').style.display = 'grid';
  $('overallCommentLabel').style.display = 'block';
  $('overallCommentInput').style.display = 'block';
  $('overallCommentInput').value = overallComment || '';
  $('returnBtn').style.display = 'block';
  $('finalMaxScoreInput').value = perQuestion.reduce((s, r) => s + (Number(r.maxScore) || 0), 0);
  recomputeTotalScore();

  // ---- Cập nhật gợi ý bấm nhanh cho tab "🤖 Hỏi AI" ở bong bóng chat nổi
  // (khung chat luôn có sẵn, không cần "mở" gì thêm ở đây nữa). ----
  renderQuickChatSuggestions(perQuestion, exam);
}
function recomputeTotalScore() {
  const sum = Array.from(document.querySelectorAll('.grade-score-input')).reduce((s, el) => s + (parseFloat(el.value) || 0), 0);
  $('finalTotalScoreInput').value = Math.round(sum * 100) / 100;
}

async function returnToChild() {
  const exam = (currentEng6().exam) || { questions: [] };
  const perQuestion = exam.questions.map(q => {
    const scoreEl = document.querySelector(`.grade-score-input[data-qid="${cssEscape(q.id)}"]`);
    const fbEl = document.querySelector(`.grade-feedback-input[data-qid="${cssEscape(q.id)}"]`);
    // Phần "status / annotations / stepSolution / tip / answerText" chỉ AI tạo ra (Cha
    // không sửa trực tiếp trên form), lấy lại từ state.gradingDetails đã lưu lúc
    // "CHẤM ĐIỂM BẰNG AI" để gói kèm theo khi trả bài, Con xem được y hệt phần
    // Cha vừa xem lại (gạch chân chỗ sai + cách làm đúng từng bước + mẹo ghi nhớ).
    const detail = state.gradingDetails[q.id] || {};
    return {
      id: q.id, type: q.type,
      score: parseFloat(scoreEl?.value) || 0,
      maxScore: q.points,
      feedback: fbEl?.value || '',
      correctIndex: q.type === 'mcq' ? q.correctIndex : null,
      options: q.type === 'mcq' ? q.options : null,
      prompt: q.prompt,
      listeningScript: q.listeningScript || '',
      status: detail.status || null,
      annotations: detail.annotations || [],
      stepSolution: detail.stepSolution || [],
      tip: detail.tip || '',
      answerText: q.type === 'essay' ? (detail.answerText || '') : null,
    };
  });
  const result = {
    deliveredAt: Date.now(),
    totalScore: parseFloat($('finalTotalScoreInput').value) || 0,
    maxScore: parseFloat($('finalMaxScoreInput').value) || 0,
    overallComment: $('overallCommentInput').value || '',
    perQuestion,
  };
  try {
    await withFailover(pid => fsPatchRoom(pid, state.roomId, { eng6: { status: 'returned', result } }, ['eng6.status', 'eng6.result', 'updatedAt']));
    pollOnce();
  } catch (e) { $('aiGradeStatus').textContent = '❌ Không trả được bài: ' + (e?.message || e); }
}
function cssEscape(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }

// ---------- Chat nhanh với AI khi đang xem lại bài chấm (chỉ máy Cha, không
// đồng bộ qua phòng — dùng để hỏi thêm/nhờ chấm lại trước khi bấm "TRẢ BÀI CHO
// CON") — có sẵn vài gợi ý bấm nhanh kiểu "chat chọn" cho đỡ phải gõ. ----------
function renderQuickChatSuggestions(perQuestion, exam) {
  const box = $('quickChatSuggestions'); box.innerHTML = '';
  const chips = [];
  perQuestion.forEach((r, idx) => {
    const q = (exam.questions || []).find(x => x.id === r.id);
    if (q && q.type === 'essay') chips.push(`Giải thích thêm cách làm câu ${idx + 1}`);
  });
  chips.push('Chấm nghiêm khắc hơn một chút', 'Chấm nhẹ tay, khích lệ hơn', 'Viết lại lời phê chung dài và ấm áp hơn');
  chips.forEach(text => {
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'quick-chat-chip'; btn.textContent = text;
    btn.addEventListener('click', () => sendQuickChat(text));
    box.appendChild(btn);
  });
}
function appendChatBubbleUI(role, text) {
  const log = $('quickChatLog');
  const b = document.createElement('div'); b.className = 'chat-bubble ' + (role === 'me' ? 'me' : 'ai');
  b.innerHTML = mathHtml(text);
  log.appendChild(b);
  log.scrollTop = log.scrollHeight;
  return b;
}
async function sendQuickChat(presetText) {
  const input = $('quickChatInput');
  const text = (presetText !== undefined ? presetText : input.value).trim();
  if (!text) return;
  input.value = '';
  appendChatBubbleUI('me', text);
  state.quickChatLog.push({ role: 'me', text });
  const sendBtn = $('quickChatSendBtn'); sendBtn.disabled = true;
  const thinking = appendChatBubbleUI('ai', '⏳ Đang trả lời...');
  try {
    // Trước đây "Hỏi AI" chỉ dùng được lúc Cha đang xem lại bài chấm (luôn có
    // sẵn dữ liệu điểm/nhận xét trên trang). Giờ khung này nằm ở bong bóng chat
    // nổi, dùng được CẢ 2 vai trò ở BẤT KỲ lúc nào (đang soạn đề, đang làm bài,
    // đang xem kết quả...), nên phải tự dựng ngữ cảnh phù hợp tuỳ tình huống,
    // thay vì luôn đòi có sẵn điểm số đang chấm trên trang.
    const exam = (currentEng6().exam) || { questions: [] };
    const sub = (currentEng6().submission) || { answers: [] };
    let promptText;
    if (exam.questions && exam.questions.length) {
      const contextPayload = exam.questions.map(q => {
        const ans = (sub.answers || []).find(a => a.id === q.id) || {};
        const scoreIn = document.querySelector(`.grade-score-input[data-qid="${cssEscape(q.id)}"]`);
        const fbIn = document.querySelector(`.grade-feedback-input[data-qid="${cssEscape(q.id)}"]`);
        return {
          prompt: q.prompt, type: q.type,
          studentAnswer: q.type === 'mcq' ? (q.options?.[ans.selectedIndex] ?? '(không trả lời)') : (ans.text || '(không trả lời)'),
          currentScore: scoreIn ? scoreIn.value : null, maxScore: q.points,
          currentFeedback: fbIn ? fbIn.value : null,
        };
      });
      promptText =
        (state.role === 'parent'
          ? 'Bạn là giáo viên Tiếng Anh lớp 6 đang trao đổi nhanh với PHỤ HUYNH về đề/bài làm dưới đây. '
          : 'Bạn là giáo viên Tiếng Anh lớp 6 đang trò chuyện với chính HỌC SINH (con) về đề/bài làm dưới đây — trả lời gần gũi, dễ hiểu, khích lệ, gợi ý cách nghĩ thay vì chỉ đọc thẳng đáp án nếu con chưa làm xong câu đó. ') +
        'Đây là dữ liệu đề bài + bài làm (và điểm/nhận xét đang chấm nếu có) (JSON): ' + JSON.stringify(contextPayload) + '\n\n' +
        (state.quickChatLog.length > 1 ? 'Lịch sử trao đổi trước đó (JSON): ' + JSON.stringify(state.quickChatLog.slice(0, -1)) + '\n\n' : '') +
        'Câu hỏi/yêu cầu: "' + text + '"\n\n';
    } else {
      // Chưa có đề nào trong phòng (vd đang soạn đề, hoặc đang chờ) — trả lời
      // như 1 trợ lý học Tiếng Anh lớp 6 nói chung, không có ngữ cảnh đề cụ thể.
      promptText =
        'Bạn là trợ lý dạy Tiếng Anh lớp 6, đang trò chuyện với ' + (state.role === 'parent' ? 'phụ huynh' : 'một bạn học sinh lớp 6') + '. ' +
        (state.quickChatLog.length > 1 ? 'Lịch sử trao đổi trước đó (JSON): ' + JSON.stringify(state.quickChatLog.slice(0, -1)) + '\n\n' : '') +
        'Câu hỏi/yêu cầu: "' + text + '"\n\n';
    }
    promptText += 'Trả lời ngắn gọn, rõ ràng, đúng trọng tâm câu hỏi, bằng tiếng Việt (có thể trích câu/từ tiếng Anh khi cần), ' +
      'giọng văn giáo viên tận tâm. Trả lời bằng văn xuôi bình thường, KHÔNG trả về JSON.';
    const raw = await callGemini([{ text: promptText }], { expectJson: false });
    thinking.remove();
    appendChatBubbleUI('ai', raw.trim());
    state.quickChatLog.push({ role: 'ai', text: raw.trim() });
  } catch (e) {
    thinking.remove();
    appendChatBubbleUI('ai', '❌ Lỗi: ' + (e?.message || e));
  } finally {
    sendBtn.disabled = false;
  }
}

// ---------- Chat trực tiếp Cha ↔ Con (khác chat AI ở trên: đây là 2 người
// nhắn thật cho nhau, đồng bộ qua phòng — lưu ở eng6.directChat, xem được ở
// cả 2 máy) — giờ hiện ở BONG BÓNG CHAT NỔI, luôn có mặt dù đang ở màn hình
// nào trong phòng (soạn đề / chờ / đang làm bài / chấm điểm / xem kết quả),
// không còn bị khóa cứng vào riêng khung chấm điểm (bên Cha) hay khung kết
// quả (bên Con) như trước — đúng tinh thần "luôn kết nối được 2 cha con dù
// đang ở đâu". Dùng CHUNG 1 bộ phần tử DOM cho cả 2 vai trò, chỉ khác nhau
// ở "myRole" (ai gửi) và tiêu đề khung hiển thị. ----------
function fmtHM(ts) { if (!ts) return ''; try { return new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } }
function directChatDom() {
  return {
    log: $('floatingChatLog'), input: $('floatingChatInput'), sendBtn: $('floatingChatSendBtn'),
    dot: $('floatingChatDot'),
    // "Chưa xem" (để hiện chấm đỏ) khi khung đang THU GỌN, HOẶC đang mở nhưng
    // lại đứng ở tab "🤖 Hỏi AI" chứ không phải tab "Nhắn tin".
    collapsedGetter: () => $('floatingChatBox').classList.contains('is-collapsed') || !$('floatingTabDirectBtn').classList.contains('is-active'),
  };
}
const _directChatRenderedLen = { parent: -1, child: -1 }; // tránh vẽ lại + cuộn xuống mỗi vòng poll (1.5s) khi không có tin mới — đỡ phiền lúc đang cuộn đọc lại tin cũ
function chatBubbleContentHtml(m) {
  // Tin nhắn thoại (type:'voice', xem sendDirectChatVoice) hiện thành 1 trình
  // phát <audio> ngay trong bong bóng chat thay vì chữ — data audio đã là
  // base64 (chỉ gồm A-Z a-z 0-9 + / =) nên nhét thẳng vào src="..." được,
  // không cần escapeHtml.
  if (m.type === 'voice') {
    return `🎤 <audio controls preload="none" src="data:${m.mime || 'audio/webm'};base64,${m.data}"></audio>` +
      (m.durationSec ? `<div class="chat-bubble-voice-len">${fmtMMSS(m.durationSec)}</div>` : '');
  }
  return escapeHtml(m.text);
}
function renderDirectChatFor(myRole, force) {
  const dom = directChatDom();
  if (!dom.log) return;
  const chat = currentEng6().directChat || [];
  if (!force && chat.length === _directChatRenderedLen[myRole]) { updateDirectChatDotOnly(myRole, chat.length); return; }
  _directChatRenderedLen[myRole] = chat.length;
  dom.log.innerHTML = chat.length
    ? chat.map(m => `<div class="chat-bubble ${m.from === myRole ? 'me' : 'them'}">${chatBubbleContentHtml(m)}<div class="chat-bubble-time">${fmtHM(m.at)}</div></div>`).join('')
    : `<div class="quick-chat-empty">Chưa có tin nhắn nào — gõ gì đó bên dưới để bắt đầu chat nhé.</div>`;
  dom.log.scrollTop = dom.log.scrollHeight;
  const unseen = chat.length - (state.directChatSeenCount[myRole] || 0);
  if (dom.collapsedGetter()) {
    if (dom.dot) dom.dot.style.display = unseen > 0 ? 'inline-block' : 'none';
  } else {
    markDirectChatSeen(myRole);
  }
}
function updateDirectChatDotOnly(myRole, totalCount) {
  const dom = directChatDom();
  if (dom.collapsedGetter()) {
    const unseen = totalCount - (state.directChatSeenCount[myRole] || 0);
    if (dom.dot) dom.dot.style.display = unseen > 0 ? 'inline-block' : 'none';
  } else {
    markDirectChatSeen(myRole);
  }
}
function markDirectChatSeen(myRole) {
  const chat = currentEng6().directChat || [];
  state.directChatSeenCount[myRole] = chat.length;
  const dom = directChatDom();
  if (dom.dot) dom.dot.style.display = 'none';
}
async function sendDirectChat(myRole, presetText) {
  const dom = directChatDom();
  const text = (presetText !== undefined ? presetText : dom.input.value).trim();
  if (!text) return;
  dom.input.value = '';
  if (dom.sendBtn) dom.sendBtn.disabled = true;
  try {
    // Đọc lại phòng mới nhất trước khi gửi (thay vì dùng state.room đang có sẵn)
    // để đỡ ghi đè mất tin của người kia vừa gửi cùng lúc — dù vẫn có thể trùng
    // nếu 2 bên bấm gửi cùng lúc trong vòng chưa tới 1 giây (chấp nhận được với
    // chat gia đình 2 người, không cần transaction phức tạp).
    const room = await withFailover(pid => fsGetRoom(pid, state.roomId));
    const current = (room?.eng6?.directChat) || [];
    const updated = current.concat([{ from: myRole, text, at: Date.now() }]);
    if (state.room) { state.room = room; if (!state.room.eng6) state.room.eng6 = {}; state.room.eng6.directChat = updated; }
    renderDirectChatFor(myRole);
    await withFailover(pid => fsPatchRoom(pid, state.roomId, { eng6: { directChat: updated } }, ['eng6.directChat', 'updatedAt']));
    pollOnce();
  } catch (e) {
    alert('Không gửi được tin nhắn: ' + (e?.message || e));
  } finally {
    if (dom.sendBtn) dom.sendBtn.disabled = false;
  }
}

// ---------- Tin nhắn THOẠI (ghi âm 1 đoạn ngắn rồi gửi, bên kia mở nghe lại
// bất cứ lúc nào — khác với "Gọi thoại trực tiếp" bên dưới là nói chuyện
// NGAY LẬP TỨC). Lưu chung mảng eng6.directChat như tin nhắn chữ, chỉ khác
// field "type":"voice" + "data" (audio mã hoá base64) + "mime" + "durationSec".
// Giới hạn thời lượng ghi (VOICE_MSG_MAX_SEC) để tài liệu phòng trên Firestore
// không phình to quá nhanh (mỗi giây ghi âm ~ vài KB base64). ----------
async function sendDirectChatVoice(myRole, base64, mime, durationSec) {
  try {
    const room = await withFailover(pid => fsGetRoom(pid, state.roomId));
    const current = (room?.eng6?.directChat) || [];
    const updated = current.concat([{ from: myRole, type: 'voice', mime, data: base64, durationSec, at: Date.now() }]);
    if (state.room) { state.room = room; if (!state.room.eng6) state.room.eng6 = {}; state.room.eng6.directChat = updated; }
    renderDirectChatFor(myRole, true);
    await withFailover(pid => fsPatchRoom(pid, state.roomId, { eng6: { directChat: updated } }, ['eng6.directChat', 'updatedAt']));
    pollOnce();
  } catch (e) {
    alert('Không gửi được tin nhắn thoại: ' + (e?.message || e));
  }
}
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error || Error('Đọc file ghi âm thất bại'));
    r.readAsDataURL(blob);
  });
}
function pickVoiceMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
  return candidates.find(c => MediaRecorder.isTypeSupported(c)) || '';
}
function fmtMMSS(sec) { sec = Math.max(0, Math.floor(sec || 0)); const m = Math.floor(sec / 60), s = sec % 60; return m + ':' + String(s).padStart(2, '0'); }
async function startVoiceRecording() {
  if (state.voiceRecorder) return; // đang ghi rồi, bấm nữa không làm gì
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    alert('Trình duyệt này không hỗ trợ ghi âm tin nhắn thoại.'); return;
  }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { alert('Không dùng được micro: ' + (e?.message || e) + ' — hãy cho phép quyền micro cho trang này rồi thử lại.'); return; }
  const mimeType = pickVoiceMimeType();
  let rec;
  try { rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream); }
  catch (e) { stream.getTracks().forEach(t => t.stop()); alert('Không khởi tạo được bộ ghi âm: ' + (e?.message || e)); return; }
  const chunks = [];
  let cancelled = false;
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    clearInterval(state.voiceRecordTimerInt);
    $('voiceRecordingBar').style.display = 'none';
    const durationSec = Math.round((Date.now() - state.voiceRecordStartedAt) / 1000);
    state.voiceRecorder = null;
    if (cancelled || !chunks.length) return;
    try {
      const blob = new Blob(chunks, { type: rec.mimeType || mimeType || 'audio/webm' });
      const base64 = await blobToBase64(blob);
      await sendDirectChatVoice(state.role, base64, blob.type, durationSec);
    } catch (e) { alert('Không gửi được tin nhắn thoại: ' + (e?.message || e)); }
  };
  rec._cancel = () => { cancelled = true; };
  state.voiceRecorder = rec;
  state.voiceRecordStartedAt = Date.now();
  rec.start();
  $('voiceRecordingBar').style.display = 'flex';
  $('voiceRecordingTime').textContent = '0:00';
  state.voiceRecordTimerInt = setInterval(() => {
    const sec = (Date.now() - state.voiceRecordStartedAt) / 1000;
    $('voiceRecordingTime').textContent = fmtMMSS(sec);
    if (sec >= VOICE_MSG_MAX_SEC) stopVoiceRecording(true);
  }, 250);
}
function stopVoiceRecording(send) {
  const rec = state.voiceRecorder;
  if (!rec) return;
  if (!send) rec._cancel();
  if (rec.state !== 'inactive') rec.stop();
}
// Gọi mỗi vòng poll (miễn đang ở trong phòng) để tin nhắn 2 bên hiện gần như
// tức thời — trước đây chỉ cập nhật khi đúng khung chấm điểm/kết quả đang mở
// nên lỡ Cha/Con đang ở màn hình khác (vd đang làm bài, đang soạn đề mới)
// thì chat không chạy; giờ luôn chạy bất kể đang ở màn hình nào trong phòng.
function updateDirectChatUI() {
  if (state.roomId && state.role) renderDirectChatFor(state.role);
}
// ---------- Bong bóng chat nổi: mở/thu nhỏ + gửi tin + chuyển tab — gọi 1
// LẦN lúc khởi động trang (không phụ thuộc vai trò), tiêu đề khung tự đổi
// theo vai trò ngay khi vào phòng (xem enterRoom). Có 2 tab dùng chung cho
// CẢ Cha lẫn Con: "💬 Nhắn tin" (chat thật 2 chiều, đồng bộ qua phòng) và
// "🤖 Hỏi AI" (hỏi AI bất cứ lúc nào, không chỉ riêng lúc Cha đang chấm bài
// như trước — máy nào chưa cài Gemini API key sẽ báo lỗi khi bấm hỏi). ----------
function setFloatingChatTab(tab) {
  $('floatingTabDirectBtn').classList.toggle('is-active', tab === 'direct');
  $('floatingTabAiBtn').classList.toggle('is-active', tab === 'ai');
  $('floatingTabScratchBtn').classList.toggle('is-active', tab === 'scratch');
  $('floatingChatPanelDirect').classList.toggle('is-active', tab === 'direct');
  $('quickChatPanelAi').classList.toggle('is-active', tab === 'ai');
  $('floatingPanelScratch').classList.toggle('is-active', tab === 'scratch');
  if (tab === 'direct') markDirectChatSeen(state.role);
  // Tab "Nháp" vừa hiện ra thì canvas mới có kích thước thật (lúc ẩn là
  // 0x0) — phải đo lại kích thước rồi vẽ lại, nếu không canvas sẽ trống trơn.
  // Dùng 2 lớp requestAnimationFrame (thay vì setTimeout 0) để chắc chắn
  // trình duyệt đã chạy xong layout cho class "is-active" vừa toggle ở trên
  // trước khi đo — setTimeout 0 đôi khi vẫn chạy trước khi layout kịp cập nhật.
  if (tab === 'scratch') requestAnimationFrame(() => requestAnimationFrame(scratchResizeCanvas));
}
// Thu gọn/mở rộng: giống hệt "Chat nhóm" bên 3D Work Manager — bấm nút ▁ co
// hẳn khối vuông lại thành 1 bong bóng tròn 💬 nổi (không chỉ ẩn nội dung),
// bấm lại vào bong bóng đó để mở ra như cũ.
function setFloatingChatCollapsed(collapsed) {
  const box = $('floatingChatBox'), btn = $('floatingChatToggleBtn');
  box.classList.toggle('is-collapsed', collapsed);
  btn.textContent = collapsed ? '💬' : '▁';
  btn.title = collapsed ? 'Mở lại khung chat' : 'Thu gọn/Mở rộng';
  if (!collapsed && $('floatingTabDirectBtn').classList.contains('is-active')) markDirectChatSeen(state.role);
  // Vừa MỞ LẠI khung (từ bong bóng tròn) mà đang đứng ở tab "📝 Nháp" thì đo
  // lại canvas — lúc thu gọn nó bị co về 0x0 nên cần tính lại kích thước.
  if (!collapsed && $('floatingTabScratchBtn').classList.contains('is-active')) requestAnimationFrame(() => requestAnimationFrame(scratchResizeCanvas));
}
function initFloatingChat() {
  const box = $('floatingChatBox'), header = $('floatingChatHeader'), toggleBtn = $('floatingChatToggleBtn');

  // ---- Bấm nút ▁/💬 để thu gọn/mở rộng ----
  let suppressToggleClick = false; // vừa KÉO bong bóng đi chỗ khác -> lần "click" kế tiếp (do thả chuột ra đúng vị trí nút) không tính là bấm mở/thu
  toggleBtn.addEventListener('click', () => {
    if (suppressToggleClick) { suppressToggleClick = false; return; }
    setFloatingChatCollapsed(!box.classList.contains('is-collapsed'));
  });

  // ---- Kéo TỰ DO khắp màn hình bằng thanh tiêu đề (giữ chuột/ngón tay rồi
  // kéo) — hỗ trợ cả chuột lẫn cảm ứng, dựa hoàn toàn theo cách làm của
  // "Chat nhóm" bên 3D Work Manager: đổi từ "right/bottom cố định" (lúc đầu,
  // trước khi kéo lần nào) sang toạ độ "left/top" tuyệt đối ngay khi kéo. ----
  let dragging = false, dragStartX = 0, dragStartY = 0, boxStartLeft = 0, boxStartTop = 0, dragMoved = false;
  const DRAG_MOVE_THRESHOLD = 4; // px — dưới ngưỡng này tính là "bấm", không phải "kéo"

  function dragMove(clientX, clientY) {
    const dx = clientX - dragStartX, dy = clientY - dragStartY;
    if (!dragMoved && (Math.abs(dx) > DRAG_MOVE_THRESHOLD || Math.abs(dy) > DRAG_MOVE_THRESHOLD)) dragMoved = true;
    const rect = box.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - rect.width);
    const maxTop = Math.max(0, window.innerHeight - rect.height);
    box.style.right = 'auto'; box.style.bottom = 'auto';
    box.style.left = Math.max(0, Math.min(boxStartLeft + dx, maxLeft)) + 'px';
    box.style.top = Math.max(0, Math.min(boxStartTop + dy, maxTop)) + 'px';
  }
  function startDrag(clientX, clientY) {
    dragging = true; dragMoved = false; dragStartX = clientX; dragStartY = clientY;
    const rect = box.getBoundingClientRect();
    boxStartLeft = rect.left; boxStartTop = rect.top;
  }
  function endDrag() { dragging = false; if (dragMoved) suppressToggleClick = true; }
  function onMouseMove(e) { if (dragging) dragMove(e.clientX, e.clientY); }
  function onMouseUp() { endDrag(); document.removeEventListener('mousemove', onMouseMove); document.removeEventListener('mouseup', onMouseUp); }

  header.addEventListener('mousedown', (e) => {
    // Khi đang MỞ, bấm đúng vào nút ▁ hoặc tab thì để nguyên hành vi bấm
    // (không tính là bắt đầu kéo) — khi đang THU GỌN, nút 💬 phủ kín cả
    // header nên vẫn phải cho bắt đầu kéo từ đó (phân biệt bấm/kéo bằng
    // quãng đường di chuyển ở endDrag()).
    const collapsed = box.classList.contains('is-collapsed');
    if (!collapsed && e.target.closest('.floating-chat-toggle-btn, .quick-chat-tab-btn, .floating-chat-call-btn')) return;
    startDrag(e.clientX, e.clientY);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    e.preventDefault();
  });
  header.addEventListener('touchstart', (e) => {
    const collapsed = box.classList.contains('is-collapsed');
    if (!collapsed && e.target.closest('.floating-chat-toggle-btn, .quick-chat-tab-btn, .floating-chat-call-btn')) return;
    startDrag(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  header.addEventListener('touchmove', (e) => { if (dragging) dragMove(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
  header.addEventListener('touchend', () => endDrag());

  $('floatingTabDirectBtn').addEventListener('click', () => setFloatingChatTab('direct'));
  $('floatingTabAiBtn').addEventListener('click', () => setFloatingChatTab('ai'));
  $('floatingTabScratchBtn').addEventListener('click', () => setFloatingChatTab('scratch'));
  $('floatingChatSendBtn').addEventListener('click', () => sendDirectChat(state.role));
  $('floatingChatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendDirectChat(state.role); } });
  $('voiceMsgBtn').addEventListener('click', startVoiceRecording);
  $('voiceRecordStopBtn').addEventListener('click', () => stopVoiceRecording(true));
  $('voiceRecordCancelBtn').addEventListener('click', () => stopVoiceRecording(false));
  $('quickChatSendBtn').addEventListener('click', () => sendQuickChat());
  $('quickChatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendQuickChat(); } });
}
initFloatingChat();
initVoiceCall();

// ============================================================
// GIAO DIỆN CON
// ============================================================
const childIdlePanel = $('childIdlePanel'), childAssignedPanel = $('childAssignedPanel'),
  childExamPanel = $('childExamPanel'), childWaitingGradePanel = $('childWaitingGradePanel'), childResultPanel = $('childResultPanel');

function renderChild(m6) {
  childIdlePanel.style.display = 'none'; childAssignedPanel.style.display = 'none';
  childExamPanel.style.display = 'none'; childWaitingGradePanel.style.display = 'none'; childResultPanel.style.display = 'none';

  if (m6.status === 'idle') {
    childIdlePanel.style.display = 'block';
    clearInterval(state.timerInterval);
  } else if (m6.status === 'assigned') {
    childAssignedPanel.style.display = 'block';
    const exam = m6.exam || {};
    $('childAssignedInfo').textContent = `"${exam.title}" — Hình thức: ${modeLabel(exam.mode)} — Thời gian làm bài: ${exam.durationMinutes} phút — ${exam.questions?.length || 0} câu.`;
    clearInterval(state.timerInterval);
  } else if (m6.status === 'in_progress') {
    childExamPanel.style.display = 'block';
    // Định danh đề bằng "assignedAt" (mốc thời gian giao đề, 1 số nguyên cố định)
    // thay vì so JSON.stringify(toàn bộ đề) — vì thứ tự field trong JSON mà
    // Firestore REST trả về KHÔNG được đảm bảo giống nhau giữa các lần đọc,
    // dù nội dung đề hoàn toàn không đổi. Nếu dùng JSON.stringify, cứ vài giây
    // (mỗi lần poll) app lại tưởng "đề vừa đổi" rồi vẽ lại toàn bộ khung câu hỏi
    // từ đầu — xóa mất ô <textarea>/<input> Con đang gõ dở, khiến Con vừa bấm
    // vào ô trả lời là bị mất focus ngay lập tức.
    const examKey = m6.exam?.assignedAt ?? null;
    if (!state._examRendered || state._examRenderedFor !== examKey) renderExamForm(m6, examKey);
    startExamTimer(m6);
  } else if (m6.status === 'submitted') {
    childWaitingGradePanel.style.display = 'block';
    clearInterval(state.timerInterval);
  } else if (m6.status === 'returned') {
    childResultPanel.style.display = 'block';
    // Chỉ vẽ lại toàn bộ khung kết quả 1 LẦN cho mỗi lần trả bài (nhận diện bằng
    // "deliveredAt") — tránh cứ mỗi lần poll (1.5s/lần) lại vẽ lại từ đầu, làm
    // mất trạng thái đang thu gọn/mở của Con hay đang xem bong bóng góp ý dở.
    const resultKey = m6.result?.deliveredAt ?? null;
    if (state._resultRenderedFor !== resultKey) { renderChildResult(m6); state._resultRenderedFor = resultKey; }
    clearInterval(state.timerInterval);
  }
}
function modeLabel(mode) { return ({ mcq: 'Trắc nghiệm', essay: 'Tự luận', both: 'Trắc nghiệm + Tự luận' })[mode] || mode; }

// (Chat "Nhắn cho Cha" bên Con giờ dùng chung bong bóng chat nổi, xem initFloatingChat())

$('startExamBtn').addEventListener('click', async () => {
  const m6 = currentEng6();
  const submission = { studentName: state.displayName, startedAt: Date.now(), answers: [] };
  try {
    await withFailover(pid => fsPatchRoom(pid, state.roomId, { eng6: { status: 'in_progress', submission } }, ['eng6.status', 'eng6.submission', 'updatedAt']));
    state._examRendered = false;
    state.childAnswers = {};
    pollOnce();
  } catch (e) { alert('Không bắt đầu được: ' + (e?.message || e)); }
});

function renderExamForm(m6, examKey) {
  const exam = m6.exam || { questions: [] };
  const previousAnswers = state.childAnswers || {}; // giữ lại bài đang làm dở (phòng khi vẫn phải vẽ lại)
  state._examRendered = true;
  state._examRenderedFor = examKey !== undefined ? examKey : (exam.assignedAt ?? null);
  $('examRunningTitle').textContent = exam.title || '';
  const box = $('examQuestionsBox'); box.innerHTML = '';
  state.childAnswers = {};
  exam.questions.forEach((q, idx) => {
    const card = document.createElement('div'); card.className = 'q-run';
    if (q.listeningScript) {
      const listenWrap = document.createElement('div');
      listenWrap.innerHTML = listeningBoxHtml(q.listeningScript, 'Nghe đoạn hội thoại (có thể nghe lại nhiều lần)', q.id);
      card.appendChild(listenWrap.firstElementChild);
    }
    const p = document.createElement('div'); p.className = 'q-run-prompt';
    p.innerHTML = mathHtml((idx + 1) + '. ' + q.prompt + `  (${q.points} điểm)`);
    card.appendChild(p);
    const prev = previousAnswers[q.id];
    if (q.type === 'mcq') {
      q.options.forEach((opt, oi) => {
        const lbl = document.createElement('label'); lbl.className = 'q-run-opt';
        const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'run_' + q.id; radio.value = oi;
        if (prev && prev.type === 'mcq' && prev.selectedIndex === oi) radio.checked = true;
        radio.addEventListener('change', () => state.childAnswers[q.id] = { id: q.id, type: 'mcq', selectedIndex: oi });
        lbl.appendChild(radio);
        const span = document.createElement('span'); span.innerHTML = mathHtml(String.fromCharCode(65 + oi) + '. ' + opt);
        lbl.appendChild(span);
        card.appendChild(lbl);
      });
      if (prev && prev.type === 'mcq') state.childAnswers[q.id] = prev;
    } else {
      const ta = document.createElement('textarea'); ta.rows = 4; ta.placeholder = 'Trình bày bài làm của con...';
      if (prev && prev.type === 'essay') { ta.value = prev.text || ''; state.childAnswers[q.id] = prev; }
      // ---- Khung xem trước bài làm của Con — để Con tự đọc lại trước khi nộp. ----
      const answerPreviewBox = document.createElement('div'); answerPreviewBox.className = 'q-preview-box';
      const answerPreviewLabel = document.createElement('div'); answerPreviewLabel.className = 'q-preview-label'; answerPreviewLabel.textContent = '👁 Xem trước bài làm của con:';
      const answerPreviewContent = document.createElement('div'); answerPreviewContent.className = 'q-preview-content';
      answerPreviewBox.appendChild(answerPreviewLabel); answerPreviewBox.appendChild(answerPreviewContent);
      function refreshAnswerPreview() {
        const text = ta.value.trim();
        answerPreviewContent.innerHTML = text ? mathHtml(text) : '<span class="hint">(chưa nhập gì)</span>';
      }
      ta.addEventListener('input', () => { state.childAnswers[q.id] = { id: q.id, type: 'essay', text: ta.value }; refreshAnswerPreview(); });
      card.appendChild(ta);
      refreshAnswerPreview();
      card.appendChild(answerPreviewBox);
    }
    box.appendChild(card);
  });
}

function startExamTimer(m6) {
  if (state._timerBoundFor === m6.submission?.startedAt) return;
  state._timerBoundFor = m6.submission?.startedAt;
  clearInterval(state.timerInterval);
  const deadline = (m6.submission?.startedAt || Date.now()) + (m6.exam?.durationMinutes || 30) * 60000;
  function tick() {
    const remainMs = deadline - Date.now();
    const timerEl = $('examTimer');
    if (remainMs <= 0) {
      timerEl.textContent = '00:00';
      clearInterval(state.timerInterval);
      submitExam(true);
      return;
    }
    const totalSec = Math.floor(remainMs / 1000);
    const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const ss = String(totalSec % 60).padStart(2, '0');
    timerEl.textContent = mm + ':' + ss;
    timerEl.classList.toggle('low', totalSec <= 60);
  }
  tick();
  state.timerInterval = setInterval(tick, 1000);
}

$('submitExamBtn').addEventListener('click', () => {
  if (!confirm('Nộp bài ngay? Sau khi nộp sẽ không sửa được nữa.')) return;
  submitExam(false);
});

async function submitExam(auto) {
  if (state.submitting) return;
  state.submitting = true;
  const m6 = currentEng6();
  const answers = (m6.exam?.questions || []).map(q => state.childAnswers[q.id] || { id: q.id, type: q.type });
  try {
    await withFailover(pid => fsPatchRoom(pid, state.roomId,
      { eng6: { status: 'submitted', submission: { studentName: state.displayName, startedAt: m6.submission?.startedAt || Date.now(), submittedAt: Date.now(), answers, auto: !!auto } } },
      ['eng6.status', 'eng6.submission', 'updatedAt']));
    clearInterval(state.timerInterval);
    pollOnce();
  } catch (e) {
    alert('Không nộp được bài, thử lại: ' + (e?.message || e));
  } finally {
    state.submitting = false;
  }
}

function renderChildResult(m6) {
  const r = m6.result || {};
  const summary = $('childResultSummary'); summary.innerHTML = '';
  const big = document.createElement('div'); big.className = 'score-big'; big.textContent = `${r.totalScore} / ${r.maxScore} điểm`;
  summary.appendChild(big);
  if (r.overallComment) { const c = document.createElement('div'); c.style.marginTop = '8px'; c.innerHTML = mathHtml('💬 ' + r.overallComment); summary.appendChild(c); }

  const detail = $('childResultDetail'); detail.innerHTML = '';
  const resultItems = [];
  (r.perQuestion || []).forEach((q, idx) => {
    const isMcq = q.type === 'mcq';
    const correct = isMcq ? (q.score >= q.maxScore) : null;
    const card = document.createElement('div'); card.className = 'q-card result-detail-q' + (isMcq ? (correct ? ' correct' : ' wrong') : '');
    const item = { _collapsed: false, _cardEl: card };
    const head = document.createElement('div'); head.className = 'q-card-head';
    const headLeft = document.createElement('div'); headLeft.className = 'q-card-head-left';
    const shortText = (q.prompt || '').replace(/\s+/g, ' ').trim();
    const summaryLineText = (idx + 1) + '. ' + (shortText.length > 60 ? shortText.slice(0, 60) + '…' : shortText) + ` — ${q.score}/${q.maxScore} điểm`;
    const { collapseBtn, summaryLine } = addCollapseHead(card, headLeft, (idx + 1) + `. ${q.score}/${q.maxScore} điểm`, summaryLineText, item);
    collapseBtn.addEventListener('click', () => { item._collapsed = !item._collapsed; card.classList.toggle('is-collapsed', item._collapsed); resultCollapseAllUpdate(); });
    if (q.status) { const chip = document.createElement('span'); chip.innerHTML = statusChipHtml(q.status); if (chip.firstChild) headLeft.appendChild(chip.firstChild); }
    head.appendChild(headLeft); card.appendChild(head); card.appendChild(summaryLine);

    const bodyWrap = document.createElement('div'); bodyWrap.className = 'q-card-body';
    card.appendChild(bodyWrap);
    if (q.listeningScript) {
      const listenBox = document.createElement('div'); listenBox.className = 'hint';
      listenBox.innerHTML = listeningBoxHtml(q.listeningScript, 'Nghe lại', q.id) +
        '<div style="margin-top:4px">🎧 Transcript (đọc lại để ôn tập): ' + mathHtml(q.listeningScript) + '</div>';
      bodyWrap.appendChild(listenBox);
    }
    const promptLine = document.createElement('div'); promptLine.innerHTML = mathHtml(`${idx + 1}. ${q.prompt || ''}`); promptLine.style.marginBottom = '6px';
    bodyWrap.appendChild(promptLine);

    if (isMcq) {
      if (q.options) {
        const opt = document.createElement('div'); opt.className = 'hint';
        opt.innerHTML = mathHtml('Đáp án đúng: ' + q.options[q.correctIndex]);
        bodyWrap.appendChild(opt);
      }
      // ---- Cách làm đúng từng bước — chỉ hiện khi Con chọn SAI, giống hệt
      // khung bên câu tự luận, để Con hiểu vì sao sai chứ không chỉ thấy
      // mỗi đáp án đúng là gì. ----
      if (q.stepSolution && q.stepSolution.length) {
        const stepBox = document.createElement('div'); stepBox.innerHTML = buildStepSolutionHtml(q.stepSolution);
        bodyWrap.appendChild(stepBox);
      }
      if (q.tip) {
        const tipBox = document.createElement('div'); tipBox.innerHTML = buildTipHtml(q.tip);
        bodyWrap.appendChild(tipBox);
      }
    } else {
      // ---- Bài làm của Con, gạch chân/đánh dấu + bong bóng góp ý — y hệt phần
      // Cha đã xem lúc chấm — kèm cách làm đúng từng bước nếu chưa làm đúng hẳn. ----
      const ansBox = document.createElement('div'); ansBox.className = 'hint';
      ansBox.innerHTML = '📝 Bài làm của con: ' + (q.answerText ? annotatedAnswerHtml(q.answerText, q.annotations) : '<i>(không trả lời)</i>');
      bodyWrap.appendChild(ansBox);
      if (q.stepSolution && q.stepSolution.length) {
        const stepBox = document.createElement('div'); stepBox.innerHTML = buildStepSolutionHtml(q.stepSolution);
        bodyWrap.appendChild(stepBox);
      } else if (q.status === 'correct') {
        const ok = document.createElement('div'); ok.className = 'answer-ok-note'; ok.textContent = '✅ Con làm đúng và trình bày tốt!';
        bodyWrap.appendChild(ok);
      }
      if (q.tip) {
        const tipBox = document.createElement('div'); tipBox.innerHTML = buildTipHtml(q.tip);
        bodyWrap.appendChild(tipBox);
      }
    }
    if (q.feedback) { const fb = document.createElement('div'); fb.className = 'feedback'; fb.innerHTML = mathHtml('💬 ' + q.feedback); bodyWrap.appendChild(fb); }
    detail.appendChild(card);
    resultItems.push(item);
  });
  const resultCollapseAllUpdate = wireCollapseAllBtn($('resultCollapseAllBtn'), () => resultItems);
  // (Chat "Nhắn cho Cha" giờ nằm ở bong bóng chat nổi, chạy nền liên tục — xem updateDirectChatUI())
}

// ============================================================
// 📞 GỌI THOẠI TRỰC TIẾP (WebRTC, chỉ tiếng — khác "Tin nhắn thoại" ở trên
// là nói chuyện NGAY LẬP TỨC như gọi điện, không cần ghi âm rồi gửi).
//
// Không có máy chủ tín hiệu (signaling server) riêng nên dùng LẠI đúng
// tài liệu phòng Firestore hiện có làm nơi trao đổi offer/answer/ICE
// candidate — y hệt cách "eng6.exam"/"eng6.directChat" đang hoạt động:
// bên A ghi, bên B tự làm mới (poll mỗi 1.5s) rồi đọc, không có kênh đẩy
// tức thời. Kết quả: bấm gọi tới lúc 2 máy thật sự nghe được nhau có thể
// mất vài giây (khớp lệch tối đa ~1-2 vòng poll), chấp nhận được cho nhu
// cầu gọi thoại gia đình 2 người, không phải video call cho hàng trăm
// người. Âm thanh SAU KHI kết nối được thì đi THẲNG giữa 2 máy (P2P thật
// sự qua WebRTC), không qua lại Firestore.
//
// Giới hạn: chỉ dùng STUN công cộng (không có TURN riêng), nên nếu 1 trong
// 2 mạng thuộc loại NAT rất chặt (mạng công ty/trường học khoá cổng) có thể
// KHÔNG kết nối được — lúc đó dùng tạm "Tin nhắn thoại" ở trên thay thế.
//
// Dữ liệu lưu ở eng6.voiceCall = {
//   callId, status: 'ringing'|'active'|'ended'|'declined',
//   caller: 'parent'|'child', offer, answer,
//   candidates: { parent:[...], child:[...] },
//   startedAt, endedAt, endedBy,
// } — luôn đọc/ghi TOÀN BỘ object này mỗi lần đổi (giống cách "exam"/
// "directChat" đang làm), không dùng updateMask cho từng field con.
// ============================================================
function getOtherRole(role) { return role === 'parent' ? 'child' : 'parent'; }
function roleLabelVi(role) { return role === 'parent' ? 'Cha' : 'Con'; }
function newCallId() { return 'call_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }

let _rtcLocalCandidateQueue = [];
let _rtcFlushingCandidates = false;
function queueLocalIceCandidate(myRole, candidateJson) {
  _rtcLocalCandidateQueue.push(candidateJson);
  flushLocalIceCandidates(myRole);
}
async function flushLocalIceCandidates(myRole) {
  if (_rtcFlushingCandidates || !_rtcLocalCandidateQueue.length || !state.rtc.callId) return;
  _rtcFlushingCandidates = true;
  const toSend = _rtcLocalCandidateQueue.splice(0, _rtcLocalCandidateQueue.length);
  try {
    const room = await withFailover(pid => fsGetRoom(pid, state.roomId));
    const call = room?.eng6?.voiceCall;
    if (!call || call.callId !== state.rtc.callId) return; // cuộc gọi đã đổi/kết thúc trong lúc đang gửi — bỏ qua, không ghi nhầm sang cuộc mới
    const curList = (call.candidates && call.candidates[myRole]) || [];
    const updatedCall = { ...call, candidates: { ...call.candidates, [myRole]: curList.concat(toSend) } };
    await withFailover(pid => fsPatchRoom(pid, state.roomId, { eng6: { voiceCall: updatedCall } }, ['eng6.voiceCall', 'updatedAt']));
  } catch (e) {
    console.warn('[Gọi thoại] Gửi ICE candidate lỗi:', e?.message || e);
  } finally {
    _rtcFlushingCandidates = false;
    if (_rtcLocalCandidateQueue.length) flushLocalIceCandidates(myRole);
  }
}
function createVoiceCallPeerConnection(myRole) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  pc.onicecandidate = (e) => { if (e.candidate) queueLocalIceCandidate(myRole, e.candidate.toJSON()); };
  pc.ontrack = (e) => { const audioEl = $('voiceCallRemoteAudio'); if (audioEl) audioEl.srcObject = e.streams[0]; };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' && state.rtc.pc === pc) {
      $('voiceCallStatusText').textContent = '❌ Kết nối thất bại (có thể do mạng chặn) — bấm "Kết thúc" rồi thử lại, hoặc dùng tin nhắn thoại.';
    }
  };
  return pc;
}
function rtcCleanup() {
  const r = state.rtc;
  if (r.timerInt) clearInterval(r.timerInt);
  if (r.pc) { try { r.pc.close(); } catch { } }
  if (r.localStream) { try { r.localStream.getTracks().forEach(t => t.stop()); } catch { } }
  _rtcLocalCandidateQueue = [];
  state.rtc = { pc: null, localStream: null, callId: null, isCaller: false, appliedRemoteDescription: false, appliedCandidateCount: 0, timerInt: null, startedAt: 0, muted: false };
  const remoteAudio = $('voiceCallRemoteAudio'); if (remoteAudio) remoteAudio.srcObject = null;
  hideVoiceCallOverlay();
}
async function startVoiceCall() {
  if (state.rtc.pc) return;
  const call = currentEng6().voiceCall;
  if (call && call.status === 'ringing') { alert('Đang có 1 cuộc gọi khác trong phòng, chờ xử lý xong đã.'); return; }
  const myRole = state.role;
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { alert('Không dùng được micro: ' + (e?.message || e) + ' — hãy cho phép quyền micro cho trang này.'); return; }
  const callId = newCallId();
  const pc = createVoiceCallPeerConnection(myRole);
  stream.getTracks().forEach(t => pc.addTrack(t, stream));
  state.rtc.pc = pc; state.rtc.localStream = stream; state.rtc.callId = callId; state.rtc.isCaller = true;
  showVoiceCallOverlay('calling');
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await withFailover(pid => fsPatchRoom(pid, state.roomId,
      { eng6: { voiceCall: { callId, status: 'ringing', caller: myRole, offer: { type: offer.type, sdp: offer.sdp }, answer: null, candidates: { parent: [], child: [] }, startedAt: null, endedAt: null, endedBy: null } } },
      ['eng6.voiceCall', 'updatedAt']));
    pollOnce();
  } catch (e) {
    alert('Không gọi được: ' + (e?.message || e));
    rtcCleanup();
  }
}
async function acceptVoiceCall() {
  const call = currentEng6().voiceCall;
  if (!call || call.status !== 'ringing') return;
  const myRole = state.role, otherRole = getOtherRole(myRole);
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { alert('Không dùng được micro: ' + (e?.message || e) + ' — hãy cho phép quyền micro cho trang này.'); return; }
  const pc = createVoiceCallPeerConnection(myRole);
  stream.getTracks().forEach(t => pc.addTrack(t, stream));
  state.rtc.pc = pc; state.rtc.localStream = stream; state.rtc.callId = call.callId; state.rtc.isCaller = false;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(call.offer));
    const existingRemote = (call.candidates && call.candidates[otherRole]) || [];
    for (const c of existingRemote) { try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch { } }
    state.rtc.appliedCandidateCount = existingRemote.length;
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    const startedAt = Date.now();
    const room = await withFailover(pid => fsGetRoom(pid, state.roomId));
    const freshCall = room?.eng6?.voiceCall;
    if (!freshCall || freshCall.callId !== call.callId) { rtcCleanup(); return; } // bên gọi đã hủy trước khi mình kịp bắt máy
    await withFailover(pid => fsPatchRoom(pid, state.roomId,
      { eng6: { voiceCall: { ...freshCall, status: 'active', answer: { type: answer.type, sdp: answer.sdp }, startedAt } } },
      ['eng6.voiceCall', 'updatedAt']));
    state.rtc.appliedRemoteDescription = true;
    startVoiceCallTimer(startedAt);
    showVoiceCallOverlay('active');
    pollOnce();
  } catch (e) {
    alert('Không bắt máy được: ' + (e?.message || e));
    rtcCleanup();
  }
}
async function declineVoiceCall() {
  const call = currentEng6().voiceCall;
  try {
    if (call) {
      await withFailover(pid => fsPatchRoom(pid, state.roomId,
        { eng6: { voiceCall: { ...call, status: 'declined', endedBy: state.role, endedAt: Date.now() } } },
        ['eng6.voiceCall', 'updatedAt']));
    }
  } catch (e) { console.warn('[Gọi thoại] Từ chối cuộc gọi lỗi:', e?.message || e); }
  rtcCleanup();
  pollOnce();
}
async function endVoiceCall() {
  const myCallId = state.rtc.callId;
  rtcCleanup(); // dọn cục bộ trước để phản hồi UI tức thời, không chờ mạng
  if (!myCallId) return;
  try {
    const room = await withFailover(pid => fsGetRoom(pid, state.roomId));
    const freshCall = room?.eng6?.voiceCall;
    if (freshCall && freshCall.callId === myCallId && freshCall.status !== 'ended' && freshCall.status !== 'declined') {
      await withFailover(pid => fsPatchRoom(pid, state.roomId,
        { eng6: { voiceCall: { ...freshCall, status: 'ended', endedBy: state.role, endedAt: Date.now() } } },
        ['eng6.voiceCall', 'updatedAt']));
    }
  } catch (e) { console.warn('[Gọi thoại] Kết thúc cuộc gọi lỗi:', e?.message || e); }
  pollOnce();
}
function toggleMuteVoiceCall() {
  const stream = state.rtc.localStream;
  if (!stream) return;
  state.rtc.muted = !state.rtc.muted;
  stream.getAudioTracks().forEach(t => { t.enabled = !state.rtc.muted; });
  $('voiceCallMuteBtn').textContent = state.rtc.muted ? '🔊 Bật mic' : '🔇 Tắt mic';
}
function startVoiceCallTimer(startedAt) {
  state.rtc.startedAt = startedAt;
  clearInterval(state.rtc.timerInt);
  const tick = () => { const el = $('voiceCallTimer'); if (el) el.textContent = fmtMMSS((Date.now() - startedAt) / 1000); };
  tick();
  state.rtc.timerInt = setInterval(tick, 1000);
}
function showVoiceCallOverlay(mode) {
  const overlay = $('voiceCallOverlay');
  overlay.style.display = 'block';
  const statusEl = $('voiceCallStatusText'), timerEl = $('voiceCallTimer');
  const accept = $('voiceCallAcceptBtn'), decline = $('voiceCallDeclineBtn'),
    mute = $('voiceCallMuteBtn'), hangup = $('voiceCallHangupBtn'), cancel = $('voiceCallCancelBtn');
  [accept, decline, mute, hangup, cancel].forEach(b => { b.style.display = 'none'; });
  timerEl.style.display = 'none';
  const otherLabel = roleLabelVi(getOtherRole(state.role));
  if (mode === 'calling') {
    statusEl.textContent = `📞 Đang gọi cho ${otherLabel}...`;
    cancel.style.display = 'inline-block';
  } else if (mode === 'incoming') {
    statusEl.textContent = `📞 ${otherLabel} đang gọi tới...`;
    accept.style.display = 'inline-block';
    decline.style.display = 'inline-block';
  } else if (mode === 'active') {
    statusEl.textContent = `🔊 Đang gọi với ${otherLabel}`;
    timerEl.style.display = 'block';
    mute.textContent = state.rtc.muted ? '🔊 Bật mic' : '🔇 Tắt mic';
    mute.style.display = 'inline-block';
    hangup.style.display = 'inline-block';
  }
}
function hideVoiceCallOverlay() { const el = $('voiceCallOverlay'); if (el) el.style.display = 'none'; }
function flashVoiceCallMessage(msg) {
  // Báo ngắn lý do cuộc gọi kết thúc (bên kia từ chối/cúp máy) rồi tự ẩn —
  // dùng tạm đúng khung overlay gọi thoại, không cần thêm khung mới.
  const overlay = $('voiceCallOverlay'), statusEl = $('voiceCallStatusText');
  overlay.style.display = 'block';
  statusEl.textContent = msg;
  ['voiceCallAcceptBtn', 'voiceCallDeclineBtn', 'voiceCallMuteBtn', 'voiceCallHangupBtn', 'voiceCallCancelBtn'].forEach(id => { $(id).style.display = 'none'; });
  $('voiceCallTimer').style.display = 'none';
  setTimeout(() => { if ($('voiceCallStatusText').textContent === msg) hideVoiceCallOverlay(); }, 3000);
}
// Gọi mỗi vòng poll (trong render(), bất kể đang ở màn hình nào) để phát
// hiện cuộc gọi đến / cập nhật ICE candidate + trạng thái cuộc gọi đang có,
// giống hệt tinh thần updateDirectChatUI() ở trên.
function updateVoiceCallUI() {
  if (!state.roomId || !state.role) return;
  const call = currentEng6().voiceCall;
  const myRole = state.role, otherRole = getOtherRole(myRole);

  if (!call || call.status === 'ended' || call.status === 'declined') {
    if (state.rtc.callId && (!call || call.callId === state.rtc.callId)) {
      const reason = call?.status === 'declined' ? `❌ ${roleLabelVi(otherRole)} đã từ chối cuộc gọi.`
        : (call?.status === 'ended' && call.endedBy && call.endedBy !== myRole ? `📴 ${roleLabelVi(otherRole)} đã kết thúc cuộc gọi.` : null);
      rtcCleanup();
      if (reason) flashVoiceCallMessage(reason);
    }
    return;
  }

  if (call.status === 'ringing' && call.caller === otherRole && state.rtc.callId !== call.callId) {
    // Có cuộc gọi ĐẾN mà mình chưa xử lý — hiện chuông (đè cả khi lỡ đang dở
    // việc khác, dù trường hợp này rất hiếm vì mỗi phòng chỉ 2 người).
    if (state.rtc.pc) rtcCleanup();
    state.rtc.callId = call.callId; state.rtc.isCaller = false;
    showVoiceCallOverlay('incoming');
    return;
  }
  if (call.status === 'ringing') return; // đang chờ bên kia bắt máy (mình là người gọi) — overlay đã hiện từ lúc bấm gọi

  if (call.status === 'active' && state.rtc.callId === call.callId && state.rtc.pc) {
    if (state.rtc.isCaller && !state.rtc.appliedRemoteDescription && call.answer) {
      state.rtc.appliedRemoteDescription = true;
      state.rtc.pc.setRemoteDescription(new RTCSessionDescription(call.answer)).catch(e => console.warn('[Gọi thoại] setRemoteDescription lỗi:', e?.message || e));
    }
    const remoteList = (call.candidates && call.candidates[otherRole]) || [];
    for (let i = state.rtc.appliedCandidateCount; i < remoteList.length; i++) {
      state.rtc.pc.addIceCandidate(new RTCIceCandidate(remoteList[i])).catch(e => console.warn('[Gọi thoại] addIceCandidate lỗi:', e?.message || e));
    }
    state.rtc.appliedCandidateCount = remoteList.length;
    if (!state.rtc.startedAt) startVoiceCallTimer(call.startedAt || Date.now());
    showVoiceCallOverlay('active');
  }
}
function initVoiceCall() {
  $('voiceCallBtn').addEventListener('click', () => {
    if (state.rtc.pc) { alert('Đang có 1 cuộc gọi rồi — bấm "Kết thúc" trước khi gọi mới.'); return; }
    startVoiceCall();
  });
  $('voiceCallAcceptBtn').addEventListener('click', acceptVoiceCall);
  $('voiceCallDeclineBtn').addEventListener('click', declineVoiceCall);
  $('voiceCallHangupBtn').addEventListener('click', endVoiceCall);
  $('voiceCallCancelBtn').addEventListener('click', endVoiceCall);
  $('voiceCallMuteBtn').addEventListener('click', toggleMuteVoiceCall);
}

// ============================================================
// 📝 GIẤY NHÁP — tab THỨ 3 NGAY TRONG khung chat nổi sẵn có (không tách
// khung riêng), dùng CHUNG cho cả nhóm (Cha & Con). Khổ giấy XEM NHƯ VÔ
// HẠN (1 mặt phẳng không biên, kéo/phóng to-thu nhỏ tự do) thay vì khổ
// giấy cố định. Nét vẽ lưu ở nhánh RIÊNG "eng6.whiteboard" trong đúng tài
// liệu phòng Firestore sẵn có — KHÔNG đụng tới các nhánh khác (exam/
// submission/directChat/voiceCall...), và ăn theo đúng vòng poll ~1.5s
// (POLL_MS) đã chạy sẵn cho cả phòng nên không tốn thêm request mạng nào
// — xem renderScratchpadFromRoom() được gọi trong render() ở trên, và
// setFloatingChatTab('scratch') ở trên lo việc đo lại canvas mỗi khi tab
// này được mở ra (kể cả sau khi thu gọn/mở lại khung chat).
//
// Dữ liệu 1 nét vẽ (stroke), cố tình đặt tên trường ngắn cho gọn:
//   { by:'parent'|'child', c:'#rrggbb', w:<độ dày, đơn vị "giấy">,
//     p:[x1,y1,x2,y2,...] }
// "p" là toạ độ THẬT trên mặt giấy vô hạn (không phải toạ độ màn hình —
// màn hình chỉ là 1 khung nhìn (viewport) đang soi vào đâu đó trên mặt
// giấy, xác định bởi scratch.view.pan/zoom, và KHÔNG đồng bộ qua phòng —
// mỗi máy tự do phóng to/thu nhỏ/cuộn xem chỗ mình muốn, không ảnh hưởng
// máy kia). Giới hạn tối đa SCRATCH_MAX_STROKES nét gần nhất (bỏ nét CŨ
// NHẤT khi vượt) để tài liệu phòng trên Firestore không phình to vô tội
// vạ — giống đúng tinh thần giới hạn VOICE_MSG_MAX_SEC ở tin nhắn thoại.
// ============================================================
const SCRATCH_MAX_STROKES = 500;
const SCRATCH_MIN_POINT_GAP = 3; // px màn hình — bỏ bớt điểm quá sát nhau khi vẽ, đỡ nặng dữ liệu
const SCRATCH_ZOOM_MIN = 0.15, SCRATCH_ZOOM_MAX = 8;
const SCRATCH_RESIZE_DEADZONE = 16; // px — vùng chừa ở góc dưới-phải canvas, tránh chồng lấn tay cầm resize gốc của khung chat

const scratch = {
  canvas: null, ctx: null, wrap: null,
  view: { panX: 0, panY: 0, zoom: 1 },   // khung nhìn hiện tại trên mặt giấy vô hạn — CHỈ lưu cục bộ từng máy
  mode: 'draw',                          // 'draw' | 'pan'
  color: '#2f8f5b', widthPaper: 3,
  drawing: false, currentPoints: null,   // nét đang vẽ dở (toạ độ giấy), chưa gửi lên phòng
  panScreen: null,                       // toạ độ MÀN HÌNH lần trước khi đang kéo bảng (null = không đang kéo)
  activePointers: new Map(),             // phục vụ chụm 2 ngón để kéo/phóng
  pinch: null,
  remoteStrokes: [],                     // bản mới nhất lấy từ phòng (nét đã vẽ xong, của cả 2 bên)
  lastSyncedLen: -1,
  ro: null,
};

function scratchWorldToScreen(x, y) { return { sx: x * scratch.view.zoom + scratch.view.panX, sy: y * scratch.view.zoom + scratch.view.panY }; }
function scratchScreenToWorld(sx, sy) { return { x: (sx - scratch.view.panX) / scratch.view.zoom, y: (sy - scratch.view.panY) / scratch.view.zoom }; }

function scratchResizeCanvas(_retriesLeft) {
  if (!scratch.canvas || !scratch.wrap) return;
  // Nếu đang có 1 cử chỉ vẽ/kéo dở giữa chừng mà canvas lại đổi kích thước
  // (vd resize cửa sổ trình duyệt, xoay máy tính bảng...) thì toạ độ chuột
  // so với canvas coi như không còn đáng tin nữa — huỷ sạch cử chỉ đó thay
  // vì để nó tiếp tục chạy với toạ độ có thể bị lệch/giật.
  if (scratch.drawing || scratch.panScreen) {
    scratch.drawing = false; scratch.currentPoints = null; scratch.panScreen = null;
  }
  const dpr = window.devicePixelRatio || 1;
  const rect = scratch.wrap.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) {
    // Tab/khung đang ẩn (0x0) — hoặc vừa hiện ra nhưng trình duyệt chưa kịp
    // chạy xong layout ngay lúc này. Thay vì bỏ cuộc hẳn (dựa hết vào
    // ResizeObserver, đôi khi bắn hơi trễ ngay sau click), thử đo lại vài
    // lần qua requestAnimationFrame — nếu sau vài khung hình vẫn 0x0 thì
    // chắc chắn đang ẩn thật, để ResizeObserver lo nốt khi nó hiện ra.
    const retries = _retriesLeft === undefined ? 5 : _retriesLeft;
    if (retries > 0) requestAnimationFrame(() => scratchResizeCanvas(retries - 1));
    return;
  }
  scratch.canvas.width = Math.max(1, Math.round(rect.width * dpr));
  scratch.canvas.height = Math.max(1, Math.round(rect.height * dpr));
  scratch.canvas.style.width = rect.width + 'px';
  scratch.canvas.style.height = rect.height + 'px';
  scratchRedraw();
}

function scratchStrokePath(ctx, pts) {
  if (!pts || pts.length < 4) return;
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.stroke();
}

function scratchRedraw() {
  const ctx = scratch.ctx, canvas = scratch.canvas;
  if (!ctx || !canvas || !canvas.width || !canvas.height) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0f1520';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // ---- Lưới chấm mờ làm mốc thị giác trên mặt giấy vô hạn — tự giãn theo
  // mức zoom để khoảng cách hiện trên MÀN HÌNH giữa các chấm luôn dễ nhìn. ----
  const cssW = canvas.width / dpr, cssH = canvas.height / dpr;
  let step = 40;
  while (step * scratch.view.zoom < 22) step *= 2;
  while (step * scratch.view.zoom > 90) step /= 2;
  const topLeft = scratchScreenToWorld(0, 0), botRight = scratchScreenToWorld(cssW, cssH);
  const startX = Math.floor(topLeft.x / step) * step, startY = Math.floor(topLeft.y / step) * step;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = 'rgba(255,255,255,.08)';
  for (let gx = startX; gx <= botRight.x; gx += step) {
    for (let gy = startY; gy <= botRight.y; gy += step) {
      const s = scratchWorldToScreen(gx, gy);
      ctx.beginPath(); ctx.arc(s.sx, s.sy, 1.2, 0, Math.PI * 2); ctx.fill();
    }
  }

  // ---- Các nét đã vẽ xong (của mình + của người kia, lấy từ phòng) ----
  ctx.setTransform(scratch.view.zoom * dpr, 0, 0, scratch.view.zoom * dpr, scratch.view.panX * dpr, scratch.view.panY * dpr);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  scratch.remoteStrokes.forEach(s => {
    ctx.strokeStyle = s.c || '#2f8f5b';
    ctx.lineWidth = s.w || 3;
    scratchStrokePath(ctx, s.p);
  });
  // ---- Nét đang vẽ dở (chưa gửi lên phòng) ----
  if (scratch.currentPoints && scratch.currentPoints.length >= 4) {
    ctx.strokeStyle = scratch.color;
    ctx.lineWidth = scratch.widthPaper;
    scratchStrokePath(ctx, scratch.currentPoints);
  }
}

function scratchSetZoom(newZoom, anchorScreen) {
  const clamped = Math.max(SCRATCH_ZOOM_MIN, Math.min(SCRATCH_ZOOM_MAX, newZoom));
  const anchor = anchorScreen || { sx: (scratch.canvas.clientWidth || 0) / 2, sy: (scratch.canvas.clientHeight || 0) / 2 };
  const world = scratchScreenToWorld(anchor.sx, anchor.sy);
  scratch.view.zoom = clamped;
  scratch.view.panX = anchor.sx - world.x * clamped;
  scratch.view.panY = anchor.sy - world.y * clamped;
  $('scratchZoomLabel').textContent = Math.round(clamped * 100) + '%';
  scratchRedraw();
}

function scratchResetView() {
  scratch.view = { panX: (scratch.canvas.clientWidth || 0) / 2, panY: (scratch.canvas.clientHeight || 0) / 2, zoom: 1 };
  $('scratchZoomLabel').textContent = '100%';
  scratchRedraw();
}

// Đặt thẳng chế độ 'draw' hoặc 'pan' (KHÔNG đảo/toggle) — gọi lại nhiều lần
// với cùng 1 giá trị vẫn an toàn. Đồng thời bôi màu đúng nút đang bật để
// người dùng luôn thấy rõ mình đang ở chế độ nào, không phải đoán qua chữ
// trên nút như kiểu nút gộp trước đây.
function scratchSetMode(mode) {
  scratch.mode = (mode === 'pan') ? 'pan' : 'draw';
  // Bấm đổi chế độ cũng tiện thể dọn sạch mọi cử chỉ đang dở (nếu lỡ có
  // cờ nào bị kẹt từ trước) — coi như 1 cách "reset" thủ công luôn có sẵn.
  scratch.drawing = false;
  scratch.currentPoints = null;
  if (scratch.canvas) scratch.canvas.style.cursor = scratch.mode === 'draw' ? 'crosshair' : 'grab';
  const drawBtn = $('scratchModeDrawBtn'), panBtn = $('scratchModePanBtn');
  if (drawBtn) drawBtn.classList.toggle('is-active', scratch.mode === 'draw');
  if (panBtn) panBtn.classList.toggle('is-active', scratch.mode === 'pan');
}

// ---------- Đồng bộ nét vẽ qua phòng — giống hệt cách sendDirectChat() đang
// làm: đọc lại phòng mới nhất ngay trước khi ghi, để đỡ ghi đè mất nét của
// người kia vừa vẽ cùng lúc (chấp nhận trùng hiếm khi cả 2 cùng thả tay
// trong cùng khoảnh khắc, không cần transaction phức tạp). ----------
async function scratchPushStroke(stroke) {
  try {
    const room = await withFailover(pid => fsGetRoom(pid, state.roomId));
    const current = (room?.eng6?.whiteboard?.strokes) || [];
    let updated = current.concat([stroke]);
    if (updated.length > SCRATCH_MAX_STROKES) updated = updated.slice(updated.length - SCRATCH_MAX_STROKES);
    if (state.room) { state.room = room; if (!state.room.eng6) state.room.eng6 = {}; state.room.eng6.whiteboard = { strokes: updated }; }
    scratch.remoteStrokes = updated; scratch.lastSyncedLen = updated.length; scratchRedraw();
    await withFailover(pid => fsPatchRoom(pid, state.roomId, { eng6: { whiteboard: { strokes: updated } } }, ['eng6.whiteboard', 'updatedAt']));
  } catch (e) { console.warn('[Giấy nháp] Không gửi được nét vẽ:', e?.message || e); }
}
async function scratchUndoMine() {
  try {
    const room = await withFailover(pid => fsGetRoom(pid, state.roomId));
    const current = (room?.eng6?.whiteboard?.strokes) || [];
    let idx = -1;
    for (let i = current.length - 1; i >= 0; i--) { if (current[i].by === state.role) { idx = i; break; } }
    if (idx === -1) return;
    const updated = current.slice(0, idx).concat(current.slice(idx + 1));
    if (state.room) { state.room = room; if (!state.room.eng6) state.room.eng6 = {}; state.room.eng6.whiteboard = { strokes: updated }; }
    scratch.remoteStrokes = updated; scratch.lastSyncedLen = updated.length; scratchRedraw();
    await withFailover(pid => fsPatchRoom(pid, state.roomId, { eng6: { whiteboard: { strokes: updated } } }, ['eng6.whiteboard', 'updatedAt']));
  } catch (e) { alert('Không hoàn tác được: ' + (e?.message || e)); }
}
async function scratchClearAll() {
  if (!confirm('Xóa TOÀN BỘ giấy nháp (cả nét của Cha lẫn Con)?')) return;
  try {
    scratch.remoteStrokes = []; scratch.lastSyncedLen = 0; scratchRedraw();
    if (state.room) { if (!state.room.eng6) state.room.eng6 = {}; state.room.eng6.whiteboard = { strokes: [] }; }
    await withFailover(pid => fsPatchRoom(pid, state.roomId, { eng6: { whiteboard: { strokes: [] } } }, ['eng6.whiteboard', 'updatedAt']));
  } catch (e) { alert('Không xóa được: ' + (e?.message || e)); }
}

// Gọi từ render() mỗi vòng poll (~1.5s) — chỉ vẽ lại khi số nét khác với
// lần trước đã biết (có nét MỚI từ người kia), để khỏi giật hình lúc mình
// đang vẽ dở trên máy mình.
function renderScratchpadFromRoom(wb) {
  if (!scratch.canvas) return;
  const strokes = (wb && wb.strokes) || [];
  if (strokes.length === scratch.lastSyncedLen) return;
  scratch.lastSyncedLen = strokes.length;
  scratch.remoteStrokes = strokes;
  scratchRedraw();
}

function initScratchpad() {
  scratch.wrap = $('scratchCanvasWrap');
  scratch.canvas = $('scratchCanvas');
  scratch.ctx = scratch.canvas.getContext('2d');

  // ---- Đo lại canvas mỗi khi khung chat được kéo-giãn to/nhỏ (khung chat
  // vốn đã có "resize:both" — kéo góc để to ra thì canvas cũng phải to
  // theo, không thì bị méo/mờ vì kích thước canvas nội bộ không khớp CSS). ----
  scratch.ro = new ResizeObserver(() => scratchResizeCanvas());
  scratch.ro.observe(scratch.wrap);
  window.addEventListener('resize', scratchResizeCanvas);

  // ---- Thanh công cụ ----
  $('scratchColorInput').addEventListener('input', e => scratch.color = e.target.value);
  $('scratchWidthInput').addEventListener('input', e => scratch.widthPaper = Number(e.target.value) || 3);
  // ---- 2 nút RIÊNG cho Vẽ/Kéo (trước đây gộp 1 nút bấm-để-đảo-chế-độ:
  // nút hiện chữ "✏️ Vẽ" khi đang Ở chế độ vẽ, nhưng bấm vào NÓ lại ĐẢO
  // sang "✋ Kéo" — dễ hiểu lầm là "bấm để bật Vẽ" trong khi thực ra nó
  // tắt Vẽ, dẫn tới bấm xong rê chuột không ra nét nào cả. Giờ mỗi nút chỉ
  // làm đúng 1 việc, có gọi lại vẫn không sao (idempotent), và có bôi màu
  // để biết đang ở chế độ nào). ----
  scratchSetMode('draw');
  $('scratchModeDrawBtn').addEventListener('click', () => scratchSetMode('draw'));
  $('scratchModePanBtn').addEventListener('click', () => scratchSetMode('pan'));
  $('scratchZoomInBtn').addEventListener('click', () => scratchSetZoom(scratch.view.zoom * 1.25));
  $('scratchZoomOutBtn').addEventListener('click', () => scratchSetZoom(scratch.view.zoom / 1.25));
  $('scratchResetViewBtn').addEventListener('click', scratchResetView);
  $('scratchUndoBtn').addEventListener('click', scratchUndoMine);
  $('scratchClearBtn').addEventListener('click', scratchClearAll);

  // ---- Lăn chuột để phóng to/thu nhỏ quanh đúng vị trí con trỏ ----
  scratch.canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = scratch.canvas.getBoundingClientRect();
    const anchor = { sx: e.clientX - rect.left, sy: e.clientY - rect.top };
    scratchSetZoom(scratch.view.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), anchor);
  }, { passive: false });

  // ---- Vẽ tay / kéo bảng bằng Pointer Events (chuột + ngón tay + bút cảm ứng) ----
  //
  // QUAN TRỌNG: trước đây "đang kéo" (lastPanScreen) và "đang vẽ"
  // (scratch.drawing/currentPoints) là 2 bộ cờ ĐỘC LẬP, không được dọn cùng
  // lúc khi bắt đầu 1 cử chỉ mới, và lúc kết thúc (endPointer) lại kiểm tra
  // bằng 2 câu "if" TÁCH RỜI (không loại trừ nhau). Hễ 1 cử chỉ trước đó kết
  // thúc bất thường — menu chuột phải bật lên giữa lúc đang vẽ, mất pointer
  // capture, chụm 2 ngón rồi nhấc bớt 1 ngón — cờ cũ có thể bị KẸT lại true,
  // khiến lần kéo/vẽ SAU đó bị dính cả 2 hiệu lực cùng lúc, hoặc buông tay
  // kéo lại vô tình "chốt" luôn 1 nét vẽ ma. Giờ mọi cử chỉ mới đều dọn sạch
  // hết cờ trước khi quyết định vẽ hay kéo, và lúc kết thúc chỉ chốt ĐÚNG 1
  // loại kết quả dựa trên đúng loại cử chỉ vừa xảy ra.
  function canvasPoint(e) { const r = scratch.canvas.getBoundingClientRect(); return { sx: e.clientX - r.left, sy: e.clientY - r.top }; }
  function scratchResetGesture() {
    scratch.drawing = false;
    scratch.currentPoints = null;
    scratch.panScreen = null;
  }
  scratch.canvas.addEventListener('pointerdown', (e) => {
    // Lưới an toàn thứ 2 (ngoài khoảng chừa CSS ở góc canvas): nếu vẫn bấm
    // quá sát góc dưới-phải của canvas — đúng chỗ tay cầm resize gốc của
    // trình duyệt có thể lấn tới ở vài trình duyệt/độ phóng đại khác nhau —
    // thì bỏ qua hẳn, KHÔNG setPointerCapture, để trình duyệt tự lo việc
    // resize, tránh giành giật cùng 1 cử động chuột với việc vẽ/kéo.
    const rectForCorner = scratch.canvas.getBoundingClientRect();
    if (e.clientX >= rectForCorner.right - SCRATCH_RESIZE_DEADZONE && e.clientY >= rectForCorner.bottom - SCRATCH_RESIZE_DEADZONE) return;
    scratch.canvas.setPointerCapture(e.pointerId);
    const p = canvasPoint(e);
    scratch.activePointers.set(e.pointerId, p);
    if (scratch.activePointers.size === 2) {
      // Chụm 2 ngón -> luôn chuyển sang kéo/phóng, huỷ SẠCH mọi cử chỉ 1
      // ngón đang dở trước đó (vẽ HAY kéo đều huỷ, không được sót lại)
      scratchResetGesture();
      const pts = Array.from(scratch.activePointers.values());
      const dist = Math.hypot(pts[0].sx - pts[1].sx, pts[0].sy - pts[1].sy);
      const mid = { sx: (pts[0].sx + pts[1].sx) / 2, sy: (pts[0].sy + pts[1].sy) / 2 };
      scratch.pinch = { startDist: dist || 1, startZoom: scratch.view.zoom, startMid: mid, startPanX: scratch.view.panX, startPanY: scratch.view.panY };
      return;
    }
    if (scratch.activePointers.size > 1) return; // >2 điểm cùng lúc (hiếm) -> bỏ qua, tránh chồng cử chỉ
    // ---- LUÔN bắt đầu lại từ đầu cho MỖI cử chỉ mới: dọn sạch trạng thái
    // của cử chỉ TRƯỚC (nếu có sót) trước khi quyết định vẽ hay kéo lần này ----
    scratchResetGesture();
    if (scratch.mode === 'pan' || e.button === 1) {
      scratch.panScreen = p;
      scratch.canvas.style.cursor = 'grabbing';
      return;
    }
    scratch.drawing = true;
    const w = scratchScreenToWorld(p.sx, p.sy);
    scratch.currentPoints = [w.x, w.y];
  });
  scratch.canvas.addEventListener('pointermove', (e) => {
    const p = canvasPoint(e);
    if (scratch.activePointers.has(e.pointerId)) scratch.activePointers.set(e.pointerId, p);
    if (scratch.pinch && scratch.activePointers.size >= 2) {
      const pts = Array.from(scratch.activePointers.values()).slice(0, 2);
      const dist = Math.hypot(pts[0].sx - pts[1].sx, pts[0].sy - pts[1].sy) || 1;
      const mid = { sx: (pts[0].sx + pts[1].sx) / 2, sy: (pts[0].sy + pts[1].sy) / 2 };
      const newZoom = Math.max(SCRATCH_ZOOM_MIN, Math.min(SCRATCH_ZOOM_MAX, scratch.pinch.startZoom * (dist / scratch.pinch.startDist)));
      scratch.view.zoom = newZoom;
      scratch.view.panX = scratch.pinch.startPanX + (mid.sx - scratch.pinch.startMid.sx);
      scratch.view.panY = scratch.pinch.startPanY + (mid.sy - scratch.pinch.startMid.sy);
      $('scratchZoomLabel').textContent = Math.round(newZoom * 100) + '%';
      scratchRedraw();
      return;
    }
    if (scratch.panScreen) {
      scratch.view.panX += p.sx - scratch.panScreen.sx; scratch.view.panY += p.sy - scratch.panScreen.sy;
      scratch.panScreen = p; scratchRedraw(); return;
    }
    if (scratch.drawing && scratch.currentPoints) {
      const n = scratch.currentPoints.length;
      const lastScreen = scratchWorldToScreen(scratch.currentPoints[n - 2], scratch.currentPoints[n - 1]);
      if (Math.hypot(p.sx - lastScreen.sx, p.sy - lastScreen.sy) < SCRATCH_MIN_POINT_GAP) return;
      const w = scratchScreenToWorld(p.sx, p.sy);
      scratch.currentPoints.push(w.x, w.y);
      scratchRedraw();
    }
  });
  // Chốt cử chỉ khi buông tay/bút — dùng if/else-if để CHỈ chốt đúng 1 loại
  // kết quả (kéo HOẶC vẽ), không bao giờ chốt cả 2 dù cờ nào đó lỡ bị kẹt.
  function endPointer(e) {
    scratch.activePointers.delete(e.pointerId);
    if (scratch.pinch && scratch.activePointers.size < 2) scratch.pinch = null;
    if (scratch.activePointers.size > 0) return; // vẫn còn điểm khác đang giữ -> cử chỉ chưa thật sự kết thúc
    if (scratch.panScreen) {
      // Vừa xong 1 lượt KÉO thuần tuý -> không có nét nào để lưu cả
      scratch.canvas.style.cursor = scratch.mode === 'draw' ? 'crosshair' : 'grab';
    } else if (scratch.drawing && scratch.currentPoints && scratch.currentPoints.length >= 4) {
      // Vừa xong 1 nét VẼ thật sự (đủ điểm) -> mới chốt & đồng bộ lên phòng
      const stroke = { by: state.role, c: scratch.color, w: scratch.widthPaper, p: scratch.currentPoints };
      scratch.remoteStrokes = scratch.remoteStrokes.concat([stroke]);
      scratchPushStroke(stroke);
    }
    scratchResetGesture();
    scratchRedraw();
  }
  scratch.canvas.addEventListener('pointerup', endPointer);
  scratch.canvas.addEventListener('pointercancel', endPointer);
  scratch.canvas.addEventListener('pointerleave', (e) => { if (scratch.activePointers.size <= 1) endPointer(e); });
  // Lưới an toàn: một số trường hợp trình duyệt nhả pointer capture (mất
  // focus tab, menu chuột phải bật lên...) mà KHÔNG bắn pointerup/pointercancel
  // — nếu không bắt thêm sự kiện này thì cờ vẽ/kéo có thể bị kẹt mãi.
  scratch.canvas.addEventListener('lostpointercapture', endPointer);

  scratch.canvas.style.cursor = 'crosshair';
  requestAnimationFrame(scratchResizeCanvas);
}

// QUAN TRỌNG: initScratchpad() phải được gọi ở ĐÂY — sau khi "const scratch"
// (và mọi hàm scratchXxx khác) đã thật sự chạy xong dòng khai báo của nó.
// Trước đây initScratchpad() bị gọi sớm hơn nhiều, ngay sau initFloatingChat()/
// initVoiceCall() ở gần đầu file — lúc đó "const scratch" bên dưới CHƯA
// được gán giá trị (JS coi biến const nằm trong "temporal dead zone" cho tới
// đúng dòng khai báo của nó chạy qua). Dòng ĐẦU TIÊN trong initScratchpad()
// là "scratch.wrap = ..." nên nó ném ReferenceError ngay lập tức và dừng
// hẳn — nghĩa là TOÀN BỘ phần còn lại của hàm (gắn sự kiện cho nút Vẽ/Kéo,
// màu, độ dày nét, zoom, undo, xoá, và cả vẽ/kéo bằng chuột) không bao giờ
// được gắn — đây là lý do bấm gì cũng vô tác dụng, không phải chỉ riêng
// nút Vẽ/Kéo. Gọi lại ở cuối file như thế này thì "scratch" chắc chắn đã
// tồn tại xong xuôi.
initScratchpad();


// ============================================================
// 🎙️ CHẤM LỒNG TIẾNG TIẾNG ANH QUA VIDEO / AUDIO
//
// Cha đưa vào 1 file video hoặc audio con lồng tiếng (hoặc bấm ghi âm /
// quay video ngay tại chỗ), phần mềm gửi NGUYÊN file đó cho Gemini
// (dạng inlineData base64 — Gemini 2.5 nghe được audio và xem được
// video) kèm 1 prompt chấm điểm chi tiết, rồi nhận về JSON gồm:
//   - transcript      : chép lại ĐÚNG những gì nghe được (kể cả chỗ sai)
//   - scores          : điểm 6 tiêu chí (phát âm, trôi chảy, ngữ điệu,
//                       bám kịch bản, tốc độ, khớp hình)
//   - errors[]        : TỪNG TỪ phát âm sai + nghe thành gì + phải đọc
//                       thế nào + IPA + mốc thời gian trong file
//   - strengths / improvements / drills / overallComment
// Hiển thị thành 1 "phiếu chấm", in ra PDF được, gửi cho Con qua khung
// chat được.
//
// LƯU Ý KỸ THUẬT: file được gửi thẳng lên Gemini, KHÔNG ghi vào tài liệu
// phòng Firestore (1 video vài chục MB sẽ làm vỡ giới hạn 1MB/tài liệu).
// Giới hạn 1 request inline của Gemini ~20MB, nên chặn ở 18MB cho chắc.
// ============================================================

const DUB_MAX_BYTES = 18 * 1024 * 1024;  // ~18MB — trên mức này Gemini từ chối request inline
const DUB_REC_MAX_SEC = 180;             // tự dừng ghi sau 3 phút cho khỏi vượt dung lượng

const dub = {
  file: null,          // File hoặc Blob đang chọn
  fileName: '',
  isVideo: false,
  objectUrl: '',
  result: null,        // JSON kết quả chấm gần nhất
  recorder: null,
  recChunks: [],
  recStream: null,
  recTimer: null,
  recStartAt: 0,
  busy: false,
};

const DUB_LEVEL_TEXT = {
  grade6:  'Học sinh lớp 6 người Việt, mới học tiếng Anh vài năm — kỳ vọng vừa phải, đừng đòi hỏi như người bản xứ.',
  grade9:  'Học sinh THCS khá (lớp 8–9) người Việt — đã quen phát âm cơ bản, cần chuẩn hơn về âm cuối và trọng âm.',
  grade12: 'Học sinh THPT đang luyện thi — chấm theo tiêu chí gần với bài thi nói (IELTS Speaking / thi HSG).',
  adult:   'Người lớn dùng tiếng Anh cho công việc — ưu tiên sự rõ ràng, tự nhiên, dễ hiểu với người nghe quốc tế.',
};
const DUB_STRICT_TEXT = {
  gentle: 'Chấm NHẸ NHÀNG, khích lệ là chính: chỉ nêu 3–5 lỗi nặng nhất, lời phê ấm áp, điểm rộng tay.',
  normal: 'Chấm VỪA PHẢI, đúng chuẩn giáo viên trên lớp: nêu các lỗi đáng chú ý, khen chê cân bằng.',
  strict: 'Chấm KHẮT KHE theo chuẩn thi cử: bắt lỗi kỹ từng âm cuối, trọng âm, nối âm; trừ điểm rõ ràng.',
  native: 'Chấm RẤT KHẮT KHE, lấy chuẩn người bản xứ làm mốc: mọi sai lệch về âm, trọng âm, ngữ điệu đều phải nêu.',
};
const DUB_ACCENT_TEXT = {
  any: 'Chấp nhận cả giọng Anh-Anh lẫn Anh-Mỹ, miễn là nhất quán.',
  us:  'Lấy giọng Mỹ (General American) làm chuẩn đối chiếu, ví dụ âm /r/ cuối từ phải đọc rõ.',
  uk:  'Lấy giọng Anh (Received Pronunciation) làm chuẩn đối chiếu.',
};
const DUB_CRITERIA = [
  { key: 'pronunciation', label: '🗣️ Phát âm từng từ' },
  { key: 'fluency',       label: '🌊 Độ trôi chảy' },
  { key: 'intonation',    label: '🎵 Ngữ điệu & trọng âm' },
  { key: 'accuracy',      label: '📜 Bám đúng kịch bản' },
  { key: 'speed',         label: '⏱️ Tốc độ nói' },
  { key: 'sync',          label: '🎬 Khớp hình / khẩu hình' },
];

function initDubUiOnce() {
  if (state._dubUiInit) return;
  if (!$('dubFileInput')) return;   // phòng trường hợp chạy với bản index.html cũ
  state._dubUiInit = true;

  $('dubFileInput').addEventListener('change', () => {
    const f = $('dubFileInput').files[0] || null;
    if (f) setDubFile(f, f.name);
  });
  $('dubRecAudioBtn').addEventListener('click', () => startDubRecording(false));
  $('dubRecVideoBtn').addEventListener('click', () => startDubRecording(true));
  $('dubRecStopBtn').addEventListener('click', stopDubRecording);
  $('dubGradeBtn').addEventListener('click', gradeDubbingWithAI);
  $('dubPrintBtn').addEventListener('click', printDubReport);
  $('dubSendChildBtn').addEventListener('click', sendDubResultToChild);
}

function dubFmtSize(bytes) {
  if (!bytes) return '';
  return bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB';
}
function dubFmtClock(sec) {
  sec = Math.max(0, Math.round(sec));
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}

// Gemini bắt buộc phải có mimeType đúng; vài trình duyệt trả file.type rỗng
// (nhất là file kéo từ điện thoại vào) nên đoán thêm theo đuôi file.
function dubGuessMime(file, name) {
  const t = (file && file.type) || '';
  if (t) return t.split(';')[0];   // "video/webm;codecs=vp8" -> "video/webm"
  const ext = String(name || '').toLowerCase().split('.').pop();
  const map = {
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
    avi: 'video/x-msvideo', m4v: 'video/mp4', '3gp': 'video/3gpp',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
    ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', amr: 'audio/amr',
  };
  return map[ext] || 'application/octet-stream';
}

function setDubFile(fileOrBlob, name) {
  if (dub.objectUrl) { try { URL.revokeObjectURL(dub.objectUrl); } catch { } }
  dub.file = fileOrBlob;
  dub.fileName = name || 'ban_ghi';
  const mime = dubGuessMime(fileOrBlob, dub.fileName);
  dub.isVideo = mime.startsWith('video/');
  dub.objectUrl = URL.createObjectURL(fileOrBlob);

  const v = $('dubPreviewVideo'), a = $('dubPreviewAudio');
  v.style.display = 'none'; a.style.display = 'none';
  v.removeAttribute('src'); a.removeAttribute('src');
  const player = dub.isVideo ? v : a;
  player.src = dub.objectUrl;
  player.style.display = 'block';

  const tooBig = fileOrBlob.size > DUB_MAX_BYTES;
  $('dubFileInfo').innerHTML = (tooBig ? '⚠️ ' : '📎 ') +
    escapeHtml(dub.fileName) + ' — ' + dubFmtSize(fileOrBlob.size) +
    ' — ' + escapeHtml(mime) +
    (tooBig
      ? '<br><b style="color:#ff9d6b">File nặng quá (giới hạn ~18MB/lần chấm).</b> Hãy cắt ngắn đoạn lồng tiếng lại (khoảng 1–2 phút là đủ để chấm), hoặc dùng file chỉ có tiếng (mp3/m4a) thay cho video.'
      : '');
  $('dubResultBox').style.display = 'none';
  $('dubResultActions').style.display = 'none';
  dub.result = null;
}

// ---------- Ghi âm / quay video ngay trong app ----------
async function startDubRecording(wantVideo) {
  if (dub.recorder) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia(
      wantVideo ? { audio: true, video: { width: { ideal: 640 }, height: { ideal: 360 } } } : { audio: true }
    );
    dub.recStream = stream;
    dub.recChunks = [];
    // Ưu tiên định dạng Gemini đọc tốt; webm/opus rất nhẹ nên quay 2–3 phút vẫn thoải mái dưới 18MB.
    const prefer = wantVideo
      ? ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
      : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    const mimeType = prefer.find(m => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || '';
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    dub.recorder = rec;
    rec.ondataavailable = e => { if (e.data && e.data.size) dub.recChunks.push(e.data); };
    rec.onstop = () => {
      const type = (rec.mimeType || mimeType || (wantVideo ? 'video/webm' : 'audio/webm')).split(';')[0];
      const blob = new Blob(dub.recChunks, { type });
      const ext = type.includes('mp4') ? (wantVideo ? 'mp4' : 'm4a') : 'webm';
      blob.name = 'ban_ghi_' + Date.now() + '.' + ext;
      setDubFile(blob, blob.name);
      try { dub.recStream.getTracks().forEach(t => t.stop()); } catch { }
      dub.recorder = null; dub.recStream = null;
      clearInterval(dub.recTimer); dub.recTimer = null;
      $('dubRecStopBtn').style.display = 'none';
      $('dubRecTimer').style.display = 'none';
      $('dubRecAudioBtn').disabled = false; $('dubRecVideoBtn').disabled = false;
    };
    rec.start();
    dub.recStartAt = Date.now();
    $('dubRecStopBtn').style.display = 'inline-block';
    $('dubRecTimer').style.display = 'inline-block';
    $('dubRecAudioBtn').disabled = true; $('dubRecVideoBtn').disabled = true;

    // Xem trực tiếp khung hình khi đang quay video cho dễ canh khẩu hình.
    if (wantVideo) {
      const v = $('dubPreviewVideo');
      $('dubPreviewAudio').style.display = 'none';
      v.srcObject = stream; v.muted = true; v.style.display = 'block'; v.play().catch(() => { });
    }
    dub.recTimer = setInterval(() => {
      const sec = (Date.now() - dub.recStartAt) / 1000;
      $('dubRecTimer').textContent = '🔴 ' + dubFmtClock(sec);
      if (sec >= DUB_REC_MAX_SEC) stopDubRecording();
    }, 250);
  } catch (e) {
    alert('Không mở được micro/camera: ' + (e?.message || e) + '\nHãy bấm "Cho phép" khi trình duyệt hỏi quyền.');
  }
}
function stopDubRecording() {
  if (!dub.recorder) return;
  const v = $('dubPreviewVideo');
  if (v.srcObject) { v.srcObject = null; v.muted = false; }
  try { dub.recorder.stop(); } catch { }
}

// ---------- Prompt + gọi Gemini ----------
function buildDubPrompt() {
  const script = $('dubScriptInput').value.trim();
  const level = $('dubLevelSelect').value;
  const strict = $('dubStrictSelect').value;
  const accent = $('dubAccentSelect').value;
  const maxScore = parseInt($('dubMaxScoreSelect').value, 10) || 10;
  const checkSync = $('dubCheckSyncInput').checked && dub.isVideo;
  const extra = $('dubExtraPromptInput').value.trim();

  return [
    'Bạn là giáo viên tiếng Anh người Việt, đang chấm bài LỒNG TIẾNG / ĐỌC THÀNH TIẾNG tiếng Anh của học sinh.',
    'Học sinh đã gửi kèm 1 file ' + (dub.isVideo ? 'VIDEO (có cả hình và tiếng)' : 'ÂM THANH') + '. Hãy nghe thật kỹ toàn bộ file rồi chấm.',
    '',
    'BỐI CẢNH NGƯỜI HỌC: ' + (DUB_LEVEL_TEXT[level] || DUB_LEVEL_TEXT.grade6),
    'ĐỘ KHẮT KHE: ' + (DUB_STRICT_TEXT[strict] || DUB_STRICT_TEXT.normal),
    'GIỌNG CHUẨN ĐỐI CHIẾU: ' + (DUB_ACCENT_TEXT[accent] || DUB_ACCENT_TEXT.any),
    'THANG ĐIỂM: mỗi tiêu chí và điểm tổng đều cho theo thang ' + maxScore + ' (số thực, 1 chữ số thập phân).',
    checkSync
      ? 'CÓ CHẤM KHỚP HÌNH: hãy xem cả hình ảnh, đánh giá lời nói có khớp với khẩu hình / hành động / diễn biến trên màn hình không.'
      : 'KHÔNG CHẤM KHỚP HÌNH: đặt trường "sync" bằng null và bỏ qua tiêu chí này.',
    script
      ? 'KỊCH BẢN GỐC học sinh phải lồng đúng (đối chiếu từng câu với những gì thực sự nghe được, chỉ rõ chỗ đọc thiếu, thừa, sai từ, bỏ qua):\n"""\n' + script + '\n"""'
      : 'KHÔNG CÓ KỊCH BẢN GỐC: hãy tự chép lại lời nghe được và tự đánh giá; tiêu chí "accuracy" chấm theo việc dùng từ/ngữ pháp có đúng và tự nhiên không.',
    extra ? 'YÊU CẦU THÊM CỦA GIÁO VIÊN: ' + extra : '',
    '',
    'NGUYÊN TẮC BẮT BUỘC:',
    '1. Chỉ dựa vào những gì THỰC SỰ nghe được trong file. Tuyệt đối không bịa ra lỗi không có, cũng không bỏ qua lỗi có thật.',
    '2. Nếu file không có tiếng người nói tiếng Anh (im lặng, nhiễu, nói tiếng Việt...), đặt "usable" = false, ghi rõ lý do vào "overallComment", và để mọi điểm bằng 0.',
    '3. Mỗi lỗi phát âm phải chỉ rõ: từ nào, nghe thành cái gì, phải đọc thế nào, phiên âm IPA đúng, và mẹo sửa cụ thể cho người Việt (vd: "âm /θ/ phải đặt đầu lưỡi giữa 2 hàm răng, không đọc thành /t/ hay /s/").',
    '4. Ghi mốc thời gian gần đúng của mỗi lỗi theo dạng "m:ss" để người học tua lại nghe.',
    '4b. BẮT BUỘC: mỗi lỗi phải kèm trường "sentence" là NGUYÊN CẢ CÂU tiếng Anh ĐÚNG có chứa từ đó (lấy từ kịch bản gốc nếu có; nếu không có kịch bản thì lấy câu nghe được rồi sửa lại cho đúng ngữ pháp). Câu này dùng để người học luyện đọc lại nên phải là 1 câu hoàn chỉnh, không cắt cụt. Nhiều lỗi trong cùng 1 câu thì ghi Y HỆT cùng một chuỗi "sentence".',
    '4c. BẮT BUỘC: trường "sentences" phải liệt kê TOÀN BỘ các câu của bài theo ĐÚNG THỨ TỰ đọc từ đầu đến cuối (kể cả câu đọc đúng, không lỗi), mỗi câu ghi: "text" = câu tiếng Anh ĐÚNG, "start"/"end" = mốc bắt đầu và kết thúc của câu đó trong file tính bằng GIÂY (số thực, vd 12.4), "hasError" = true nếu câu đó có trong danh sách "errors", ngược lại false. Mốc thời gian phải bám sát thật vì sẽ dùng để CẮT đúng đoạn tiếng của từng câu, không được làm tròn ẩu.',
    '5. TOÀN BỘ phần nhận xét, mẹo sửa, lời phê viết bằng TIẾNG VIỆT dễ hiểu, thân thiện; riêng từ tiếng Anh và IPA thì giữ nguyên tiếng Anh.',
    '6. Lời phê chung phải nêu được: làm tốt chỗ nào, yếu nhất chỗ nào, và việc CẦN LUYỆN NGAY tuần này.',
    '',
    'Chỉ trả về DUY NHẤT 1 đối tượng JSON, không thêm chữ nào khác, theo đúng khuôn sau:',
    '{',
    '  "usable": true,',
    '  "spokenLanguage": "en",',
    '  "durationText": "1:24",',
    '  "transcript": "chép lại nguyên văn tiếng Anh những gì nghe được, kể cả chỗ đọc sai",',
    '  "scores": { "pronunciation": 0, "fluency": 0, "intonation": 0, "accuracy": 0, "speed": 0, "sync": null },',
    '  "criteriaComments": { "pronunciation": "nhận xét ngắn tiếng Việt", "fluency": "", "intonation": "", "accuracy": "", "speed": "", "sync": "" },',
    '  "totalScore": 0,',
    '  "maxScore": ' + maxScore + ',',
    '  "cefr": "A1 | A2 | B1 | B2 | C1",',
    '  "wpm": 0,',
    '  "scriptDiff": [ { "expected": "câu trong kịch bản", "heard": "câu thực sự nghe được", "issue": "đọc thiếu từ \\"the\\"" } ],',
    '  "sentences": [ { "text": "There are three books on the table.", "start": 0.0, "end": 3.2, "hasError": true } ],',
    '  "errors": [ { "time": "0:12", "word": "three", "heard": "tree", "correct": "three", "ipa": "/θriː/", "type": "âm đầu | âm cuối | trọng âm | nguyên âm | nối âm | ngữ điệu", "sentence": "There are three books on the table.", "tip": "mẹo sửa cụ thể bằng tiếng Việt" } ],',
    '  "strengths": ["điểm mạnh 1", "điểm mạnh 2"],',
    '  "improvements": ["việc cần sửa 1", "việc cần sửa 2"],',
    '  "drills": ["bài luyện cụ thể 1 (vd: đọc to 10 lần chuỗi three - free - tree)", "bài luyện 2"],',
    '  "overallComment": "lời phê chung 3–5 câu bằng tiếng Việt"',
    '}',
  ].filter(Boolean).join('\n');
}

async function gradeDubbingWithAI() {
  if (dub.busy) return;
  const statusEl = $('dubGradeStatus');
  if (!dub.file) { statusEl.textContent = '⚠️ Chưa chọn file video/audio nào. Hãy chọn file hoặc bấm ghi âm trực tiếp.'; return; }
  if (dub.file.size > DUB_MAX_BYTES) {
    statusEl.textContent = '⚠️ File nặng ' + dubFmtSize(dub.file.size) + ', vượt giới hạn ~18MB mỗi lần chấm. Hãy cắt ngắn đoạn lồng tiếng hoặc tách riêng phần tiếng (mp3/m4a) rồi thử lại.';
    return;
  }
  if (!getAllUsableApiKeys().length) {
    statusEl.textContent = '⚠️ Chưa có Gemini API Key. Bấm ⚙️ Cài Gemini API ở phía trên để nhập.';
    return;
  }

  dub.busy = true;
  $('dubGradeBtn').disabled = true;
  statusEl.textContent = '⏳ Đang tải file lên và nhờ AI nghe... (file càng dài càng lâu, thường 20–60 giây)';
  $('dubResultBox').style.display = 'none';
  $('dubResultActions').style.display = 'none';

  try {
    const base64 = await fileToBase64(dub.file);
    const mime = dubGuessMime(dub.file, dub.fileName);
    const parts = [
      { inlineData: { mimeType: mime, data: base64 } },
      { text: buildDubPrompt() },
    ];
    const text = await callGemini(parts, { expectJson: true });
    const data = parseJsonLoose(text);
    dub.result = data;
    renderDubResult(data);
    statusEl.textContent = '✅ Đã chấm xong.';
  } catch (e) {
    console.error('[Chấm lồng tiếng] lỗi:', e);
    statusEl.textContent = '❌ Chấm không được: ' + (e?.message || e);
  } finally {
    dub.busy = false;
    $('dubGradeBtn').disabled = false;
  }
}

// ---------- Hiển thị phiếu chấm ----------
function dubScoreColor(score, max) {
  const p = max ? (Number(score) || 0) / max : 0;
  if (p >= 0.8) return '#4ad07f';
  if (p >= 0.65) return '#8ecbff';
  if (p >= 0.5) return '#ffcf6b';
  return '#ff8f8f';
}
function dubListHtml(arr, icon) {
  if (!Array.isArray(arr) || !arr.length) return '';
  return '<ul class="dub-list">' + arr.map(x => '<li>' + icon + ' ' + escapeHtml(String(x)) + '</li>').join('') + '</ul>';
}

function renderDubResult(d) {
  const box = $('dubResultBox');
  const max = Number(d.maxScore) || parseInt($('dubMaxScoreSelect').value, 10) || 10;
  const scores = d.scores || {};
  const comments = d.criteriaComments || {};
  let html = '';

  if (d.usable === false) {
    html += '<div class="dub-warning">⚠️ AI không chấm được file này. ' + escapeHtml(d.overallComment || 'Không nghe thấy phần nói tiếng Anh nào rõ ràng.') + '</div>';
    box.innerHTML = html;
    box.style.display = 'block';
    $('dubResultActions').style.display = 'none';
    return;
  }

  const total = Number(d.totalScore) || 0;
  html += '<div class="dub-total" style="border-color:' + dubScoreColor(total, max) + '">' +
    '<div class="dub-total-score" style="color:' + dubScoreColor(total, max) + '">' + (Math.round(total * 10) / 10) + '<span>/' + max + '</span></div>' +
    '<div class="dub-total-meta">' +
      (d.cefr ? '<span class="dub-chip">Trình độ ước lượng: <b>' + escapeHtml(String(d.cefr)) + '</b></span>' : '') +
      (d.wpm ? '<span class="dub-chip">Tốc độ: <b>' + escapeHtml(String(d.wpm)) + ' từ/phút</b></span>' : '') +
      (d.durationText ? '<span class="dub-chip">Thời lượng: <b>' + escapeHtml(String(d.durationText)) + '</b></span>' : '') +
    '</div></div>';

  // Bảng 6 tiêu chí
  html += '<div class="dub-criteria">';
  DUB_CRITERIA.forEach(c => {
    const s = scores[c.key];
    if (s === null || s === undefined) return;
    const pct = Math.max(0, Math.min(100, (Number(s) / max) * 100));
    html += '<div class="dub-crit-row">' +
      '<div class="dub-crit-head"><span>' + c.label + '</span><b style="color:' + dubScoreColor(s, max) + '">' + (Math.round(Number(s) * 10) / 10) + '/' + max + '</b></div>' +
      '<div class="dub-bar"><i style="width:' + pct + '%;background:' + dubScoreColor(s, max) + '"></i></div>' +
      (comments[c.key] ? '<div class="dub-crit-note">' + escapeHtml(String(comments[c.key])) + '</div>' : '') +
      '</div>';
  });
  html += '</div>';

  if (d.transcript) {
    html += '<div class="dub-section"><b>📝 AI nghe được:</b><div class="dub-transcript">' + escapeHtml(String(d.transcript)) + '</div></div>';
  }

  if (Array.isArray(d.scriptDiff) && d.scriptDiff.length) {
    html += '<div class="dub-section"><b>📜 So với kịch bản gốc:</b><table class="dub-table"><tr><th>Kịch bản</th><th>Con đọc thành</th><th>Vấn đề</th></tr>' +
      d.scriptDiff.map(r => '<tr><td>' + escapeHtml(String(r.expected || '')) + '</td><td>' + escapeHtml(String(r.heard || '')) + '</td><td>' + escapeHtml(String(r.issue || '')) + '</td></tr>').join('') +
      '</table></div>';
  }

  if (Array.isArray(d.errors) && d.errors.length) {
    html += '<div class="dub-section"><b>🔎 Lỗi phát âm chi tiết (' + d.errors.length + ' lỗi):</b>';
    d.errors.forEach(er => {
      html += '<div class="dub-err">' +
        '<div class="dub-err-head">' +
          (er.time ? '<span class="dub-time">⏱ ' + escapeHtml(String(er.time)) + '</span>' : '') +
          '<span class="dub-err-word">' + escapeHtml(String(er.word || '')) + '</span>' +
          (er.ipa ? '<span class="dub-ipa">' + escapeHtml(String(er.ipa)) + '</span>' : '') +
          (er.type ? '<span class="dub-err-type">' + escapeHtml(String(er.type)) + '</span>' : '') +
          (er.word ? '<button type="button" class="dub-speak-btn" data-word="' + escapeHtml(String(er.correct || er.word)) + '" title="Nghe đọc mẫu">🔊</button>' : '') +
        '</div>' +
        (er.heard ? '<div class="dub-err-line">❌ Nghe thành: <b>' + escapeHtml(String(er.heard)) + '</b> &nbsp;→&nbsp; ✅ Đúng phải là: <b>' + escapeHtml(String(er.correct || er.word || '')) + '</b></div>' : '') +
        (er.sentence ? '<div class="dub-err-sentence">📌 Câu chứa lỗi: <b>' + escapeHtml(String(er.sentence)) + '</b></div>' : '') +
        (er.tip ? '<div class="dub-err-tip">💡 ' + escapeHtml(String(er.tip)) + '</div>' : '') +
        '</div>';
    });
    html += '</div>';
  }

  // Khu LUYỆN LẠI TỪNG CÂU — render riêng bằng JS (có nút bấm + ghi âm) nên
  // chỉ chừa sẵn 1 cái hộc rỗng ở đây, lát nữa buildDubPractice() đổ vào.
  html += '<div class="dub-section"><b>🔁 Luyện lại từng câu sai:</b><div id="dubPracticeBox" class="dub-practice-box"></div></div>';
  if (Array.isArray(d.strengths) && d.strengths.length) html += '<div class="dub-section"><b>💪 Làm tốt:</b>' + dubListHtml(d.strengths, '✅') + '</div>';  if (Array.isArray(d.improvements) && d.improvements.length) html += '<div class="dub-section"><b>🛠️ Cần sửa:</b>' + dubListHtml(d.improvements, '🔸') + '</div>';
  if (Array.isArray(d.drills) && d.drills.length) html += '<div class="dub-section"><b>🏋️ Bài luyện gợi ý:</b>' + dubListHtml(d.drills, '▶️') + '</div>';
  if (d.overallComment) html += '<div class="dub-section dub-overall"><b>🧑‍🏫 Lời phê chung:</b><div>' + escapeHtml(String(d.overallComment)) + '</div></div>';

  box.innerHTML = html;
  box.style.display = 'block';
  $('dubResultActions').style.display = 'flex';

  // Nút 🔊 đọc mẫu từ đúng — dùng lại speakEnglish() sẵn có của phần nghe hiểu.
  box.querySelectorAll('.dub-speak-btn').forEach(btn => {
    btn.addEventListener('click', () => speakEnglish(btn.dataset.word || ''));
  });

  buildDubPractice(d);
}

// ---------- In / xuất PDF phiếu chấm ----------
function printDubReport() {
  const d = dub.result;
  if (!d) return;
  const max = Number(d.maxScore) || 10;
  const rows = DUB_CRITERIA
    .filter(c => d.scores && d.scores[c.key] !== null && d.scores[c.key] !== undefined)
    .map(c => '<tr><td>' + c.label + '</td><td style="text-align:center"><b>' + (Math.round(Number(d.scores[c.key]) * 10) / 10) + '/' + max + '</b></td><td>' + escapeHtml(String((d.criteriaComments || {})[c.key] || '')) + '</td></tr>')
    .join('');
  const errRows = (Array.isArray(d.errors) ? d.errors : [])
    .map(er => '<tr><td>' + escapeHtml(String(er.time || '')) + '</td><td><b>' + escapeHtml(String(er.word || '')) + '</b> ' + escapeHtml(String(er.ipa || '')) + '</td><td>' + escapeHtml(String(er.heard || '')) + ' → ' + escapeHtml(String(er.correct || '')) + '</td><td>' + escapeHtml(String(er.tip || '')) + '</td></tr>')
    .join('');
  const html = '<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>Phiếu chấm lồng tiếng</title>' +
    '<style>body{font-family:"Times New Roman",serif;color:#000;max-width:800px;margin:24px auto;line-height:1.5}' +
    'h1{font-size:20px;text-align:center;margin-bottom:4px}h2{font-size:15px;margin:18px 0 6px;border-bottom:1px solid #000}' +
    'table{width:100%;border-collapse:collapse;margin-top:6px}td,th{border:1px solid #666;padding:5px 7px;font-size:13px;vertical-align:top}' +
    '.total{text-align:center;font-size:22px;font-weight:bold;margin:10px 0}.meta{text-align:center;font-size:13px}' +
    '.quote{border-left:3px solid #666;padding-left:10px;font-style:italic;font-size:13px}</style></head><body>' +
    '<h1>PHIẾU CHẤM LỒNG TIẾNG TIẾNG ANH</h1>' +
    '<div class="meta">File: ' + escapeHtml(dub.fileName) + ' — Ngày chấm: ' + new Date().toLocaleString('vi-VN') + '</div>' +
    '<div class="total">' + (Math.round((Number(d.totalScore) || 0) * 10) / 10) + ' / ' + max +
      (d.cefr ? ' &nbsp;(' + escapeHtml(String(d.cefr)) + ')' : '') + '</div>' +
    '<h2>1. Điểm theo tiêu chí</h2><table><tr><th>Tiêu chí</th><th>Điểm</th><th>Nhận xét</th></tr>' + rows + '</table>' +
    (d.transcript ? '<h2>2. AI nghe được</h2><div class="quote">' + escapeHtml(String(d.transcript)) + '</div>' : '') +
    (errRows ? '<h2>3. Lỗi phát âm chi tiết</h2><table><tr><th>Phút</th><th>Từ / IPA</th><th>Nghe thành → Đúng</th><th>Cách sửa</th></tr>' + errRows + '</table>' : '') +
    (Array.isArray(d.improvements) && d.improvements.length ? '<h2>4. Cần sửa</h2><ul>' + d.improvements.map(x => '<li>' + escapeHtml(String(x)) + '</li>').join('') + '</ul>' : '') +
    (Array.isArray(d.drills) && d.drills.length ? '<h2>5. Bài luyện gợi ý</h2><ul>' + d.drills.map(x => '<li>' + escapeHtml(String(x)) + '</li>').join('') + '</ul>' : '') +
    (d.overallComment ? '<h2>6. Lời phê chung</h2><div class="quote">' + escapeHtml(String(d.overallComment)) + '</div>' : '') +
    (dubPractice.items && dubPractice.items.some(it => it.attempts.length)
      ? '<h2>7. Luyện lại từng câu</h2><table><tr><th>Câu</th><th>Số lần thử</th><th>Điểm lần cuối</th><th>Kết quả</th></tr>' +
        dubPractice.items.filter(it => it.attempts.length).map(it => {
          const last = it.attempts[it.attempts.length - 1];
          const m = it.maxScore || 10;
          return '<tr><td>' + escapeHtml(it.sentence) + '</td><td style="text-align:center">' + it.attempts.length + '</td><td style="text-align:center"><b>' + (Math.round(Number(last.score) * 10) / 10) + '/' + m + '</b></td><td>' + (Number(last.score) >= m * DUB_PASS_RATIO ? 'Đạt' : 'Chưa đạt') + (last.comment ? ' — ' + escapeHtml(String(last.comment)) : '') + '</td></tr>';
        }).join('') + '</table>'
      : '') +
    '<p style="text-align:right;margin-top:30px;font-size:13px">Người chấm (ký, ghi rõ họ tên)</p>' +
    '</body></html>';
  const w = window.open('', '_blank');
  if (!w) { alert('Trình duyệt chặn cửa sổ in. Hãy cho phép pop-up rồi thử lại.'); return; }
  w.document.write(html); w.document.close();
  setTimeout(() => { try { w.print(); } catch { } }, 400);
}

// ---------- Gửi tóm tắt nhận xét cho Con qua khung chat có sẵn ----------
async function sendDubResultToChild() {
  const d = dub.result;
  if (!d) return;
  if (!state.roomId) { alert('Chưa vào phòng nào nên chưa gửi cho Con được.'); return; }
  const max = Number(d.maxScore) || 10;
  const lines = ['🎙️ KẾT QUẢ CHẤM LỒNG TIẾNG: ' + (Math.round((Number(d.totalScore) || 0) * 10) / 10) + '/' + max + (d.cefr ? ' (' + d.cefr + ')' : '')];
  const errs = Array.isArray(d.errors) ? d.errors.slice(0, 5) : [];
  if (errs.length) {
    lines.push('Lỗi cần sửa:');
    errs.forEach(er => lines.push('• ' + (er.word || '') + ' ' + (er.ipa || '') + (er.heard ? ' — con đọc thành "' + er.heard + '"' : '') + (er.tip ? ' — ' + er.tip : '')));
  }
  if (d.overallComment) lines.push('Lời phê: ' + d.overallComment);
  try {
    await sendDirectChat('parent', lines.join('\n'));
    $('dubGradeStatus').textContent = '✅ Đã gửi nhận xét cho Con qua khung chat.';
  } catch (e) {
    alert('Không gửi được: ' + (e?.message || e));
  }
}


// ============================================================
// 🔁 LUYỆN LẠI TỪNG CÂU SAI — vòng lặp "thu lại → AI chấm → sửa tiếp"
//
// Sau khi chấm cả bài, phần mềm gom các lỗi lại THEO CÂU (trường
// "sentence" mà AI trả về cho từng lỗi). Mỗi câu thành 1 thẻ luyện tập
// có: câu đúng đầy đủ, các từ sai trong câu đó, nút 🔊 nghe đọc mẫu cả
// câu (dùng giọng đọc sẵn có của trình duyệt), và nút 🎤 thu lại câu này.
//
// Thu xong, phần mềm gửi RIÊNG đoạn ghi âm ngắn đó lên Gemini kèm đúng
// câu chuẩn để chấm lại CHỈ 1 CÂU (nhanh, nhẹ, vài giây). Kết quả lưu
// thành 1 "lần thử" trong lịch sử của câu đó — thu bao nhiêu lần cũng
// được, tới khi nào người học thấy hài lòng thì thôi (hoặc bấm "✔️ Ổn
// rồi" để đánh dấu xong). Điểm ≥ 80% thang điểm thì tự gắn nhãn ĐẠT.
// ============================================================

const DUB_PASS_RATIO = 0.8;         // ≥ 80% thang điểm coi như đạt
const DUB_RETRY_MAX_SEC = 30;       // 1 câu thì 30 giây là quá đủ

// dubPractice[sentenceKey] = { sentence, errors:[], attempts:[], done:false, recorder, ... }
const dubPractice = { items: [], rec: null, recStream: null, recTimer: null, recIdx: -1, recStartAt: 0, busyIdx: -1 };

function dubNormSentence(s) { return String(s || '').trim().replace(/\s+/g, ' '); }

function buildDubPractice(d) {
  const box = $('dubPracticeBox');
  if (!box) return;
  const max = Number(d.maxScore) || parseInt($('dubMaxScoreSelect').value, 10) || 10;

  // Gom lỗi theo câu (khớp bằng chuỗi câu đã chuẩn hoá khoảng trắng + chữ thường)
  const errByKey = new Map();
  (Array.isArray(d.errors) ? d.errors : []).forEach(er => {
    const s = dubNormSentence(er.sentence);
    if (!s) return;
    const key = s.toLowerCase();
    if (!errByKey.has(key)) errByKey.set(key, []);
    errByKey.get(key).push(er);
  });

  const items = [];
  if (Array.isArray(d.sentences) && d.sentences.length) {
    // Bản đầy đủ: AI trả về TOÀN BỘ câu của bài kèm mốc thời gian — câu đọc
    // đúng cũng được giữ lại (cắt sẵn từ file gốc) để lát nữa ghép thành bài.
    d.sentences.forEach(sn => {
      const text = dubNormSentence(sn.text);
      if (!text) return;
      const key = text.toLowerCase();
      const errs = errByKey.get(key) || [];
      items.push({
        sentence: text,
        start: Number(sn.start), end: Number(sn.end),
        padStart: DUB_PAD_SEC, padEnd: DUB_PAD_SEC,
        errors: errs,
        hadError: !!(errs.length || sn.hasError),
        attempts: [], done: false, maxScore: max,
      });
      errByKey.delete(key);
    });
    // Câu có lỗi mà AI quên đưa vào "sentences" thì bổ sung vào cuối cho khỏi sót.
    errByKey.forEach((errs, key) => {
      items.push({ sentence: dubNormSentence(errs[0].sentence), start: NaN, end: NaN, errors: errs, hadError: true, attempts: [], done: false, maxScore: max });
    });
  } else {
    // Bản rút gọn (AI không trả "sentences"): chỉ luyện các câu có lỗi, và
    // không ghép được bài vì thiếu mốc thời gian của các câu đúng.
    errByKey.forEach(errs => {
      items.push({ sentence: dubNormSentence(errs[0].sentence), start: NaN, end: NaN, errors: errs, hadError: true, attempts: [], done: false, maxScore: max });
    });
  }

  dubPractice.items = items;
  dubPractice.assembled = null;
  if (!items.length) {
    box.innerHTML = '<div class="hint">🎉 Không có câu nào cần luyện lại — hoặc AI chưa tách được câu.</div>';
    return;
  }
  renderDubPractice();
  // Mốc AI đưa chỉ là ước lượng, dễ dính chữ câu bên cạnh — dò lại khoảng lặng
  // thật trong file gốc để nắn ranh giới cho chuẩn, xong thì vẽ lại 1 lần nữa.
  dubRefineOriginalBoundaries()
    .then(changed => { if (changed) renderDubPractice(); })
    .catch(e => console.warn('[Nắn biên câu] lỗi:', e?.message || e));
}

function renderDubPractice() {
  const box = $('dubPracticeBox');
  if (!box) return;
  box.innerHTML = dubPractice.items.map((it, i) => dubPracticeCardHtml(it, i)).join('') + dubAssembleBarHtml();

  box.querySelectorAll('[data-act]').forEach(btn => {
    const i = parseInt(btn.dataset.idx, 10);
    const act = btn.dataset.act;
    btn.addEventListener('click', () => {
      if (act === 'speak') speakEnglish(dubPractice.items[i].sentence);
      else if (act === 'rec') startDubRetryRecording(i);
      else if (act === 'stop') stopDubRetryRecording();
      else if (act === 'done') { dubPractice.items[i].done = !dubPractice.items[i].done; renderDubPractice(); }
      else if (act === 'clear') { dubPractice.items[i].attempts = []; dubPractice.items[i].done = false; renderDubPractice(); }
      else if (act === 'playorig') playDubOriginalSegment(i);
      else if (act === 'assemble') assembleDubFinal();
      else if (act === 'speakall') speakEnglish(dubPractice.items.map(x => x.sentence).join(' '));
    });
  });
}

function dubItemPassed(it) {
  const last = it.attempts[it.attempts.length - 1];
  return !!(last && Number(last.score) >= (it.maxScore || 10) * DUB_PASS_RATIO);
}
// Câu này đã có tiếng dùng được để ghép bài chưa? — hoặc là bản gốc đọc đúng
// ngay từ đầu, hoặc là bản thu lại đã ĐẬU.
function dubItemReady(it) {
  if (dubItemPassed(it)) return true;
  if (!it.hadError && isFinite(it.start) && isFinite(it.end) && it.end > it.start) return true;
  return false;
}

function dubPracticeCardHtml(it, i) {
  const max = it.maxScore || 10;
  const last = it.attempts[it.attempts.length - 1] || null;
  const passed = dubItemPassed(it);
  const recording = dubPractice.recIdx === i;
  const busy = dubPractice.busyIdx === i;
  const okOriginal = !it.hadError && !it.attempts.length;
  const hasOrigAudio = isFinite(it.start) && isFinite(it.end) && it.end > it.start;

  let cls = 'dub-pract';
  if (okOriginal) cls += ' is-orig';
  else if (passed || it.done) cls += ' is-pass';

  let h = '<div class="' + cls + '">';
  h += '<div class="dub-pract-head"><span class="dub-pract-no">Câu ' + (i + 1) + '</span>' +
    (okOriginal ? '<span class="dub-pract-flag ok">✅ Đọc đúng sẵn — đã lưu tiếng gốc</span>'
      : passed ? '<span class="dub-pract-flag pass">🏆 ĐẬU — đã lưu bản thu lại</span>'
      : it.done ? '<span class="dub-pract-flag ok">✔️ Đã đánh dấu ổn</span>'
      : '<span class="dub-pract-flag todo">⏳ Cần luyện lại</span>') +
    (it.attempts.length ? '<span class="dub-pract-count">' + it.attempts.length + ' lần thử</span>' : '') +
    '</div>';

  h += '<div class="dub-pract-sentence">' + escapeHtml(it.sentence) + '</div>';

  if (it.errors.length) {
    h += '<div class="dub-pract-words">' + it.errors.map(er =>
      '<span class="dub-pract-word" title="' + escapeHtml(String(er.tip || '')) + '">' +
        escapeHtml(String(er.correct || er.word || '')) +
        (er.ipa ? ' <i>' + escapeHtml(String(er.ipa)) + '</i>' : '') +
        (er.heard ? ' <s>' + escapeHtml(String(er.heard)) + '</s>' : '') +
      '</span>').join('') + '</div>';
  }

  h += '<div class="dub-pract-actions">' +
    '<button type="button" class="secondary small" data-act="speak" data-idx="' + i + '">🔊 Nghe đọc mẫu</button>' +
    (hasOrigAudio ? '<button type="button" class="secondary small" data-act="playorig" data-idx="' + i + '">▶️ Nghe lại bản gốc của con</button>' : '') +
    (recording
      ? '<button type="button" class="primary small" data-act="stop" data-idx="' + i + '">⏹ Dừng &amp; chấm lại</button><span class="dub-rec-timer" id="dubRetryTimer">🔴 0:00</span>'
      : '<button type="button" class="' + (it.hadError && !passed ? 'primary' : 'secondary') + ' small" data-act="rec" data-idx="' + i + '"' + (busy || dubPractice.recIdx >= 0 ? ' disabled' : '') + '>🎤 ' + (it.attempts.length ? 'Thu lại lần nữa' : 'Thu lại câu này') + '</button>') +
    '<button type="button" class="secondary small" data-act="done" data-idx="' + i + '">' + (it.done ? '↩️ Bỏ đánh dấu' : '✔️ Câu này ổn rồi') + '</button>' +
    (it.attempts.length ? '<button type="button" class="secondary small" data-act="clear" data-idx="' + i + '">🗑️ Xoá lịch sử</button>' : '') +
    '</div>';

  if (busy) h += '<div class="dub-pract-status">⏳ AI đang nghe lại câu này...</div>';

  if (it.attempts.length) {
    h += '<div class="dub-pract-history">';
    it.attempts.forEach((a, k) => {
      const ok = Number(a.score) >= max * DUB_PASS_RATIO;
      const prev = k > 0 ? Number(it.attempts[k - 1].score) : null;
      const delta = prev === null ? '' : (Number(a.score) > prev ? ' <span class="dub-up">▲ tiến bộ</span>' : (Number(a.score) < prev ? ' <span class="dub-down">▼ kém hơn</span>' : ''));
      h += '<div class="dub-att' + (k === it.attempts.length - 1 ? ' is-last' : '') + '">' +
        '<div class="dub-att-head">Lần ' + (k + 1) + ': <b style="color:' + dubScoreColor(a.score, max) + '">' + (Math.round(Number(a.score) * 10) / 10) + '/' + max + '</b> ' +
          (ok ? '🏆 ĐẬU' : '❌ Chưa đạt') + delta + '</div>' +
        (a.heardText ? '<div class="dub-att-line">👂 Nghe thành: <i>' + escapeHtml(String(a.heardText)) + '</i></div>' : '') +
        (Array.isArray(a.remaining) && a.remaining.length
          ? '<div class="dub-att-line">🔸 Còn sai: ' + a.remaining.map(r => '<b>' + escapeHtml(String(r.word || '')) + '</b>' + (r.ipa ? ' ' + escapeHtml(String(r.ipa)) : '') + (r.tip ? ' — ' + escapeHtml(String(r.tip)) : '')).join('; ') + '</div>'
          : '') +
        (Array.isArray(a.fixed) && a.fixed.length ? '<div class="dub-att-line">✅ Đã sửa được: ' + a.fixed.map(x => escapeHtml(String(x))).join(', ') + '</div>' : '') +
        (a.comment ? '<div class="dub-att-line">🧑‍🏫 ' + escapeHtml(String(a.comment)) + '</div>' : '') +
        (a.audioUrl ? '<audio class="dub-att-audio" controls src="' + a.audioUrl + '"></audio>' : '') +
        '</div>';
    });
    h += '</div>';
  }

  h += '</div>';
  return h;
}

// ---------- Thanh GHÉP BÀI HOÀN CHỈNH ----------
function dubAssembleBarHtml() {
  const items = dubPractice.items || [];
  if (!items.length) return '';
  const ready = items.filter(dubItemReady).length;
  const all = items.length;

  let h = '<div class="dub-assemble">';
  h += '<div class="dub-assemble-head"><b>🧩 Ghép lại thành bài hoàn chỉnh</b>' +
    '<span class="dub-assemble-progress">' + ready + '/' + all + ' câu đã sẵn sàng</span></div>';
  h += '<div class="dub-assemble-bar"><i style="width:' + (all ? (ready / all) * 100 : 0) + '%"></i></div>';
  h += '<div class="hint" style="margin-top:6px">Câu đọc đúng ngay từ đầu được cắt sẵn từ bản thu gốc (đã tự dò khoảng lặng để nắn lại ranh giới 2 câu liền kề cho đỡ dính chữ nhau); câu nào sai thì ưu tiên lấy bản THU LẠI đã đậu, chưa đậu thì lấy bản thu mới nhất. Không cần xong hết mới ghép được — bấm ghép lúc nào cũng được, câu nào chưa có tiếng thì sẽ báo rõ.</div>';

  if (!dubHasOriginalAudio()) {
    h += '<div class="dub-assemble-warn">⚠️ Không lấy được tiếng từ file gốc (AI chưa trả mốc thời gian từng câu, hoặc trình duyệt không giải mã được định dạng này). Vẫn có thể thu lại TỪNG câu rồi ghép — cứ bấm 🎤 ở mọi câu.</div>';
  }

  h += '<div class="dub-pract-actions" style="margin-top:8px">' +
    '<button type="button" class="primary small" data-act="assemble" data-idx="-1">🧩 GHÉP BÀI HOÀN CHỈNH' + (ready < all ? ' (tạm)' : '') + '</button>' +
    '<button type="button" class="secondary small" data-act="speakall" data-idx="-1">🔊 Đọc mẫu nguyên bài</button>' +
    '</div>';

  if (dubPractice.assembled) {
    const a = dubPractice.assembled;
    let head = '🎧 Bài hoàn chỉnh (' + dubFmtClock(a.duration) + ') — ghép từ ' + a.fromOriginal + ' câu gốc + ' + a.fromRetake + ' câu thu lại';
    if (a.fromRetakeUnpassed) head += ' (trong đó ' + a.fromRetakeUnpassed + ' câu chưa đạt điểm, dùng tạm bản thu mới nhất)';
    h += '<div class="dub-assembled">' +
      '<div class="dub-att-head">' + head + '</div>' +
      (a.skipped && a.skipped.length ? '<div class="dub-assemble-warn">⚠️ Câu số ' + a.skipped.join(', ') + ' chưa có tiếng nào dùng được nên để trống trong bài ghép — thu lại các câu đó rồi ghép lại nhé.</div>' : '') +
      '<audio class="dub-att-audio" controls src="' + a.url + '"></audio>' +
      '<a class="dub-dl" href="' + a.url + '" download="bai_lang_tieng_hoan_chinh.wav">⬇️ Tải file WAV về máy</a>' +
      '<div class="dub-final-script">' + escapeHtml(dubPractice.items.map(x => x.sentence).join(' ')) + '</div>' +
      '</div>';
  }
  h += '</div>';
  return h;
}

// ---------- Ghi âm lại 1 câu ----------
async function startDubRetryRecording(i) {
  if (dubPractice.rec) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    dubPractice.recStream = stream;
    const chunks = [];
    const prefer = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    const mimeType = prefer.find(m => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || '';
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    dubPractice.rec = rec;
    dubPractice.recIdx = i;
    dubPractice.recStartAt = Date.now();
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      const type = (rec.mimeType || mimeType || 'audio/webm').split(';')[0];
      const blob = new Blob(chunks, { type });
      try { dubPractice.recStream.getTracks().forEach(t => t.stop()); } catch { }
      clearInterval(dubPractice.recTimer); dubPractice.recTimer = null;
      dubPractice.rec = null; dubPractice.recStream = null;
      const idx = dubPractice.recIdx; dubPractice.recIdx = -1;
      renderDubPractice();
      if (blob.size > 800) gradeDubRetry(idx, blob, type);
      else alert('Bản ghi quá ngắn, chưa nghe thấy gì. Thu lại nhé.');
    };
    rec.start();
    renderDubPractice();
    dubPractice.recTimer = setInterval(() => {
      const sec = (Date.now() - dubPractice.recStartAt) / 1000;
      const el = $('dubRetryTimer'); if (el) el.textContent = '🔴 ' + dubFmtClock(sec);
      if (sec >= DUB_RETRY_MAX_SEC) stopDubRetryRecording();
    }, 250);
  } catch (e) {
    alert('Không mở được micro: ' + (e?.message || e));
  }
}
function stopDubRetryRecording() {
  if (!dubPractice.rec) return;
  try { dubPractice.rec.stop(); } catch { }
}

// ---------- Chấm lại RIÊNG 1 câu vừa thu ----------
async function gradeDubRetry(i, blob, mime) {
  const it = dubPractice.items[i];
  if (!it) return;
  dubPractice.busyIdx = i;
  renderDubPractice();
  try {
    const max = it.maxScore || 10;
    const base64 = await fileToBase64(blob);
    const focusWords = it.errors.map(er => (er.correct || er.word || '') + (er.ipa ? ' ' + er.ipa : '')).filter(Boolean);
    const prompt = [
      'Bạn là giáo viên tiếng Anh người Việt. Học sinh vừa ĐỌC LẠI đúng 1 câu tiếng Anh để sửa lỗi phát âm. File âm thanh gửi kèm chính là lần đọc lại đó.',
      '',
      'CÂU CHUẨN học sinh phải đọc đúng:',
      '"""' + it.sentence + '"""',
      focusWords.length ? 'CÁC TỪ LẦN TRƯỚC ĐỌC SAI, cần kiểm tra thật kỹ lần này: ' + focusWords.join(', ') : '',
      'ĐỘ KHẮT KHE: ' + (DUB_STRICT_TEXT[$('dubStrictSelect').value] || DUB_STRICT_TEXT.normal),
      'TRÌNH ĐỘ: ' + (DUB_LEVEL_TEXT[$('dubLevelSelect').value] || DUB_LEVEL_TEXT.grade6),
      'GIỌNG CHUẨN: ' + (DUB_ACCENT_TEXT[$('dubAccentSelect').value] || DUB_ACCENT_TEXT.any),
      '',
      'Nghe kỹ rồi trả lời: lần này đọc đã đúng chưa, những từ nào đã sửa được, những từ nào VẪN còn sai.',
      'Chỉ dựa vào âm thanh thực tế, không đoán bừa. Nếu file im lặng hoặc không đọc câu đó thì "usable": false.',
      'Nhận xét viết bằng TIẾNG VIỆT, ngắn gọn 1–3 câu, khích lệ nhưng thành thật.',
      'Chấm điểm câu này theo thang ' + max + '.',
      '',
      'Chỉ trả về DUY NHẤT 1 JSON đúng khuôn:',
      '{',
      '  "usable": true,',
      '  "heardText": "chép lại đúng những gì nghe được",',
      '  "score": 0,',
      '  "maxScore": ' + max + ',',
      '  "pass": true,',
      '  "fixed": ["từ đã sửa đúng"],',
      '  "remaining": [ { "word": "three", "ipa": "/θriː/", "heard": "tree", "tip": "mẹo sửa bằng tiếng Việt" } ],',
      '  "comment": "nhận xét ngắn bằng tiếng Việt"',
      '}',
    ].filter(Boolean).join('\n');

    const text = await callGemini([{ inlineData: { mimeType: mime, data: base64 } }, { text: prompt }], { expectJson: true });
    const r = parseJsonLoose(text);
    if (r.usable === false) {
      alert('AI không nghe được câu này: ' + (r.comment || 'file im lặng hoặc không rõ tiếng.') + '\nThu lại nhé.');
    } else {
      it.attempts.push({
        score: Number(r.score) || 0,
        heardText: r.heardText || '',
        fixed: Array.isArray(r.fixed) ? r.fixed : [],
        remaining: Array.isArray(r.remaining) ? r.remaining : [],
        comment: r.comment || '',
        audioUrl: URL.createObjectURL(blob),
        blob,                      // giữ nguyên bản ghi để lát nữa GHÉP BÀI
        at: Date.now(),
      });
      // Đạt rồi thì tự đánh dấu xong, nhưng vẫn cho thu lại nếu muốn đọc hay hơn nữa.
      if (Number(r.score) >= (it.maxScore || 10) * DUB_PASS_RATIO && r.pass !== false) it.done = true;
    }
  } catch (e) {
    alert('Chấm lại không được: ' + (e?.message || e));
  } finally {
    dubPractice.busyIdx = -1;
    renderDubPractice();
  }
}


// ============================================================
// 🧩 GHÉP BÀI HOÀN CHỈNH
//
// Ý tưởng: bài đọc của con gồm nhiều câu. Câu nào AI KHÔNG chê thì giữ
// nguyên tiếng gốc (cắt ra từ chính file con đã nộp, theo mốc thời gian
// AI trả về). Câu nào bị chê thì con thu lại tới khi ĐẬU — bản thu đậu
// đó được cất riêng. Bấm "GHÉP BÀI HOÀN CHỈNH" là phần mềm nối tất cả
// lại theo đúng thứ tự câu, xuất ra 1 file WAV nghe liền mạch + nút tải
// về + nút đọc mẫu nguyên bài.
//
// Kỹ thuật: giải mã file gốc và từng bản thu lại thành AudioBuffer bằng
// Web Audio (decodeAudioData đọc được cả mp4/webm/mp3/m4a — với file
// VIDEO thì nó lấy đúng phần tiếng, bỏ hình), rồi xếp tuần tự vào một
// OfflineAudioContext (tự động khớp sample rate giùm) và tự tay đóng gói
// kết quả thành WAV 16-bit để trình duyệt nào cũng phát/tải được.
// ============================================================

const DUB_GAP_SEC = 0.28;   // khoảng lặng chèn giữa 2 câu cho tự nhiên
const DUB_PAD_SEC = 0.12;   // nới mỗi đầu đoạn cắt 1 chút kẻo cụt âm

function dubHasOriginalAudio() {
  return (dubPractice.items || []).some(it => isFinite(it.start) && isFinite(it.end) && it.end > it.start);
}
function dubAudioCtx() {
  if (!dubPractice._ac) dubPractice._ac = new (window.AudioContext || window.webkitAudioContext)();
  return dubPractice._ac;
}
async function dubDecode(blobOrFile) {
  const buf = await blobOrFile.arrayBuffer();
  return await dubAudioCtx().decodeAudioData(buf);
}
// Giải mã file gốc 1 lần rồi nhớ luôn (file có thể vài chục MB, giải mã lại mỗi
// lần bấm thì rất phí).
async function dubOriginalBuffer() {
  if (dubPractice._origBuf) return dubPractice._origBuf;
  if (!dub.file) return null;
  try {
    dubPractice._origBuf = await dubDecode(dub.file);
    return dubPractice._origBuf;
  } catch (e) {
    console.warn('[Ghép bài] không giải mã được file gốc:', e?.message || e);
    return null;
  }
}

function dubMixDownMono(buffer) {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const n = buffer.length;
  const out = new Float32Array(n);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += ch[i] / buffer.numberOfChannels;
  }
  return out;
}

// Mốc thời gian đầu/cuối mỗi câu do AI ước lượng — có thể lệch cả giây, cắt
// dính chữ câu bên cạnh (VD: câu 1 dính luôn nửa đầu câu 2). Hàm này dò lại
// SÓNG ÂM THẬT của file gốc để tìm đúng chỗ ngắt hơi (khoảng lặng) gần mốc AI
// đưa nhất, rồi nắn lại ranh giới giữa 2 câu liền kề về đúng chỗ đó — câu
// trước lấy đến đầu khoảng lặng, câu sau lấy từ cuối khoảng lặng, không cắt
// đè lên nhau nữa. Trả về true nếu có nắn lại được ít nhất 1 ranh giới.
async function dubRefineOriginalBoundaries() {
  const items = dubPractice.items || [];
  const seq = items.filter(it => isFinite(it.start) && isFinite(it.end) && it.end > it.start);
  if (seq.length < 2) return false;
  seq.sort((a, b) => a.start - b.start); // phòng khi AI trả không đúng thứ tự

  const orig = await dubOriginalBuffer();
  if (!orig) return false;
  if (dubPractice._boundariesRefinedFor === orig) return false; // đã nắn cho file này rồi
  dubPractice._boundariesRefinedFor = orig;

  const sr = orig.sampleRate;
  const data = dubMixDownMono(orig);
  const hop = Math.max(1, Math.round(sr * 0.01));    // bước 10ms
  const win = Math.max(hop, Math.round(sr * 0.02));  // năng lượng RMS trên cửa sổ 20ms
  const frameCount = Math.max(0, Math.floor((data.length - win) / hop) + 1);
  if (frameCount < 4) return false;
  const energy = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    let sum = 0;
    const off = f * hop;
    for (let k = 0; k < win; k++) { const v = data[off + k]; sum += v * v; }
    energy[f] = Math.sqrt(sum / win);
  }
  const sorted = Float64Array.from(energy).sort();
  const floor = sorted[Math.floor(sorted.length * 0.10)] || 0;
  const peak = sorted[Math.floor(sorted.length * 0.90)] || (floor + 1e-6);
  const threshold = floor + (peak - floor) * 0.18; // dưới ngưỡng này coi là "lặng"
  const frameTime = (f) => (f * hop) / sr;

  let changed = false;
  for (let i = 1; i < seq.length; i++) {
    const prev = seq[i - 1], cur = seq[i];
    const guess = (prev.end + cur.start) / 2;
    const searchRadius = 2.2; // giây — đủ rộng để bắt cả khi AI đoán lệch nhiều giây
    const fLo = Math.max(0, Math.floor((guess - searchRadius) * sr / hop));
    const fHi = Math.min(energy.length - 1, Math.ceil((guess + searchRadius) * sr / hop));

    let best = null; // { runStart, runEnd, dist }
    let runStart = -1;
    for (let f = fLo; f <= fHi + 1; f++) {
      const isSilent = f <= fHi && energy[f] <= threshold;
      if (isSilent) {
        if (runStart < 0) runStart = f;
      } else if (runStart >= 0) {
        const runEnd = f - 1;
        const durSec = (runEnd - runStart + 1) * hop / sr;
        if (durSec >= 0.05) { // ít nhất 50ms mới tính là 1 chỗ ngắt hơi thật
          const center = frameTime(Math.round((runStart + runEnd) / 2));
          const dist = Math.abs(center - guess);
          if (!best || dist < best.dist) best = { runStart, runEnd, dist };
        }
        runStart = -1;
      }
    }

    if (!best) continue; // không thấy khoảng lặng nào gần đó thì đành giữ mốc AI

    const runStartTime = frameTime(best.runStart);
    const runEndTime = frameTime(best.runEnd);
    const runDur = Math.max(0, runEndTime - runStartTime);
    const margin = Math.min(DUB_PAD_SEC, runDur * 0.4); // đệm 1 chút cho khỏi cụt, không vượt quá khoảng lặng

    prev.end = runStartTime + margin;
    prev.padEnd = 0; // đã đệm sẵn ở trên rồi, khỏi cộng thêm lần nữa
    cur.start = runEndTime - margin;
    cur.padStart = 0;
    changed = true;
  }
  return changed;
}

// Nghe thử đúng đoạn tiếng của 1 câu trong bản gốc (để biết mốc thời gian
// AI cắt có chuẩn không trước khi ghép).
async function playDubOriginalSegment(i) {
  const it = dubPractice.items[i];
  if (!it) return;
  const player = dub.isVideo ? $('dubPreviewVideo') : $('dubPreviewAudio');
  if (!player || !player.src) return;
  const from = Math.max(0, it.start - (it.padStart ?? DUB_PAD_SEC));
  const to = it.end + (it.padEnd ?? DUB_PAD_SEC);
  try {
    player.currentTime = from;
    await player.play();
    clearTimeout(dubPractice._segTimer);
    dubPractice._segTimer = setTimeout(() => { try { player.pause(); } catch { } }, Math.max(300, (to - from) * 1000));
  } catch (e) { /* trình duyệt chặn phát tự động thì thôi, người dùng tự bấm play */ }
}

// Đóng gói AudioBuffer thành file WAV 16-bit PCM (mono).
function dubBufferToWavBlob(buffer) {
  const ch = buffer.numberOfChannels === 1 ? [buffer.getChannelData(0)] : [buffer.getChannelData(0)];
  const data = ch[0];
  const sr = buffer.sampleRate;
  const bytes = 44 + data.length * 2;
  const ab = new ArrayBuffer(bytes);
  const view = new DataView(ab);
  const ws = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  ws(0, 'RIFF'); view.setUint32(4, bytes - 8, true); ws(8, 'WAVE');
  ws(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sr, true); view.setUint32(28, sr * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ws(36, 'data'); view.setUint32(40, data.length * 2, true);
  let off = 44;
  for (let i = 0; i < data.length; i++) {
    let v = Math.max(-1, Math.min(1, data[i]));
    view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    off += 2;
  }
  return new Blob([ab], { type: 'audio/wav' });
}

async function assembleDubFinal() {
  const items = dubPractice.items || [];
  if (!items.length) return;

  const notReady = items.filter(it => !dubItemReady(it));
  if (notReady.length) {
    const ok = confirm('Còn ' + notReady.length + ' câu chưa đọc đạt (chưa thu lại hoặc thu chưa đủ điểm).\n\nBấm OK để ghép TẠM bài hiện tại — câu nào có bản thu thì lấy bản mới nhất dù chưa đậu, câu nào chưa thu lần nào và cũng không có tiếng gốc thì sẽ để trống. Bấm Cancel để quay lại luyện tiếp.');
    if (!ok) return;
  }

  const btnBox = $('dubPracticeBox');
  if (btnBox) btnBox.querySelectorAll('[data-act="assemble"]').forEach(b => { b.disabled = true; b.textContent = '⏳ Đang ghép...'; });

  try {
    const orig = dubHasOriginalAudio() ? await dubOriginalBuffer() : null;
    const segs = [];   // { buffer, offset, duration, kind }
    let fromOriginal = 0, fromRetake = 0, fromRetakeUnpassed = 0;
    const skipped = [];

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      // Ưu tiên: bản thu lại ĐẬU (lần đậu gần nhất) > bản gốc nếu câu đó không bị chê
      // > bản thu lại mới nhất dù CHƯA đậu (còn hơn để trống) > để trống.
      const passedAttempt = [...it.attempts].reverse().find(a => Number(a.score) >= (it.maxScore || 10) * DUB_PASS_RATIO && a.blob);
      const anyAttempt = passedAttempt || [...it.attempts].reverse().find(a => a.blob);
      if (passedAttempt) {
        if (!passedAttempt._buf) { try { passedAttempt._buf = await dubDecode(passedAttempt.blob); } catch { } }
        if (passedAttempt._buf) { segs.push({ buffer: passedAttempt._buf, offset: 0, duration: passedAttempt._buf.duration, kind: 'retake' }); fromRetake++; continue; }
      }
      if (!it.hadError && orig && isFinite(it.start) && isFinite(it.end) && it.end > it.start) {
        const from = Math.max(0, it.start - (it.padStart ?? DUB_PAD_SEC));
        const to = Math.min(orig.duration, it.end + (it.padEnd ?? DUB_PAD_SEC));
        if (to > from) { segs.push({ buffer: orig, offset: from, duration: to - from, kind: 'orig' }); fromOriginal++; continue; }
      }
      if (anyAttempt) {
        if (!anyAttempt._buf) { try { anyAttempt._buf = await dubDecode(anyAttempt.blob); } catch { } }
        if (anyAttempt._buf) { segs.push({ buffer: anyAttempt._buf, offset: 0, duration: anyAttempt._buf.duration, kind: 'retake-unpassed' }); fromRetake++; fromRetakeUnpassed++; continue; }
      }
      skipped.push(i + 1);
    }

    if (!segs.length) { alert('Chưa có đoạn tiếng nào dùng được để ghép.'); return; }

    const sr = 44100;
    const total = segs.reduce((s, x) => s + x.duration, 0) + DUB_GAP_SEC * (segs.length - 1);
    const off = new OfflineAudioContext(1, Math.ceil(total * sr) + sr, sr);
    let cursor = 0;
    segs.forEach(sg => {
      const src = off.createBufferSource();
      src.buffer = sg.buffer;
      // Vào/ra nhẹ 25ms cho khỏi "cụp" ở chỗ nối
      const g = off.createGain();
      const fade = 0.025;
      g.gain.setValueAtTime(0, cursor);
      g.gain.linearRampToValueAtTime(1, cursor + fade);
      g.gain.setValueAtTime(1, cursor + Math.max(fade, sg.duration - fade));
      g.gain.linearRampToValueAtTime(0, cursor + sg.duration);
      src.connect(g); g.connect(off.destination);
      src.start(cursor, sg.offset, sg.duration);
      cursor += sg.duration + DUB_GAP_SEC;
    });

    const rendered = await off.startRendering();
    const blob = dubBufferToWavBlob(rendered);
    if (dubPractice.assembled && dubPractice.assembled.url) { try { URL.revokeObjectURL(dubPractice.assembled.url); } catch { } }
    dubPractice.assembled = {
      url: URL.createObjectURL(blob),
      blob,
      duration: rendered.duration,
      fromOriginal, fromRetake, fromRetakeUnpassed, skipped,
      at: Date.now(),
    };
  } catch (e) {
    console.error('[Ghép bài] lỗi:', e);
    alert('Ghép bài không được: ' + (e?.message || e) + '\nMẹo: nếu file gốc là video định dạng lạ, hãy thu lại từng câu bằng nút 🎤 rồi ghép.');
  } finally {
    renderDubPractice();
  }
}
