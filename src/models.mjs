// Bản mới nhất của từng dòng model Claude mà Orbit Remote dùng: Opus, Sonnet, Haiku. Không dùng Fable.
//
// Tên tắt của Claude Code không trỏ tới bản mới nhất (đo thật ngày 2026-11-03: "haiku" ra claude-haiku-4-5-20251001,
// "sonnet" ra claude-sonnet-5, trong khi đã có Haiku 5.5 và Sonnet 5.5). Vì vậy Orbit Remote tự đổi tên dòng ("opus",
// "sonnet", "haiku") ra mã model đầy đủ trước khi mở phiên hay đổi model.
//
// Nguồn: chỉ cập nhật khi chủ dự án bấm nút cập nhật bản model trên app (không tự hỏi định kỳ). Máy giữ trạm hỏi
// GET /v1/models bằng đăng nhập Claude Code của chính nó (mã không rời máy, như usage.mjs), chọn model ra mắt sau
// cùng của từng dòng, ghi ~/.orbit/state/models.json, rồi trạm phát bảng đó xuống mọi máy (máy đang tắt nhận khi nối
// lại). Máy chưa có bảng thì dùng bản ghi sẵn trong repo (data/models.json).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TOOL_DIR, writeJsonAtomic } from './paths.mjs';
import { CREDENTIALS_FILE } from './usage.mjs';

export const FAMILIES = ['opus', 'sonnet', 'haiku'];
const FAMILY_RE = /^claude-(opus|sonnet|haiku)-/;
const MODELS_URL = 'https://api.anthropic.com/v1/models?limit=100';

export const cacheFile = () => process.env.ORBIT_MODELS_FILE || join(homedir(), '.orbit', 'state', 'models.json');
export const PINNED_FILE = join(TOOL_DIR, 'data', 'models.json');

const readJsonFile = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const validTable = (t) => Boolean(t?.models && FAMILIES.every((f) => typeof t.models[f]?.id === 'string' && FAMILY_RE.test(t.models[f].id)));

// "claude-opus-5-5" -> "Opus 5.5"; "claude-haiku-4-5-20251001" -> "Haiku 4.5"; "claude-sonnet-5" -> "Sonnet 5".
export function modelName(id) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(String(id || '').replace(/\[.*\]$/, ''));
  if (!m) return String(id || '');
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

// Model ra mắt sau cùng của từng dòng trong danh sách của máy chủ. Thiếu dòng nào thì trả null.
export function pickLatest(list) {
  const best = {};
  for (const m of Array.isArray(list) ? list : []) {
    const fam = FAMILY_RE.exec(String(m?.id || ''))?.[1];
    if (!fam) continue;
    const at = Date.parse(m.created_at || '') || 0;
    if (!best[fam] || at > best[fam].at || (at === best[fam].at && m.id > best[fam].id)) {
      best[fam] = { id: m.id, name: String(m.display_name || `Claude ${modelName(m.id)}`), at };
    }
  }
  if (!FAMILIES.every((f) => best[f])) return null;
  return Object.fromEntries(FAMILIES.map((f) => [f, { id: best[f].id, name: best[f].name, created: new Date(best[f].at).toISOString() }]));
}

// Bảng đang dùng: tệp máy tự hỏi được, không có thì bản ghi sẵn trong kho. { models, source, at }.
export function modelTable({ file = cacheFile(), pinned = PINNED_FILE } = {}) {
  const fresh = readJsonFile(file);
  if (validTable(fresh)) return { models: fresh.models, source: 'api', at: fresh.at || '' };
  const base = readJsonFile(pinned);
  if (validTable(base)) return { models: base.models, source: 'pinned', at: base.checked || '' };
  return { models: null, source: 'none', at: '' };
}

// Tên dòng ("opus", "Sonnet") -> mã model mới nhất; mã đầy đủ hay "" giữ nguyên. Không có bảng thì giữ tên dòng
// (Claude Code tự hiểu tên tắt, chỉ là có thể ra bản cũ).
export function resolveModel(name, table = modelTable()) {
  const key = String(name || '').trim().toLowerCase();
  if (!FAMILIES.includes(key)) return String(name || '').trim();
  return table.models?.[key]?.id || key;
}

// Bảng trạm phát xuống (sau khi chủ dự án bấm cập nhật): ghi khi hợp lệ và khác bảng đang có. Trả true khi đã ghi.
export function applyTable(table, file = cacheFile()) {
  if (!validTable(table)) return false;
  const next = { at: String(table.at || ''), models: Object.fromEntries(FAMILIES.map((f) => [f, table.models[f]])) };
  if (JSON.stringify(readJsonFile(file)) === JSON.stringify(next)) return false;
  writeJsonAtomic(file, next);
  return true;
}

// Hỏi máy chủ Anthropic danh sách model, ghi bảng mới. Đăng nhập Claude Code (OAuth) hay ANTHROPIC_API_KEY.
// Không bao giờ ném lỗi: trả { ok, table } hay { ok: false, error }.
export async function refreshModels({ fetchImpl = fetch, credentialsFile = CREDENTIALS_FILE, file = cacheFile(), now = Date.now } = {}) {
  const oauth = readJsonFile(credentialsFile)?.claudeAiOauth;
  const headers = { 'anthropic-version': '2023-06-01', 'User-Agent': 'orbit-remote' };
  if (oauth?.accessToken && !(oauth.expiresAt && Number(oauth.expiresAt) < now())) {
    headers.Authorization = `Bearer ${oauth.accessToken}`;
    headers['anthropic-beta'] = 'oauth-2025-04-20';
  } else if (process.env.ANTHROPIC_API_KEY) {
    headers['x-api-key'] = process.env.ANTHROPIC_API_KEY;
  } else {
    return { ok: false, error: 'Máy chưa đăng nhập Claude Code (hay mã đã hết hạn): dùng bảng ghi sẵn trong kho.' };
  }
  try {
    const res = await fetchImpl(MODELS_URL, { headers, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { ok: false, error: `Máy chủ Anthropic trả mã ${res.status}.` };
    const models = pickLatest((await res.json())?.data);
    if (!models) return { ok: false, error: 'Danh sách model thiếu một trong các dòng Opus, Sonnet, Haiku.' };
    const table = { at: new Date(now()).toISOString(), models };
    writeJsonAtomic(file, table);
    return { ok: true, table: { ...table, source: 'api' } };
  } catch (err) {
    return { ok: false, error: `Không hỏi được máy chủ Anthropic: ${err.message}` };
  }
}

// Cho app: mỗi dòng một mục { id: "opus", modelId, label: "Opus 5.5" }, kèm nguồn của bảng.
export function modelsView(table = modelTable()) {
  return {
    source: table.source,
    at: table.at,
    families: FAMILIES.map((f) => {
      const modelId = table.models?.[f]?.id || '';
      return { id: f, modelId, label: modelId ? modelName(modelId) : `${f[0].toUpperCase()}${f.slice(1)}` };
    }),
  };
}
