// 被观测的文明 —— 状态演化与通讯记录
//
// 设计意图：读数保持临床式的冷静，文明的声音从中穿透出来。
// 反差本身就是内容——你在无所谓地拖滑块，他们在里面经历纪元。

const IDEAL_T = 288;      // K
const IDEAL_P = 1.0;      // atm
const POP_BASE = 78.4;    // 亿

/* 样本编号从 3,241 往上走。每换一个就跳过几个号，那几个号不属于你就不会出现。
   生物型和纪元一律不变：对观测者而言它们本来就是可互换的，这比逐个编背景更冷。 */
const CATALOGS = ['GLIESE', 'KEPLER', 'WOLF', 'ROSS', 'TRAPPIST', 'LHS', 'HD'];
const NUMERALS = ['II', 'III', 'IV', 'V', 'VI'];

function designation(){
  const cat = CATALOGS[(Math.random() * CATALOGS.length) | 0];
  const num = 100 + ((Math.random() * 900) | 0);
  return `${cat} ${num} / ${NUMERALS[(Math.random() * NUMERALS.length) | 0]}`;
}

export class Civilization {
  constructor(){
    this.id = 3241;
    this.tag = 'GLIESE 581 / IV';
    this.reset();
  }

  /** 下一个样本。编号只往上走——那是「你已经做过很多次」唯一的痕迹。 */
  nextSpecimen(){
    this.id += 7 + ((Math.random() * 34) | 0);
    this.tag = designation();
    this.reset();
  }

  get idText(){ return this.id.toLocaleString('en-US'); }

  reset(){
    this.pop = 1;
    this.tech = 2.41;
    this.hab = 1;
    this.effHab = 1;
    this.dead = false;
    this.struck = null;
    this.fired = new Set();
    this.cooldown = 0;
    this.minPop = 1;
    this.queue = [];
    this.elapsed = 0;
    this.spun = 0;
  }

  /** 宜居指数：温度按线性尺度、气压按对数尺度各自衰减 */
  static habitability(T, P){
    const t = Math.exp(-Math.pow((T - IDEAL_T) / 44, 2));
    if(P < 0.008) return 0;
    const p = Math.exp(-Math.pow(Math.log(P / IDEAL_P) / 0.98, 2));
    return t * p;
  }

  update(dt, T, P, spinAnomaly){
    if(this.struck) return;
    this.elapsed += dt;
    // 被外力拨动自转的累计量，单位是弧度。他们测得到昼夜，测不到那只手。
    this.spun += dt * Math.min(8, spinAnomaly || 0);
    this.cooldown = Math.max(0, this.cooldown - dt);

    this.hab = Civilization.habitability(T, P);

    // 技术抵抗：等级 2.0 以上开始能对抗环境，但有上限
    const resist = Math.max(0, Math.min(0.30, (this.tech - 2.0) * 0.17));
    this.effHab = Math.min(1, this.hab + resist * (this.pop > 0.08 ? 1 : 0));

    // 人口：死得快，长得慢
    const prevPop = this.pop;
    const rate = this.effHab < this.pop ? 0.62 : 0.085;
    this.pop += (this.effHab - this.pop) * rate * dt;
    if(this.pop < 0.004) this.pop = 0;
    this.minPop = Math.min(this.minPop, this.pop);

    // 技术：人口稳定时缓慢积累
    if(this.pop > 0.22) this.tech += dt * 0.016 * this.pop;

    this._check(T, P, prevPop, resist);
  }

  _say(id, text, tone){
    if(this.fired.has(id)) return;
    if(this.cooldown > 0 && tone !== 'final') return;
    this.fired.add(id);
    this.cooldown = tone === 'final' ? 0 : 1.4;
    this.queue.push({ text, tone: tone || 'normal' });
  }

  _check(T, P, prevPop, resist){
    this._say('hello', `Narrowband signal detected. Civilization No. ${this.idText} greets an unknown observer.`);

    // ── 温度
    if(T > 302) this._say('warm', 'Mean temperature up 14 K. They noticed, and blamed the stellar cycle.');
    if(T > 334) this._say('hot1', 'Three straight equatorial harvests lost. Populations begin moving toward the poles.');
    if(T > 402) this._say('hot2', 'Ocean surface boiling. Outbound broadcasts cease; survival moves underground.');
    if(T > 620) this._say('hot3', 'No liquid water left on the surface. Seven shelters still operating.');
    if(T < 262) this._say('cold1', 'Ice sheets pass 40° N. They burned the last forests.');
    if(T < 228) this._say('cold2', 'Oceans frozen over. Geothermal cities are the only way left to live.');
    if(T < 196) this._say('cold3', 'The signal collapses to a single coordinate, looping one piece of music.');

    // ── 气压
    if(P < 0.42) this._say('thin1', 'The atmosphere is escaping. Twelve cities have been domed.');
    if(P < 0.09) this._say('thin2', 'Dome structures failing one after another.');
    if(P > 7.5) this._say('thick1', 'Pressure at seven times standard. Surface structures crushed one by one.');
    if(P > 24) this._say('thick2', 'Crustal load exceeded. No signal is getting out.');

    // ── 技术抵抗（他们真的在反击）
    if(resist > 0.11 && this.hab < 0.55)
      this._say('resist', 'They built a mirror array at the Lagrange point. It works. For now.');

    // ── 人口节点
    if(this.pop < 0.52) this._say('p50', 'Population halved. The broadcasts have changed from greetings to coordinates.');
    if(this.pop < 0.21) this._say('p20', `Civilization No. ${this.idText} requests dialogue. Any form of dialogue.`);
    if(this.pop < 0.06) this._say('p05', 'Broadcast power has decayed to the noise floor.');
    if(this.pop <= 0 && prevPop > 0){
      this.dead = true;
      this._say('gone', '…signal lost.', 'final');
    }

    // ── 自转异常。这是整个模拟里唯一一处他们能「察觉到被干预」的地方：
    // 温度和气压还能归因于恒星，天空以错误的速度移动却无法解释。
    if(this.spun > 3.0)  this._say('spin1', 'Unexplained drift in the length of the day. Every calendar recalibrated.');
    if(this.spun > 13)   this._say('spin2', 'The sky is moving at the wrong speed. Someone proposes the "being watched" hypothesis.');
    if(this.spun > 34)   this._say('spin3', 'Circadian rhythms collapse. They have given the invisible hand a name.');

    // ── 恢复（奖励把参数调回来的人）
    if(this.minPop < 0.32 && this.pop > 0.72 && !this.dead)
      this._say('revive', 'Population recovering. They wrote this period into scripture and called it the Long Night.');
  }

  /** 发动打击 */
  strike(kind){
    this.struck = kind;
    this.pop = 0;
    this.dead = true;
  }

  verdict(){
    if(this.struck === 'foil')
      return 'The fall into two dimensions took 1,341 years.\nFrom their side, the universe simply grew thinner.';
    if(this.struck === 'crush')
      return `Planetary disintegration took 94 seconds.\nCivilization No. ${this.idText} sent no message.`;
    // 不动手也能结束——参数拧到那里，他们自己就走完了
    return `No weapon was used.\nCivilization No. ${this.idText}: observation ended.`;
  }

  /** 取出待播报的消息并清空队列 */
  /** 外部模块（生存模式）的播报入口。同一 id 每个样本只播一次；冷却期内会被丢弃，
      返回「是否已播出」供调用方下一帧重试。 */
  say(id, text, tone){ this._say(id, text, tone); return this.fired.has(id); }

  drain(){ const q = this.queue; this.queue = []; return q; }

  get popText(){
    const v = this.pop * POP_BASE;
    if(v <= 0) return '0';
    if(v < 0.01) return '< 1 M';                    // v 的单位是亿：×100 = 百万，÷10 = 十亿
    if(v < 10) return (v * 100).toFixed(0) + ' M';
    return (v / 10).toFixed(2) + ' B';
  }
  get techText(){ return this.tech.toFixed(2); }
  get habText(){ return this.hab.toFixed(2); }
}
