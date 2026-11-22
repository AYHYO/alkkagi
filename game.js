/* 알까기 1 vs 1 — game.js
 * 단일 공용 물리 공간(Matter.js) / 스와이프 발사 / 상태 머신 / 게임 시계(일시정지 시 완전 정지)
 * 좌표계: 게임판 내부 단위 1000x1000 (화면 크기에 맞춰 스케일링, 항상 정사각형)
 */
(() => {
'use strict';
if (typeof Matter === 'undefined') {
  document.body.innerHTML = '<p style="color:#fff;padding:24px;font:16px sans-serif">물리 엔진(Matter.js)을 불러오지 못했습니다. 인터넷 연결을 확인하고 새로고침하세요.</p>';
  return;
}
const { Engine, Bodies, Body, Composite, Events } = Matter;
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);

/* ================= 상수 (플레이 테스트로 조정하는 값) ================= */
const BS = 1000;                 // 게임판 한 변 (내부 단위)
const STEP = 1000 / 120;         // 고정 물리 스텝(ms)
const PH = {
  decel: 0.30,      // 바닥 마찰 감속 (단위/프레임², 1프레임=16.67ms) — 일정 감속(쿨롱 마찰)
  expo: 0.004,      // 속도 비례 감쇠(프레임당)
  angDamp: 0.985,   // 회전 감쇠(스텝당)
  restSpeed: 0.12, restAng: 0.012, restHold: 250,  // 정지 판정: 임계값 이하가 250ms 유지
  vmin: 5, vmax: 30,                 // 발사 속도 범위(단위/프레임)
  restitution: 0.78, friction: 0.08
};
const RULE = {
  curlLimit: 10000, placeLimit: 20000, turnLimit: 10000,
  forceEvery: 3,
  attackTol: 104,    // 강제 공격 판정: 알 2개 직경(2 x 52)
  curlTie: 2         // 컬링 거리 차이가 이 값 이하이면 재경기
};
const R_STONE = 26, R_PIECE = 28, R_HORSE = 34;
const HORSE_V = [{x:-12,y:-34},{x:12,y:-34},{x:30,y:-14},{x:30,y:16},{x:18,y:34},{x:-18,y:34},{x:-30,y:16},{x:-30,y:-14}];

/* ================= 설정 저장 ================= */
const settings = { volume: 0.8, haptic: true };
try { const s = JSON.parse(localStorage.getItem('algakgi-settings')); if (s) Object.assign(settings, s); } catch (e) {}
const saveSettings = () => { try { localStorage.setItem('algakgi-settings', JSON.stringify(settings)); } catch (e) {} };

/* ================= 사운드 (실제 음원 파일이 있을 때만 재생) =================
 * sounds/{stone|wood}_{light|mid|hard}_{1..3}.mp3, sounds/launch_{stone|wood}.mp3
 * 파일이 없으면 조용히 무시한다(전자음 대체 없음). */
const Snd = {
  ctx: null, bufs: {},
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { this.ctx = new AC(); } catch (e) { return; }
      this.load();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  },
  fetchBuf(key, url) {
    fetch(url).then(r => r.ok ? r.arrayBuffer() : null).then(ab => ab && new Promise((res, rej) => this.ctx.decodeAudioData(ab, res, rej)))
      .then(buf => { if (buf) (this.bufs[key] = this.bufs[key] || []).push(buf); }).catch(() => {});
  },
  load() {
    for (const k of ['stone', 'wood']) {
      for (const lv of ['light', 'mid', 'hard']) for (let i = 1; i <= 3; i++) this.fetchBuf(`${k}_${lv}`, `sounds/${k}_${lv}_${i}.mp3`);
      this.fetchBuf(`launch_${k}`, `sounds/launch_${k}.mp3`);
    }
  },
  play(key, vol, rate) {
    if (!this.ctx || settings.volume <= 0) return;
    const list = this.bufs[key]; if (!list || !list.length) return;
    const src = this.ctx.createBufferSource(), g = this.ctx.createGain();
    src.buffer = list[(Math.random() * list.length) | 0];
    src.playbackRate.value = rate * rand(0.95, 1.05);
    g.gain.value = clamp(vol * settings.volume * rand(0.9, 1), 0, 1);
    src.connect(g); g.connect(this.ctx.destination); src.start(0);
  }
};
function haptic(pattern, strong) {
  if (!settings.haptic) return;
  if (navigator.vibrate) { navigator.vibrate(pattern); return; }
  // iOS Safari 대체: 화면 흔들림
  const st = $('stage'); st.classList.remove('shake1', 'shake2'); void st.offsetWidth;
  st.classList.add(strong ? 'shake2' : 'shake1');
  setTimeout(() => st.classList.remove('shake1', 'shake2'), 300);
}

/* ================= 게임 시계 / 스케줄러 (일시정지 시 정지) ================= */
const T = { now: 0, list: [] };
const after = (ms, fn) => T.list.push({ at: T.now + ms, fn });
function runTimers() {
  for (let guard = 0; guard < 50; guard++) {
    const i = T.list.findIndex(t => t.at <= T.now);
    if (i < 0) return;
    const [t] = T.list.splice(i, 1); t.fn();
  }
}

/* ================= 전역 상태 ================= */
let state = 'MainMenu', prevState = 'MainMenu';
const G = {
  mode: 'omok', colors: { 1: 'black', 2: 'white' }, pieces: [], fx: [],
  turn: 0, turnCount: { 1: 0, 2: 0 }, forced: false, launched: false, attackOK: false,
  restMs: 0, turnLeft: 0, placeLeft: 0, place: null, cur: null, pen: null, first: 0, noticeTok: 0
};
let engine, W = 0, H = 0, bx = 0, by = 0, bs = 300, sc = 0.3, dpr = 1, acc = 0;
const cvs = $('game'), ctx = cvs.getContext('2d'), bgc = $('bg');
let boardCache = null;

/* ================= 화면 전환 ================= */
const SCREEN_OF = { MainMenu: 's-menu', Settings: 's-settings', PieceSelection: 's-select', CurlingInstructions: 's-instr', Paused: 's-pause', GameOver: 's-over' };
const GAME_STATES = ['CurlingCountdown', 'Curling', 'Placement', 'Playing', 'WaitingForPhysics', 'TurnTransition', 'Penalty', 'Paused'];
function setState(s) {
  if (s === 'Paused') prevState = state;
  state = s;
  document.querySelectorAll('.screen').forEach(el => el.classList.remove('show'));
  if (SCREEN_OF[s]) $(SCREEN_OF[s]).classList.add('show');
  if (s === 'MainMenu') { const lg = $('logo'); lg.classList.remove('play'); void lg.offsetWidth; lg.classList.add('play'); }
  $('hud').classList.toggle('show', GAME_STATES.includes(s) || (s === 'GameOver'));
  $('pauseBtn').style.display = (s === 'GameOver' || s === 'Paused') ? 'none' : 'flex';
  refreshUI();
}

/* ================= 물리 월드 ================= */
function newEngine() {
  engine = Engine.create({ gravity: { x: 0, y: 0, scale: 0 }, positionIterations: 8, velocityIterations: 6, enableSleeping: false });
  Events.on(engine, 'collisionStart', ev => {
    for (const pair of ev.pairs) {
      const a = pair.bodyA, b = pair.bodyB, n = pair.collision && pair.collision.normal; if (!n) continue;
      const va = getV(a), vb = getV(b);
      onImpact(Math.abs((va.x - vb.x) * n.x + (va.y - vb.y) * n.y));
    }
  });
}
const getV = b => Body.getVelocity ? Body.getVelocity(b) : b.velocity;
const getAV = b => Body.getAngularVelocity ? Body.getAngularVelocity(b) : b.angularVelocity;

function makePiece(owner, x, y, spec) {
  const opt = { restitution: PH.restitution, friction: PH.friction, frictionStatic: 0, frictionAir: 0, slop: 0.02 };
  let body, r;
  if (spec.type === 'stone') { r = R_STONE; body = Bodies.circle(x, y, r, opt, 32); }
  else if (spec.type === 'piece') { r = R_PIECE; body = Bodies.polygon(x, y, 8, r, opt); }
  else { r = R_HORSE; body = Bodies.fromVertices(x, y, [HORSE_V.map(v => ({ x: v.x, y: v.y }))], opt); }
  Body.setPosition(body, { x, y });
  const local = spec.type === 'stone' ? null : body.vertices.map(v => ({ x: v.x - body.position.x, y: v.y - body.position.y }));
  Body.setAngle(body, owner === 2 ? Math.PI : 0);
  const p = { owner, spec, body, r, local, out: false, gone: false };
  G.pieces.push(p); Composite.add(engine.world, body);
  return p;
}
const px = p => p.body.position.x, py = p => p.body.position.y;
const alive = o => G.pieces.filter(p => p.owner === o && !p.out);
const shown = o => G.pieces.filter(p => p.owner === o && !p.gone);

function specsFor(owner) {
  const color = G.colors[owner];
  if (G.mode === 'omok') return Array.from({ length: 7 }, () => ({ type: 'stone', color }));
  const chars = color === 'red' ? ['兵', '兵', '兵', '包', '車', '象', '士'] : ['卒', '卒', '卒', '包', '車', '象', '士'];
  return [...chars.map(ch => ({ type: 'piece', color, ch })), { type: 'horse', color, ch: '馬' }, { type: 'horse', color, ch: '馬' }];
}
function assignColors() {
  const flip = Math.random() < 0.5;
  G.colors = G.mode === 'omok' ? (flip ? { 1: 'black', 2: 'white' } : { 1: 'white', 2: 'black' })
                               : (flip ? { 1: 'red', 2: 'blue' } : { 1: 'blue', 2: 'red' });
}
function resetAll() {
  T.list.length = 0; pointers.clear(); acc = 0; hideNotices();
  G.pieces = []; G.fx = []; newEngine();
  Object.assign(G, { turn: 0, turnCount: { 1: 0, 2: 0 }, forced: false, launched: false, attackOK: false, restMs: 0, turnLeft: 0,
    placeLeft: 0, place: null, cur: null, pen: null, first: 0 });
  ['done1', 'done2'].forEach(id => { const b = $(id); b.classList.remove('show', 'done'); b.textContent = '배치완료'; });
}

/* ================= 물리 스텝 ================= */
function stopDist(v) { let d = 0; while (v > 0.02) { d += v; v = Math.max(0, v - PH.decel) * (1 - PH.expo); } return d; }
function stepPhysics(dt) {
  acc += dt; let n = 0;
  while (acc >= STEP && n < 12) {
    for (const p of G.pieces) {
      if (p.out) continue;
      const b = p.body, v = getV(b), sp = Math.hypot(v.x, v.y);
      if (sp > 0) {
        let ns = Math.max(0, sp - PH.decel * 0.5) * (1 - PH.expo * 0.5); if (ns < 0.02) ns = 0;
        const k = ns / sp; Body.setVelocity(b, { x: v.x * k, y: v.y * k });
      }
      let av = getAV(b);
      if (av !== 0) { av *= PH.angDamp; if (Math.abs(av) < 0.0015) av = 0; Body.setAngularVelocity(b, av); }
    }
    Engine.update(engine, STEP);
    let moving = false;
    for (const p of G.pieces) {
      if (p.out) continue;
      const x = px(p), y = py(p);
      if (x < 0 || x > BS || y < 0 || y > BS) { startFall(p); continue; }   // 판 가장자리를 넘는 순간 탈락 (벽 없음)
      const v = getV(p.body);
      if (Math.hypot(v.x, v.y) > PH.restSpeed || Math.abs(getAV(p.body)) > PH.restAng) moving = true;
    }
    G.restMs = moving ? 0 : G.restMs + STEP;
    acc -= STEP; n++;
  }
  if (n >= 12) acc = 0;
}
function startFall(p) {
  p.out = true;
  const v = getV(p.body);
  Composite.remove(engine.world, p.body);       // 낙하 중에는 충돌하지 않음
  G.fx.push({ p, x: px(p), y: py(p), vx: v.x, vy: v.y, ang: p.body.angle, av: getAV(p.body) * 1.5 + rand(-0.01, 0.01), t: 0 });
  haptic(35, true);
  if (G.cur) G.cur.dq[p.owner] = true;
}
function updateFx(dt) {
  const f = dt / 16.667;
  for (let i = G.fx.length - 1; i >= 0; i--) {
    const e = G.fx[i]; e.t += dt;
    e.x += e.vx * f; e.y += e.vy * f; e.vx *= 0.99; e.vy *= 0.99; e.ang += e.av * f;
    if (e.t > 950) { e.p.gone = true; G.fx.splice(i, 1); }
  }
}
function onImpact(imp) {
  if (imp < 0.7) return;
  const kind = G.mode === 'omok' ? 'stone' : 'wood';
  const lv = imp < 6 ? 'light' : imp < 15 ? 'mid' : 'hard';
  Snd.play(`${kind}_${lv}`, clamp(0.25 + imp / 24, 0.2, 1), 1);
  if (imp >= 15) haptic(20, false);
}

/* ================= 알림 문구 (seat: 0=양쪽, 1, 2) ================= */
function showNotice(text, seat, ms, cls) {
  const tok = ++G.noticeTok;
  for (const s of [1, 2]) {
    const el = $('nt' + s);
    if (seat === 0 || seat === s) { el.textContent = text; el.className = 'nt show' + (s === 2 ? ' rot' : '') + (cls ? ' ' + cls : ''); }
    else el.className = 'nt' + (s === 2 ? ' rot' : '');
  }
  if (ms) after(ms, () => { if (G.noticeTok === tok) hideNotices(); });
}
function hideNotices() { for (const s of [1, 2]) { const el = $('nt' + s); el.className = 'nt' + (s === 2 ? ' rot' : ''); } }

/* ================= 컬링(선공 결정) ================= */
function startCurling() {
  resetAll(); assignColors();
  const spec = G.mode === 'omok' ? { type: 'stone' } : { type: 'piece', ch: '車' };
  const a = makePiece(1, 250, BS - 66, { ...spec, color: G.colors[1] });
  const b = makePiece(2, 750, 66, { ...spec, color: G.colors[2] });
  G.cur = { launched: { 1: false, 2: false }, dq: { 1: false, 2: false }, closed: false, resolved: false, left: RULE.curlLimit, pc: { 1: a, 2: b } };
  setState('CurlingCountdown');
  const seq = ['3', '2', '1'];
  let i = 0;
  const tick = () => {
    if (i < seq.length) { showNotice(seq[i], 0, 0, 'big'); i++; after(1000, tick); }
    else { showNotice('SHOOT!', 0, 900, 'big'); setState('Curling'); }
  };
  tick();
}
function curlingUpdate(dt) {
  const c = G.cur; if (!c || c.resolved) return;
  if (!c.closed) {
    c.left -= dt;
    if ((c.launched[1] || c.dq[1]) && (c.launched[2] || c.dq[2]) || c.left <= 0) {
      c.closed = true;
      for (const o of [1, 2]) if (!c.launched[o]) c.dq[o] = true;      // 발사하지 않으면 실격
      G.restMs = 0;
    }
    return;
  }
  if (G.fx.length === 0 && G.restMs >= PH.restHold) resolveCurling();
}
function resolveCurling() {
  const c = G.cur; c.resolved = true;
  const d = o => Math.abs(py(c.pc[o]) - BS / 2);
  let first = 0, msg = '';
  if (c.dq[1] && c.dq[2]) msg = '두 플레이어 모두 실격! 재경기';
  else if (c.dq[1]) first = 2; else if (c.dq[2]) first = 1;
  else if (Math.abs(d(1) - d(2)) <= RULE.curlTie) msg = '거리가 같습니다! 재경기';
  else first = d(1) < d(2) ? 1 : 2;
  if (!first) {
    showNotice(msg, 0, 1800, 'warn');
    after(2000, () => startCurling());
    return;
  }
  G.first = first;
  showNotice(`${first} PLAYER 선공!`, 0, 1800);
  after(2000, () => startPlacement());
}

/* ================= 배치 ================= */
function startPlacement() {
  const mode = G.mode, colors = { ...G.colors }, first = G.first;
  resetAll(); G.colors = colors; G.mode = mode; G.first = first;
  for (const o of [1, 2]) {
    const specs = specsFor(o), n = specs.length, gap = n === 7 ? 110 : 100;
    const y = o === 1 ? BS - 100 : 100;
    specs.forEach((s, i) => makePiece(o, BS / 2 + (i - (n - 1) / 2) * gap, y, s));
  }
  G.first = G.first || 1;
  G.place = { done: { 1: false, 2: false } }; G.placeLeft = RULE.placeLimit;
  setState('Placement');
}
function bounds(p) {
  const r = p.r + 2;
  return p.owner === 1 ? { x0: r, x1: BS - r, y0: BS / 2 + r, y1: BS - r } : { x0: r, x1: BS - r, y0: r, y1: BS / 2 - r };
}
function validPos(p, x, y) {
  for (const q of G.pieces) if (q !== p && !q.out && Math.hypot(px(q) - x, py(q) - y) < p.r + q.r + 1) return false;
  return true;
}
function movePlaced(p, x, y) {
  const bd = bounds(p); x = clamp(x, bd.x0, bd.x1); y = clamp(y, bd.y0, bd.y1);
  if (validPos(p, x, y)) Body.setPosition(p.body, { x, y });
  else if (validPos(p, x, py(p))) Body.setPosition(p.body, { x, y: py(p) });
  else if (validPos(p, px(p), y)) Body.setPosition(p.body, { x: px(p), y });
}
function randomizePlacement(o) {
  const mine = G.pieces.filter(p => p.owner === o);
  const spots = []; 
  for (const p of mine) {
    const bd = bounds(p); let ok = false;
    for (let k = 0; k < 400 && !ok; k++) {
      const x = rand(bd.x0, bd.x1), y = rand(bd.y0, bd.y1);
      if (validPos(p, x, y) && !spots.some(s => Math.hypot(s.x - x, s.y - y) < p.r + s.r + 1)) { Body.setPosition(p.body, { x, y }); spots.push({ x, y, r: p.r }); ok = true; }
    }
  }
}
function placementDone(o) {
  if (state !== 'Placement' || G.place.done[o]) return;
  G.place.done[o] = true;
  for (const [id, who] of [['done1', 1], ['done2', 2]]) if (who === o) { $(id).classList.add('done'); $(id).textContent = '대기 중'; }
  for (const [k, v] of pointers) if (v.p.owner === o) pointers.delete(k);
  if (G.place.done[1] && G.place.done[2]) endPlacement();
}
function endPlacement() {
  for (const o of [1, 2]) if (!G.place.done[o]) randomizePlacement(o);   // 시간 초과: 자신의 영역에 무작위 배치
  ['done1', 'done2'].forEach(id => $(id).classList.remove('show'));
  startTurn(G.first);
}

/* ================= 턴 ================= */
function startTurn(p) {
  G.turn = p; G.turnCount[p]++; G.forced = G.turnCount[p] % RULE.forceEvery === 0;
  G.launched = false; G.attackOK = false;
  setState('TurnTransition');
  showNotice(`${p} PLAYER 차례`, p, 500);
  after(500, () => {
    if (G.forced) { showNotice('이번 턴은 공격해야 합니다!', p, 1000, 'warn'); after(1000, beginPlay); }
    else beginPlay();
  });
}
function beginPlay() { G.turnLeft = RULE.turnLimit; setState('Playing'); }

function isValidAttack(p, dir, v) {
  const reach = stopDist(v), ox = px(p), oy = py(p);
  for (const q of alive(p.owner === 1 ? 2 : 1)) {
    const dx = px(q) - ox, dy = py(q) - oy;
    const t = clamp(dx * dir.x + dy * dir.y, 0, reach);          // 감속 후 도달 가능한 경로 위의 최근접점
    if (Math.hypot(dx - dir.x * t, dy - dir.y * t) <= RULE.attackTol) return true;
  }
  return false;
}
function launch(p, dir, v) {
  if (state === 'Playing') {
    if (G.launched || p.owner !== G.turn) return false;
    G.launched = true;
    G.attackOK = G.forced ? isValidAttack(p, dir, v) : true;
    Body.setVelocity(p.body, { x: dir.x * v, y: dir.y * v });
    G.restMs = 0; acc = 0;
    Snd.play('launch_' + (G.mode === 'omok' ? 'stone' : 'wood'), 0.6 + v / 80, 1);
    setState('WaitingForPhysics');
    return true;
  }
  if (state === 'Curling' && G.cur && !G.cur.closed && !G.cur.launched[p.owner] && !G.cur.dq[p.owner]) {
    G.cur.launched[p.owner] = true;
    Body.setVelocity(p.body, { x: dir.x * v, y: dir.y * v });
    G.restMs = 0;
    Snd.play('launch_' + (G.mode === 'omok' ? 'stone' : 'wood'), 0.6 + v / 80, 1);
    return true;
  }
  return false;
}
function endTurn() {
  const a1 = alive(1).length, a2 = alive(2).length;
  if (a1 === 0 || a2 === 0) return gameOver(a1 === 0 && a2 === 0 ? G.turn : (a1 === 0 ? 1 : 2));   // 동시 전멸: 발사자 패배
  if (G.forced && !G.attackOK) return startPenalty(G.turn);
  startTurn(G.turn === 1 ? 2 : 1);
}
function startPenalty(o) {
  setState('Penalty');
  showNotice('공격을 하지 않았습니다. 패널티가 적용됩니다.', o, 1500, 'warn');
  after(1500, () => {
    const cand = alive(o); const pick = cand[(Math.random() * cand.length) | 0];
    G.pen = { p: pick, t: 0 }; hideNotices();
    haptic([40, 60, 40], true);
    after(3000, () => {                                   // 약 3초 빨간 깜빡임 후 제거
      pick.out = pick.gone = true; Composite.remove(engine.world, pick.body); G.pen = null;
      haptic(40, true);
      showNotice('패널티 적용 완료', o, 1000);
      after(1000, () => {
        const a1 = alive(1).length, a2 = alive(2).length;
        if (a1 === 0 || a2 === 0) return gameOver(a1 === 0 ? 1 : 2);
        startTurn(G.turn === 1 ? 2 : 1);
      });
    });
  });
}
function gameOver(loser) {
  hideNotices();
  const w = loser === 1 ? 2 : 1;
  $('goTitle').textContent = `PLAYER ${w} 승리!`; $('goTitle2').textContent = `PLAYER ${w} 승리!`;
  $('goCnt').innerHTML = `PLAYER 1 · 남은 알 ${alive(1).length}개<br>PLAYER 2 · 남은 알 ${alive(2).length}개<br><small>패배: PLAYER ${loser}</small>`;
  setState('GameOver');
}

/* ================= 메인 업데이트 ================= */
function update(dt) {
  T.now += dt; runTimers(); updateFx(dt);
  if (G.pen) G.pen.t += dt;
  switch (state) {
    case 'Curling': stepPhysics(dt); curlingUpdate(dt); break;
    case 'Placement':
      G.placeLeft -= dt;
      if (G.placeLeft <= 0) { G.placeLeft = 0; endPlacement(); }
      break;
    case 'Playing':
      G.turnLeft -= dt;
      if (G.turnLeft <= 0) { G.turnLeft = 0; G.attackOK = false; endTurn(); }        // 시간 초과: 발사 없이 종료
      break;
    case 'WaitingForPhysics':
      stepPhysics(dt);
      if (G.restMs >= PH.restHold && G.fx.length === 0) endTurn();                  // 모든 움직임 종료 후에만 턴 전환
      break;
  }
}

/* ================= 입력 ================= */
const pointers = new Map();
function toBoard(e) { return { x: (e.clientX - bx) / sc, y: (e.clientY - by) / sc }; }
function inputState() { return state === 'Curling' || state === 'Placement' || state === 'Playing'; }
function pick(pt) {
  let best = null, bd = 1e9;
  for (const p of G.pieces) {
    if (p.out) continue;
    if (state === 'Placement') { if (G.place.done[p.owner]) continue; }
    else if (state === 'Playing') { if (p.owner !== G.turn || G.launched) continue; }
    else if (state === 'Curling') { const c = G.cur; if (!c || c.closed || c.launched[p.owner] || c.dq[p.owner]) continue; }
    const d = Math.hypot(px(p) - pt.x, py(p) - pt.y);
    if (d <= Math.max(p.r * 1.35, 26 / sc) && d < bd) { best = p; bd = d; }
  }
  return best;
}
cvs.addEventListener('pointerdown', e => {
  e.preventDefault(); Snd.unlock();
  if (!inputState() || pointers.has(e.pointerId)) return;
  const pt = toBoard(e), p = pick(pt); if (!p) return;
  if ([...pointers.values()].some(v => v.p === p)) return;
  try { cvs.setPointerCapture(e.pointerId); } catch (err) {}
  pointers.set(e.pointerId, { p, sx: e.clientX, sy: e.clientY, st: e.timeStamp, hist: [{ x: e.clientX, y: e.clientY, t: e.timeStamp }],
    ox: px(p) - pt.x, oy: py(p) - pt.y });
});
cvs.addEventListener('pointermove', e => {
  const s = pointers.get(e.pointerId); if (!s) return; e.preventDefault();
  if (state === 'Placement') { const pt = toBoard(e); movePlaced(s.p, pt.x + s.ox, pt.y + s.oy); }
  else { s.hist.push({ x: e.clientX, y: e.clientY, t: e.timeStamp }); if (s.hist.length > 40) s.hist.shift(); }
});
function endPointer(e, cancel) {
  const s = pointers.get(e.pointerId); if (!s) return;
  pointers.delete(e.pointerId); e.preventDefault();
  if (cancel || state === 'Placement' || !inputState()) return;
  const dx = e.clientX - s.sx, dy = e.clientY - s.sy, d = Math.hypot(dx, dy);
  if (d < 14) return;                                           // 탭은 무시
  s.hist.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
  const last = s.hist[s.hist.length - 1];
  let ref = s.hist[0];
  for (const h of s.hist) if (last.t - h.t <= 110) { ref = h; break; }
  const dt = Math.max(16, last.t - ref.t), spd = Math.hypot(last.x - ref.x, last.y - ref.y) / dt;   // px/ms
  const power = clamp(spd / 2.2, 0, 1) * 0.65 + clamp(d / (bs * 0.3), 0, 1) * 0.35;
  launch(s.p, { x: dx / d, y: dy / d }, PH.vmin + (PH.vmax - PH.vmin) * power);
}
cvs.addEventListener('pointerup', e => endPointer(e, false));
cvs.addEventListener('pointercancel', e => endPointer(e, true));
// 크롬/사파리 스크롤·드래그·확대 방지
document.addEventListener('touchmove', e => { if (e.target.tagName !== 'INPUT') e.preventDefault(); }, { passive: false });
document.addEventListener('touchstart', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
['gesturestart', 'gesturechange', 'contextmenu', 'dragstart', 'selectstart', 'dblclick'].forEach(t => document.addEventListener(t, e => e.preventDefault()));
document.addEventListener('wheel', e => e.preventDefault(), { passive: false });

/* ================= 버튼 ================= */
const on = (id, fn) => $(id).addEventListener('click', e => { Snd.unlock(); fn(e); });
on('b-play', () => setState('PieceSelection'));
on('b-settings', () => setState('Settings'));
on('b-set-back', () => setState('MainMenu'));
on('b-sel-back', () => setState('MainMenu'));
on('c-omok', () => { G.mode = 'omok'; resetAll(); setState('CurlingInstructions'); });
on('c-janggi', () => { G.mode = 'janggi'; resetAll(); setState('CurlingInstructions'); });
on('b-instr-start', () => startCurling());
on('pauseBtn', () => { if (GAME_STATES.includes(state) && state !== 'Paused') { pointers.clear(); setState('Paused'); } });
on('p-resume', () => { if (state === 'Paused') setState(prevState); });
on('p-restart', () => startCurling());
on('p-menu', () => { resetAll(); setState('MainMenu'); });
on('o-restart', () => startCurling());
on('o-menu', () => { resetAll(); setState('MainMenu'); });
on('done1', () => placementDone(1));
on('done2', () => placementDone(2));
$('vol').addEventListener('input', e => { settings.volume = e.target.value / 100; $('volTxt').textContent = e.target.value; saveSettings(); });
on('hapticBtn', () => { settings.haptic = !settings.haptic; saveSettings(); syncSettings(); if (settings.haptic) haptic(20, false); });
function syncSettings() {
  $('vol').value = Math.round(settings.volume * 100); $('volTxt').textContent = $('vol').value;
  $('hapticBtn').setAttribute('aria-pressed', settings.haptic ? 'true' : 'false');
}

/* ================= HUD / 영역 UI ================= */
const colCSS = o => ({ black: '#111', white: '#f4f2ea', red: '#c1272d', blue: '#1f4fb3' })[G.colors[o]];
let hudKey = '';
function refreshUI() {
  const key = [state, G.turn, G.mode, G.colors[1], G.colors[2], shown(1).length, shown(2).length, G.place && G.place.done[1], G.place && G.place.done[2], G.forced, G.launched].join('|');
  const st = state === 'Paused' ? prevState : state;
  const t = st === 'Curling' || st === 'CurlingCountdown' ? 0 : st === 'Placement' ? 1 : 2;
  $('hP1').innerHTML = `P1 <i class="cdot" style="background:${colCSS(1)}"></i> ${shown(1).length}`;
  $('hP2').innerHTML = `P2 <i class="cdot" style="background:${colCSS(2)}"></i> ${shown(2).length}`;
  $('hTurn').innerHTML = t === 0 ? '선공 결정' : t === 1 ? '알 배치' : (G.turn ? `<span class="hturn-on">${G.turn}P 차례</span>` : '');
  $('dot1').style.background = colCSS(1); $('dot2').style.background = colCSS(2);
  for (const o of [1, 2]) {
    let h = '';
    if (st === 'Curling') h = '알을 스와이프해서 발사!';
    else if (st === 'Placement') h = G.place && G.place.done[o] ? '상대를 기다리는 중…' : '알을 드래그해 배치하세요';
    else if (st === 'Playing') h = G.turn === o ? (G.forced ? '⚔ 반드시 공격하세요!' : '스와이프로 발사!') : '상대 차례';
    else if (st === 'WaitingForPhysics') h = '';
    $('hint' + o).textContent = h;
    $('zone' + o).classList.toggle('active', (G.turn === o && ['Playing', 'WaitingForPhysics', 'TurnTransition', 'Penalty'].includes(st)));
    $('done' + o).classList.toggle('show', st === 'Placement');
  }
  hudKey = key;
}
function updateTimeHUD() {
  const st = state === 'Paused' ? prevState : state;
  let ms = null;
  if (st === 'Curling' && G.cur && !G.cur.closed) ms = G.cur.left;
  else if (st === 'Placement') ms = G.placeLeft;
  else if (st === 'Playing') ms = G.turnLeft;
  const el = $('hTime'), txt = ms === null ? '--' : String(Math.max(0, Math.ceil(ms / 1000)));
  if (el.textContent !== txt) el.textContent = txt;
  el.classList.toggle('low', ms !== null && ms <= 3000);
}

/* ================= 레이아웃 ================= */
function layout() {
  W = window.innerWidth; H = window.innerHeight; dpr = Math.min(window.devicePixelRatio || 1, 3);
  const strip = Math.max(52, Math.min(64, Math.round(W * 0.14)));
  document.documentElement.style.setProperty('--strip', strip + 'px');
  const avail = W - strip;
  bs = Math.max(200, Math.floor(Math.min(avail - 8, H - 192)));       // 항상 정사각형
  bx = Math.round((avail - bs) / 2); by = Math.round((H - bs) / 2); sc = bs / BS;
  for (const c of [cvs, bgc]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); c.style.width = W + 'px'; c.style.height = H + 'px'; }
  const z2 = $('zone2'), z1 = $('zone1');
  z2.style.width = z1.style.width = avail + 'px'; z2.style.height = by + 'px'; z1.style.height = (H - by - bs) + 'px';
  const nt = bs * 0.19;
  $('nt1').style.top = (by + bs / 2 + nt) + 'px'; $('nt2').style.top = (by + bs / 2 - nt) + 'px';
  $('nt1').style.translate = $('nt2').style.translate = '0 -50%';
  const fs = Math.max(26, Math.round(bs * 0.1)); $('nt1').style.fontSize = $('nt2').style.fontSize = '';
  document.documentElement.style.setProperty('--ntfs', fs + 'px');
  buildBoard(); drawBG();
}

/* ================= 그리기: 배경(대나무 숲) ================= */
function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function leaf(g, x, y, len, ang, col) {
  g.save(); g.translate(x, y); g.rotate(ang); g.fillStyle = col; g.beginPath(); g.moveTo(0, 0);
  g.quadraticCurveTo(len * 0.5, -len * 0.16, len, 0); g.quadraticCurveTo(len * 0.5, len * 0.1, 0, 0); g.fill(); g.restore();
}
function drawBG() {
  const g = bgc.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#0a1914'); sky.addColorStop(0.45, '#163a2e'); sky.addColorStop(1, '#07110c');
  g.fillStyle = sky; g.fillRect(0, 0, W, H);
  const moon = g.createRadialGradient(W * 0.7, H * 0.13, 0, W * 0.7, H * 0.13, W * 0.55);
  moon.addColorStop(0, 'rgba(235,242,210,.42)'); moon.addColorStop(0.25, 'rgba(200,225,190,.14)'); moon.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = moon; g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(240,246,222,.5)'; g.beginPath(); g.arc(W * 0.7, H * 0.13, W * 0.045, 0, 7); g.fill();
  const rnd = mulberry(11);
  const layers = [
    { n: 11, w: 0.014, col: [34, 84, 66], a: 0.5, leaf: 0.9 }, { n: 8, w: 0.026, col: [24, 66, 50], a: 0.7, leaf: 1.2 },
    { n: 5, w: 0.05, col: [13, 40, 30], a: 0.95, leaf: 1.7 }
  ];
  layers.forEach((L, li) => {
    const mist = g.createLinearGradient(0, H * 0.35, 0, H * 0.95);
    mist.addColorStop(0, 'rgba(160,200,175,0)'); mist.addColorStop(0.6, `rgba(160,200,175,${0.12 - li * 0.03})`); mist.addColorStop(1, 'rgba(160,200,175,0)');
    g.fillStyle = mist; g.fillRect(0, H * 0.35, W, H * 0.6);
    for (let i = 0; i < L.n; i++) {
      const x = (i + rnd() * 0.8) / L.n * W, w = L.w * W * (0.75 + rnd() * 0.5), [r, gg, b] = L.col;
      const grad = g.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
      grad.addColorStop(0, `rgba(${r * 0.5},${gg * 0.5},${b * 0.5},${L.a})`); grad.addColorStop(0.4, `rgba(${r * 1.5},${gg * 1.5},${b * 1.5},${L.a})`);
      grad.addColorStop(1, `rgba(${r * 0.4},${gg * 0.4},${b * 0.4},${L.a})`);
      g.fillStyle = grad; g.fillRect(x - w / 2, 0, w, H);
      let y = rnd() * H * 0.1;
      while (y < H) {
        g.fillStyle = `rgba(4,14,9,${0.55 * L.a})`; g.fillRect(x - w / 2 - 1, y, w + 2, Math.max(2, w * 0.12));
        if (y < H * 0.5 && rnd() < 0.55) {
          const dir = rnd() < 0.5 ? -1 : 1, len = w * (4 + rnd() * 5) * L.leaf;
          for (let k = 0; k < 3; k++) leaf(g, x, y, len * (0.7 + rnd() * 0.5), (dir > 0 ? 0 : Math.PI) + (rnd() - 0.5) * 1.1 + dir * 0.25, `rgba(${r * 1.2},${gg * 1.4},${b * 1.2},${L.a * 0.85})`);
        }
        y += H * (0.1 + rnd() * 0.1);
      }
    }
  });
  const fog = g.createLinearGradient(0, H * 0.72, 0, H);
  fog.addColorStop(0, 'rgba(170,205,185,0)'); fog.addColorStop(1, 'rgba(170,205,185,.16)'); g.fillStyle = fog; g.fillRect(0, H * 0.72, W, H * 0.28);
  const vg = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.75);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.6)'); g.fillStyle = vg; g.fillRect(0, 0, W, H);
}

/* ================= 그리기: 게임판 ================= */
function buildBoard() {
  const s = Math.round(bs * dpr); boardCache = document.createElement('canvas'); boardCache.width = boardCache.height = s;
  const g = boardCache.getContext('2d'), k = s / BS; g.scale(k, k);
  const base = g.createLinearGradient(0, 0, BS, BS);
  base.addColorStop(0, '#e9bd72'); base.addColorStop(0.5, '#dba859'); base.addColorStop(1, '#c98f44');
  g.fillStyle = base; g.fillRect(0, 0, BS, BS);
  const rnd = mulberry(5);
  for (let i = 0; i < 160; i++) {
    const y = rnd() * BS, a = 0.03 + rnd() * 0.07; g.strokeStyle = `rgba(90,50,10,${a})`; g.lineWidth = 0.6 + rnd() * 2.2;
    g.beginPath(); g.moveTo(0, y); g.bezierCurveTo(BS * 0.3, y + (rnd() - 0.5) * 24, BS * 0.7, y + (rnd() - 0.5) * 24, BS, y + (rnd() - 0.5) * 12); g.stroke();
  }
  const m = BS * 0.055, step = (BS - 2 * m) / 18;
  g.strokeStyle = 'rgba(60,30,6,.8)'; g.lineWidth = 1.8;
  for (let i = 0; i < 19; i++) {
    g.beginPath(); g.moveTo(m + i * step, m); g.lineTo(m + i * step, BS - m); g.stroke();
    g.beginPath(); g.moveTo(m, m + i * step); g.lineTo(BS - m, m + i * step); g.stroke();
  }
  g.lineWidth = 4; g.strokeRect(m, m, BS - 2 * m, BS - 2 * m);
  g.fillStyle = 'rgba(60,30,6,.9)';
  for (const a of [3, 9, 15]) for (const b of [3, 9, 15]) { g.beginPath(); g.arc(m + a * step, m + b * step, 6, 0, 7); g.fill(); }
  g.strokeStyle = '#5a3410'; g.lineWidth = 12; g.strokeRect(0, 0, BS, BS);
  g.strokeStyle = 'rgba(255,230,170,.35)'; g.lineWidth = 3; g.strokeRect(10, 10, BS - 20, BS - 20);
}

/* ================= 그리기: 알 ================= */
const JCOL = { red: '#c1272d', blue: '#1f4fb3' };
function polyPath(local, s) { ctx.beginPath(); local.forEach((v, i) => i ? ctx.lineTo(v.x * s, v.y * s) : ctx.moveTo(v.x * s, v.y * s)); ctx.closePath(); }
function drawPiece(p, x, y, ang, s, alpha, dark, red) {
  const r = p.r * s; ctx.save(); ctx.globalAlpha = alpha;
  // 그림자 (낙하 중에는 멀어지며 흐려짐)
  const so = (1 - s) * 40 + 4;
  ctx.fillStyle = 'rgba(0,0,0,.35)';
  ctx.beginPath(); ctx.ellipse(x + so * 0.5, y + so, r * 0.98, r * 0.9, 0, 0, 7); ctx.fill();
  ctx.translate(x, y); ctx.rotate(ang);
  if (p.spec.type === 'stone') {
    const k = p.spec.color === 'black';
    const gr = ctx.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.1, 0, 0, r);
    if (k) { gr.addColorStop(0, '#7b7b7b'); gr.addColorStop(0.45, '#1c1c1c'); gr.addColorStop(1, '#000'); }
    else { gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.6, '#e6e3d8'); gr.addColorStop(1, '#aaa798'); }
    ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill();
    ctx.strokeStyle = k ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.18)'; ctx.lineWidth = r * 0.07; ctx.beginPath(); ctx.arc(0, 0, r * 0.62, 0.4, 1.5); ctx.stroke();   // 회전이 보이는 결
    ctx.beginPath(); ctx.arc(0, 0, r * 0.3, 3.6, 4.5); ctx.stroke();
  } else {
    const col = JCOL[p.spec.color];
    polyPath(p.local, s); const gr = ctx.createLinearGradient(-r, -r, r, r); gr.addColorStop(0, '#f3d7a0'); gr.addColorStop(1, '#c99a55');
    ctx.fillStyle = gr; ctx.fill(); ctx.lineWidth = r * 0.12; ctx.strokeStyle = '#7a5424'; ctx.stroke();
    polyPath(p.local, s * 0.8); ctx.lineWidth = r * 0.07; ctx.strokeStyle = col; ctx.stroke();
    ctx.fillStyle = col; ctx.font = `900 ${r * 1.05}px "Noto Serif KR","Nanum Myeongjo","Batang",serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(p.spec.ch, 0, r * 0.05);
  }
  if (dark) { ctx.fillStyle = `rgba(0,0,0,${dark})`; if (p.spec.type === 'stone') { ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill(); } else { polyPath(p.local, s); ctx.fill(); } }
  if (red) { ctx.fillStyle = 'rgba(255,30,20,.62)'; if (p.spec.type === 'stone') { ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill(); } else { polyPath(p.local, s); ctx.fill(); } }
  ctx.restore();
}
function drawMarks() {
  ctx.save(); ctx.lineCap = 'round';
  if (state === 'Curling' || state === 'CurlingCountdown' || (state === 'Paused' && (prevState === 'Curling' || prevState === 'CurlingCountdown'))) {
    ctx.strokeStyle = 'rgba(70,30,0,.65)'; ctx.lineWidth = 5; ctx.setLineDash([22, 14]); ctx.beginPath(); ctx.moveTo(BS / 2, 0); ctx.lineTo(BS / 2, BS); ctx.stroke(); ctx.setLineDash([]);
    ctx.shadowColor = 'rgba(255,40,30,.9)'; ctx.shadowBlur = 18; ctx.strokeStyle = '#e0261b'; ctx.lineWidth = 9;
    for (const [a, b] of [[70, 430], [570, 930]]) { ctx.beginPath(); ctx.moveTo(a, BS / 2); ctx.lineTo(b, BS / 2); ctx.stroke(); }
  } else if (state === 'Placement' || (state === 'Paused' && prevState === 'Placement')) {
    ctx.fillStyle = 'rgba(20,50,90,.10)'; ctx.fillRect(0, 0, BS, BS / 2);
    ctx.fillStyle = 'rgba(120,30,20,.10)'; ctx.fillRect(0, BS / 2, BS, BS / 2);
    ctx.strokeStyle = 'rgba(160,30,20,.85)'; ctx.lineWidth = 6; ctx.setLineDash([26, 16]); ctx.beginPath(); ctx.moveTo(0, BS / 2); ctx.lineTo(BS, BS / 2); ctx.stroke();
  }
  ctx.restore();
}
function render() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  if (['MainMenu', 'Settings', 'PieceSelection'].includes(state)) return;
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 26; ctx.shadowOffsetY = 10;
  ctx.drawImage(boardCache, bx, by, bs, bs); ctx.restore();
  ctx.setTransform(dpr * sc, 0, 0, dpr * sc, dpr * bx, dpr * by);
  drawMarks();
  for (const p of G.pieces) {
    if (p.out) continue;
    const blink = G.pen && G.pen.p === p && Math.floor(G.pen.t / 250) % 2 === 0;
    drawPiece(p, px(p), py(p), p.body.angle, 1, 1, 0, blink);
  }
  for (const e of G.fx) {                                   // 낙하: 축소 + 어두워짐 + 아래로 가속 낙하 + 라벨
    const t = e.t, s = Math.max(0.35, 1 - t / 900 * 0.65), drop = 0.5 * 0.0016 * t * t;
    drawPiece(e.p, e.x, e.y + drop, e.ang, s, 1 - Math.max(0, (t - 600) / 350), Math.min(0.7, t / 500 * 0.7), false);
    if (t < 700) {
      ctx.save(); ctx.globalAlpha = 1 - t / 700; ctx.translate(clamp(e.x, 70, 930), clamp(e.y, 70, 930) - t * 0.05);
      if (e.p.owner === 2) ctx.rotate(Math.PI);
      ctx.font = '900 44px "Noto Serif KR",serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#ff5a48'; ctx.strokeStyle = '#000'; ctx.lineWidth = 6;
      ctx.strokeText('탈락', 0, 0); ctx.fillText('탈락', 0, 0); ctx.restore();
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/* ================= 메인 루프 ================= */
let last = performance.now(), hudT = 0;
function frame(t) {
  const dt = Math.min(50, t - last); last = t;
  if (state !== 'Paused' && !['MainMenu', 'Settings', 'PieceSelection', 'CurlingInstructions', 'GameOver'].includes(state)) update(dt);
  hudT += dt;
  if (hudT > 80) { hudT = 0; refreshUI(); }
  updateTimeHUD(); render();
  requestAnimationFrame(frame);
}

/* ================= 초기화 ================= */
newEngine(); syncSettings(); layout(); setState('MainMenu');
window.addEventListener('resize', layout); window.addEventListener('orientationchange', () => setTimeout(layout, 120));
if (window.visualViewport) window.visualViewport.addEventListener('resize', layout);
document.addEventListener('visibilitychange', () => { if (document.hidden && GAME_STATES.includes(state) && state !== 'Paused') { pointers.clear(); setState('Paused'); } });
window.__algakgi = { G, PH, RULE, get state() { return state; }, stopDist };   // 디버그/테스트용
requestAnimationFrame(frame);
})();
