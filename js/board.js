// 生存模式结算 —— 抓拍、上报、画像与观测者榜
//
// 服务器只在本地 serve.py 里有；GitHub Pages 上每个 fetch 都 404，一律吞掉，流程照走：
// 判词照出，画像退成原片按档调色，榜单只活在本页内存里。
// 抓拍发生在一局结束的那一帧（fire() 里），不在判词那一刻：判词要等 2.7 秒的碎裂动画，
// 到那时脸上的反应已经散了。

/* 评级（与 serve.py 保持一致）。分只来自陨石：击落 5、拦下 2，烧穿也照算。
   自己按下武器（握拳 / 摊掌）= 魔，不管多少分——哪怕已经是神的分数，动手的那一刻就是魔。
   行星先你一步死去：≥250 神、≥100 半神、其余人。 */
export const GOD_SCORE = 250, DEMIGOD_SCORE = 100;
export const TIER_EN = { devil:'DEVIL', human:'HUMAN', demigod:'DEMIGOD', god:'GOD' };
const PROBE_MS = 8000, FINISH_MS = 20000;               // 结算立刻回（分先入账），画像在后台生成、这边轮询
const POLL_MS = 3000, POLL_MAX_MS = 20 * 60000;        // Gemini 慢起来实测要十分钟以上：轮询二十分钟，之后当失败
const BOARD_REFRESH_MS = 10000;                        // 榜上还有在生成的行时，每 10 秒刷一次
const tmo = ms => AbortSignal.timeout(ms);

export function tierOf(ending, score){
  if(ending === 'self') return 'devil';
  return score >= GOD_SCORE ? 'god' : score >= DEMIGOD_SCORE ? 'demigod' : 'human';
}

/* 从直播 <video> 抓一张 640×480 JPEG（纯 base64）。面板上是 scaleX(-1) 的镜像，
   照片也要镜像——那才是他自己看见的那张脸。无流 / 未就绪 → null。 */
export function captureSnapshot(video){
  if(!video?.srcObject || video.readyState < 2 || !video.videoWidth) return null;
  const W = 640, H = 480, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const s = Math.max(W / video.videoWidth, H / video.videoHeight);       // object-fit:cover 同款裁法
  const w = video.videoWidth * s, h = video.videoHeight * s;
  ctx.translate(W, 0); ctx.scale(-1, 1);
  ctx.drawImage(video, (W - w) / 2, (H - h) / 2, w, h);
  try{ return c.toDataURL('image/jpeg', 0.85).split(',')[1]; }catch{ return null; }
}

export class Board {
  constructor(el){
    this.el = el;                     // { userName, portrait, portraitImg, portraitMeta, board }
    this.online = null;               // null = 未探；探过一次就定
    this.hasKey = false;
    this.rows = []; this.local = []; this.run = null; this.seq = 0;
    this.capture = captureSnapshot;   // 无头测试可替换：__ds.board.capture = () => B64
    // 清榜要按两下：第一下举起来（CONFIRM?），4 秒内第二下才清。不用 confirm()：那是浏览器的弹窗，不是这台控制台的
    // 两个入口：榜标题右边的小字，和弹窗里的按钮
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

  /* ── 全榜弹窗：点标题或任一行打开；Esc / 背景 / Close 关；Export CSV 下载当前榜 ── */
  _wireModal(){
    const { boardTitle, board, boardModal, boardClose, boardCsv, boardClear } = this.el;
    if(!boardModal) return;
    if(boardClear) boardClear.addEventListener('click', e => e.stopPropagation());   // 清榜键不开弹窗
    boardTitle?.addEventListener('click', () => this.openModal());
    board?.addEventListener('click', e => { if(!e.target.closest('a')) this.openModal(); });   // 缩略图仍是打开画像
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
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type:'text/csv;charset=utf-8' });   // BOM：Excel 直接认 UTF-8
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    const d = new Date(), pad = n => String(n).padStart(2, '0');
    a.download = `observer-board-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.csv`;   // 本地日期，不是 UTC
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /* 每个代号只留最好的一局（服务器已经这么给；本地行在这里再并一次），按分排序 */
  _sorted(){
    const best = new Map();
    for(const e of [...this.rows, ...this.local].sort((a, b) => b.score - a.score || (a.ts < b.ts ? -1 : 1))){
      const k = String(e.username || '').toLowerCase();
      const b = best.get(k);
      if(!b) best.set(k, { ...e, runs:e.runs ?? 1 });
      else if(!e.runs) b.runs = (b.runs || 1) + 1;   // 服务器行自带 runs；本地行手工累加
    }
    return [...best.values()].sort((a, b) => b.score - a.score || (a.ts < b.ts ? -1 : 1));
  }

  /* 清榜：服务器上的行与画像文件一起删；没有服务器就只清本页的行 */
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

  async probe(){                      // 进生存模式时探一次
    try{
      const r = await fetch('api/health', { cache:'no-store', signal:tmo(PROBE_MS) });
      const j = r.ok ? await r.json() : null;            // Pages 回 404 HTML：先看 ok 再 json
      this.online = !!j?.ok; this.hasKey = !!j?.hasKey;
    }catch{ this.online = false; }
    this._toggle();
    if(this.online) await this.refresh();
    return this.online;
  }

  async refresh(){
    try{
      const r = await fetch('api/leaderboard?limit=50', { cache:'no-store', signal:tmo(PROBE_MS) });   // 全列出来、可滚动：只列前八的话，一局 20 分就像没存
      if(r.ok) this.rows = (await r.json()).leaderboard || [];
    }catch{}
    this._toggle(); this.render(this.run?.entry);
    // 榜上还有画像没生成完的行（也许是上一次会话留下的）：过会儿再来看
    clearTimeout(this._refreshT);
    if(this.rows.some(e => e.pending)) this._refreshT = setTimeout(() => this.refresh(), BOARD_REFRESH_MS);
  }

  /* fire() 那一刻调用：抓拍、定档、立刻上报。判词 2.7 秒后才出现，到时候看 run.state。 */
  endRun({ ending, snapshot, score, kills, blocks = 0, elapsed }){
    const run = this.run = {
      id:++this.seq, username:this.username(), ending, tier:tierOf(ending, score),
      score, kills, blocks, elapsed:+elapsed.toFixed(1), snapshot, state:'pending', entry:null
    };
    this._submit(run);                // 不 await
    return run;
  }

  async _submit(run){
    const payload = { username:run.username, score:run.score, kills:run.kills, blocks:run.blocks, elapsed:run.elapsed,
                      ending:run.ending, tier:run.tier, snapshot:run.snapshot };
    try{
      // 不看 online：探测超时不该让整局白抓。真没有服务器（Pages）这里会立刻 404，一样走降级
      const r = await fetch('api/finish', { method:'POST', headers:{ 'Content-Type':'application/json' },
                                            body:JSON.stringify(payload), signal:tmo(FINISH_MS) });
      if(!r.ok) throw new Error('finish → ' + r.status);
      const j = await r.json();
      run.entry = j.entry; run.state = j.entry.pending ? 'generating' : 'done'; this.online = true;
      if(j.leaderboard) this.rows = j.leaderboard;
      this.refresh();                 // 结算只回前十；整榜再拉一次，自己那行一定在
      if(j.warnings?.length) console.warn('[run] degraded:', j.warnings);
      if(run.state === 'generating') this._poll(run);
    }catch(e){                        // 服务器不在 / 超时 / 5xx：原片 + 本地行，不落盘
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

  /* 画像在服务器后台生成：每 3 秒问一次，到了就换上。哪怕玩家已经开了下一局，榜单上的缩略图也会补上。 */
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

  showVerdict(){ this._paintVerdict(this.run); }       // main.showVerdict() 调用；非生存局 run 为 null

  clear(){                                             // 换样本 / 退出 / 重开：丢掉本局；迟到的响应只刷榜不画像
    this.run = null;
    const { portrait, portraitImg, portraitMeta } = this.el;
    portrait.className = 'portrait'; portrait.removeAttribute('href');
    portraitImg.removeAttribute('src'); portraitMeta.textContent = '';
  }

  _paintVerdict(run){
    const { portrait, portraitImg, portraitMeta } = this.el;
    if(!run || run !== this.run) return;
    portrait.className = `portrait is-on is-${run.tier}`;
    // 评级先行，在计分卡上说清楚：DEVIL / HUMAN / DEMIGOD / GOD
    const tierTag = () => { const b = document.createElement('b'); b.className = `tier is-${run.tier}`;
      b.textContent = `RANK ${TIER_EN[run.tier]}`; return b; };
    if(run.state === 'pending' || run.state === 'generating'){
      portrait.classList.add('is-wait');
      if(run.snapshot) portraitImg.src = 'data:image/jpeg;base64,' + run.snapshot;   // 先垫原片，画像到了再换
      portraitMeta.replaceChildren(tierTag(), document.createTextNode(run.state === 'pending' ? '\u2003Recording…' : '\u2003Generating portrait… (Gemini can take minutes)'));
      return;
    }
    const e = run.entry;
    if(e.portrait){ portraitImg.src = e.portrait; portrait.href = e.portrait; }
    else if(run.snapshot){                            // 降级：原片，按档调色
      portraitImg.src = portrait.href = 'data:image/jpeg;base64,' + run.snapshot;
      portrait.classList.add('is-raw');
    }else portrait.classList.add('is-none');
    const why = e.local ? (run.error === 'offline' || /Failed to fetch|404/.test(run.error || '') ? '\u2003· server offline' : '\u2003· not saved')
              : (e.timeout ? '\u2003· portrait timed out' : (!e.portrait && e.warnings?.length ? '\u2003· portrait failed' : ''));
    portraitMeta.replaceChildren(tierTag(),
      document.createTextNode(`\u2003Mood ${e.emotion || 'unread'}` + why));
  }

  _toggle(){ document.body.classList.toggle('has-board', this.rows.length + this.local.length > 0); }   // 空榜不占地方

  render(me){
    const rows = this._sorted();
    this.el.board.replaceChildren(...rows.map((e, i) => {
      const li = document.createElement('li');
      li.className = (me && e.username === me.username ? 'is-me' : '') + (e.local ? ' is-local' : '');   // 自己那行 = 自己最好的一局
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
    const mine = this.el.board.querySelector('li.is-me');           // 刚打完的那局：滚到看得见的地方
    if(mine) mine.scrollIntoView({ block:'nearest' });
  }
}
