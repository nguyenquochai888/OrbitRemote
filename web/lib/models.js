// Tên và số bản model để hiện trên app. Trạm đổi tên dòng ("opus", "sonnet", "haiku") ra bản mới nhất của dòng
// đó (src/models.mjs); app lấy bảng đó qua /api/models để ô chọn model ghi đúng số bản, và đọc mã model thật
// phiên đang chạy (activeModel, Claude Code báo) để ô chat hiện đúng bản đang dùng.

import { store } from './store.js';
import { api } from './api.js';
import { h, toast } from './dom.js';
import { icon } from './icons.js';

// Vai trò gợi ý của từng dòng: Opus cho việc khó và điều phối, Sonnet và Haiku cho việc thường và việc máy móc.
const ROLE = {
  opus: 'Bộ não: lập kế hoạch, quyết định, nghiệm thu, việc khó.',
  sonnet: 'Tay chân: việc thường có yêu cầu rõ.',
  haiku: 'Tay chân: việc máy móc (sửa nhỏ, đổi tên, chạy kiểm).',
};
const FAMILY = ['opus', 'sonnet', 'haiku'];
const cap = (f) => `${f[0].toUpperCase()}${f.slice(1)}`;

// "claude-opus-5-5" -> "Opus 5.5"; "claude-haiku-4-5-20251001" -> "Haiku 4.5"; mã lạ thì bỏ tiền tố "claude-".
export function modelName(id) {
  const raw = String(id || '').replace(/\[.*\]$/, '');
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(raw);
  if (!m) return raw.replace(/^claude-/, '');
  return `${cap(m[1])} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

// Các lựa chọn model: mỗi dòng một mục, nhãn kèm số bản mới nhất, gợi ý kèm mã đầy đủ và vai trò.
export function modelOptions() {
  const fams = store.models?.families || [];
  return FAMILY.map((f) => {
    const row = fams.find((x) => x.id === f);
    return {
      id: f,
      label: row?.modelId ? modelName(row.modelId) : cap(f),
      hint: `${row?.modelId ? `${row.modelId} · ` : ''}${ROLE[f]}`,
    };
  });
}

// Model của một phiên để hiện: mã thật đang chạy nếu Claude Code đã báo, không thì bản mới nhất của dòng đã chọn.
export function sessionModel(s) {
  if (s?.activeModel && /^claude-/.test(s.activeModel)) return modelName(s.activeModel);
  const fam = String(s?.model || '').toLowerCase();
  if (FAMILY.includes(fam)) return modelOptions().find((o) => o.id === fam).label;
  return s?.model ? modelName(s.model) : '';
}

// Nút cập nhật bản model, bên phải nút Mức dùng Claude: máy giữ trạm hỏi danh sách model mới nhất của Anthropic, phát xuống mọi
// máy, và chuyển các phiên đang chạy theo tên dòng sang bản mới (src/hub.mjs, updateModels). Orbit không tự hỏi
// định kỳ: chủ dự án biết khi nào có model mới thì bấm.
export function modelUpdateButton() {
  const button = h('button', { class: 'icon-btn models-btn', 'aria-label': 'Cập nhật bản model mới nhất', onclick: () => update() }, icon('rotate'));
  let busy = false;
  const current = () => modelOptions().map((o) => o.label).join(' · ');
  const label = () => { button.title = `Cập nhật bản model mới nhất (đang dùng: ${current()})`; };
  label();
  const off = store.on('models', label);

  async function update() {
    if (busy) return;
    if (!store.models) await store.loadModels(); // bấm ngay khi app vừa mở: lấy bảng trước để hỏi lại đúng số bản
    if (!window.confirm(`Lấy bản mới nhất của Opus, Sonnet, Haiku từ Anthropic và áp cho mọi máy?\n\nĐang dùng: ${current()}. Phiên đang chạy sẽ chuyển sang bản mới từ lượt kế tiếp.`)) return;
    busy = true;
    button.classList.add('busy');
    try {
      const r = await api.post('/api/models/update');
      store.models = { source: r.source, at: r.at, families: r.families };
      store.emit('models', store.models);
      const failed = (r.machines || []).filter((m) => !m.ok);
      const okCount = (r.machines || []).length - failed.length;
      toast([
        `Đang dùng: ${current()}`,
        `${okCount} máy đã nhận bảng mới`,
        r.switched ? `${r.switched} phiên chuyển sang bản mới` : '',
        failed.length ? `chưa tới: ${failed.map((m) => m.name).join(', ')}` : '',
      ].filter(Boolean).join(' · '), failed.length ? 'error' : 'info');
    } catch (err) {
      toast(`Không cập nhật được: ${err.message}`, 'error');
    } finally {
      busy = false;
      button.classList.remove('busy');
    }
  }

  return { button, destroy: off };
}
