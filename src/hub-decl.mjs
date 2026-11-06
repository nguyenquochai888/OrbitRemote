// Trạm được khai trong custom/hub.json: mã trạm, tên máy giữ trạm và địa chỉ của trạm qua Tailscale
// ("tailnet setup" ghi). Đầu máy ở mạng khác đọc file này để tìm ra trạm; máy từng giữ trạm thấy file
// khai trạm ở máy khác thì tự thôi làm trạm.
//
// File này là của riêng từng người dùng nên .gitignore bỏ qua nó. Muốn các máy của mình tự nhận nó qua
// git thì commit vào bản fork riêng: git add -f custom/hub.json.

import { join } from 'node:path';
import { CUSTOM_DIR, readJson, writeJsonAtomic } from './paths.mjs';

export const REPO_HUB = join(CUSTOM_DIR, 'hub.json');

// Gộp vào custom/hub.json thay vì ghi đè. Khoá mang giá trị undefined thì bị bỏ. File đang khai một trạm
// khác thì bắt đầu lại từ đầu, không trộn hai trạm.
export function publishRepoHub(patch, file = REPO_HUB) {
  const old = readJson(file, {});
  const base = old.hubId && patch.hubId && old.hubId !== patch.hubId ? {} : old;
  writeJsonAtomic(file, { ...base, ...patch });
}

export function repoHub(file = REPO_HUB) {
  return readJson(file, null);
}

// Mọi địa chỉ file khai cho trạm (địa chỉ Tailscale).
export function repoHubUrls(hub = repoHub()) {
  return [...new Set((Array.isArray(hub?.tailnet) ? hub.tailnet : []).filter(Boolean))];
}
