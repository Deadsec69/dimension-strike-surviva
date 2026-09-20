// 降维打击模拟器 —— 装配
import { PlanetStage } from './planet.js';
import { Civilization } from './civ.js';
import { Board, TIER_EN } from './board.js';
// gesture.js 走动态 import：它会拖进 11MB 的 MediaPipe 运行时和 8MB 模型，
// 而绝大多数访客从不开摄像头。等点了「开启摄像头」再加载。

const $ = id => document.getElementById(id);

const el = {
  stage:$('stage'), temp:$('temp'), pres:$('pres'), tempOut:$('tempOut'), presOut:$('presOut'),
  reset:$('reset'), statusTag:$('statusTag'), pop:$('popOut'), tech:$('techOut'),
  hab:$('habOut'), habBar:$('habBar'), log:$('log'),
  crush:$('crush'), foil:$('foil'), flash:$('flash'),
  verdict:$('verdict'), verdictText:$('verdictText'),
  cam:$('cam'), camMin:$('camMin'), camBtn:$('camBtn'), video:$('video'), hand:$('hand'), gestState:$('gestState'),
  again:$('again'), specId:$('specId'), specTag:$('specTag'),
  envTag:$('envTag'), survivalBtn:$('survivalBtn'),
  survTime:$('survTime'), survKills:$('survKills'), survBlocks:$('survBlocks'), survShields:$('survShields'), survScore:$('survScore'), survTier:$('survTier'),
  heatWarn:$('heatWarn'),
  userName:$('userName'), portrait:$('portrait'), portraitImg:$('portraitImg'), portraitMeta:$('portraitMeta'), board:$('board'), boardClear:$('boardClear')
};

const stage = new PlanetStage(el.stage);
const civ = new Civilization();
const board = new Board(el);    // 生存结算：抓拍、画像、观测者榜
window.__ds = { stage, civ, board };   // 调试用句柄

/* ── 气压：对数刻度。滑块 0..100 → 0.01..100 atm，50 处正好 1 atm ── */
const toPressure = v => Math.pow(10, (v - 50) / 25);
const fmtPressure = p =>
  p >= 10 ? p.toFixed(0) : p >= 1 ? p.toFixed(2) : p >= 0.1 ? p.toFixed(3) : p.toFixed(4);

let T = 288, P = 1;

function readControls(){
  T = +el.temp.value;
  P = toPressure(+el.pres.value);
  el.tempOut.innerHTML = `${T}<i>K</i>`;
  el.presOut.innerHTML = `${fmtPressure(P)}<i>atm</i>`;
}
el.temp.addEventListener('input', readControls);
el.pres.addEventListener('input', readControls);
readControls();
// 生存模式：环境由撞击驱动，滑块退成仪表——把它们推到对应位置，读数照旧写。模块变量 T/P 不动，退出时 readControls() 一键交还。
let envTxt = '';
function writeEnv(t, p){
  const txt = `${Math.round(t)}|${fmtPressure(p)}`;
  if(txt === envTxt) return;
  envTxt = txt;
  el.tempOut.innerHTML = `${Math.round(t)}<i>K</i>`;
  el.presOut.innerHTML = `${fmtPressure(p)}<i>atm</i>`;
  el.temp.value = Math.round(t);
  el.pres.value = 50 + 25 * Math.log10(p);
}

/* ── 琥珀抽干：文明消亡时，界面上代表「他们」的颜色向死灰收敛 ── */
const AMBER = [232, 176, 75], DEAD = [90, 103, 115];
let shownAmber = -1;
function paintLife(life){
  const q = Math.round(life * 24) / 24;          // 量化，避免每帧写样式
  if(q === shownAmber) return;
  shownAmber = q;
  const c = AMBER.map((a, i) => Math.round(DEAD[i] + (a - DEAD[i]) * q));
  document.documentElement.style.setProperty('--amber-live', `rgb(${c.join(',')})`);
}

/* ── 通讯记录 ── */
let year = 0;
function pushLog({ text, tone }){
  const li = document.createElement('li');
  li.className = tone === 'final' ? 'is-final' : 'is-new';
  const t = document.createElement('time');
  t.textContent = `T+${String(Math.floor(year)).padStart(4, '0')} STD YR`;
  li.appendChild(t);
  li.appendChild(document.createTextNode(text));
  el.log.appendChild(li);
  // 仅最新一条高亮
  [...el.log.children].forEach(n => { if(n !== li && n.classList.contains('is-new')) n.classList.remove('is-new'); });
  while(el.log.children.length > 14) el.log.removeChild(el.log.firstChild);
}

/* ── 状态标签 ── */
function statusOf(){
  if(civ.struck === 'foil') return ['FLATTENED', true];
  if(civ.struck === 'crush') return ['DISINTEGRATED', true];
  if(civ.dead) return ['SILENT', true];
  if(civ.pop < 0.25) return ['CRITICAL', true];
  if(civ.pop < 0.7) return ['STRESSED', false];
  return ['OBSERVING', false];
}

/* ── 打击 ── */
function fire(kind){
  if(civ.struck) return false;
  const ok = kind === 'foil' ? stage.triggerFoil() : stage.triggerCrush();
  if(!ok) return false;
  civ.strike(kind);
  el.crush.disabled = el.foil.disabled = true;
  if(survivalOn){
    // 热死那条路已先标了 'heat'；其余到这里的都是手势按下的武器 = 自己收手
    survival.finish(endCause || 'self'); endCause = null;
    // 抓拍必须在此刻：判词要等 2.7 秒碎裂动画，那时脸上的反应已经散了
    board.endRun({ ending:survival.ending, snapshot:board.capture(el.video),
                   score:survival.score, kills:survival.kills, blocks:survival.blocks, elapsed:survival.elapsed });
  }
  return true;
}
window.__ds.fire = fire;   // 测试句柄：无摄像头时模拟手势武器

// 闪光挂在断裂那一帧上，不能按秒数预定：命中停顿会把场景时间拉长，
// 写死的延时必然和画面错开。
stage.onShock = () => {
  el.flash.animate(
    [{ opacity:0 }, { opacity:.88, offset:.08 }, { opacity:0 }],
    { duration:520, easing:'ease-out' }
  );
};

function showVerdict(){
  if(el.verdict.classList.contains('is-on')) return;
  // 生存模式的判词说的是你（评级、分、怎么结束的）；沙盒里才是他们的故事
  el.verdictText.textContent = survivalOn ? survival.verdictCard() : civ.verdict();
  el.verdict.classList.add('is-on');
  el.verdict.setAttribute('aria-hidden', 'false');
  board.showVerdict();
  // 判词期间摄像头只认击掌；先打断手上可能还握着的蓄力
  gesture?.interrupt();
  gesture?.setClapMode(true);
}
stage.onEffectEnd = showVerdict;

/* ── 重玩：换下一个样本 ──
   编号只往上走，其余一律不变——对观测者而言它们本来就是可互换的。
   这比「重新开始」更贴这个设定：你不是在重来，你是在处理下一个。 */
/* 场景复位：newSpecimen 与 #reset 共用。next 决定是换编号还是原样本清零。 */
function resetScene({ next }){
  gesture?.interrupt();          // 拳头多半还握着：不打断，0.3 秒后就砸在新样本上
  gesture?.setClapMode(false);   // 放在 stage.reset() 前面：切换识别器那一下卡顿落在复位帧上
  next ? civ.nextSpecimen() : civ.reset();
  stage.reset();
  year = 0; shownAmber = -1;
  el.log.replaceChildren();
  el.crush.disabled = el.foil.disabled = false;
  board.clear();
  el.verdict.classList.remove('is-on');
  el.verdict.setAttribute('aria-hidden', 'true');
  el.specId.textContent = civ.idText;
  el.specTag.textContent = civ.tag;
  el.temp.value = 288; el.pres.value = 50;
  readControls(); envTxt = '';
  if(survivalOn){ survival.start(); board.probe(); }   // 生存模式下换样本 = 新的一局；滑块保持仪表状态；顺带刷榜
}
function newSpecimen(){ resetScene({ next:true }); }
el.again.addEventListener('click', newSpecimen);

el.crush.addEventListener('click', () => fire('crush'));
el.foil.addEventListener('click', () => fire('foil'));

/* ── 操控：像转地球仪一样转它 ──
   指针事件只挂在画布上，HUD 面板是它上层的独立元素，落在面板上的按下不会到这儿来。
   用 pointer 事件而不是 mouse/touch 两套：一套代码同时吃鼠标、触摸和手写笔。 */
let dragId = null, lastX = 0, lastY = 0;

el.stage.addEventListener('pointerdown', ev => {
  if(dragId !== null || !stage.grab()) return;
  dragId = ev.pointerId;
  lastX = ev.clientX; lastY = ev.clientY;
  el.stage.setPointerCapture(dragId);   // 拖出画布外也不丢事件
  el.stage.classList.add('is-grabbing');
});

el.stage.addEventListener('pointermove', ev => {
  if(ev.pointerId !== dragId) return;
  stage.dragBy(ev.clientX - lastX, ev.clientY - lastY);
  lastX = ev.clientX; lastY = ev.clientY;
});

const endDrag = ev => {
  if(ev.pointerId !== dragId) return;
  stage.release();
  el.stage.classList.remove('is-grabbing');
  dragId = null;
};
el.stage.addEventListener('pointerup', endDrag);
el.stage.addEventListener('pointercancel', endDrag);

/* ── 复位（生存模式下 = 重新开始这一局） ── */
el.reset.addEventListener('click', () => resetScene({ next:false }));

/* ── 手势 ── */
// 手势模块每个摄像头帧都会来一次，文本多半没变，别每帧写 DOM
let gestTxt = '', gestCls = '';
const setGestState = (txt, cls = '') => {
  if(txt === gestTxt && cls === gestCls) return;
  gestTxt = txt; gestCls = cls;
  el.gestState.textContent = txt;
  el.gestState.className = 'cam-state' + (cls ? ` is-${cls}` : '');
};

let gesture = null;
async function ensureGesture(){
  if(gesture) return gesture;
  setGestState('Loading…');
  const { GestureInput } = await import('./gesture.js');
  gesture = new GestureInput({
    video: el.video,
    canvas: el.hand,
    // 指针优先也管武器：真有人在拖的时候，握拳不该在他手底下把星球压碎
    canFire: () => !civ.struck && stage.state === 'idle' && dragId === null,
    onGesture: g => {
      // 击掌只在判词期间有意义；识别器也只在那时跟两只手，这里再拦一道
      if(g === 'clap'){ if(el.verdict.classList.contains('is-on')) newSpecimen(); return true; }
      return fire(g === 'fist' ? 'crush' : 'foil');
    },
    // 蓄力只给引力挤压：二维武器没有「正在积蓄」这回事，二向箔只在状态标签上走百分比
    onCharge: (kind, k) => stage.setCharge(kind === 'fist' ? k : 0),
    // 准星：gesture.js 已做镜像与增益，这里只是传给生存模块
    onAim: (x, y, pose) => { if(survivalOn) x == null ? survival.aim(null) : survival.aim(x, y, pose); },
    onState: setGestState,
    // 手势拨动走和鼠标完全相同的那条通路，惯性、封顶、打击期禁用一并继承。
    // 指针优先：真有人在拖的时候，别让摄像头和他抢同一颗星球。
    onDrag: (kind, dx, dy) => {
      if(dragId !== null) return;
      if(kind === 'start') stage.grab();
      else if(kind === 'move') stage.dragBy(dx, dy);
      else stage.release();
    }
  });
  window.__ds.gesture = gesture;   // 调试句柄；capture.js 只读 stage / civ
  return gesture;
}

let camOn = false;
el.camBtn.addEventListener('click', async () => {
  if(camOn){
    exitSurvival();                  // 没有手就没有准星：关摄像头即退出生存
    gesture?.stop(); camOn = false;
    el.cam.classList.remove('is-live'); document.body.classList.remove('cam-live');
    el.camBtn.textContent = 'Turn on camera';
    return;
  }
  el.camBtn.disabled = true;
  try{
    const g = await ensureGesture();
    g.setClapMode(el.verdict.classList.contains('is-on'));   // 判词已经在了就直接进双手模式
    g.setMode(survivalOn ? 'survive' : 'observe');
    await g.start();
    camOn = true;
    el.cam.classList.add('is-live'); document.body.classList.add('cam-live');
    el.camBtn.textContent = 'Turn off camera';
  }catch(err){
    console.error('[gesture]', err);
    el.gestState.textContent = el.gestState.textContent.includes('HTTPS') ? 'HTTPS required' : 'Unavailable';
    el.gestState.className = 'cam-state is-err';
  }finally{
    el.camBtn.disabled = false;
  }
});

/* ── 生存模式 ──
   只认摄像头：射击的成本是「把手停住 0.3 秒」，鼠标上这是零成本，难度来自手。
   环境由撞击与护盾驱动，滑块退成仪表；文明照常演化，他们的读数就是你的计分板。 */
let survival = null, survivalOn = false, endCause = null;
async function ensureSurvival(){
  if(survival) return survival;
  const { Survival } = await import('./survival.js');
  // 温度到顶 = 既有的引力挤压；先标 'heat'，fire() 里的 finish 才知道这不是你按的
  survival = new Survival({ stage, civ, onCrush: () => { endCause = 'heat'; fire('crush'); } });
  window.__ds.survival = survival;
  return survival;
}
async function enterSurvival(force = false){
  if(survivalOn || (!camOn && !force)) return;    // force 只给无头测试用
  el.survivalBtn.disabled = true;
  try{
    await ensureSurvival();
    if(!camOn && !force) return;                  // 等 import 的时候摄像头被关了
    survivalOn = true;
    document.body.classList.add('is-survive');
    board.probe();                                // 本地服务器在不在：在就拉榜
    el.survivalBtn.textContent = 'Exit Survival';
    el.reset.textContent = 'Restart';
    el.envTag.textContent = 'IMPACT';
    // 判词还在：这颗已经没了，换下一个；否则原样本清零——它还没被消耗
    resetScene({ next: el.verdict.classList.contains('is-on') });   // 里面会 survival.start()
    gesture?.setMode('survive');
  }finally{ syncSurvivalBtn(); }
}
function exitSurvival(){
  if(!survivalOn) return;
  survivalOn = false;
  survival.stop();                              // 清场：小行星、护盾、准星
  board.clear();
  gesture?.setMode('observe');
  document.body.classList.remove('is-survive');
  el.survivalBtn.textContent = 'Start Survival';
  el.reset.textContent = 'Reset parameters';
  el.envTag.textContent = 'ENV';
  el.tempOut.classList.remove('is-hot', 'is-critical');
  el.heatWarn.classList.remove('is-on', 'is-critical');
  el.temp.value = 288; el.pres.value = 50;
  readControls(); envTxt = '';                  // 交互权交回滑块；文明与舞台不复位，行星自己凉下来
}
el.survivalBtn.addEventListener('click', () => survivalOn ? exitSurvival() : enterSurvival());
// 摄像头面板可收起（记住选择）；右面板按它的实际高度让位
el.camMin.addEventListener('click', () => {
  const on = el.cam.classList.toggle('is-min');
  el.camMin.textContent = on ? '+' : '–';
  try{ localStorage.setItem('ds.camMin', on ? '1' : '0'); }catch{}
});
try{ if(localStorage.getItem('ds.camMin') === '1') el.camMin.click(); }catch{}
new ResizeObserver(() => document.documentElement.style.setProperty('--cam-h', el.cam.offsetHeight + 'px')).observe(el.cam);
board.probe();                                   // 开页就探一次：榜不限生存模式
// 观测者代号：开局前必填，记住上一次的
el.userName.value = localStorage.getItem('ds.username') || '';
const syncSurvivalBtn = () => { el.survivalBtn.disabled = !survivalOn && !el.userName.value.trim(); };
el.userName.addEventListener('input', () => { localStorage.setItem('ds.username', el.userName.value.trim()); syncSurvivalBtn(); });
syncSurvivalBtn();
window.__ds.enterSurvival = enterSurvival; window.__ds.exitSurvival = exitSurvival;

let survTxt = '';
function writeSurv(){
  const tier = survival.tier;
  const txt = `${survival.elapsed.toFixed(1)}|${survival.kills}|${survival.blocks}|${survival.shields}|${survival.score}|${tier}`;
  if(txt === survTxt) return;
  survTxt = txt;
  el.survTier.textContent = TIER_EN[tier];
  el.survTier.className = `num tier is-${tier}`;
  el.survTime.textContent = survival.elapsed.toFixed(1) + 's';
  el.survKills.textContent = survival.kills;
  el.survBlocks.textContent = survival.blocks;
  el.survShields.textContent = survival.shields;
  el.survScore.textContent = survival.score.toLocaleString('en-US');
}

/* ── 画质自适应：按真实帧间隔的均值升降渲染缩放。行星管线是 GPU 密集型的，
   Retina 全分辨率会钉在 30fps；降到 DPR 1.0 少掉四分之三的片元，观感几乎不变。 ── */
const Q_STEPS = [1, 0.83, 0.67];        // DPR 1.5 → 1.25 → 1.0
let qIdx = 0, fEma = 16.7, qSlow = 0, qFast = 0, qHold = 0;
function adaptQuality(rawMs){
  fEma += (rawMs - fEma) * 0.08;
  if(document.hidden){ qSlow = qFast = 0; return; }
  if(qHold > 0){ qHold -= rawMs; return; }
  if(fEma > 22){ qSlow += rawMs; qFast = 0; }
  else if(fEma < 13){ qFast += rawMs; qSlow = 0; }
  else { qSlow = qFast = 0; }
  let next = qIdx;
  if(qSlow > 1200 && qIdx < Q_STEPS.length - 1) next = qIdx + 1;
  else if(qFast > 6000 && qIdx > 0) next = qIdx - 1;
  if(next !== qIdx){
    qIdx = next; qSlow = qFast = 0; qHold = 2000;
    stage.setQuality(Q_STEPS[qIdx]);
    console.log(`[quality] ×${Q_STEPS[qIdx]} (frame ${fEma.toFixed(1)}ms)`);
  }
}
window.__ds.quality = () => ({ scale: Q_STEPS[qIdx], frameMs: +fEma.toFixed(1), pixelRatio: stage.renderer.getPixelRatio() });

/* ── 主循环 ── */
let last = performance.now();
function frame(now){
  requestAnimationFrame(frame);
  const rawMs = now - last;
  const dt = Math.min(0.05, rawMs / 1000);
  last = now;
  adaptQuality(rawMs);

  if(!civ.struck) year += dt * 47;     // 你拖一秒，他们过四十七年

  let envT = T, envP = P;
  if(survivalOn){
    survival.update(dt);               // 先推进：这一帧的撞击要在文明与舞台看到之前落地
    envT = survival.T; envP = survival.P;
    writeEnv(envT, envP);
    el.tempOut.classList.toggle('is-hot', envT >= 560);        // 再挨两下
    el.tempOut.classList.toggle('is-critical', envT >= 610);   // 再挨一下
    el.heatWarn.classList.toggle('is-on', !survival.over && envT >= 560);
    el.heatWarn.classList.toggle('is-critical', envT >= 610);
    writeSurv();
  }
  civ.update(dt, envT, envP, stage.spinAnomaly);
  stage.setEnv(envT, envP, civ.pop);
  stage.update(dt);

  el.pop.textContent = civ.popText;
  el.tech.textContent = civ.techText;
  el.hab.textContent = civ.habText;
  el.habBar.style.width = (civ.hab * 100).toFixed(1) + '%';

  const [tag, alert] = statusOf();
  if(el.statusTag.textContent !== tag){
    el.statusTag.textContent = tag;
    el.statusTag.classList.toggle('is-alert', alert);
  }

  paintLife(civ.struck ? 0 : civ.pop);
  for(const m of civ.drain()) pushLog(m);

  // 不动手也能把他们耗光。那条路径原先没有结局也没有出口，只剩一颗空行星。
  // 生存模式里文明沉默只是中途的一件事（约 391K 就没了，离 640K 的极限还远），不是结局。
  if(civ.dead && !civ.struck && !survivalOn) showVerdict();
}
requestAnimationFrame(frame);

addEventListener('resize', () => {
  stage.resize();
  if(survivalOn && innerWidth <= 900) exitSurvival();   // 窄屏下摄像头面板隐藏，退出按钮随之消失
});
