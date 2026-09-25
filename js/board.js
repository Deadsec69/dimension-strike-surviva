// Survival scoring - snapshot, submit, portrait, and the observer board
//
// The server only exists locally in serve.py; on GitHub Pages every fetch 404s. Swallow them all
// and carry on: the verdict still appears, the portrait degrades to the raw snapshot tinted by tier,
// and the board lives only in this page's memory.
// The snapshot is taken on the frame the run ends (inside fire()), not when the verdict appears:
// the verdict waits out a 2.7s shatter animation, and by then the reaction has left the face.

/* Tiers (kept in sync with serve.py). Score comes only from asteroids: 5 for a kill, 2 for a block,
   and burn-through keeps it all. Firing a weapon yourself (fist / open palm) = DEVIL at any score -
   even at a god's score, the moment you act you are the devil.
   If the planet dies before you do: >=250 GOD, >=100 DEMIGOD, otherwise HUMAN. */
export const GOD_SCORE = 250, DEMIGOD_SCORE = 100;
export const TIER_EN = { devil:'DEVIL', human:'HUMAN', demigod:'DEMIGOD', god:'GOD' };
const PROBE_MS = 8000, FINISH_MS = 20000;               // scoring returns immediately (the score banks first); the portrait generates in the background and we poll
const POLL_MS = 3000, POLL_MAX_MS = 20 * 60000;        // Gemini has measurably taken over ten minutes when slow: poll for twenty, then call it failed
const BOARD_REFRESH_MS = 10000;                        // while any row is still generating, refresh every 10s
const tmo = ms => AbortSignal.timeout(ms);

export function tierOf(ending, score){
  if(ending === 'self') return 'devil';
  return score >= GOD_SCORE ? 'god' : score >= DEMIGOD_SCORE ? 'demigod' : 'human';
}

/* Grab a 640x480 JPEG (plain base64) from the live <video>. The panel shows it mirrored with
   scaleX(-1), so the photo is mirrored too - that is the face they actually saw.
   No stream / not ready -> null. */
export function captureSnapshot(video){
  if(!video?.srcObject || video.readyState < 2 || !video.videoWidth) return null;
  const W = 640, H = 480, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const s = Math.max(W / video.videoWidth, H / video.videoHeight);       // same crop as object-fit:cover
  const w = video.videoWidth * s, h = video.videoHeight * s;
  ctx.translate(W, 0); ctx.scale(-1, 1);
  ctx.drawImage(video, (W - w) / 2, (H - h) / 2, w, h);
  try{ return c.toDataURL('image/jpeg', 0.85).split(',')[1]; }catch{ return null; }
}

export class Board {
  constructor(el){
    this.el = el;                     // { userName, portrait, portraitImg, portraitMeta, board }
    this.online = null;               // null = not probed yet; fixed once probed
    this.hasKey = false;
    this.rows = []; this.local = []; this.run = null; this.seq = 0;
    this.capture = captureSnapshot;   // swappable for headless tests: __ds.board.capture = () => B64
    // Clearing takes two clicks: the first arms it (CONFIRM?), a second within 4s does it. No confirm():
    // that dialog belongs to the browser, not to this console.
    // Two entry points: the small label beside the board title, and the button in the modal.
    this._wireClear(this.el.boardClear, 'CLEAR', 'CONFIRM?');
    this._wireClear(this.el.boardClearModal, 'Clear board', 'Click again to confirm');
    this._wireModal();
  }
  _wireClear(btn, idle, armed){
    if(!btn) return;
    btn.addEventListener('click', () => {
      if(btn.classList.contains('is-arm')){ this._disarm(); this.clearBoard(); this.closeModal(); return; }
      this._disarm();
      btn.classList.add('is-arm'); btn.textContent = armed;
      this._armT = setTimeout(() => this._disarm(), 4000);
    });
    (this._clearBtns ??= []).push([btn, idle]);
  }
  _disarm(){ clearTimeout(this._armT); for(const [btn, idle] of this._clearBtns || []){ btn.classList.remove('is-arm'); btn.textContent = idle; } }

  /* -- Full-board modal: opens on the title or any row; closes on Esc / backdrop / Close;
        Export CSV downloads the current board -- */
  _wireModal(){
    const { boardTitle, board, boardModal, boardClose, boardCsv, boardClear } = this.el;
    if(!boardModal) return;
    if(boardClear) boardClear.addEventListener('click', e => e.stopPropagation());   // the clear button must not open the modal
    boardTitle?.addEventListener('click', () => this.openModal());
    board?.addEventListener('click', e => { if(!e.target.closest('a')) this.openModal(); });   // thumbnails still open the portrait
    boardClose?.addEventListener('click', () => this.closeModal());
    boardModal.addEventListener('click', e => { if(e.target === boardModal) this.closeModal(); });
    document.addEventListener('keydown', e => { if(e.key === 'Escape' && !boardModal.hidden) this.closeModal(); });
    boardCsv?.addEventListener('click', () => this.exportCsv());
  }
  openModal(){
    const { boardModal, boardRows, modalCount } = this.el;
    const rows = this._sorted(), me = this.run?.entry;
    modalCount.textContent = `${rows.length} ${rows.length === 1 ? 'OBSERVER' : 'OBSERVERS'}`;
    boardRows.replaceChildren(...rows.map((e, i) => {
      const tr = document.createElement('tr');
      if(me && e.username === me.username) tr.className = 'is-me';
      const td = (txt, cls) => { const d = document.createElement('td'); if(cls) d.className = cls; d.textContent = txt; return d; };
      const th = document.createElement('td');
      if(e.portrait){ const a = document.createElement('a'); a.className = `thumb is-${e.tier}`; a.href = e.portrait; a.target = '_blank'; a.rel = 'noopener';
        const img = new Image(); img.src = e.portrait; img.alt = ''; a.appendChild(img); th.appendChild(a); }
      tr.append(td(String(i + 1).padStart(2, '0')), th, td(e.username, 'name'), td(TIER_EN[e.tier] || '', `tier is-${e.tier}`),
                td(Number(e.score || 0).toLocaleString('en-US'), 'r score'), td(e.kills ?? '', 'r'), td(e.blocks ?? '', 'r'),
                td(e.elapsed != null ? e.elapsed + 's' : '', 'r'), td(e.ending === 'self' ? 'crushed it' : e.ending === 'heat' ? 'burn-through' : ''),
                td(e.emotion || ''), td(e.runs ?? 1, 'r'), td((e.ts || '').replace('T', ' ').slice(0, 16)));
      return tr;
    }));
    boardModal.hidden = false;
  }
  closeModal(){ if(this.el.boardModal) this.el.boardModal.hidden = true; }
  exportCsv(){
    const rows = this._sorted();
    const cols = ['rank', 'username', 'tier', 'score', 'kills', 'blocks', 'elapsed_s', 'ending', 'emotion', 'runs', 'date', 'portrait'];
    const q = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [cols.join(',')].concat(rows.map((e, i) => [i + 1, e.username, TIER_EN[e.tier] || e.tier, e.score, e.kills, e.blocks, e.elapsed, e.ending, e.emotion,
      e.runs ?? 1, e.ts, e.portrait ? new URL(e.portrait, location.href).href : ''].map(q).join(',')));
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type:'text/csv;charset=utf-8' });   // BOM so Excel reads it as UTF-8 without asking
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    const d = new Date(), pad = n => String(n).padStart(2, '0');
    a.download = `observer-board-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.csv`;   // local date, not UTC
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /* Keep only each callsign's best run (the server already does this; local rows are merged here
     as well) and sort by score. */
  _sorted(){
    const best = new Map();
    for(const e of [...this.rows, ...this.local].sort((a, b) => b.score - a.score || (a.ts < b.ts ? -1 : 1))){
      const k = String(e.username || '').toLowerCase();
      const b = best.get(k);
      if(!b) best.set(k, { ...e, runs:e.runs ?? 1 });
      else if(!e.runs) b.runs = (b.runs || 1) + 1;   // server rows carry their own runs count; local rows are tallied by hand
    }
    return [...best.values()].sort((a, b) => b.score - a.score || (a.ts < b.ts ? -1 : 1));
  }

  /* Clear the board: rows and portrait files go together on the server; with no server, only this
     page's rows are cleared. */
  async clearBoard(){
    try{
      const r = await fetch('api/leaderboard/clear', { method:'POST', signal:tmo(FINISH_MS) });
      if(r.ok) this.rows = [];
      else console.warn('[board] clear →', r.status);
    }catch(e){ console.warn('[board] clear failed:', e.message); }
    this.local = [];
    this.render(this.run?.entry); this._toggle();
  }

  username(){
    const v = (this.el.userName?.value || '').trim() || localStorage.getItem('ds.username') || 'observer';
    return v.slice(0, 16);
  }

  /* Callsigns are unique: a name already on the board can't be reused - except the one this browser
     last played under (that's you, and you may keep adding runs to your own row).
     "Played" is recorded in ds.played at the moment a run is submitted, not from the input field:
     merely typing someone else's name doesn't claim it. */
  isTaken(name){
    const k = String(name || '').trim().toLowerCase();
    if(!k) return false;
    let mine = ''; try{ mine = (localStorage.getItem('ds.played') || '').toLowerCase(); }catch{}
    if(k === mine) return false;
    return [...this.rows, ...this.local].some(e => String(e.username || '').toLowerCase() === k);
  }

  async probe(){                      // probe once when entering survival mode
    try{
      const r = await fetch('api/health', { cache:'no-store', signal:tmo(PROBE_MS) });
      const j = r.ok ? await r.json() : null;            // Pages returns 404 HTML: check ok before parsing json
      this.online = !!j?.ok; this.hasKey = !!j?.hasKey;
    }catch{ this.online = false; }
    this._toggle();
    if(this.online) await this.refresh();
    return this.online;
  }

  async refresh(){
    try{
      const r = await fetch('api/leaderboard?limit=50', { cache:'no-store', signal:tmo(PROBE_MS) });   // list everything, scrollable: capped at eight, a 20-point run looks like it was never saved
      if(r.ok) this.rows = (await r.json()).leaderboard || [];
    }catch{}
    this._toggle(); this.render(this.run?.entry);
    // Rows whose portrait is still generating (possibly left over from an earlier session): check back shortly
    clearTimeout(this._refreshT);
    if(this.rows.some(e => e.pending)) this._refreshT = setTimeout(() => this.refresh(), BOARD_REFRESH_MS);
  }

  /* Called on the frame fire() runs: snapshot, fix the tier, submit immediately. The verdict appears
     2.7s later and reads run.state at that point. */
  endRun({ ending, snapshot, score, kills, blocks = 0, elapsed }){
    const run = this.run = {
      id:++this.seq, username:this.username(), ending, tier:tierOf(ending, score),
      score, kills, blocks, elapsed:+elapsed.toFixed(1), snapshot, state:'pending', entry:null
    };
    try{ localStorage.setItem('ds.played', run.username); }catch{}   // this name is yours from now on
    this._submit(run);                // not awaited
    return run;
  }

  async _submit(run){
    const payload = { username:run.username, score:run.score, kills:run.kills, blocks:run.blocks, elapsed:run.elapsed,
                      ending:run.ending, tier:run.tier, snapshot:run.snapshot };
    try{
      // Ignore this.online: a slow probe shouldn't waste a whole run. With no server at all (Pages)
      // this 404s immediately and falls back the same way.
      const r = await fetch('api/finish', { method:'POST', headers:{ 'Content-Type':'application/json' },
                                            body:JSON.stringify(payload), signal:tmo(FINISH_MS) });
      if(!r.ok) throw new Error('finish → ' + r.status);
      const j = await r.json();
      run.entry = j.entry; run.state = j.entry.pending ? 'generating' : 'done'; this.online = true;
      if(j.leaderboard) this.rows = j.leaderboard;
      this.refresh();                 // finish() only returns the top ten; refetch the whole board so your row is definitely in it
      if(j.warnings?.length) console.warn('[run] degraded:', j.warnings);
      if(run.state === 'generating') this._poll(run);
    }catch(e){                        // no server / timeout / 5xx: raw snapshot plus a local row, nothing written to disk
      console.warn('[run] local fallback:', e.message);
      run.state = 'failed'; run.error = e.message;
      run.entry = { username:run.username, score:run.score, kills:run.kills, blocks:run.blocks, elapsed:run.elapsed, ending:run.ending,
                    tier:run.tier, portrait:null, emotion:null, emotion_zh:null,
                    ts:new Date().toISOString(), local:true, id:'local-' + run.id };
      this.local.push(run.entry);
    }
    this._toggle();
    this._paintVerdict(run);
    this.render(run.entry);
  }

  /* The portrait generates in the background on the server: ask every 3s and swap it in when it lands.
     Even if the player has already started another run, the board thumbnail still fills in. */
  async _poll(run){
    const t0 = performance.now();
    while(performance.now() - t0 < POLL_MAX_MS){
      await new Promise(r => setTimeout(r, POLL_MS));
      try{
        const r = await fetch('api/run/' + encodeURIComponent(run.entry.id), { cache:'no-store', signal:tmo(PROBE_MS) });
        if(!r.ok) continue;
        const e = (await r.json()).entry;
        if(!e || e.pending) continue;
        run.entry = e; run.state = 'done';
        if(e.warnings?.length) console.warn('[run] portrait degraded:', e.warnings);
        this._paintVerdict(run);
        await this.refresh(); this.render(run.entry);
        return;
      }catch{}
    }
    run.state = 'done'; run.entry.pending = false; run.entry.timeout = true;
    this._paintVerdict(run);
  }

  showVerdict(){ this._paintVerdict(this.run); }       // called by main.showVerdict(); run is null outside survival

  clear(){                                             // next specimen / exit / restart: drop this run; late responses
                                                       // then only refresh the board, they don't paint a portrait
    this.run = null;
    const { portrait, portraitImg, portraitMeta } = this.el;
    portrait.className = 'portrait'; portrait.removeAttribute('href');
    portraitImg.removeAttribute('src'); portraitMeta.textContent = '';
  }

  _paintVerdict(run){
    const { portrait, portraitImg, portraitMeta } = this.el;
    if(!run || run !== this.run) return;
    portrait.className = `portrait is-on is-${run.tier}`;
    // Tier first, stated plainly on the scorecard: DEVIL / HUMAN / DEMIGOD / GOD
    const tierTag = () => { const b = document.createElement('b'); b.className = `tier is-${run.tier}`;
      b.textContent = `RANK ${TIER_EN[run.tier]}`; return b; };
    if(run.state === 'pending' || run.state === 'generating'){
      portrait.classList.add('is-wait');
      if(run.snapshot) portraitImg.src = 'data:image/jpeg;base64,' + run.snapshot;   // show the raw snapshot first, swap when the portrait lands
      portraitMeta.replaceChildren(tierTag(), document.createTextNode(run.state === 'pending' ? '\u2003Recording…' : '\u2003Generating portrait… (Gemini can take minutes)'));
      return;
    }
    const e = run.entry;
    if(e.portrait){ portraitImg.src = e.portrait; portrait.href = e.portrait; }
    else if(run.snapshot){                            // degraded: the raw snapshot, tinted by tier
      portraitImg.src = portrait.href = 'data:image/jpeg;base64,' + run.snapshot;
      portrait.classList.add('is-raw');
    }else portrait.classList.add('is-none');
    const why = e.local ? (run.error === 'offline' || /Failed to fetch|404/.test(run.error || '') ? '\u2003· server offline' : '\u2003· not saved')
              : (e.timeout ? '\u2003· portrait timed out' : (!e.portrait && e.warnings?.length ? '\u2003· portrait failed' : ''));
    portraitMeta.replaceChildren(tierTag(),
      document.createTextNode(`\u2003Mood ${e.emotion || 'unread'}` + why));
  }

  _toggle(){ document.body.classList.toggle('has-board', this.rows.length + this.local.length > 0); }   // an empty board takes no space

  render(me){
    const rows = this._sorted();
    this.el.board.replaceChildren(...rows.map((e, i) => {
      const li = document.createElement('li');
      li.className = (me && e.username === me.username ? 'is-me' : '') + (e.local ? ' is-local' : '');   // your row = your own best run
      const thumb = document.createElement(e.portrait ? 'a' : 'span');
      thumb.className = `thumb is-${e.tier}` + (e.pending ? ' is-pending' : '');
      if(e.pending) thumb.title = 'Generating portrait…';
      if(e.portrait){
        thumb.href = e.portrait; thumb.target = '_blank'; thumb.rel = 'noopener';
        const img = new Image(); img.src = e.portrait; img.alt = ''; thumb.appendChild(img);
      }
      const mk = (cls, txt, title) => { const s = document.createElement('span'); s.className = cls; s.textContent = txt; if(title) s.title = title; return s; };
      li.append(mk('rank', String(i + 1).padStart(2, '0')), thumb,
                mk('name', e.username, `${TIER_EN[e.tier] || ''} · ${e.emotion || ''} · ${e.elapsed}s · shot ${e.kills}` + (e.blocks != null ? ` · blocked ${e.blocks}` : '')),
                mk(`tag is-${e.tier}`, TIER_EN[e.tier] || ''),
                mk('score num', Number(e.score || 0).toLocaleString('en-US')));
      return li;
    }));
    const mine = this.el.board.querySelector('li.is-me');           // the run just finished: scroll it into view
    if(mine) mine.scrollIntoView({ block:'nearest' });
    this.onRows?.();
  }
}
