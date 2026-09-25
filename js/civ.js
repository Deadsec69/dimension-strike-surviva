// The observed civilization - state evolution and comms log
//
// Design intent: the readouts stay clinically calm and the civilization's voice cuts through them.
// The contrast is the content - you drag a slider without much thought, they live through epochs inside it.

const IDEAL_T = 288;      // K
const IDEAL_P = 1.0;      // atm
const POP_BASE = 78.4;    // in units of 100 million

/* Specimen numbers count up from 3,241. Each new one skips a few - those belong to someone else
   and never show up here. Biology and era never change: to an observer they are interchangeable
   anyway, and that reads colder than inventing a backstory for each one. */
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

  /** Next specimen. The number only ever goes up - the one trace that you have done this many times. */
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

  /** Habitability: temperature falls off on a linear scale, pressure on a logarithmic one. */
  static habitability(T, P){
    const t = Math.exp(-Math.pow((T - IDEAL_T) / 44, 2));
    if(P < 0.008) return 0;
    const p = Math.exp(-Math.pow(Math.log(P / IDEAL_P) / 0.98, 2));
    return t * p;
  }

  update(dt, T, P, spinAnomaly){
    if(this.struck) return;
    this.elapsed += dt;
    // Accumulated externally-imposed spin, in radians. They can measure day and night; they cannot measure the hand.
    this.spun += dt * Math.min(8, spinAnomaly || 0);
    this.cooldown = Math.max(0, this.cooldown - dt);

    this.hab = Civilization.habitability(T, P);

    // Technological resistance: above level 2.0 they start pushing back against the environment, up to a cap
    const resist = Math.max(0, Math.min(0.30, (this.tech - 2.0) * 0.17));
    this.effHab = Math.min(1, this.hab + resist * (this.pop > 0.08 ? 1 : 0));

    // Population: dies fast, grows slowly
    const prevPop = this.pop;
    const rate = this.effHab < this.pop ? 0.62 : 0.085;
    this.pop += (this.effHab - this.pop) * rate * dt;
    if(this.pop < 0.004) this.pop = 0;
    this.minPop = Math.min(this.minPop, this.pop);

    // Technology: accumulates slowly while the population is stable
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

    // -- Temperature
    if(T > 302) this._say('warm', 'Mean temperature up 14 K. They noticed, and blamed the stellar cycle.');
    if(T > 334) this._say('hot1', 'Three straight equatorial harvests lost. Populations begin moving toward the poles.');
    if(T > 402) this._say('hot2', 'Ocean surface boiling. Outbound broadcasts cease; survival moves underground.');
    if(T > 620) this._say('hot3', 'No liquid water left on the surface. Seven shelters still operating.');
    if(T < 262) this._say('cold1', 'Ice sheets pass 40° N. They burned the last forests.');
    if(T < 228) this._say('cold2', 'Oceans frozen over. Geothermal cities are the only way left to live.');
    if(T < 196) this._say('cold3', 'The signal collapses to a single coordinate, looping one piece of music.');

    // -- Pressure
    if(P < 0.42) this._say('thin1', 'The atmosphere is escaping. Twelve cities have been domed.');
    if(P < 0.09) this._say('thin2', 'Dome structures failing one after another.');
    if(P > 7.5) this._say('thick1', 'Pressure at seven times standard. Surface structures crushed one by one.');
    if(P > 24) this._say('thick2', 'Crustal load exceeded. No signal is getting out.');

    // -- Technological resistance (they really are fighting back)
    if(resist > 0.11 && this.hab < 0.55)
      this._say('resist', 'They built a mirror array at the Lagrange point. It works. For now.');

    // -- Population milestones
    if(this.pop < 0.52) this._say('p50', 'Population halved. The broadcasts have changed from greetings to coordinates.');
    if(this.pop < 0.21) this._say('p20', `Civilization No. ${this.idText} requests dialogue. Any form of dialogue.`);
    if(this.pop < 0.06) this._say('p05', 'Broadcast power has decayed to the noise floor.');
    if(this.pop <= 0 && prevPop > 0){
      this.dead = true;
      this._say('gone', '…signal lost.', 'final');
    }

    // -- Spin anomaly. The one place in the whole simulation where they can notice they are being
    // interfered with: temperature and pressure can still be blamed on the star, but a sky moving
    // at the wrong speed has no explanation.
    if(this.spun > 3.0)  this._say('spin1', 'Unexplained drift in the length of the day. Every calendar recalibrated.');
    if(this.spun > 13)   this._say('spin2', 'The sky is moving at the wrong speed. Someone proposes the "being watched" hypothesis.');
    if(this.spun > 34)   this._say('spin3', 'Circadian rhythms collapse. They have given the invisible hand a name.');

    // -- Recovery (a reward for anyone who dials the parameters back)
    if(this.minPop < 0.32 && this.pop > 0.72 && !this.dead)
      this._say('revive', 'Population recovering. They wrote this period into scripture and called it the Long Night.');
  }

  /** Fire a strike. */
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
    // It can end without you touching a weapon - twist the parameters far enough and they finish on their own
    return `No weapon was used.\nCivilization No. ${this.idText}: observation ended.`;
  }

  /** Broadcast entry point for other modules (survival mode). The same id fires at most once per
      specimen; calls during the cooldown are dropped, and the return value says whether it has
      aired, so the caller can retry on the next frame. */
  say(id, text, tone){ this._say(id, text, tone); return this.fired.has(id); }

  /** Take the pending messages and clear the queue. */
  drain(){ const q = this.queue; this.queue = []; return q; }

  get popText(){
    const v = this.pop * POP_BASE;
    if(v <= 0) return '0';
    if(v < 0.01) return '< 1 M';                    // v is in units of 100 million: x100 = millions, /10 = billions
    if(v < 10) return (v * 100).toFixed(0) + ' M';
    return (v / 10).toFixed(2) + ' B';
  }
  get techText(){ return this.tech.toFixed(2); }
  get habText(){ return this.hab.toFixed(2); }
}
