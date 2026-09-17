// 宣传 GIF 的页面侧采集。由 capserve.py 注入到 /capture.html，不属于站点本身。
//
// 逐帧确定性推进 → 渲染 → toDataURL → POST 回 capserve 落盘。
// 页面自己的主循环必须停掉：它按真实时间推进，混进来采样就不再等距。

const FPS = 24;
const W = 960, H = 540;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const $ = id => document.getElementById(id);

while (!window.__ds) await sleep(50);
const S = window.__ds.stage, C = window.__ds.civ;
const cv = $('stage');

async function post(path, body){
  for(let a = 0; ; a++){
    try{
      const r = await fetch(path, { method:'POST', body });
      if(r.ok) return;
      throw new Error(`${path} → ${r.status}`);
    }catch(e){
      if(a >= 5) throw e;
      await sleep(200 * (a + 1));      // 偶发 Failed to fetch，重试即可
    }
  }
}

/* ── 冻结页面 ── */
async function freeze(){
  // 贴图异步加载，没到齐就开拍，前几帧会是占位色
  for(let k = 0; ; k++){
    if(Object.values(S.tex).every(t => t.image && t.image.width > 1)) break;
    if(k > 240) throw new Error('贴图没加载齐——先跑 fetch-assets.sh');
    await sleep(250);
  }
  window.requestAnimationFrame = () => 0;
  await sleep(1500);                   // 让已经排上的那一帧跑完，之后就只剩我们在推

  // 尺寸钉死：窗口一变，页面的 resize 监听会按 devicePixelRatio 重算一遍
  S.resize = function(){
    this.renderer.setPixelRatio(1); this.renderer.setSize(W, H, false);
    this.composer.setPixelRatio(1); this.composer.setSize(W, H);
    this.depthRT.setSize(W, H);
    this.dof.uniforms.uTexel.value.set(1 / W, 1 / H);
    this.dof.uniforms.uMax.value = Math.max(3, H * 0.008);
    this.camera.aspect = W / H;
    const vFov = this.camera.fov * Math.PI / 180;
    this.baseR = 1.45 / (Math.tan(vFov / 2) * Math.min(1, W / H));
    this.camera.updateProjectionMatrix();
    this._applyCam();
  };
  S.resize();
  // 颗粒让每个像素每帧都在变，GIF 的帧间差分完全失效；256 色量化之后它本来也看不见
  S.grain.uniforms.uAmount.value = 0;
}

/* ── 推进 ── */
const T = () => +$('temp').value;
const P = () => Math.pow(10, (+$('pres').value - 50) / 25);
const setSlider = (id, v) => { const e = $(id); e.value = v; e.dispatchEvent(new Event('input')); };

// envK：环境与文明按 envK 倍推进，镜头、自转、打击仍按 1 倍。
// 整体快放的话，升温那 18 秒里行星会转过 200°，地表怎么变就看不清了。
function advance(dt, sub, envK){
  for(let k = 0; k < sub; k++){
    const h = dt / sub;
    C.update(h * envK, T(), P(), S.spinAnomaly);
    S.setEnv(T(), P(), C.struck ? 0 : C.pop);
    if(envK > 1) S._dampEnv(h * (envK - 1));
    S.update(h);
  }
}

function fresh(spin){
  $('reset').click();
  setSlider('pres', 50); setSlider('temp', 288);
  C.drain();
  S.warm = false;                      // 环境直接落到目标，不必等阻尼阶梯回暖
  S.cur.fire = 0; S.cur.burn = 0;
  S.driftT = 0; S.wind = 0;
  for(let i = 0; i < 4; i++) advance(1 / FPS, 1, 1);
  S.spin = spin;                       // 2.9 ≈ 印度洋，3.3 ≈ 东亚正对镜头
}

/* ── 事件 ── */
let cur = null;
const onShock = S.onShock, onEnd = S.onEffectEnd;
S.onShock = () => { if(cur) cur.events.shock ??= cur.frames; onShock && onShock(); };
S.onEffectEnd = w => {
  if(cur){ cur.events.end ??= cur.frames; cur.verdict = C.verdict(); }
  onEnd && onEnd(w);
};

function strike(kind, m){
  m.events.trigger = m.frames;
  $(kind).click();                     // 走按钮：打击和文明判定同一条通路
}

// 拨动那段的手。坐标是画布像素，compose.py 按它画触点。
let ptr = null;
const grab = (x, y) => { S.grab(); ptr = [x, y]; };
const drag = (dx, dy) => { S.dragBy(dx, dy); ptr[0] += dx; ptr[1] += dy; };
const release = () => { S.release(); ptr = null; };

/* ── 各段 ── */
const CLIPS = {
  a_hero: {
    spin:2.9, dt:2.5 / FPS, sub:1,
    until: m => m.frames >= 120,
  },
  b_foil: {
    spin:3.3, sub:2,
    step: (i, m) => { if(i === 16) strike('foil', m); },
    // 停留要够读完判词：淡入 1.6 秒，再留约 3 秒
    until: m => m.events.end !== undefined && m.frames >= m.events.end + 110,
  },
  c_crush: {
    spin:3.3, sub:4,                   // 断裂那几帧变化最快，子步进多给一倍
    step: (i, m) => {
      if(i === 12) strike('crush', m);
      // 碎片在「结束」之后还要积分到 1.8，停稳了再停留
      if(m.events.settled === undefined && S.state === 'done' && S.effectT >= 1.8) m.events.settled = i;
    },
    until: m => m.events.settled !== undefined && m.frames >= m.events.settled + 48,
  },
  d_heat: {
    spin:3.3, sub:3, envK:3,
    // 6 秒升到 520K（火灾挂在热冲击上，要升得够猛）→ 5 秒升到 800K → 停住等慢通道追上。
    // 不拉到 900：880K 往上整颗星白热过曝，泛光糊满全屏。
    temp: te => te < 1 ? 288 : te < 7 ? 288 + (te - 1) / 6 * 232
              : te < 12 ? 520 + (te - 7) / 5 * 280 : 800,
    until: m => m.envT >= 18 - 1e-6,
  },
  e_cold: {
    spin:3.3, sub:3, envK:3, tilt:0.28,  // 扳向北半球，看冰从西伯利亚铺下来
    // 冰线在冰盖通道 296→214K 间推进，τ=4：慢降到 200K 让冰线走满，再降到底
    temp: te => te < 1 ? 288 : te < 14 ? 288 - (te - 1) / 13 * 88
              : te < 18 ? 200 - (te - 14) / 4 * 90 : 110,
    until: m => m.envT >= 21 - 1e-6,
  },
  f_spin: {
    spin:3.3, sub:2,
    step: i => {
      // 向左甩出去，靠惯性滑行
      if(i === 12) grab(600, 300);
      if(i >= 13 && i <= 32){ const s = Math.pow((i - 13) / 19, 1.5); drag(-(4 + 22 * s), -0.6); }
      if(i === 33) release();
      // 抓停，往下扳看北极
      if(i === 81) grab(470, 250);
      if(i >= 82 && i <= 105) drag(-2, 7);
      if(i === 106) release();
      // 扳回来。速度按正弦收到零再松手，否则倾角带着惯性冲过头
      if(i === 136) grab(480, 410);
      if(i >= 137 && i <= 156){ const s = Math.sin((i - 136.5) / 20 * Math.PI); drag(9 * s, -13.9 * s); }
      if(i === 157) release();
    },
    until: m => m.frames >= 190,
  },
};

async function capture(name){
  const c = CLIPS[name];
  if(!c) throw new Error('没有这一段：' + name);
  await post(`/reset/${name}`, '');
  const m = cur = { frames:0, events:{}, ptr:[], log:[], temp:[], envT:0, spec:C.idText, verdict:null };
  fresh(c.spin);
  if(c.tilt) S.userEl = c.tilt;
  const dt = c.dt ?? 1 / FPS, envK = c.envK ?? 1;

  while(!c.until(m)){
    if(m.frames > 600) throw new Error(name + ' 停不下来');
    if(c.temp) setSlider('temp', Math.round(c.temp(m.envT)));
    if(c.step) c.step(m.frames, m);
    advance(dt, c.sub, envK);
    m.envT += dt * envK;
    // 你拖一秒，他们过四十七年——和 main.js 的换算一致
    for(const msg of C.drain()) m.log.push({ f:m.frames, year:Math.floor(m.envT * 47), ...msg });
    m.ptr.push(S.grabbed && ptr ? [...ptr] : null);
    m.temp.push(T());
    // 必须和渲染在同一个任务里取：之后缓冲区就被清了
    await post(`/frame/${name}/${m.frames}`, cv.toDataURL('image/png'));
    m.frames++;
    document.title = `采集 ${name} · ${m.frames}`;
  }
  cur = null;
  return m;
}

try{
  await freeze();
  const want = new URLSearchParams(location.search).get('clips');
  const names = want ? want.split(',') : Object.keys(CLIPS);
  const meta = {};
  for(const n of names) meta[n] = await capture(n);
  await post('/meta', JSON.stringify(meta));
  document.title = '采集完成';
}catch(e){
  console.error(e);
  document.title = '采集失败';
  await post('/fail', String(e && e.stack || e)).catch(() => {});
}
