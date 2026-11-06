// Kéo thẻ phiên thả vào một nhóm.
//
// Chuột: nhấn rồi kéo quá vài điểm ảnh là bắt đầu kéo, thả ra là thôi, cú bấm theo sau bị nuốt để không mở
// phiên. Cảm ứng: giữ yên một nhịp rồi mới kéo, còn vuốt ngay thì vẫn cuộn danh sách như thường (iPhone
// không có kéo thả HTML5, nên tự làm bằng sự kiện chạm). Chỗ thả là mọi phần tử có data-drop-group,
// kể cả màn của nhóm ở cột phải bản PC.
//
// Bóng của thẻ chỉ dời bằng transform trong requestAnimationFrame: mỗi nhịp màn hình vẽ một lần, trình
// duyệt đẩy sang GPU, không tính lại bố cục trang.

const HOLD_MS = 360; // giữ yên chừng này trên màn cảm ứng thì nhấc thẻ lên
const MOVE_PX = 6; // chuột kéo quá chừng này mới tính là kéo (dưới mức đó là một cú bấm)
const SLOP_PX = 10; // ngón tay trôi quá chừng này trước khi nhấc thẻ: người dùng đang cuộn
const EDGE_PX = 56; // kéo tới sát mép trên hay dưới của vùng cuộn thì tự cuộn theo
const EDGE_SPEED = 14; // điểm ảnh mỗi nhịp khi chạm hẳn mép

// onEnd: chạy khi một lần kéo kết thúc (thả trúng hay trượt), để màn đã hoãn vẽ lại thì vẽ bù.
export function isDragging() {
  return document.documentElement.classList.contains('dragging-session');
}

export function enableSessionDrag(root, onDrop, onEnd = null) {
  let s = null; // một lần kéo: { card, sid, x0, y0, x, y, active, kind, timer, ghost, ... }
  let frame = 0;

  const cardAt = (target) => {
    const card = target?.closest?.('a.session-card[data-sid]');
    return card && root.contains(card) ? card : null;
  };

  function begin() {
    const r = s.card.getBoundingClientRect();
    const ghost = s.card.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.classList.remove('current');
    ghost.removeAttribute('href');
    Object.assign(ghost.style, { width: `${r.width}px`, left: `${r.left}px`, top: `${r.top}px` });
    document.body.append(ghost);
    Object.assign(s, { active: true, ghost, left: r.left, top: r.top, offX: s.x - r.left, offY: s.y - r.top });
    s.card.classList.add('drag-source');
    document.documentElement.classList.add('dragging-session');
    s.scroller = s.card.closest('.scroll');
    // Đang kéo thì không bôi chữ của trang (chuột lướt qua chữ ở cột bên cạnh).
    window.getSelection?.()?.removeAllRanges();
    document.addEventListener('selectstart', noSelect);
    navigator.vibrate?.(12);
    tick();
  }

  function noSelect(e) {
    e.preventDefault();
  }

  // Mỗi nhịp: dời bóng, tìm chỗ thả dưới ngón tay, tự cuộn khi sát mép.
  function tick() {
    frame = 0;
    if (!s?.active) return;
    s.ghost.style.transform = `translate3d(${s.x - s.offX - s.left}px, ${s.y - s.offY - s.top}px, 0) scale(1.03) rotate(-1deg)`;
    const over = document.elementFromPoint(s.x, s.y)?.closest('[data-drop-group]') || null;
    if (over !== s.over) {
      s.over?.classList.remove('drop-over');
      over?.classList.add('drop-over');
      s.over = over;
    }
    let scrolling = false;
    if (s.scroller) {
      const box = s.scroller.getBoundingClientRect();
      const up = s.y - box.top;
      const down = box.bottom - s.y;
      const speed = up < EDGE_PX ? -EDGE_SPEED * (1 - Math.max(0, up) / EDGE_PX)
        : down < EDGE_PX ? EDGE_SPEED * (1 - Math.max(0, down) / EDGE_PX) : 0;
      if (speed) {
        const before = s.scroller.scrollTop;
        s.scroller.scrollTop += speed;
        scrolling = s.scroller.scrollTop !== before;
      }
    }
    if (scrolling) frame = requestAnimationFrame(tick); // đang cuộn thì chỗ thả dưới ngón tay đổi theo
  }

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(tick);
  };

  function finish(drop) {
    if (!s) return;
    clearTimeout(s.timer);
    cancelAnimationFrame(frame);
    frame = 0;
    const done = s;
    s = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('touchmove', onTouchMove);
    window.removeEventListener('touchend', onTouchEnd);
    window.removeEventListener('touchcancel', onTouchCancel);
    if (!done.active) return;
    document.removeEventListener('selectstart', noSelect);
    done.over?.classList.remove('drop-over');
    done.card.classList.remove('drag-source');
    document.documentElement.classList.remove('dragging-session');
    const target = drop ? done.over?.dataset.dropGroup : '';
    // Thả trúng thì bóng thu vào chỗ thả; trượt thì mờ đi tại chỗ.
    done.ghost.classList.add(target ? 'drop-in' : 'drop-miss');
    setTimeout(() => done.ghost.remove(), 220);
    onEnd?.();
    if (target) onDrop(done.sid, target);
  }

  // ---- Chuột và bút ---------------------------------------------------------------------------
  function onPointerDown(e) {
    if (e.pointerType === 'touch' || e.button !== 0 || s) return;
    const card = cardAt(e.target);
    if (!card) return;
    s = { card, sid: card.dataset.sid, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, active: false, kind: 'mouse' };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  }
  function onPointerMove(e) {
    if (!s || s.kind !== 'mouse') return;
    s.x = e.clientX;
    s.y = e.clientY;
    if (!s.active) {
      if (Math.hypot(s.x - s.x0, s.y - s.y0) < MOVE_PX) return;
      begin();
    }
    schedule();
  }
  function onPointerUp() {
    if (s?.active) swallowClick();
    finish(true);
  }
  function onPointerCancel() {
    finish(false);
  }

  // ---- Cảm ứng ------------------------------------------------------------------------------------
  function onTouchStart(e) {
    if (s || e.touches.length !== 1) return;
    const card = cardAt(e.target);
    if (!card) return;
    const t = e.touches[0];
    s = { card, sid: card.dataset.sid, x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY, active: false, kind: 'touch' };
    s.timer = setTimeout(() => { if (s && !s.active) begin(); }, HOLD_MS);
    // passive: false để chặn được cuộn trang khi đã nhấc thẻ lên.
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd, { passive: false });
    window.addEventListener('touchcancel', onTouchCancel);
  }
  function onTouchMove(e) {
    if (!s || s.kind !== 'touch') return;
    const t = e.touches[0];
    if (!t) return;
    s.x = t.clientX;
    s.y = t.clientY;
    if (!s.active) {
      if (Math.hypot(s.x - s.x0, s.y - s.y0) > SLOP_PX) finish(false); // đang cuộn, không phải kéo
      return;
    }
    e.preventDefault();
    schedule();
  }
  function onTouchEnd(e) {
    // Đã nhấc thẻ thì chặn cú chạm biến thành cú bấm mở phiên.
    if (s?.active) e.preventDefault();
    finish(true);
  }
  function onTouchCancel() {
    finish(false);
  }

  function swallowClick() {
    const stop = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('click', stop, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 0);
  }

  // Giữ lâu trên điện thoại thì trình duyệt mở bảng của liên kết; kéo chuột trên liên kết thì trình duyệt
  // tự kéo đường dẫn. Chặn cả hai trên thẻ phiên; bấm chuột phải thì vẫn có bảng như thường.
  const onContextMenu = (e) => { if (s?.kind === 'touch') e.preventDefault(); };
  const onDragStart = (e) => { if (cardAt(e.target)) e.preventDefault(); };

  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('touchstart', onTouchStart, { passive: true });
  root.addEventListener('contextmenu', onContextMenu);
  root.addEventListener('dragstart', onDragStart);
  return () => {
    finish(false);
    root.removeEventListener('pointerdown', onPointerDown);
    root.removeEventListener('touchstart', onTouchStart);
    root.removeEventListener('contextmenu', onContextMenu);
    root.removeEventListener('dragstart', onDragStart);
  };
}
