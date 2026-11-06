// Bộ biểu tượng nét mảnh, vẽ bằng SVG để nét căng ở mọi mật độ điểm ảnh.

const PATHS = {
  plus: 'M12 5v14M5 12h14',
  back: 'M15 18l-6-6 6-6',
  send: 'M5 12h13M13 6l6 6-6 6',
  stop: 'M7 7h10v10H7z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z',
  channel: 'M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2zM8 9h8M8 13h5',
  check: 'M5 12.5l4.5 4.5L19 7',
  x: 'M6 6l12 12M18 6L6 18',
  terminal: 'M4 17l6-5-6-5M12 19h8',
  file: 'M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9zM14 3v6h6',
  edit: 'M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-4.35-4.35',
  globe: 'M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18',
  agent: 'M12 8V4M8 4h8M6 8h12a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2v-8a2 2 0 012-2zM9 13h.01M15 13h.01',
  tool: 'M14.7 6.3a4 4 0 00-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 005.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z',
  chevron: 'M9 18l6-6-6-6',
  down: 'M6 9l6 6 6-6',
  history: 'M3 12a9 9 0 109-9 9.7 9.7 0 00-6.7 2.8L3 8M3 3v5h5M12 7v5l4 2',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  bolt: 'M13 2L3 14h9l-1 8 10-12h-9z',
  copy: 'M9 9h11v11H9zM5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
  play: 'M7 4l13 8-13 8z',
  machine: 'M3 4h18v12H3zM8 20h8M12 16v4',
  link: 'M10 13a5 5 0 007.07 0l3-3a5 5 0 00-7.07-7.07l-1.5 1.5M14 11a5 5 0 00-7.07 0l-3 3a5 5 0 007.07 7.07l1.5-1.5',
  keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M18 10h.01M7 14h10',
  mouse: 'M12 3a6 6 0 016 6v6a6 6 0 01-12 0V9a6 6 0 016-6zM12 7v4',
  touch: 'M9 11V5a2 2 0 014 0v5M13 10a2 2 0 014 0v1M17 11a2 2 0 014 0v3a7 7 0 01-7 7h-1.5a7 7 0 01-5.6-2.8L4.3 15a2 2 0 013.3-2.2L9 15',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  shrink: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  rotate: 'M3 11a9 9 0 0115.4-6.4L21 7M21 3v4h-4M21 13a9 9 0 01-15.4 6.4L3 17M3 21v-4h4',
  drag: 'M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3',
  power: 'M12 3v8M6.3 6.7a8 8 0 1011.4 0',
  gamepad: 'M6 11h4M8 9v4M15 12h.01M18 10h.01M17.3 5H6.7a4 4 0 00-3.9 3.1l-1.2 5.4A3 3 0 004.5 17h.6a3 3 0 002.4-1.2L9 14h6l1.5 1.8a3 3 0 002.4 1.2h.6a3 3 0 002.9-3.5l-1.2-5.4A4 4 0 0017.3 5z',
  folder: 'M3 7.5A1.5 1.5 0 014.5 6h4.2l2 2h8.8A1.5 1.5 0 0121 9.5v8a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 17.5z',
  drive: 'M4 13h16v5a1 1 0 01-1 1H5a1 1 0 01-1-1zM4 13l2.5-7h11L20 13M16.5 16h.01',
  // Cần gạt kiểu máy điện tử thùng: chế độ tay cầm dời chuột.
  joystick: 'M12 3.5a3 3 0 110 6 3 3 0 010-6zM12 9.5V15M5.5 15h13a1.5 1.5 0 011.5 1.5v2a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 18.5v-2A1.5 1.5 0 015.5 15z',
  // Ba nút giữa tay cầm Xbox: View (hai khung chồng), Xbox (vòng có chữ X), Menu (ba vạch).
  xview: 'M9 5h9a1 1 0 011 1v7M5 9h9a1 1 0 011 1v8a1 1 0 01-1 1H5a1 1 0 01-1-1v-8a1 1 0 011-1z',
  xguide: 'M12 3a9 9 0 110 18 9 9 0 010-18zM8.8 8.8l6.4 6.4M15.2 8.8l-6.4 6.4',
  xmenu: 'M5 7h14M5 12h14M5 17h14',
  mic: 'M12 3a3 3 0 013 3v6a3 3 0 01-6 0V6a3 3 0 013-3zM5 11a7 7 0 0014 0M12 18v3',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  gauge: 'M12 14l4-4M3.5 18a9 9 0 1117 0',
  spark: 'M12 3l1.8 4.6L18.5 9.4l-4.7 1.8L12 16l-1.8-4.8L5.5 9.4l4.7-1.8z',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  clip: 'M21 11l-8.5 8.5a5 5 0 01-7-7L14 4a3.5 3.5 0 015 5l-8.5 8.5a2 2 0 01-3-3L15 7',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  download: 'M12 4v11M7 10l5 5 5-5M4 20h16',
  info: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v5.5M12 7.6h.01',
  thermo: 'M14 14.76V5a2 2 0 10-4 0v9.76a4 4 0 104 0zM12 17.5v-6',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5',
  // Nhóm phiên: ba người, vương miện của trưởng nhóm, hồng tâm của mục tiêu.
  group: 'M16 20v-1.5a3.5 3.5 0 00-3.5-3.5h-5A3.5 3.5 0 004 18.5V20M10 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM20 20v-1.5a3.5 3.5 0 00-2.6-3.38M15.5 4.13a3.5 3.5 0 010 6.74',
  crown: 'M4 18h16M4.5 15L3 7l5 3.5L12 5l4 5.5L21 7l-1.5 8z',
  target: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 16.5a4.5 4.5 0 100-9 4.5 4.5 0 000 9zM12 12.6a.6.6 0 100-1.2.6.6 0 000 1.2z',
  pause: 'M9 5v14M15 5v14',
  // Phiên nổi trên màn của máy: khung màn hình có một ô nhỏ nổi ở góc phải.
  pip: 'M20 11V6a1 1 0 00-1-1H4a1 1 0 00-1 1v12a1 1 0 001 1h7M14 14h7v6h-7z',
};

export function icon(name, size = 20, cls = '') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', name === 'more' ? '3' : '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', PATHS[name] || PATHS.tool);
  svg.append(path);
  return svg;
}

export function toolIcon(name = '') {
  const n = name.toLowerCase();
  if (n === 'bash' || n === 'powershell' || n.includes('shell')) return 'terminal';
  if (n === 'read' || n === 'write' || n === 'notebookedit') return 'file';
  if (n === 'edit' || n === 'multiedit') return 'edit';
  if (n === 'grep' || n === 'glob' || n.includes('search')) return 'search';
  if (n.startsWith('web')) return 'globe';
  if (n === 'agent' || n === 'task') return 'agent';
  if (n.startsWith('mcp__orbit-remote')) return 'channel';
  return 'tool';
}
