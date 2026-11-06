// Kênh: mọi tin các phiên nhắn cho nhau, trên mọi máy. Tin mới nhất ở trên cùng, giảm dần tới cũ nhất.

import { h, clear, clockTime } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { renderMarkdown } from '../lib/md.js';
import { store } from '../lib/store.js';

// Tin trạm đẩy thay cho chủ dự án của một nhóm không có phiên gửi: hiện tên, không có liên kết.
function who(p) {
  if (!p?.id) return h('span', { class: 'who' }, p?.name || 'Chủ dự án');
  return h('a', { class: 'who', href: `#/s/${p.id}` }, p.name, h('span', { class: 'who-machine' }, p.machine));
}

function entry(c) {
  const team = c.groupId ? store.groups.get(c.groupId) : null;
  return h('div', { class: 'channel-entry' },
    team ? h('a', { class: 'team-tag channel-team', href: `#/g/${team.id}` }, icon('group', 12), team.name) : null,
    h('div', { class: 'channel-head' },
      who(c.from), icon('chevron', 14), c.to.length ? c.to.map(who) : h('span', { class: 'dim' }, 'không ai nhận'),
      h('span', { class: 'msg-time' }, clockTime(c.at))),
    h('div', { class: 'channel-body md', html: renderMarkdown(c.text) }),
    c.failed?.length ? h('div', { class: 'field-hint warn' }, `Không tới: ${c.failed.map((f) => `${f.name} (${f.error})`).join(', ')}`) : null,
    // Người gửi khai tin chỉ để báo: đầu máy giữ lại, tin đi kèm lượt kế tiếp của người nhận.
    c.held?.length ? h('div', { class: 'field-hint' }, icon('bolt', 12), ` Chỉ để báo: giữ lại, gộp vào lượt kế tiếp của ${c.held.map((x) => x.name).join(', ')}`) : null);
}

export function mountChannel(root) {
  const list = h('main', { class: 'scroll channel-list' });
  const view = h('div', { class: 'view channel' },
    h('header', { class: 'topbar' },
      h('a', { class: 'icon-btn', href: '#/', 'aria-label': 'Quay lại' }, icon('back')),
      h('div', { class: 'title-wrap static' }, h('div', { class: 'title' }, 'Kênh giữa các phiên'),
        h('div', { class: 'subtitle' }, 'Tin các phiên gửi nhau bằng orbit_remote_send'))),
    list);

  // Đang mở Kênh thì mọi tin đều đã xem: số trên nút Kênh (màn chính) về 0 ngay, kể cả khi tin mới tới lúc đang mở.
  const markSeen = () => {
    sessionStorage.setItem('orbit-channel-seen', String(store.channel.length));
    store.emit('channel-seen');
  };
  const render = () => {
    clear(list);
    if (!store.channel.length) {
      list.append(h('div', { class: 'empty' },
        h('div', { class: 'empty-title' }, 'Chưa có tin nào'),
        h('div', { class: 'empty-text' }, 'Bảo một phiên "gửi cho phiên X ..." là nó tự dùng công cụ orbit_remote_send. Tin hiện ở đây và đi thẳng vào phiên nhận, kể cả khi phiên đó ở máy khác.')));
    } else {
      for (let i = store.channel.length - 1; i >= 0; i -= 1) list.append(entry(store.channel[i]));
    }
    list.scrollTop = 0;
    markSeen();
  };
  // Một tin mới: chỉ chèn thẻ của nó lên đầu, không dựng lại cả danh sách. Đang cuộn xuống đọc tin cũ thì
  // giữ nguyên chỗ đang đọc thay vì để thẻ mới đẩy nội dung xuống.
  const prepend = (c) => {
    if (!list.querySelector('.channel-entry')) {
      render();
      return;
    }
    const atTop = list.scrollTop < 8;
    const before = list.scrollHeight;
    list.prepend(entry(c));
    // Kho chỉ giữ một số tin gần nhất: bỏ thẻ cũ nhất ở đáy cho khớp.
    while (list.childElementCount > store.channel.length) list.lastElementChild.remove();
    if (!atTop) list.scrollTop += list.scrollHeight - before;
    markSeen();
  };
  render();
  root.append(view);
  const offs = [store.on('channel', prepend), store.on('state', render)];
  return () => offs.forEach((off) => off());
}
