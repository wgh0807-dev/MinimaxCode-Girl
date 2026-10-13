'use strict';

/* ==================================================================== *
 *  桌宠渲染 + 状态机
 *
 *  形象是 6 张预抠好的透明 PNG（assets/pet-flat-*.png），
 *  全部统一画布 364x584、脚底对齐、水平居中，所以切表情时角色
 *  不会跳动、不会忽大忽小。
 *
 *  DOM 分层：
 *    #bodywrap  水平居中（只做 translateX，不参与动画）
 *    #body      身体动画目标，transform-origin 在脚底
 *    .sprite    6 张图叠在一起，只有一张 .on
 *    #fx        特效层，dots / zzz / spark / excl，不跟身体一起 transform
 * ==================================================================== */

const STATES = {
  idle:       { sprite: 'idle',       anim: 'anim-breathe', fx: '' },
  thinking:   { sprite: 'thinking',   anim: 'anim-tilt',    fx: 'show-dots' },
  typing:     { sprite: 'working',    anim: 'anim-tap',     fx: '' },
  working:    { sprite: 'working',    anim: 'anim-tap',     fx: '' },
  permission: { sprite: 'permission', anim: 'anim-bump',    fx: 'show-ask' },
  happy:      { sprite: 'happy',      anim: 'anim-jump',    fx: 'show-spark' },
  error:      { sprite: 'error',      anim: 'anim-shake',   fx: 'show-excl' },
  sleeping:   { sprite: 'sleeping',   anim: 'anim-sleep',   fx: 'show-zzz' }
};

const ALL_ANIMS = ['anim-breathe', 'anim-tilt', 'anim-tap', 'anim-bump', 'anim-jump', 'anim-shake', 'anim-sleep'];
const ALL_FX = ['show-dots', 'show-ask', 'show-zzz', 'show-spark', 'show-excl'];

const bodyWrap = document.getElementById('bodywrap');
const body = document.getElementById('body');
const shadow = document.getElementById('shadow');
const fx = document.getElementById('fx');
const bubbleEl = document.getElementById('bubble');
const sprites = [...document.querySelectorAll('.sprite')];
const panel = document.getElementById('panel');
const panelBar = document.getElementById('panel-bar');
const panelNum = document.getElementById('panel-num');
const panelModel = document.getElementById('panel-model');

/** 上下文用量面板：上下文占用 / 上限 + 模型名 */
function fmtTokens(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'K';
  return String(n);
}

let lastCtxKey = null;
function renderContext(ctx) {
  const key = ctx ? `${ctx.used}/${ctx.window}/${ctx.model}` : 'none';
  if (key === lastCtxKey) return;
  lastCtxKey = key;

  if (!ctx) {
    panel.classList.add('empty');
    panelNum.textContent = '—';
    panelModel.textContent = '';
    panelBar.style.width = '0%';
    return;
  }

  panel.classList.remove('empty');
  const pct = ctx.pct == null ? 0 : Math.max(0, Math.min(1, ctx.pct));
  panelBar.style.width = (pct * 100).toFixed(1) + '%';
  panelBar.className = pct >= 0.85 ? 'bar hot' : pct >= 0.6 ? 'bar warm' : 'bar';
  panelNum.textContent = ctx.window
    ? `${fmtTokens(ctx.used)} / ${fmtTokens(ctx.window)}`
    : fmtTokens(ctx.used);
  panelModel.textContent = ctx.model ? ctx.model.replace(/^MiniMax-/, '') : '';
}

let state = 'idle';
let rendered = null;   // 当前真正画出来的状态
let forcing = null;    // 戳一戳时临时接管
let forcingUntil = 0;

function render(next) {
  // 关键：watcher 每 1.2s 就会推一次状态（哪怕没变）。
  // 如果每次都摘掉再加回 class，CSS 动画会被无限重启，只播前一截就弹回起点。
  // 所以状态没变时直接跳过，让动画自己跑完整个周期。
  if (rendered === next) return;
  rendered = next;

  const st = STATES[next] || STATES.idle;

  for (const img of sprites) {
    img.classList.toggle('on', img.dataset.sprite === st.sprite);
  }

  body.classList.remove(...ALL_ANIMS);
  shadow.classList.remove(...ALL_ANIMS);
  // 强制回流，保证同一个动画重新开始播放
  void body.offsetWidth;
  body.classList.add(st.anim);
  shadow.classList.add(st.anim);

  fx.classList.remove(...ALL_FX);
  if (st.fx) fx.classList.add(st.fx);
}

/* ---------------------------------------------------------------- *
 *  气泡
 * ---------------------------------------------------------------- */

let bubbleTimer = null;

function say(text, kind) {
  if (!text) {
    bubbleEl.classList.remove('show');
    return;
  }
  bubbleEl.textContent = text;
  bubbleEl.classList.remove('happy', 'error');
  if (kind) bubbleEl.classList.add(kind);
  bubbleEl.classList.add('show');
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubbleEl.classList.remove('show'), 3600);
}

/* ---------------------------------------------------------------- *
 *  状态接入
 * ---------------------------------------------------------------- */

const LABEL_KIND = { happy: 'happy', error: 'error', permission: 'ask' };

function applyState(next, label, context) {
  const prev = state;
  state = STATES[next] ? next : 'idle';

  if (label) {
    // 刚从忙 -> 完成，给个更长的庆祝
    const finished = state === 'happy' && prev !== 'happy';
    say(label, LABEL_KIND[state]);
    if (finished) {
      setTimeout(() => {
        if (state === 'happy') say('搞定！', 'happy');
      }, 700);
    }
  } else if (state !== prev) {
    bubbleEl.classList.remove('show');
  }

  render(forcing || state);
  renderContext(context || null);
}

function poke() {
  forcing = 'happy';
  forcingUntil = performance.now() + 1400;
  say('戳到了！', 'happy');
  render('happy');
  // 到期后落回真实状态（期间可能已经切过状态，所以记当前 state 而不是恢复旧值）
  setTimeout(() => {
    if (performance.now() < forcingUntil) return;
    forcing = null;
    render(state);
  }, 1450);
}

if (window.pet && window.pet.onState) {
  window.pet.onState((p) => applyState(p.state, p.label, p.context));
  window.pet.onPoke(poke);
}

/* ---------------------------------------------------------------- *
 *  鼠标：穿透 / 拖动 / 戳
 * ---------------------------------------------------------------- */

let hovering = false;
let dragging = false;
let downAt = 0;
let moved = false;
const clickable = () => [bodyWrap, bubbleEl];

function isOverPet(x, y) {
  for (const el of clickable()) {
    const r = el.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
  }
  return false;
}

window.addEventListener('mousemove', (e) => {
  const over = isOverPet(e.clientX, e.clientY);
  if (over !== hovering) {
    hovering = over;
    window.pet.hover(over);
  }
  if (dragging) {
    if (Math.abs(e.clientX - downAt.x) > 3 || Math.abs(e.clientY - downAt.y) > 3) {
      moved = true;
    }
  }
});

bodyWrap.addEventListener('mousedown', (e) => {
  e.preventDefault();
  dragging = true;
  moved = false;
  downAt = { x: e.clientX, y: e.clientY };
  bodyWrap.classList.add('dragging');
  window.pet.dragStart();
});

window.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  bodyWrap.classList.remove('dragging');
  window.pet.dragEnd();
  if (!moved) poke();
});

bodyWrap.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.pet.menu();
});

// 鼠标移出窗口后交还穿透
window.addEventListener('mouseleave', () => {
  if (hovering) {
    hovering = false;
    window.pet.hover(false);
  }
});

render(state);
renderContext(null);