// Gesture input - MediaPipe GestureRecognizer
//
// Uses the officially trained gesture classifier rather than hand-rolled joint-distance thresholds:
// the model outputs eight labelled classes (Closed_Fist / Open_Palm and friends) with confidences,
// and is far more robust to lighting, hand orientation and individual differences than any rule we
// could write. gesture_recognizer.task bundles hand_landmarker internally, so nothing else to load.
//
// But a single frame's classification can't be used as input directly. This is a state machine:
// nohand -> idle <-> grab / charge -> fired.
//   idle    hand in frame, not commanding anything. It only "arms" after 300ms still and relaxed.
//   grab    spinning the planet. A moving hand is always a spin whatever its shape - while it moves
//           fast the pose itself can't be trusted.
//   charge  a still fist/palm building up. It only fires at full charge; releasing or moving aborts.
//   fired   fired; must relax (both weapon scores drop) before returning to idle.
// While the verdict is up it switches to two-hand mode and only watches for a clap; spin and weapons
// are suspended.
// The gesture loop runs on real time, independent of the scene's hit-stop.
//
// Two different path rules here, don't mix them up:
//   import statements  -> relative to this module (js/), hence '../vendor/...'
//   runtime fetch      -> relative to the document URL (the root), hence './vendor/...'
//
// All assets are local; storage.googleapis.com is never contacted at runtime.

import { GestureRecognizer, FilesetResolver } from '../vendor/vision_bundle.mjs';

const CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],
  [13,17],[17,18],[18,19],[19,20],
  [0,17]
];

const PALM_IDX = [0, 5, 9, 13, 17];   // palm center = mean of the wrist and the four knuckles: steadier than any single point, and unmoved by the fingers
const LABEL = { fist:'Fist', palm:'Palm' };

/* Class table. All four classes share one hysteresis (enter at 0.62 / leave only after 120ms
   continuously below 0.45).
   The weapon flag decides two things: whether leaving records weaponEndT (which suppresses the start
   of a spin in observe mode), and who wins a conflict - a still, confident weapon beats aiming, and
   never the other way round. */
const CLASS = {
  fist:    { cat:'Closed_Fist', weapon:true  },
  palm:    { cat:'Open_Palm',   weapon:true  },
  point:   { cat:'Pointing_Up', weapon:false },
  victory: { cat:'Victory',     weapon:false }
};
const AIM_LABEL = { point:'Aim', victory:'Shield' };

/* Geometric test for pointing (survival mode). Pointing_Up only recognizes a vertical index finger,
   and its score collapses when you point sideways at a corner of the screen. So add a soft score from
   fingertip-to-wrist distance (normalized by hand length): index extended, the other three curled.
   Ramps rather than hard thresholds, running through the same hysteresis. The thumb is ignored: it
   often sticks out while pointing, and the classifier ignores it too. */
const EXT_UP = [1.45, 1.60], EXT_DOWN = [1.25, 1.40];   // extended >=1.6 / curled <=1.25, a ramp in between
/* One more, relative test for the V sign: index and middle are clearly longer than ring and pinky.
   The absolute test needs the ring finger curled below 1.25 and both front fingers past 1.6, but the
   ring finger often half-follows the middle one (~1.4), and tilting the V toward the camera shortens
   the tips - both conditions collapse.
   A ratio is unaffected by tilt (all four shorten together) and tolerates a half-curled ring finger;
   an open palm has four fingers of equal length and a lone index has a short middle finger, so
   neither gets in. */
const V_LEAD = [1.30, 1.42], V_RATIO = [1.18, 1.32];
const TIP_MIN_CUTOFF = 1.0, TIP_BETA = 20, TIP_D_CUTOFF = 1.0;   // fingertips shake more than the palm: a slightly lower resting cutoff
/* Gain from fingertip to viewport. 1.25: the hand only has to cover the middle 80% of the camera
   frame to reach all four edges of the screen, without straightening your arm.
   The y gain is scaled by (viewport aspect / camera aspect) so a circle drawn by the hand is still a
   circle on screen (about 1.67 at 16:9); floored at the x gain and capped at 2.0, so y doesn't become
   twitchy on an ultra-wide display. */
const AIM_GAIN = 1.25, AIM_GAIN_MAX = 2.0;

/* Spin: how far the hand moves in frame, converted into "pixels" for the stage through exactly the
   same path as the mouse.
   0.5 normalized units (half the frame) is about 350px, a bit over two radians - one sweep turns it
   just under half a turn.
   x must be negated: the preview is mirrored with scaleX(-1) while the landmarks are in raw image
   coordinates, and without the flip a hand moving right would spin the planet left. */
const DRAG_PX_X = -700, DRAG_PX_Y = 500;
const DEAD_ZONE = 0.0008;   // the post-filter dead zone can be tiny: the filter already suppresses jitter, and a large one would eat the start of a slow spin

/* Class hysteresis. With one shared threshold for entering and leaving, a held pose makes the
   confidence flicker across the line.
   The None score is ignored: it isn't calibrated for anything (a half-closed hand can read
   None 0.5 / Closed_Fist 0.45). Each weapon class's score is read by name instead. */
const ENTER_SCORE = 0.62, EXIT_SCORE = 0.45, EXIT_MS = 120;
const IDLE_SCORE  = 0.30;   // both weapon scores must be below this to count as "genuinely not commanding"
const EDGE = 0.04;          // palm landmarks within 4% of the frame edge: half the hand is cropped and the classification is unreliable - the number one source of false Closed_Fist

/* Charging. It fires at full charge, not the moment the pose appears. */
const CHARGE_PRE_MS = 100;                       // quiet period: two or three misclassified frames never reach the planet
const CHARGE_MS     = { fist:700, palm:600 };    // the foil is slightly shorter: it has no charge to show, so a long wait feels stuck
const V_CHARGE = 0.30, V_PAUSE = 0.60;           // palm speed (normalized units/s): below the first the charge advances, between them it pauses, above the second it aborts
const V_FAST   = 0.80;                           // raw (unfiltered) speed above this disarms: after a fast movement you must go still again to have a weapon

/* Arming / starting a spin / dropped frames. All timing runs on an internal clock (accumulated per
   frame, each step capped at 100ms):
   not frame counts - in a dim room the camera drops to 15fps and every frame-counted timer doubles;
   and not raw performance.now() deltas either - switching away from the tab and back jumps several
   seconds, firing a held fist on the spot. */
const REARM_MS = 300, COOL_MS = 250, LOCK_MS = 1000;   // relaxed and still for 300ms plus a cooldown before rearming; interrupt() locks for 1s
const GRAB_SUPPRESS_MS = 250;                    // no spin right after a weapon pose ends: the transition frames read as None, and None means spin
const GRACE_MS = 100;                            // tracking loss shorter than this leaves charge and arming untouched, riding out a few dropped frames
const FLICK_MS = 600, SETTLE_MS = 150;           // returning within 600ms of flicking out of frame: 150ms still counts as "catching" it, otherwise let it keep spinning

/* Palm filtering: One-Euro. The cutoff rises with speed - 1.2Hz at rest filters the shake away, and
   a sweep pushes the cutoff up for near-zero latency. A fixed-ratio EMA has only one knob: tight
   enough to kill the jitter means too slow to follow the hand.
   beta is in Hz per (unit/s): the 0.02-0.05 in the literature is tuned for pixel speeds, and these
   coordinates are normalized (roughly 1/640), so about 20 is the same thing. */
const PALM_MIN_CUTOFF = 1.2, PALM_BETA = 20, PALM_D_CUTOFF = 1.0;
const VEL_TAU = 0.06;                            // the speed used for thresholds gets its own short low-pass; the filter's own 1Hz derivative lags too much

/* Clap (only while the verdict is up). Distances are normalized by hand length (wrist 0 -> middle
   knuckle 9), so it holds at any distance from the camera.
   A clap is a motion, not a pose: the hands must have been apart and then come together fast enough;
   two hands simply resting together never trigger it.
   Classes are ignored - a clap facing the camera is edge-on, and Open_Palm's score collapses at the
   moment the hands meet. */
const CLAP_FAR = 2.2, CLAP_FAR_MS = 500;         // must have been this far apart within the last 500ms
const CLAP_NEAR = 1.1, CLAP_V = 4.0;             // closing to within about one hand length at >= 4 hand lengths/s (two frames in a row, or one frame at >= 2x)
const CLAP_LOSS_D = 1.9, CLAP_LOSS_MS = 120;     // a hand disappears mid-close (they often occlude each other as they meet): near enough on the previous frame still counts
const CLAP_OPEN = 1.55;                          // mean fingertip-to-wrist distance / hand length (open is about 1.8-2.0, a fist about 1.0)
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

// Two-hand geometry. Normalized coordinates are anisotropic (4:3 by default), so x is scaled by the aspect ratio before measuring distance.
const dist = (a, b, asp) => Math.hypot((a.x - b.x) * asp, a.y - b.y);
const handSize = (lm, asp) => dist(lm[0], lm[9], asp);
/* Soft geometric scores for pointing / the V sign (a pure function, so it can be tested).
   Fingertip-to-wrist distances are normalized by hand length (wrist -> middle knuckle). */
export function poseScores(lm, asp){
  const size = Math.max(1e-4, handSize(lm, asp));
  const ext = i => dist(lm[i], lm[0], asp) / size;
  const up = e => sstep(EXT_UP[0], EXT_UP[1], e), down = e => 1 - sstep(EXT_DOWN[0], EXT_DOWN[1], e);
  const e8 = ext(8), e12 = ext(12), e16 = ext(16), e20 = ext(20);
  const point    = up(e8) * down(e12) * down(e16) * down(e20);
  const victoryH = up(e8) * up(e12)   * down(e16) * down(e20);
  const lead = Math.min(e8, e12), trail = Math.max(e16, e20);
  const victoryR = sstep(V_LEAD[0], V_LEAD[1], lead) * sstep(V_RATIO[0], V_RATIO[1], lead / Math.max(1e-4, trail));
  return { point, victory:Math.max(victoryH, victoryR) };
}
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
const fingersUp = lm => lm[12].y < lm[0].y;   // image y points down

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
    this.mode = 'observe';   // 'observe' | 'survive': survival has no spin, and pointing / V become the crosshair

    this.rec = null;
    this.stream = null;
    this.running = false;
    this.lastVideoTime = -1;
    this.lastNow = 0;
    this.clock = 0;          // internal clock (ms), see the note above
    this.dtMs = 0;
    this.errN = 0;

    this.wantClap = false;   // set by main.js; true while the verdict is up
    this.numHands = 1;
    this.switching = false;

    this.fx = new OneEuro(PALM_MIN_CUTOFF, PALM_BETA, PALM_D_CUTOFF);
    this.fy = new OneEuro(PALM_MIN_CUTOFF, PALM_BETA, PALM_D_CUTOFF);
    this.p = null;           // filtered palm center
    this.vel = 0;            // palm speed after the short low-pass, used for the stillness test
    this.vRaw = 0;           // raw speed, used for the fast-movement test
    this.anchor = null;      // reference point for a spin
    this.tx = new OneEuro(TIP_MIN_CUTOFF, TIP_BETA, TIP_D_CUTOFF);   // the fingertip gets its own filter pair rather than sharing the palm's:
    this.ty = new OneEuro(TIP_MIN_CUTOFF, TIP_BETA, TIP_D_CUTOFF);   // the palm judges speed, the fingertip is the crosshair
    this.aiming = false;

    this._toNoHand();
    this.armed = false;
    this.seenT = -Infinity; this.idleT = 0; this.weaponEndT = -Infinity;
    this.firedT = -Infinity; this.lockUntil = 0;
    this.lostT = -Infinity; this.lostV = 0;
    this._resetClap();
    this.clapT = -Infinity;  // the cooldown survives a mode switch
  }

  async start(){
    if(!window.isSecureContext){
      this.onState('HTTPS required', 'err');
      throw new Error('getUserMedia needs a secure context (HTTPS or localhost)');
    }
    if(!navigator.mediaDevices?.getUserMedia){
      this.onState('Unsupported', 'err');
      throw new Error('This browser has no getUserMedia');
    }

    this.onState('Loading model…');
    const fileset = await FilesetResolver.forVisionTasks('./vendor/wasm');
    const hands = this.wantClap ? 2 : 1;   // the camera may have been turned on after the verdict already appeared
    this.rec = await GestureRecognizer.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: './models/gesture_recognizer.task', delegate: 'GPU' },
      runningMode: 'VIDEO',
      numHands: hands,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.6
    });
    this.numHands = hands;

    this.onState('Requesting camera…');
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
    this.onState('Standby', 'live');
    this._applyHands();      // wantClap may have changed again while the model was loading
    this._loop();
  }

  stop(){
    this.running = false;
    this.interrupt();
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    const rec = this.rec; this.rec = null;
    try{ rec?.close?.(); }catch{}   // start() builds a new recognizer each time; without this, every camera toggle leaks one
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this._toNoHand();
    this.onState('Off');
  }

  /* Interrupt from outside: next specimen, reset, verdict appearing. End any spin, cancel the charge,
     disarm and lock for 1s - the fist is usually still clenched when the specimen changes, and
     without this it lands on the new one 0.3s later. */
  interrupt(){
    this._abandon();
    this.armed = false;
    this.lockUntil = this.clock + LOCK_MS;
    this.lostT = -Infinity;
    this._resetClap();
  }

  /* Survival mode: no spin, weapons unchanged, pointing / V become the crosshair. Switching
     interrupts - there is usually still a pose on the hand at that moment. */
  setMode(m){
    if(m === this.mode) return;
    this.mode = m;
    this.interrupt();
  }

  /* While the verdict is up only claps matter, so switch to two hands. Otherwise track one hand -
     half the compute, and no second hand competing for the planet. */
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
    this.onState('Switching…', 'live');
    try{
      // Without baseOptions this rebuilds the graph synchronously, but it is still handled as a
      // promise. numHands is written unconditionally in this bundle (t.numHands ?? 1), so it has to
      // be passed explicitly - otherwise setOptions({}) quietly falls back to one hand.
      await rec.setOptions({ numHands: want });
    }catch(e){
      console.warn('[gesture] setOptions failed, staying in one-hand mode', e);
      this.switching = false;
      return;
    }
    this.switching = false;
    if(rec !== this.rec) return;       // stop()/start() swapped the recognizer mid-switch: discard this result
    this.numHands = want;
    this._resetClap();
    this._toNoHand();
    if((this.wantClap ? 2 : 1) !== this.numHands) this._applyHands();   // the target changed again during the switch
  }

  _loop(){
    if(!this.running) return;
    requestAnimationFrame(() => this._loop());
    if(this.switching || !this.rec) return;

    const vt = this.video.currentTime;
    if(vt === this.lastVideoTime) return;
    // Two clocks: the recognizer needs performance.now() (it must be monotonic within one image),
    // while filtering and speed need deltas of video.currentTime (the real sampling interval; wall
    // clock deltas beat against the camera's own cadence).
    const now = performance.now();
    this.dtMs = Math.min(100, now - this.lastNow);
    this.lastNow = now;
    this.clock += this.dtMs;
    const stall = this.lastVideoTime < 0 || vt - this.lastVideoTime > 0.15;   // first frame, throttled tab, or a stalled camera
    const dt = Math.min(0.1, Math.max(1 / 60, vt - this.lastVideoTime));
    this.lastVideoTime = vt;

    let res;
    try{
      res = this.rec.recognizeForVideo(this.video, now);
      this.errN = 0;
    }catch(e){
      this._abandon();
      if(++this.errN >= 30){
        console.error('[gesture] recognizer keeps failing', e);
        this.stop();
        this.onState('Recognizer error', 'err');
      }
      return;
    }

    const hands = res?.landmarks ?? [];
    this._draw(hands);
    if(this.numHands === 2) this._clap(hands, dt);
    else if(this.mode === 'survive') this._stepSurvive(res, hands[0] ?? null, dt, stall);
    else this._step(res, hands[0] ?? null, dt, stall);
  }

  /* -- One-hand state machine -- */
  _step(res, lm, dt, stall){
    if(!lm){
      if(this.st === 'grab'){                        // let go at once and hand the inertia to the stage
        this.onDrag('end');
        this.lostT = this.clock; this.lostV = this.vel;
        this.st = 'idle';
      }
      this._resetPalm();                             // position filtering must not span dropped frames: it would emit one huge jump on return
      if(this.clock - this.seenT < GRACE_MS) return; // brief loss: charge timing and armed state are preserved
      if(this.st === 'charge' && this.k > 0) this.onCharge(this.kind, 0);
      this._toNoHand();                              // leaving the frame is a pause, not a rearm
      this.onState('Standby', 'live');
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
        if(this.cls && this.vel < V_PAUSE){          // a still weapon pose
          if(!this.armed) this.onState('Cooldown', 'live');
          else if(!this.canFire()) this.onState('Unavailable', 'live');
          else {
            this.st = 'charge'; this.kind = this.cls;
            this.chargeT = this.clock; this.k = 0; this.pausedMs = 0;
            this.onState(`${label} charging 0%`, 'live');
          }
          break;
        }
        // A moving hand is always a spin, whatever its shape
        if(this.clock - this.weaponEndT < GRAB_SUPPRESS_MS){ this.onState(this.armed ? 'Standby' : 'Cooldown', 'live'); break; }
        if(this.clock - this.lostT < FLICK_MS && this.lostV > V_FAST){   // back after flicking out of frame
          if(this.vRaw > V_FAST) this._beginDrag();                     // a new sweep: grab straight away (clearing speed is harmless, the hand is moving)
          else if(still){                                               // gone still: this is a deliberate catch
            if(this.settleT < 0) this.settleT = this.clock;
            if(this.clock - this.settleT >= SETTLE_MS) this._beginDrag();
            else this.onState('Standby', 'live');
          }else{ this.settleT = -1; this.onState('Standby', 'live'); }     // a drifting hand: let the planet keep spinning
          break;
        }
        this._beginDrag();
        break;
      }
      case 'grab': {
        // Spin has priority: a weapon pose appearing mid-spin only counts once the hand slows down
        if(this.cls && this.vel < V_PAUSE){
          this.onDrag('end'); this.weaponEndT = this.clock; this.st = 'idle';
          this.onState(`${label} hold still`, 'live');
          break;
        }
        if(!seeded){
          const dx = this.p.x - this.anchor.x, dy = this.p.y - this.anchor.y;
          if(Math.abs(dx) > DEAD_ZONE || Math.abs(dy) > DEAD_ZONE) this.onDrag('move', dx * DRAG_PX_X, dy * DRAG_PX_Y);
        }
        this.anchor = this.p;
        this.onState('Spinning', 'live');
        break;
      }
      case 'charge': this._stepCharge(s[this.kind] ?? 0, label); break;
      case 'fired':  this._stepFired(idle, label); break;
    }
  }

  // The charge and fired states are identical in observe and survival mode, so they are shared
  _stepCharge(score, label){
    if(this.cls !== this.kind || this.vel >= V_PAUSE){   // released, or the hand is moving: abort
      if(this.k > 0) this.onCharge(this.kind, 0);
      this.k = 0; this.weaponEndT = this.clock; this.st = 'idle';
      // Aborting also disarms: opening a fist into a palm and holding still shouldn't become a foil strike 0.6s later
      this.armed = false;
      this.onState('Cooldown', 'live');
      return;
    }
    // Score dipped into the hysteresis band, or the hand twitched: pause, neither advancing nor
    // aborting. Aborting waits for the exit to be confirmed - otherwise releasing at 85% would be
    // carried to 100% by that 120ms exit delay.
    if(score < EXIT_SCORE || this.vel >= V_CHARGE){
      this.pausedMs += this.dtMs;
      this.onState(`${label} hold still`, 'live');
      return;
    }
    this.k = clamp01((this.clock - this.chargeT - CHARGE_PRE_MS - this.pausedMs) / CHARGE_MS[this.kind]);
    this.onCharge(this.kind, this.k);
    if(this.k >= 1){
      this.armed = false; this.firedT = this.clock; this.st = 'fired';
      this.onGesture(this.kind);
      this.onState(`${label} fired`, 'live');
    }else{
      this.onState(`${label} charging ${Math.round(this.k * 20) * 5}%`, 'live');
    }
  }
  _stepFired(idle, label){                            // must relax before returning to idle
    if(idle){
      this.onCharge(this.kind, 0); this.k = 0;
      this.weaponEndT = this.clock; this.st = 'idle';
      this.onState('Cooldown', 'live');
    }else this.onState(`${label} fired`, 'live');
  }

  /* -- One-hand state machine for survival mode: no grab; pointing / V drive the crosshair,
        weapons unchanged -- */
  _stepSurvive(res, lm, dt, stall){
    if(!lm){
      this._aimOff();                                  // drop the crosshair at once: no hand, no target
      this._resetPalm(); this._resetTip();
      if(this.clock - this.seenT < GRACE_MS) return;   // brief loss: charge and armed state are preserved
      if(this.st === 'charge' && this.k > 0) this.onCharge(this.kind, 0);
      this._toNoHand();
      this.onState('Standby', 'live');
      return;
    }

    this.seenT = this.clock;
    this._palm(lm, dt, stall);                         // palm speed is still the only judge of "still"
    const tip = this._tip(lm, dt, stall);              // viewport coordinates: mirrored, gained and clamped to [0,1]
    const cats = res?.gestures?.[0] ?? [];
    const S = n => cats.find(c => c.categoryName === n)?.score ?? 0;
    const atEdge = PALM_IDX.some(i => lm[i].x < EDGE || lm[i].x > 1 - EDGE || lm[i].y < EDGE || lm[i].y > 1 - EDGE);

    // Geometric tests (soft scores)
    const asp = this.canvas.width / this.canvas.height;
    const { point:pointH, victory:victoryH } = poseScores(lm, asp);

    // Raw weapon scores: gated at the frame edge, and a hand with an extended index finger is not a
    // fist (a confident geometric test suppresses Closed_Fist, so a pointing hand never fires however fist-like it reads)
    const fistS = atEdge || pointH > 0.5 || victoryH > 0.5 ? 0 : S('Closed_Fist'), palmS = atEdge ? 0 : S('Open_Palm');
    // Scores used for classification: a moving hand issues no commands (already true in observe mode)
    // but may still aim.
    // Without this gate, a fast sideways point gets read as Closed_Fist on the motion-blurred frames
    // and the crosshair drops out.
    const moving = this.vel >= V_PAUSE;
    const s = { fist: moving ? 0 : fistS, palm: moving ? 0 : palmS,
                point: Math.max(S('Pointing_Up'), pointH), victory: Math.max(S('Victory'), victoryH) };
    if(Math.max(s.fist, s.palm) >= ENTER_SCORE) s.point = s.victory = 0;   // weapons win (and at this point they are necessarily still and confident)
    this._classify(s);

    // Arming: 300ms of stillness is enough, with no "relax first" requirement - in survival the hand
    // is aiming the whole time and then closes into a fist directly, so demanding 300ms of a neutral
    // pose first would leave the fist stuck on "Cooldown" forever.
    // V_FAST disarming only affects weapons; aiming never looks at armed / lockUntil.
    const idle  = !atEdge;
    const still = this.vel < V_CHARGE;
    if(this.st === 'nohand'){ this.st = 'idle'; this.armed = false; this.idleT = this.clock; }
    if(this.vRaw >= V_FAST) this.armed = false;
    if(!(idle && still)) this.idleT = this.clock;
    else if(!this.armed && this.clock - this.idleT >= REARM_MS
            && this.clock - this.firedT >= COOL_MS && this.clock >= this.lockUntil) this.armed = true;

    const label = LABEL[this.cls] ?? LABEL[this.kind] ?? '';
    switch(this.st){
      case 'idle': {
        if(CLASS[this.cls]?.weapon && this.vel < V_PAUSE){   // a still weapon pose: the same three-way branch as _step
          this._aimOff();
          if(!this.armed) this.onState('Cooldown', 'live');
          else if(!this.canFire()) this.onState('Unavailable', 'live');
          else {
            this.st = 'charge'; this.kind = this.cls;
            this.chargeT = this.clock; this.k = 0; this.pausedMs = 0;
            this.onState(`${label} charging 0%`, 'live');
          }
          break;
        }
        // Aiming. Only emit a crosshair while the class score is still above the exit line; during
        // the 120ms inside the hysteresis band, emit null - otherwise a V released at 0.35s would be
        // carried to 0.45s by the hysteresis and drop a shield nobody asked for (the same trap as
        // releasing a charge at 85%).
        if((this.cls === 'point' || this.cls === 'victory') && s[this.cls] >= EXIT_SCORE){
          this._aimOn(tip.x, tip.y, this.cls);
          this.onState(AIM_LABEL[this.cls], 'live');
        }else{
          this._aimOff();
          this.onState(this.armed ? 'Standby' : 'Cooldown', 'live');
        }
        break;
      }
      case 'grab': this.st = 'idle'; break;             // left over from a mode switch: survival has no spin
      case 'charge': this._aimOff(); this._stepCharge(s[this.kind] ?? 0, label); break;
      case 'fired':  this._aimOff(); this._stepFired(idle, label); break;
    }
  }

  _aimOn(x, y, pose){ this.aiming = true; this.onAim(x, y, pose); }
  _aimOff(){ if(!this.aiming) return; this.aiming = false; this.onAim(null); }   // deduplicated: null is emitted once
  _resetTip(){ this.tx.reset(); this.ty.reset(); }
  _tip(lm, dt, stall){
    if(stall) this._resetTip();
    const x = this.tx.filter(lm[8].x, dt), y = this.ty.filter(lm[8].y, dt);
    return this._toView(1 - x, y);                    // mirror: the preview is scaleX(-1), so a hand pointing right sits left in raw coordinates
  }
  /* Fingertip -> viewport. The camera frame is 4:3 and the viewport is anything; the y gain is
     corrected by (viewport / camera) aspect so a circle drawn by the hand stays a circle on screen.
     innerWidth/innerHeight is the right viewport here: #stage is a fixed canvas at inset:0, so the
     two are the same rectangle. */
  _toView(hx, hy){
    const vidAsp = (this.canvas.width || 4) / (this.canvas.height || 3);
    const gx = AIM_GAIN;
    const gy = Math.min(AIM_GAIN_MAX, Math.max(gx, gx * (innerWidth / innerHeight) / vidAsp));
    return { x:clamp01(0.5 + (hx - 0.5) * gx), y:clamp01(0.5 + (hy - 0.5) * gy) };
  }

  // s: the per-class score table (missing entries are 0). Entering takes the highest score at or
  // above ENTER; leaving requires EXIT_MS continuously below EXIT.
  _classify(s){
    if(this.cls){
      const cur = s[this.cls] ?? 0;
      if(cur >= EXIT_SCORE) this.exitMs = 0;
      else if((this.exitMs += this.dtMs) >= EXIT_MS) this._exitClass();
      // Weapons win: a confident weapon appearing during an aiming pose reclassifies immediately,
      // without waiting 120ms.
      // The caller has already gated weapon scores on stillness, so any weapon reaching here at or
      // above ENTER is necessarily both still and confident.
      if(this.cls && !CLASS[this.cls].weapon){
        const w = (s.fist ?? 0) >= (s.palm ?? 0) ? 'fist' : 'palm';
        if((s[w] ?? 0) >= ENTER_SCORE){ this.cls = w; this.exitMs = 0; }
        // Pointing <-> V also skips the 120ms: the current class has dropped out and the other is
        // confident, which is not a bad frame but a changed pose
        else if(cur < EXIT_SCORE){
          const o = this.cls === 'point' ? 'victory' : 'point';
          if((s[o] ?? 0) >= ENTER_SCORE){ this.cls = o; this.exitMs = 0; }
        }
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
    if(CLASS[was]?.weapon) this.weaponEndT = this.clock;   // only a weapon ending suppresses the start of a spin: the transition frames belong to it
  }

  _palm(lm, dt, stall){
    const c = palmCenter(lm);
    if(stall) this._resetPalm();
    const seeded = this.fx.x === null;
    const x = this.fx.filter(c.x, dt), y = this.fy.filter(c.y, dt);
    if(seeded){ this.p = { x, y }; this.vel = 0; this.vRaw = 0; return true; }   // the seeding frame emits no displacement
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
    this.onState('Spinning', 'live');
  }

  // End any spin, cancel the charge (firing whatever callbacks are due) and return to nohand.
  // Leaves armed and the locks alone.
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

  /* -- Two hands: the clap -- */
  _clap(hands, dt){
    this.onState('Clap for next specimen', 'live');
    if(this.clock - this.clapT < CLAP_COOL_MS){ this.clapPrev = null; this.closingN = 0; return; }
    if(hands.length < 2){
      const prev = this.clapPrev;
      this.clapPrev = null; this.closingN = 0;
      // Just closed fast and then lost a hand: as they meet, one usually occludes the other
      if(prev && prev.closing && prev.d < CLAP_LOSS_D && this.clock - prev.t < CLAP_LOSS_MS && this._farRecent()) this._fireClap();
      return;
    }
    const [a, b] = hands;                            // the order varies between frames: everything below is symmetric and never reads the handedness label
    const asp = this.canvas.width / this.canvas.height;
    const sa = handSize(a, asp), sb = handSize(b, asp);
    const sMin = Math.min(sa, sb), sMax = Math.max(sa, sb), s = (sa + sb) / 2;
    const d = dist(palmCenter(a), palmCenter(b), asp) / s;
    if(d >= CLAP_FAR) this.farT = this.clock;
    const open = isOpen(a, sa, asp) && isOpen(b, sb, asp) && fingersUp(a) && fingersUp(b);

    const prev = this.clapPrev;
    const jump = prev && (Math.abs(sMin - prev.sMin) > 0.4 * prev.sMin || Math.abs(sMax - prev.sMax) > 0.4 * prev.sMax);
    const vA = prev && !jump ? (prev.d - d) / dt : 0;   // hand lengths per second, positive = closing
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
