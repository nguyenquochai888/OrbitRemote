// Sổ token Claude Code của từng máy trong tuần usage, nằm trên trạm. Mỗi máy tự đếm từ nhật ký Claude Code
// của chính nó (claude-tokens.mjs) rồi tự báo lên: lệnh "tokens" mỗi 5 phút khi số đổi, và kèm câu trả lời
// lệnh "usage". Trạm giữ số mới nhất của từng máy theo tài khoản và cộng thành tổng của tài khoản. Sổ được
// lưu xuống đĩa, nên máy đã tắt (hay trạm vừa khởi động lại) vẫn được tính bằng số nó báo lần cuối.
//
// Ước số token còn lại của tuần: số đếm được ở các máy (T) ứng với phần trăm tuần đã dùng (p) nhân phần của
// Claude Code trong mức đó (s, máy chủ chia theo Claude Code, chat, Cowork...): q = p × s / 100. Cả tuần
// ≈ T × 100 / q, còn lại ≈ T × (100 − p) / q, với giả định từ giờ tới cuối tuần vẫn dùng như từ đầu tuần (cùng
// model, cùng tỉ lệ đọc cache). Máy chủ trả phần trăm là số nguyên nên lúc đầu tuần (p nhỏ) số ước còn thô.

import { readJson, writeJsonAtomic } from './paths.mjs';
import { TOKEN_FIELDS, addTotals, tokenSum } from './claude-tokens.mjs';

const SAVE_DELAY_MS = 2000;
const KEEP_MS = 14 * 24 * 3600 * 1000; // tài khoản không ai báo số suốt hai tuần thì bỏ khỏi sổ
const MAX_MODELS = 20;

const count = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};
const isoOrNull = (v) => {
  const t = Date.parse(v || '');
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const emptyTotals = () => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
// Số do máy gửi lên: chỉ giữ đúng các trường biết, mỗi trường là số nguyên không âm.
const cleanTotals = (t) => Object.fromEntries(['calls', ...TOKEN_FIELDS].map((f) => [f, count(t?.[f])]));

export class TokenBook {
  constructor(file) {
    this.file = file;
    const saved = readJson(file, null);
    this.book = saved && typeof saved === 'object' ? saved : {}; // tài khoản -> { week, machines: { mã máy -> số } }
    this.timer = null;
  }

  // report: { accountId, tokens: { since, at, lastAt, total, models } }. Trả về false khi bỏ qua.
  record(machineId, name, report) {
    const acc = String(report?.accountId || '').slice(0, 80);
    const week = isoOrNull(report?.tokens?.since);
    if (!acc || !week || !machineId) return false;
    let a = this.book[acc];
    if (!a || week > a.week) a = this.book[acc] = { week, machines: {} }; // tuần mới: số tuần cũ hết nghĩa
    else if (week < a.week) return false; // số của tuần trước tới muộn
    const t = report.tokens;
    const models = {};
    for (const [model, v] of Object.entries(t.models || {}).slice(0, MAX_MODELS)) models[String(model).slice(0, 80)] = cleanTotals(v);
    a.machines[machineId] = { name: String(name || '').slice(0, 80), at: isoOrNull(t.at) || new Date().toISOString(), lastAt: isoOrNull(t.lastAt), total: cleanTotals(t.total), models };
    this.scheduleSave();
    return true;
  }

  // Tổng của một tài khoản trong tuần `week` ({ startedAt, resetsAt, percent, claudeCodeShare } của usage.mjs)
  // kèm số từng máy và số ước còn lại; null khi chưa máy nào báo số của tuần này. machineInfo(mã máy) trả
  // { name, online } của máy theo trạm.
  summary(accountId, week, machineInfo = () => null) {
    const a = this.book[accountId];
    if (!a || !week?.startedAt || a.week !== week.startedAt) return null;
    const machines = Object.entries(a.machines).map(([id, m]) => {
      const info = machineInfo(id);
      return { name: info?.name || m.name || id, online: Boolean(info?.online), at: m.at, lastAt: m.lastAt, total: m.total, sum: tokenSum(m.total) };
    }).sort((x, y) => y.sum - x.sum);
    const total = machines.reduce((t, m) => addTotals(t, m.total), emptyTotals());
    const used = tokenSum(total);
    const percent = Number(week.percent) || 0;
    const share = week.claudeCodeShare ?? 100; // máy chủ không chia theo nơi dùng: coi như cả mức là Claude Code
    const q = (percent * share) / 100;
    let estimate = null;
    if (used > 0 && q > 0) {
      const factor = Math.max(0, 100 - percent) / q;
      estimate = { remaining: Math.round(used * factor), budget: Math.round((used * 100) / q), byType: {} };
      for (const f of TOKEN_FIELDS) estimate.byType[f] = Math.round(total[f] * factor);
    }
    return { since: a.week, resetsAt: week.resetsAt || null, percent, claudeCodeShare: week.claudeCodeShare ?? null, total, sum: used, machines, estimate };
  }

  scheduleSave() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.saveNow();
    }, SAVE_DELAY_MS);
    this.timer.unref?.();
  }

  saveNow(now = Date.now()) {
    for (const [acc, a] of Object.entries(this.book)) if (!(Date.parse(a?.week) > now - KEEP_MS)) delete this.book[acc];
    try {
      writeJsonAtomic(this.file, this.book);
    } catch {
      // đĩa đầy hay bị khoá: lần ghi sau thử lại, số vẫn còn trong bộ nhớ
    }
  }
}
