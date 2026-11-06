// Mức dùng Claude của tài khoản đăng nhập trên máy này: phiên 5 giờ, tuần, và hạn mức tuần riêng của
// từng model, kèm giờ reset. Cùng nguồn với lệnh /usage của Claude Code: GET /api/oauth/usage bằng mã
// đăng nhập Claude Code tự lưu ở ~/.claude/.credentials.json.
//
// Mã đăng nhập không bao giờ rời máy: đầu máy tự gọi rồi chỉ gửi phần trăm và giờ reset lên trạm. Mã hết
// hạn thì không tự làm mới (làm mới đổi mã mà Claude Code đang giữ, có thể đăng xuất nó): báo để mở
// Claude Code trên máy, Claude Code tự làm mới. Kết quả nhớ 60 giây để mở bảng liên tục không gọi dồn.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CLAUDE_DIR = process.env.ORBIT_REMOTE_CLAUDE_DIR || join(homedir(), '.claude');
export const CREDENTIALS_FILE = join(CLAUDE_DIR, '.credentials.json');
const PROFILE_FILE = process.env.ORBIT_REMOTE_CLAUDE_PROFILE || join(homedir(), '.claude.json');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CACHE_MS = 60 * 1000;

const LABEL = { session: 'Phiên 5 giờ', weekly_all: 'Tuần, mọi model' };

const readJsonFile = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const pct = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(100, Math.round(Number(v)))) : null);
// Mốc giờ máy chủ trả lệch nhau chút ít giữa các lần hỏi (đo thật cho cùng một giờ reset: 15:00:00.105,
// 15:00:00.005 rồi 14:59:59.951, làm bảng hiện "Reset 21:59"): làm tròn tới phút, để giờ hiện ra đúng và mốc
// đầu tuần không đổi giữa các lần hỏi (bộ đếm token khỏi phải đếm lại từ đầu).
const when = (v) => {
  const t = Date.parse(v || '');
  return Number.isFinite(t) ? new Date(Math.round(t / 60000) * 60000).toISOString() : null;
};

// Rút gọn câu trả lời của máy chủ thành các hạn mức cần hiện. Ưu tiên danh sách "limits" (có cả hạn mức
// tuần riêng theo model); máy chủ cũ không có thì lấy five_hour và seven_day.
export function parseUsage(body) {
  const limits = [];
  if (Array.isArray(body?.limits) && body.limits.length) {
    for (const l of body.limits) {
      const percent = pct(l?.percent);
      if (percent === null) continue;
      const model = l?.scope?.model?.display_name;
      limits.push({
        kind: String(l.kind || ''),
        label: LABEL[l.kind] || (model ? `Tuần, ${model}` : String(l.kind || 'Hạn mức')),
        percent,
        resetsAt: when(l.resets_at),
        severity: String(l.severity || 'normal'),
      });
    }
  } else {
    for (const [key, kind] of [['five_hour', 'session'], ['seven_day', 'weekly_all']]) {
      const percent = pct(body?.[key]?.utilization);
      if (percent !== null) limits.push({ kind, label: LABEL[kind], percent, resetsAt: when(body[key].resets_at), severity: 'normal' });
    }
  }
  return limits;
}

const WEEK_MS = 7 * 24 * 3600 * 1000;

// Tuần của hạn mức "Tuần, mọi model": mốc bắt đầu (máy chủ báo trong seven_day_breakdown; máy chủ không báo
// thì lấy giờ reset lùi 7 ngày), giờ reset, phần trăm đã dùng, và phần của Claude Code trong mức đã dùng
// (seven_day_breakdown chia theo Claude Code, chat, Cowork...; không có thì null). Không có hạn mức tuần thì null.
export function parseWeek(body, limits = parseUsage(body)) {
  const weekly = limits.find((l) => l.kind === 'weekly_all');
  if (!weekly?.resetsAt) return null;
  const { resetsAt } = weekly;
  const breakdown = body?.seven_day_breakdown;
  const started = when(breakdown?.window_started_at);
  const startedAt = started && started < resetsAt ? started : new Date(Date.parse(resetsAt) - WEEK_MS).toISOString();
  const row = Array.isArray(breakdown?.rows) ? breakdown.rows.find((r) => r?.key === 'claude_code') : null;
  return { startedAt, resetsAt, percent: weekly.percent, claudeCodeShare: row ? pct(row.percent) : null };
}

let cached = null; // { at, value }

// Vừa đăng nhập tài khoản khác (claude-auth.mjs): bỏ số liệu đã nhớ của tài khoản cũ.
export function forgetUsage() {
  cached = null;
}

// Trả về { account: { id, label }, plan, limits, week, at } hay { error, reason }.
export async function readClaudeUsage({ fetchImpl = fetch, now = Date.now, credentialsFile = CREDENTIALS_FILE, profileFile = PROFILE_FILE, fresh = false } = {}) {
  if (!fresh && cached && now() - cached.at < CACHE_MS) return cached.value;
  const oauth = readJsonFile(credentialsFile)?.claudeAiOauth;
  const profile = readJsonFile(profileFile)?.oauthAccount || {};
  const account = { id: String(profile.accountUuid || ''), label: String(profile.emailAddress || profile.displayName || '') };
  let value;
  if (!oauth?.accessToken) {
    value = { error: 'Máy này chưa đăng nhập Claude Code bằng tài khoản Claude (hay lưu mã ở chỗ khác, như Keychain của macOS).', reason: 'nologin', account };
  } else if (oauth.expiresAt && Number(oauth.expiresAt) < now()) {
    value = { error: 'Mã đăng nhập Claude trên máy này đã hết hạn: mở Claude Code trên máy là tự làm mới.', reason: 'expired', account };
  } else {
    try {
      const res = await fetchImpl(USAGE_URL, {
        headers: { Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'orbit-remote' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        value = { error: res.status === 401 ? 'Máy chủ Claude từ chối mã đăng nhập của máy này: mở Claude Code trên máy để đăng nhập lại.' : `Máy chủ Claude trả mã ${res.status}.`, reason: `http${res.status}`, account };
      } else {
        const body = await res.json();
        const limits = parseUsage(body);
        value = limits.length
          ? { account, plan: String(oauth.subscriptionType || ''), limits, week: parseWeek(body, limits), at: new Date(now()).toISOString() }
          : { error: 'Máy chủ Claude không trả số liệu usage nào.', reason: 'empty', account };
      }
    } catch (err) {
      value = { error: `Không hỏi được máy chủ Claude: ${err.message}`, reason: 'network', account };
    }
  }
  cached = { at: now(), value };
  return value;
}
