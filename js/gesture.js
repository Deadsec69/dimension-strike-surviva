// 手势输入 —— MediaPipe GestureRecognizer
//
// 用官方训练好的手势分类器，而不是自己量关节距离定阈值：
// 模型直接输出 Closed_Fist / Open_Palm 等八类标签并带置信度，
// 对光照、手的朝向和个体差异的鲁棒性远好于手搓规则。
// gesture_recognizer.task 内部已打包 hand_landmarker，无需另外加载。
//
// 但单帧分类结果不能直接当输入，这里是一台状态机：nohand → idle ⇄ grab / charge → fired。
//   idle    手在画面里、没在下令。静止且放松 300ms 后才「武装」。
//   grab    在拨动星球。在动的手一律是拨，不管什么手形——动得快时姿势本身不可信。
//   charge  静止的握拳/摊掌在蓄力。握满才发动，中途松开或动起来就中断。
//   fired   已发动，必须放松（两个武器分数都掉下来）才回到 idle。
// 判词期间切到双手模式，只认「击掌」，拨动与武器一律挂起。
// 手势环路走真实时间，与场景的命中停顿无关。
//
// 路径解析有两套规则，别写混：
//   import 语句  → 相对本模块（js/），故用 '../vendor/...'
//   运行时 fetch → 相对文档 URL（根目录），故用 './vendor/...'
//
// 资源全部本地化，不访问 storage.googleapis.com，国内可直连。

import { GestureRecognizer, FilesetResolver } from '../vendor/vision_bundle.mjs';

const CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],
  [13,17],[17,18],[18,19],[19,20],
  [0,17]
];

const PALM_IDX = [0, 5, 9, 13, 17];   // 掌心 = 腕点与四个掌指关节的平均：比任何单点都稳，手指乱动也不会带偏
const LABEL = { fist:'握拳', palm:'摊掌' };

/* ── 类别表。四个类别共用同一套迟滞（进 0.62 / 连续 120ms 低于 0.45 才出）。
   weapon 标记决定两件事：退出时是否记 weaponEndT（观察模式的起拨抑制），
   以及冲突时谁赢——静止且确信的武器压过瞄准，反过来永远不成立。 */
const CLASS = {
  fist:    { cat:'Closed_Fist', weapon:true  },
  palm:    { cat:'Open_Palm',   weapon:true  },
  point:   { cat:'Pointing_Up', weapon:false },
  victory: { cat:'Victory',     weapon:false }
};
const AIM_LABEL = { point:'瞄准', victory:'护盾' };

/* ── 指向的几何判据（生存模式）。Pointing_Up 只认竖着的食指，侧着指屏幕角落时分数塌掉，
   所以再按指尖到腕的距离（按手长归一）补一条软分数：食指伸直、其余三指蜷起。
   斜坡而不是硬阈值，走同一套迟滞。拇指不看：指向时拇指常常翘着，分类器也不管它。 */
const EXT_UP = [1.45, 1.60], EXT_DOWN = [1.25, 1.40];   // 伸直 ≥1.6 / 蜷起 ≤1.25，中间是斜坡
const TIP_MIN_CUTOFF = 1.0, TIP_BETA = 20, TIP_D_CUTOFF = 1.0;   // 指尖比掌心抖：静止截止略低
/* 指尖 → 视口的增益。1.25：手只需走画面中间 80% 就够到屏幕四边，不必伸直胳膊。
   y 的增益按「视口宽高比 / 画面宽高比」补上去，让手画的圆在屏上仍是圆（16:9 上 ≈1.67）；
   下限取 x 的增益，上限 2.0，超宽屏也别让 y 灵敏到发抖。 */
const AIM_GAIN = 1.25, AIM_GAIN_MAX = 2.0;

/* 拨动：手在画面里移动多少，折算成多少「像素」交给舞台，用的是和鼠标同一条通路。
   0.5 个归一化单位（半个画面）约合 350px，也就是两个多弧度——一次挥手拨小半圈。
   x 要取反：预览用 scaleX(-1) 做了镜像，而关键点是原始图像坐标，不反过来
   手往右挥星球会往左转。 */
const DRAG_PX_X = -700, DRAG_PX_Y = 500;
const DEAD_ZONE = 0.0008;   // 滤波后的死区可以很小：静止抑制已由滤波器负责，太大会吃掉慢拨的起步

/* ── 类别迟滞。进出同一条线，握着不动时置信度会在线上来回跳。
   不看 None 的分数：它没有校准意义（半握的手可以是 None 0.5 / Closed_Fist 0.45），
   只按名字取两个武器类别各自的分数。 */
const ENTER_SCORE = 0.62, EXIT_SCORE = 0.45, EXIT_MS = 120;
const IDLE_SCORE  = 0.30;   // 两个武器分数都低于它才算「确实没在下令」
const EDGE = 0.04;          // 掌部关键点贴着画面边缘 4% 以内：手被裁掉一半，分类不可信——这是 Closed_Fist 误报的头号来源

/* ── 蓄力。握满才发动，不是摆出来就发动。 */
const CHARGE_PRE_MS = 100;                       // 静默期：两三帧误判到不了星球
const CHARGE_MS     = { fist:700, palm:600 };    // 二向箔略短：它没有蓄力可看，等太久像卡住
const V_CHARGE = 0.30, V_PAUSE = 0.60;           // 掌心速度（归一化单位/秒）：低于前者蓄力推进，之间暂停，高于后者中断
const V_FAST   = 0.80;                           // 原始（未滤波）速度超过它：解除武装。快动作后必须重新静止才有武器

/* ── 武装 / 起拨 / 掉帧。时间一律走内部时钟（每帧累加、单步封顶 100ms）：
   不按帧数——昏暗房间里摄像头掉到 15fps，帧数计时全部翻倍；
   也不直接用 performance.now() 的差——标签页切走再回来会跳几秒，握着的拳当场发动。 */
const REARM_MS = 300, COOL_MS = 250, LOCK_MS = 1000;   // 放松且静止 300ms + 冷却才重新武装；interrupt() 后锁 1s
const GRAB_SUPPRESS_MS = 250;                    // 武器姿势结束后不起拨：过渡帧会被判成 None，而 None 就是拨
const GRACE_MS = 100;                            // 追踪丢失这么久以内蓄力与武装都不变，撑过两三帧掉帧
const FLICK_MS = 600, SETTLE_MS = 150;           // 快甩出画面后 600ms 内回来：静止 150ms 才算「接住」，否则让它继续转

/* ── 掌心滤波：One-Euro。截止频率随速度上升——静止时 1.2Hz 把抖动滤干净，一挥手截止拉高、
   几乎零延迟；定比 EMA 只有一个旋钮，压得住抖就跟不上手。β 的量纲是 Hz/(单位/秒)：
   文献里 0.02~0.05 是按像素速度调的，这里坐标归一化（约 1/640），要放大到 20 左右才是同一件事。 */
const PALM_MIN_CUTOFF = 1.2, PALM_BETA = 20, PALM_D_CUTOFF = 1.0;
const VEL_TAU = 0.06;                            // 门槛用的速度另走一条短低通；滤波器自己 1Hz 的导数太滞后

/* ── 击掌（只在判词期间）。距离按手长（腕 0 → 中指根 9）归一，离摄像头远近都成立。
   击掌是一个动作，不是一个姿势：先分开过、再以足够速度合拢才算；两手一直贴着不触发。
   不看类别——正对摄像头的击掌是侧着的，合掌那一刻 Open_Palm 的分数会塌掉。 */
const CLAP_FAR = 2.2, CLAP_FAR_MS = 500;         // 500ms 内先分开过这么远
const CLAP_NEAR = 1.1, CLAP_V = 4.0;             // 合拢到一个多手长以内，且合拢速度 ≥ 4 手长/秒（连续两帧，或单帧 ≥ 2 倍）
const CLAP_LOSS_D = 1.9, CLAP_LOSS_MS = 120;     // 快速合拢中少了一只手（合掌那一刻常遮住另一只），上一帧够近也算
const CLAP_OPEN = 1.55;                          // 四指尖到腕的平均距离 / 手长（张开约 1.8~2.0，握拳约 1.0）
const CLAP_COOL_MS = 1000;

const damp = (cur, tgt, tau, dt) => cur + (tgt - cur) * (1 - Math.exp(-dt / tau));
const clamp01 = v => Math.max(0, Math.min(1, v));
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

class OneEuro {
  constructor(minCutoff, beta, dCutoff){ this.mc = minCutoff; this.beta = beta; this.dc = dCutoff; this.reset(); }
  reset(){ this.x = null; this.dx = 0; }
  static alpha(cutoff, dt){ return 1 / (1 + 1 / (2 * Math.PI * cutoff * dt)); }
  filter(x, dt){
    if(this.x === null){ this.x = x; this.dx = 0; return x; }
    const dxRaw = (x - this.x) / dt;
    this.dx += (dxRaw - this.dx) * OneEuro.alpha(this.dc, dt);
    this.x  += (x - this.x) * OneEuro.alpha(this.mc + this.beta * Math.abs(this.dx), dt);
    return this.x;
  }
}

// 双手几何。归一化坐标是各向异性的（默认 4:3），x 要按宽高比缩放再量距离。
const dist = (a, b, asp) => Math.hypot((a.x - b.x) * asp, a.y - b.y);
const handSize = (lm, asp) => dist(lm[0], lm[9], asp);
function palmCenter(lm){
  let x = 0, y = 0;
  for(const i of PALM_IDX){ x += lm[i].x; y += lm[i].y; }
  return { x:x / 5, y:y / 5 };
}
function isOpen(lm, size, asp){
  let s = 0;
  for(const i of [8, 12, 16, 20]) s += dist(lm[i], lm[0], asp) / size;
  return s / 4 >= CLAP_OPEN;
}
const fingersUp = lm => lm[12].y < lm[0].y;   // 图像 y 向下

export class GestureInput {
  constructor({ video, canvas, onGesture, onState, onDrag, onCharge, canFire, onAim }){
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onGesture = onGesture;
    this.onState = onState || (() => {});
    this.onDrag = onDrag || (() => {});
    this.onCharge = onCharge || (() => {});
    this.canFire = canFire || (() => true);
    this.onAim = onAim || (() => {});
    this.mode = 'observe';   // 'observe' | 'survive'：生存模式不拨动，指向 / 剪刀手变成准星

    this.rec = null;
    this.stream = null;
    this.running = false;
    this.lastVideoTime = -1;
    this.lastNow = 0;
    this.clock = 0;          // 内部时钟（ms），见上面的说明
    this.dtMs = 0;
    this.errN = 0;

    this.wantClap = false;   // main.js 决定；判词期间为真
    this.numHands = 1;
    this.switching = false;

    this.fx = new OneEuro(PALM_MIN_CUTOFF, PALM_BETA, PALM_D_CUTOFF);
    this.fy = new OneEuro(PALM_MIN_CUTOFF, PALM_BETA, PALM_D_CUTOFF);
    this.p = null;           // 滤波后的掌心
    this.vel = 0;            // 短低通后的掌心速度，供静止判断
    this.vRaw = 0;           // 原始速度，供快动作判断
    this.anchor = null;      // 拨动的参考点
    this.tx = new OneEuro(TIP_MIN_CUTOFF, TIP_BETA, TIP_D_CUTOFF);   // 指尖各走一对滤波器，不和掌心共用：
    this.ty = new OneEuro(TIP_MIN_CUTOFF, TIP_BETA, TIP_D_CUTOFF);   // 掌心是速度裁判，指尖是准星
    this.aiming = false;

    this._toNoHand();
    this.armed = false;
    this.seenT = -Infinity; this.idleT = 0; this.weaponEndT = -Infinity;
    this.firedT = -Infinity; this.lockUntil = 0;
    this.lostT = -Infinity; this.lostV = 0;
    this._resetClap();
    this.clapT = -Infinity;  // 冷却跨越模式切换
  }

  async start(){
    if(!window.isSecureContext){
      this.onState('需 HTTPS', 'err');
      throw new Error('getUserMedia 需要安全上下文（HTTPS 或 localhost）');
    }
    if(!navigator.mediaDevices?.getUserMedia){
      this.onState('不支持', 'err');
      throw new Error('此浏览器不支持 getUserMedia');
    }

    this.onState('加载模型…');
    const fileset = await FilesetResolver.forVisionTasks('./vendor/wasm');
    const hands = this.wantClap ? 2 : 1;   // 摄像头可能是在判词已经出来之后才开的
    this.rec = await GestureRecognizer.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: './models/gesture_recognizer.task', delegate: 'GPU' },
      runningMode: 'VIDEO',
      numHands: hands,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.6
    });
    this.numHands = hands;

    this.onState('请求摄像头…');
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false
    });
    this.video.srcObject = this.stream;
    await this.video.play();

    this.canvas.width = this.video.videoWidth || 640;
    this.canvas.height = this.video.videoHeight || 480;

    this.lastVideoTime = -1;
    this.lastNow = performance.now();
    this.errN = 0;
    this._toNoHand(); this._resetClap();
    this.running = true;
    this.onState('待机', 'live');
    this._applyHands();      // 等模型的这段时间里 wantClap 可能又变了
    this._loop();
  }

  stop(){
    this.running = false;
    this.interrupt();
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    const rec = this.rec; this.rec = null;
    try{ rec?.close?.(); }catch{}   // start() 每次新建一个识别器，不关就是每开一次摄像头漏一个
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this._toNoHand();
    this.onState('未启用');
  }

  /* 外部打断：换样本、复位、判词出现。结束拨动、取消蓄力、解除武装并锁 1 秒——
     换样本那一刻拳头多半还握着，不打断的话 0.3 秒后就会砸在新样本上。 */
  interrupt(){
    this._abandon();
    this.armed = false;
    this.lockUntil = this.clock + LOCK_MS;
    this.lostT = -Infinity;
    this._resetClap();
  }

  /* 生存模式：不拨动，武器照旧，指向 / 剪刀手变成准星。切换即打断——那一刻手上多半还有姿势。 */
  setMode(m){
    if(m === this.mode) return;
    this.mode = m;
    this.interrupt();
  }

  /* 判词期间只认击掌：切到两只手。平时只跟一只手——省一半算力，也没有第二只手来抢星球。 */
  setClapMode(on){
    on = !!on;
    if(this.wantClap === on) return;
    this.wantClap = on;
    this.interrupt();
    if(this.running) this._applyHands();
  }

  async _applyHands(){
    if(this.switching || !this.rec) return;
    const want = this.wantClap ? 2 : 1;
    if(want === this.numHands) return;
    const rec = this.rec;
    this.switching = true;
    this.onState('切换中…', 'live');
    try{
      // 不带 baseOptions 时是同步重建图，但仍按 promise 处理。numHands 在这个 bundle 里是
      // 无条件写入的（t.numHands ?? 1），所以必须显式给，否则 setOptions({}) 会悄悄退回一只手。
      await rec.setOptions({ numHands: want });
    }catch(e){
      console.warn('[手势] setOptions 失败，留在单手模式', e);
      this.switching = false;
      return;
    }
    this.switching = false;
    if(rec !== this.rec) return;       // 切换途中 stop()/start() 换了识别器：这次结果作废
    this.numHands = want;
    this._resetClap();
    this._toNoHand();
    if((this.wantClap ? 2 : 1) !== this.numHands) this._applyHands();   // 切的过程中目标又变了
  }

  _loop(){
    if(!this.running) return;
    requestAnimationFrame(() => this._loop());
    if(this.switching || !this.rec) return;

    const vt = this.video.currentTime;
    if(vt === this.lastVideoTime) return;
    // 两套时间：识别器要 performance.now()（同一张图内必须单调），
    // 滤波与速度要 video.currentTime 的差（真实的采样间隔；墙钟的差会与摄像头节拍拍频）。
    const now = performance.now();
    this.dtMs = Math.min(100, now - this.lastNow);
    this.lastNow = now;
    this.clock += this.dtMs;
    const stall = this.lastVideoTime < 0 || vt - this.lastVideoTime > 0.15;   // 首帧、标签页节流、摄像头卡住
    const dt = Math.min(0.1, Math.max(1 / 60, vt - this.lastVideoTime));
    this.lastVideoTime = vt;

    let res;
    try{
      res = this.rec.recognizeForVideo(this.video, now);
      this.errN = 0;
    }catch(e){
      this._abandon();
      if(++this.errN >= 30){
        console.error('[手势] 识别连续出错', e);
        this.stop();
        this.onState('识别出错', 'err');
      }
      return;
    }

    const hands = res?.landmarks ?? [];
    this._draw(hands);
    if(this.numHands === 2) this._clap(hands, dt);
    else if(this.mode === 'survive') this._stepSurvive(res, hands[0] ?? null, dt, stall);
    else this._step(res, hands[0] ?? null, dt, stall);
  }

  /* ── 单手状态机 ── */
  _step(res, lm, dt, stall){
    if(!lm){
      if(this.st === 'grab'){                        // 立刻松手，惯性交给舞台
        this.onDrag('end');
        this.lostT = this.clock; this.lostV = this.vel;
        this.st = 'idle';
      }
      this._resetPalm();                             // 位置滤波不跨掉帧：回来时不能吐出一个巨大的位移
      if(this.clock - this.seenT < GRACE_MS) return; // 短暂丢失：蓄力计时、武装状态原样保留
      if(this.st === 'charge' && this.k > 0) this.onCharge(this.kind, 0);
      this._toNoHand();                              // 离开画面 = 暂停，不是重新武装
      this.onState('待机', 'live');
      return;
    }

    this.seenT = this.clock;
    const seeded = this._palm(lm, dt, stall);
    const cats = res?.gestures?.[0] ?? [];
    let fistS = cats.find(c => c.categoryName === 'Closed_Fist')?.score ?? 0;
    let palmS = cats.find(c => c.categoryName === 'Open_Palm')?.score ?? 0;
    const atEdge = PALM_IDX.some(i => lm[i].x < EDGE || lm[i].x > 1 - EDGE || lm[i].y < EDGE || lm[i].y > 1 - EDGE);
    if(atEdge) fistS = palmS = 0;
    const s = { fist:fistS, palm:palmS };
    this._classify(s);

    const idle  = !atEdge && fistS < IDLE_SCORE && palmS < IDLE_SCORE;
    const still = this.vel < V_CHARGE;
    if(this.st === 'nohand'){ this.st = 'idle'; this.armed = false; this.idleT = this.clock; }
    if(this.vRaw >= V_FAST) this.armed = false;
    if(!(idle && still)) this.idleT = this.clock;
    else if(!this.armed && this.clock - this.idleT >= REARM_MS
            && this.clock - this.firedT >= COOL_MS && this.clock >= this.lockUntil) this.armed = true;

    const label = LABEL[this.cls] ?? LABEL[this.kind] ?? '';
    switch(this.st){
      case 'idle': {
        if(this.cls && this.vel < V_PAUSE){          // 静止的武器姿势
          if(!this.armed) this.onState('冷却', 'live');
          else if(!this.canFire()) this.onState('不可用', 'live');
          else {
            this.st = 'charge'; this.kind = this.cls;
            this.chargeT = this.clock; this.k = 0; this.pausedMs = 0;
            this.onState(`${label} 蓄力 0%`, 'live');
          }
          break;
        }
        // 在动的手一律是拨，不管什么手形
        if(this.clock - this.weaponEndT < GRAB_SUPPRESS_MS){ this.onState(this.armed ? '待机' : '冷却', 'live'); break; }
        if(this.clock - this.lostT < FLICK_MS && this.lostV > V_FAST){   // 快甩出画面后回来
          if(this.vRaw > V_FAST) this._beginDrag();                     // 新的一挥：直接抓（清速无害，手在动）
          else if(still){                                               // 静止下来：这是有意接住
            if(this.settleT < 0) this.settleT = this.clock;
            if(this.clock - this.settleT >= SETTLE_MS) this._beginDrag();
            else this.onState('待机', 'live');
          }else{ this.settleT = -1; this.onState('待机', 'live'); }     // 漂着的手：让星球继续转
          break;
        }
        this._beginDrag();
        break;
      }
      case 'grab': {
        // 拨动优先：拨动中出现的武器姿势只在手慢下来之后才作数
        if(this.cls && this.vel < V_PAUSE){
          this.onDrag('end'); this.weaponEndT = this.clock; this.st = 'idle';
          this.onState(`${label} 稳住`, 'live');
          break;
        }
        if(!seeded){
          const dx = this.p.x - this.anchor.x, dy = this.p.y - this.anchor.y;
          if(Math.abs(dx) > DEAD_ZONE || Math.abs(dy) > DEAD_ZONE) this.onDrag('move', dx * DRAG_PX_X, dy * DRAG_PX_Y);
        }
        this.anchor = this.p;
        this.onState('拨动', 'live');
        break;
      }
      case 'charge': this._stepCharge(s[this.kind] ?? 0, label); break;
      case 'fired':  this._stepFired(idle, label); break;
    }
  }

  // 蓄力与已发动两态在观察 / 生存模式里完全相同，抽出来共用
  _stepCharge(score, label){
    if(this.cls !== this.kind || this.vel >= V_PAUSE){   // 松开了，或手在动：中断
      if(this.k > 0) this.onCharge(this.kind, 0);
      this.k = 0; this.weaponEndT = this.clock; this.st = 'idle';
      // 中断也解除武装：握拳张开成摊掌、就地停住，不该 0.6 秒后变成一记二向箔
      this.armed = false;
      this.onState('冷却', 'live');
      return;
    }
    // 分数掉进迟滞带、或手在微动：暂停，不推进也不中断。中断得等退出确认——
    // 否则 85% 时松手，那 120ms 的退出延迟会把它送到 100%。
    if(score < EXIT_SCORE || this.vel >= V_CHARGE){
      this.pausedMs += this.dtMs;
      this.onState(`${label} 稳住`, 'live');
      return;
    }
    this.k = clamp01((this.clock - this.chargeT - CHARGE_PRE_MS - this.pausedMs) / CHARGE_MS[this.kind]);
    this.onCharge(this.kind, this.k);
    if(this.k >= 1){
      this.armed = false; this.firedT = this.clock; this.st = 'fired';
      this.onGesture(this.kind);
      this.onState(`${label} 已发动`, 'live');
    }else{
      this.onState(`${label} 蓄力 ${Math.round(this.k * 20) * 5}%`, 'live');
    }
  }
  _stepFired(idle, label){                            // 必须放松才回到 idle
    if(idle){
      this.onCharge(this.kind, 0); this.k = 0;
      this.weaponEndT = this.clock; this.st = 'idle';
      this.onState('冷却', 'live');
    }else this.onState(`${label} 已发动`, 'live');
  }

  /* ── 生存模式的单手状态机：没有 grab；指向 / 剪刀手发准星，武器照旧 ── */
  _stepSurvive(res, lm, dt, stall){
    if(!lm){
      this._aimOff();                                  // 准星立刻收：没有手就没有靶
      this._resetPalm(); this._resetTip();
      if(this.clock - this.seenT < GRACE_MS) return;   // 短暂丢失：蓄力、武装原样保留
      if(this.st === 'charge' && this.k > 0) this.onCharge(this.kind, 0);
      this._toNoHand();
      this.onState('待机', 'live');
      return;
    }

    this.seenT = this.clock;
    this._palm(lm, dt, stall);                         // 掌心速度仍是「静止」的唯一裁判
    const tip = this._tip(lm, dt, stall);              // 视口坐标，已镜像、已加增益、已夹到 [0,1]
    const cats = res?.gestures?.[0] ?? [];
    const S = n => cats.find(c => c.categoryName === n)?.score ?? 0;
    const atEdge = PALM_IDX.some(i => lm[i].x < EDGE || lm[i].x > 1 - EDGE || lm[i].y < EDGE || lm[i].y > 1 - EDGE);

    // 几何判据（软分数）
    const asp = this.canvas.width / this.canvas.height;
    const size = Math.max(1e-4, handSize(lm, asp));
    const ext = i => dist(lm[i], lm[0], asp) / size;
    const up = e => sstep(EXT_UP[0], EXT_UP[1], e), down = e => 1 - sstep(EXT_DOWN[0], EXT_DOWN[1], e);
    const e8 = ext(8), e12 = ext(12), e16 = ext(16), e20 = ext(20);
    const pointH   = up(e8) * down(e12) * down(e16) * down(e20);
    const victoryH = up(e8) * up(e12)   * down(e16) * down(e20);

    // 原始武器分数只做贴边门控，供武装 / fired 判断——与观察模式完全相同
    const fistS = atEdge ? 0 : S('Closed_Fist'), palmS = atEdge ? 0 : S('Open_Palm');
    // 分类用的分数：在动的手不下令（观察模式里这条已成立），但可以瞄准。
    // 不门控的话，快速挥过去的侧向指向会被模糊帧判成 Closed_Fist，准星就断了。
    const moving = this.vel >= V_PAUSE;
    const s = { fist: moving ? 0 : fistS, palm: moving ? 0 : palmS,
                point: Math.max(S('Pointing_Up'), pointH), victory: Math.max(S('Victory'), victoryH) };
    if(Math.max(s.fist, s.palm) >= ENTER_SCORE) s.point = s.victory = 0;   // 武器优先（此时必然静止且确信）
    this._classify(s);

    // 武装：与 _step 逐字相同。V_FAST 解除武装只影响武器；瞄准从不看 armed / lockUntil
    const idle  = !atEdge && fistS < IDLE_SCORE && palmS < IDLE_SCORE;
    const still = this.vel < V_CHARGE;
    if(this.st === 'nohand'){ this.st = 'idle'; this.armed = false; this.idleT = this.clock; }
    if(this.vRaw >= V_FAST) this.armed = false;
    if(!(idle && still)) this.idleT = this.clock;
    else if(!this.armed && this.clock - this.idleT >= REARM_MS
            && this.clock - this.firedT >= COOL_MS && this.clock >= this.lockUntil) this.armed = true;

    const label = LABEL[this.cls] ?? LABEL[this.kind] ?? '';
    switch(this.st){
      case 'idle': {
        if(CLASS[this.cls]?.weapon && this.vel < V_PAUSE){   // 静止的武器姿势：与 _step 相同的三岔口
          this._aimOff();
          if(!this.armed) this.onState('冷却', 'live');
          else if(!this.canFire()) this.onState('不可用', 'live');
          else {
            this.st = 'charge'; this.kind = this.cls;
            this.chargeT = this.clock; this.k = 0; this.pausedMs = 0;
            this.onState(`${label} 蓄力 0%`, 'live');
          }
          break;
        }
        // 瞄准。只在类别分数仍在退出线以上时发准星：掉进迟滞带那 120ms 发 null——
        // 否则 ✌️ 在 0.35s 松开，迟滞会把它送到 0.45s，多出一块没人要的护盾（和蓄力 85% 松手是同一个坑）
        if((this.cls === 'point' || this.cls === 'victory') && s[this.cls] >= EXIT_SCORE){
          this._aimOn(tip.x, tip.y, this.cls);
          this.onState(AIM_LABEL[this.cls], 'live');
        }else{
          this._aimOff();
          this.onState(this.armed ? '待机' : '冷却', 'live');
        }
        break;
      }
      case 'grab': this.st = 'idle'; break;             // 切换模式的残留：生存模式里没有拨动
      case 'charge': this._aimOff(); this._stepCharge(s[this.kind] ?? 0, label); break;
      case 'fired':  this._aimOff(); this._stepFired(idle, label); break;
    }
  }

  _aimOn(x, y, pose){ this.aiming = true; this.onAim(x, y, pose); }
  _aimOff(){ if(!this.aiming) return; this.aiming = false; this.onAim(null); }   // 去重：null 只发一次
  _resetTip(){ this.tx.reset(); this.ty.reset(); }
  _tip(lm, dt, stall){
    if(stall) this._resetTip();
    const x = this.tx.filter(lm[8].x, dt), y = this.ty.filter(lm[8].y, dt);
    return this._toView(1 - x, y);                    // 镜像：预览 scaleX(-1)，指向右边的手在原始坐标里在左边
  }
  /* 指尖 → 视口。画面是 4:3、视口任意；y 的增益按视口/画面宽高比补齐，手画的圆在屏上仍是圆。
     视口可用 innerWidth/innerHeight：#stage 是 inset:0 的 fixed 画布，两者就是同一个矩形。 */
  _toView(hx, hy){
    const vidAsp = (this.canvas.width || 4) / (this.canvas.height || 3);
    const gx = AIM_GAIN;
    const gy = Math.min(AIM_GAIN_MAX, Math.max(gx, gx * (innerWidth / innerHeight) / vidAsp));
    return { x:clamp01(0.5 + (hx - 0.5) * gx), y:clamp01(0.5 + (hy - 0.5) * gy) };
  }

  // s：各类别的分数表（缺省为 0）。进入取最高且 ≥ ENTER；退出要连续 EXIT_MS 低于 EXIT。
  _classify(s){
    if(this.cls){
      const cur = s[this.cls] ?? 0;
      if(cur >= EXIT_SCORE) this.exitMs = 0;
      else if((this.exitMs += this.dtMs) >= EXIT_MS) this._exitClass();
      // 武器优先：瞄准姿势中冒出确信的武器，立即改判，不等 120ms。
      // 调用方已按「静止」把武器分数门控过，所以到这里 ≥ ENTER 的武器一定是静止且确信的。
      if(this.cls && !CLASS[this.cls].weapon){
        const w = (s.fist ?? 0) >= (s.palm ?? 0) ? 'fist' : 'palm';
        if((s[w] ?? 0) >= ENTER_SCORE){ this.cls = w; this.exitMs = 0; }
      }
    }
    if(!this.cls){
      let best = null, bs = 0;
      for(const k in s) if(s[k] > bs){ bs = s[k]; best = k; }
      if(best && bs >= ENTER_SCORE){ this.cls = best; this.exitMs = 0; }
    }
  }
  _exitClass(){
    const was = this.cls;
    this.cls = null; this.exitMs = 0;
    if(CLASS[was]?.weapon) this.weaponEndT = this.clock;   // 只有武器结束才抑制起拨：过渡帧是它的
  }

  _palm(lm, dt, stall){
    const c = palmCenter(lm);
    if(stall) this._resetPalm();
    const seeded = this.fx.x === null;
    const x = this.fx.filter(c.x, dt), y = this.fy.filter(c.y, dt);
    if(seeded){ this.p = { x, y }; this.vel = 0; this.vRaw = 0; return true; }   // 种子帧不吐位移
    this.vRaw = Math.hypot(x - this.p.x, y - this.p.y) / dt;
    this.vel = damp(this.vel, this.vRaw, VEL_TAU, dt);
    this.p = { x, y };
    return false;
  }
  _resetPalm(){ this.fx.reset(); this.fy.reset(); this.vel = 0; this.vRaw = 0; }

  _beginDrag(){
    this.anchor = this.p;
    this.settleT = -1;
    this.st = 'grab';
    this.onDrag('start');
    this.onState('拨动', 'live');
  }

  // 结束拨动、取消蓄力（该发的回调都发），回到 nohand。不动 armed 与锁。
  _abandon(){
    if(this.st === 'grab') this.onDrag('end');
    if(this.k > 0) this.onCharge(this.kind, 0);
    this._aimOff();
    this._toNoHand();
  }
  _toNoHand(){
    this.st = 'nohand'; this.cls = null; this.exitMs = 0;
    this.kind = null; this.k = 0; this.pausedMs = 0; this.chargeT = 0;
    this.settleT = -1;
    this._resetPalm();
    this._resetTip();
    this._aimOff();
  }

  /* ── 双手：击掌 ── */
  _clap(hands, dt){
    this.onState('击掌换样本', 'live');
    if(this.clock - this.clapT < CLAP_COOL_MS){ this.clapPrev = null; this.closingN = 0; return; }
    if(hands.length < 2){
      const prev = this.clapPrev;
      this.clapPrev = null; this.closingN = 0;
      // 刚快速合拢、然后少了一只手：合掌那一刻常会遮住另一只
      if(prev && prev.closing && prev.d < CLAP_LOSS_D && this.clock - prev.t < CLAP_LOSS_MS && this._farRecent()) this._fireClap();
      return;
    }
    const [a, b] = hands;                            // 顺序帧间任意：下面所有量都对称，不看左右手标签
    const asp = this.canvas.width / this.canvas.height;
    const sa = handSize(a, asp), sb = handSize(b, asp);
    const sMin = Math.min(sa, sb), sMax = Math.max(sa, sb), s = (sa + sb) / 2;
    const d = dist(palmCenter(a), palmCenter(b), asp) / s;
    if(d >= CLAP_FAR) this.farT = this.clock;
    const open = isOpen(a, sa, asp) && isOpen(b, sb, asp) && fingersUp(a) && fingersUp(b);

    const prev = this.clapPrev;
    const jump = prev && (Math.abs(sMin - prev.sMin) > 0.4 * prev.sMin || Math.abs(sMax - prev.sMax) > 0.4 * prev.sMax);
    const vA = prev && !jump ? (prev.d - d) / dt : 0;   // 手长/秒，正 = 在合拢
    const closing = vA >= CLAP_V;
    this.closingN = closing ? this.closingN + 1 : 0;
    this.clapPrev = { d, t:this.clock, closing, sMin, sMax };

    if(open && this._farRecent() && d <= CLAP_NEAR && (this.closingN >= 2 || vA >= 2 * CLAP_V)) this._fireClap();
  }
  _farRecent(){ return this.clock - this.farT < CLAP_FAR_MS; }
  _fireClap(){
    this.clapT = this.clock;
    this._resetClap();
    this.onGesture('clap');
  }
  _resetClap(){ this.clapPrev = null; this.closingN = 0; this.farT = -Infinity; }

  _draw(hands){
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if(!hands.length) return;

    const amber = getComputedStyle(document.documentElement)
      .getPropertyValue('--amber-live').trim() || '#E8B04B';

    for(const lm of hands){
      ctx.strokeStyle = amber;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      for(const [a, b] of CONNECTIONS){
        ctx.moveTo(lm[a].x * W, lm[a].y * H);
        ctx.lineTo(lm[b].x * W, lm[b].y * H);
      }
      ctx.stroke();

      ctx.fillStyle = amber;
      ctx.globalAlpha = 1;
      for(const p of lm){
        ctx.beginPath();
        ctx.arc(p.x * W, p.y * H, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}
