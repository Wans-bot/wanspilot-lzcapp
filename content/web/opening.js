// 启动开场动画：铺一层星空，按 CSS 里排好的时间轴播完就自动淡出。
// 点击任意位置、按 Enter、Esc 或空格都会立刻结束。
// 系统开启“减少动态效果”时不做动画，只留一帧静态画面然后淡出。

const root = document.getElementById('opening');

// 同一次会话里再刷新就不重播开场，免得每次刷新都白等两秒多。
function seenAlready() {
  try { return window.sessionStorage.getItem('wanspilot.openingSeen') === '1'; } catch { return false; }
}

function rememberSeen() {
  try { window.sessionStorage.setItem('wanspilot.openingSeen', '1'); } catch { /* 隐私模式下写不进去，重播一次也无妨 */ }
}

if (root && seenAlready()) {
  root.remove();
} else if (root) {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // 原型时间轴最后一拍是 2.2s 起、0.72s 的副标题淡入，所以 2.95s 之后再淡出
  const holdMs = reduceMotion ? 400 : 2950;
  const fadeMs = 500;
  let finished = false;
  let frame = 0;

  const canvas = document.getElementById('openingStars');
  const ctx = canvas ? canvas.getContext('2d') : null;
  let stars = [];

  function paint(time) {
    if (!ctx) return;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    const glow = ctx.createRadialGradient(
      innerWidth * .5, innerHeight * .42, 0,
      innerWidth * .5, innerHeight * .42, Math.min(innerWidth, innerHeight) * .56,
    );
    glow.addColorStop(0, 'rgba(29, 129, 239, .08)');
    glow.addColorStop(1, 'rgba(2, 6, 17, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, innerWidth, innerHeight);
    for (const star of stars) {
      const pulse = reduceMotion ? 1 : .75 + Math.sin(time * .0008 * star.drift * 12 + star.phase) * .25;
      ctx.globalAlpha = star.a * pulse;
      ctx.fillStyle = star.r > 1 ? '#86d6ff' : '#b2c9ee';
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
      ctx.fill();
      if (!reduceMotion) star.y -= star.drift * .018;
      if (star.y < -4) star.y = innerHeight + 4;
    }
    ctx.globalAlpha = 1;
    if (!finished) frame = requestAnimationFrame(paint);
  }

  function resize() {
    if (!ctx || !canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(innerWidth * dpr);
    canvas.height = Math.floor(innerHeight * dpr);
    canvas.style.width = innerWidth + 'px';
    canvas.style.height = innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    stars = Array.from({ length: Math.min(140, Math.floor(innerWidth / 8)) }, (_, index) => ({
      x: Math.random() * innerWidth,
      y: Math.random() * innerHeight,
      r: Math.random() * (index % 8 === 0 ? 1.5 : .8) + .15,
      a: Math.random() * .55 + .12,
      drift: Math.random() * .12 + .02,
      phase: Math.random() * Math.PI * 2,
    }));
  }

  function finish() {
    if (finished) return;
    finished = true;
    rememberSeen();
    document.documentElement.classList.remove('opening-active');
    cancelAnimationFrame(frame);
    window.removeEventListener('keydown', onKey, true);
    root.removeEventListener('click', onPointer);
    window.clearTimeout(timer);
    root.classList.add('opening--leaving');
    window.setTimeout(() => root.remove(), fadeMs);
  }

  function onKey(event) {
    if (event.key === 'Enter' || event.key === 'Escape' || event.key === ' ') finish();
  }

  function onPointer(event) {
    event.preventDefault();
    finish();
  }

  resize();
  window.addEventListener('resize', resize);
  document.documentElement.classList.add('opening-active');
  root.classList.add('opening--playing');
  if (!reduceMotion) paint(0);
  window.addEventListener('keydown', onKey, true);
  root.addEventListener('click', onPointer);
  const timer = window.setTimeout(finish, holdMs);
}
