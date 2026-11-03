// ==UserScript==
// @name         B站黑名单增强管理
// @namespace    workbuddy.bili.blacklist
// @version      0.10.4
// @description  在 B 站黑名单页面注入按钮，点击打开浮窗：全量加载、搜索、排序、只看疑似注销、多选、手动批量取消拉黑
// @author       lei39
// @license      MIT
// @homepage     https://github.com/lei39/bilibili-blacklist-manager
// @match        https://account.bilibili.com/*
// @downloadURL  https://raw.githubusercontent.com/lei39/bilibili-blacklist-manager/main/bili-blacklist-manager.user.js
// @updateURL    https://raw.githubusercontent.com/lei39/bilibili-blacklist-manager/main/bili-blacklist-manager.user.js
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// @early-start
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.10.4';

  const NOFACE = /noface/i;
  const CANCELLED_NAME = '账号已注销';
  const CACHE_KEY = 'bl_cache_v3';
  const CACHE_TTL = 6 * 60 * 60 * 1000;

  // ---------- 存储 ----------
  const store = {
    get(k, d) {
      try { if (typeof GM_getValue === 'function') return GM_getValue(k, d); } catch (e) { /* ignore */ }
      try { const v = localStorage.getItem('blm:' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set(k, v) {
      try { if (typeof GM_setValue === 'function') { GM_setValue(k, v); return; } } catch (e) { /* ignore */ }
      try { localStorage.setItem('blm:' + k, JSON.stringify(v)); } catch (e) { /* ignore */ }
    },
  };

  // ---------- 工具 ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const csrf = () => (document.cookie.match(/bili_jct=([^;]+)/) || [])[1] || '';
  const pad = (n) => String(n).padStart(2, '0');
  const fmtTime = (ts) => {
    if (!ts) return '-';
    const d = new Date(ts * 1000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- 自绘确认框 / 提示条 ----------
  // 注意：脚本猫运行在隔离环境，原生 confirm/alert 不会弹窗且直接返回 true，
  // 所以所有写操作前的确认必须用自己画的弹窗，否则等于没有确认。
  function askConfirm(opts) {
    const o = opts || {};
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'blm-modal-mask';
      mask.innerHTML = `
        <div class="blm-modal">
          <div class="blm-modal-hd">${esc(o.title || '确认操作')}</div>
          <div class="blm-modal-bd">${o.body || ''}</div>
          <div class="blm-modal-ft">
            <button class="blm-btn" data-res="0">取消</button>
            <button class="blm-btn ${o.danger ? 'danger' : 'pri'}" data-res="1">${esc(o.okText || '确定')}</button>
          </div>
        </div>`;
      document.body.appendChild(mask);
      requestAnimationFrame(() => mask.classList.add('on'));
      let closed = false;
      const done = (v) => {
        if (closed) return;
        closed = true;
        mask.classList.remove('on');
        setTimeout(() => mask.remove(), 200);
        resolve(v);
      };
      mask.addEventListener('click', (e) => {
        const b = e.target.closest('[data-res]');
        if (b) return done(b.getAttribute('data-res') === '1');
        if (e.target === mask) return done(false);
      });
    });
  }

  let toastTimer = null;
  function toast(msg) {
    let el = document.querySelector('.blm-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'blm-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    requestAnimationFrame(() => el.classList.add('on'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('on'), 2600);
  }

  // ---------- 判定（只标记，不自动删） ----------
  const isNoFace = (u) => NOFACE.test(u.face || '');
  const isSuspicious = (u) => isNoFace(u) || u.uname === CANCELLED_NAME;

  // 账号状态核验缓存：mid -> {lv, spacesta, fans, friend, archive, like}
  //   spacesta === -2  → 账号被封禁
  //   lv === 0 且有历史数据 → 账号已注销（等级被清零）
  const stateCache = new Map();
  const STATE_KEY = 'bl_state_v2';

  function loadStates() {
    try {
      const raw = store.get(STATE_KEY, null);
      if (!raw) return;
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
      Object.keys(obj || {}).forEach((mid) => stateCache.set(mid, obj[mid]));
    } catch (e) { /* ignore */ }
  }
  function saveStates() {
    const obj = {};
    stateCache.forEach((v, k) => { obj[k] = v; });
    store.set(STATE_KEY, JSON.stringify(obj));
  }

  function classify(u) {
    if (u.uname === CANCELLED_NAME) return { tag: '已注销', cls: 'bad' };
    const st = stateCache.get(String(u.mid));
    if (st && st.failed) return { tag: '未核验', cls: 'mute' };
    if (st) {
      if (st.spacesta === -2) return { tag: '已封禁', cls: 'ban' };
      const hasHistory = st.fans > 0 || st.friend > 0 || st.archive > 0 || st.like > 0;
      if (st.lv === 0) {
        return hasHistory ? { tag: '已注销 LV0', cls: 'bad' } : { tag: 'LV0 空号', cls: 'warn' };
      }
      return { tag: `无头像 LV${st.lv}`, cls: 'mute' };
    }
    if (isNoFace(u)) return { tag: '疑似注销', cls: 'warn' };
    return { tag: '', cls: '' };
  }

  // ---------- 数据 ----------
  async function fetchAll(onProgress) {
    const per = 50;
    let pn = 1;
    const all = [];
    while (pn <= 200) {
      const res = await fetch(`https://api.bilibili.com/x/relation/blacks?pn=${pn}&ps=${per}`, { credentials: 'include' });
      const json = await res.json();
      if (json.code !== 0) throw new Error(`接口返回 ${json.code}: ${json.message}`);
      const list = (json.data && json.data.list) || [];
      all.push(...list);
      onProgress && onProgress(all.length, (json.data && json.data.total) || 0);
      if (list.length < per) break;
      pn++;
      await sleep(180);
    }
    return all;
  }

  function loadCache() {
    try {
      const raw = store.get(CACHE_KEY, null);
      if (!raw) return null;
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!obj || !obj.at || Date.now() - obj.at > CACHE_TTL) return null;
      return obj.list;
    } catch (e) { return null; }
  }
  const saveCache = (list) => store.set(CACHE_KEY, JSON.stringify({ at: Date.now(), list }));

  async function unblockOne(mid) {
    const body = new URLSearchParams({ fid: String(mid), act: '6', re_src: '11', csrf: csrf() });
    const res = await fetch('https://api.bilibili.com/x/relation/modify', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = await res.json();
    return json.code === 0;
  }

  // ---------- 状态 ----------
  const state = {
    list: [], view: [], selected: new Set(),
    q: '', sortKey: 'mtime', sortDesc: true,
    pageSize: 50, page: 1, mode: 'list',
    onlySus: false, loading: false, open: false,
    verifying: false, verifyDone: 0, verifyTotal: 0, verifyRound: 0, waiting: 0,
  };

  // ---------- 样式 ----------
  const CSS = `
  .blm-fab{position:fixed;right:24px;bottom:72px;z-index:999998;display:inline-flex;align-items:center;gap:6px;
    padding:10px 16px;border-radius:22px;background:#00aeec;color:#fff;border:none;cursor:pointer;
    font:13px/1 -apple-system,"Microsoft YaHei",sans-serif;box-shadow:0 4px 16px rgba(0,174,236,.45);transition:.15s}
  .blm-fab:hover{transform:translateY(-2px);box-shadow:0 6px 20px rgba(0,174,236,.6)}
  :root[data-blm-off] .blm-fab{display:none !important}
  .blm-mask{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:999999;display:none}
  .blm-mask.on{display:block}
  .blm-panel{position:fixed;top:5vh;left:50%;transform:translateX(-50%);width:min(1120px,94vw);height:88vh;
    background:#fff;border-radius:10px;z-index:1000000;display:none;flex-direction:column;overflow:hidden;
    box-shadow:0 16px 56px rgba(0,0,0,.28);font:13px/1.5 -apple-system,"Microsoft YaHei",sans-serif;color:#18191c}
  .blm-panel.on{display:flex}
  .blm-hd{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid #e3e5e7}
  .blm-hd h3{margin:0;font-size:15px;font-weight:600}
  .blm-quota{margin-left:auto;font-size:12px;color:#61666d}
  .blm-x{border:none;background:none;font-size:22px;line-height:1;cursor:pointer;color:#9499a0;padding:0 2px}
  .blm-x:hover{color:#18191c}
  .blm-bar{display:flex;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid #f1f2f3;flex-wrap:wrap}
  .blm-inp{padding:6px 10px;border:1px solid #e3e5e7;border-radius:6px;font-size:13px;outline:none;width:200px}
  .blm-inp:focus{border-color:#00aeec}
  .blm-btn{padding:6px 12px;border:1px solid #e3e5e7;background:#fff;border-radius:6px;cursor:pointer;font-size:12px;color:#18191c}
  .blm-btn:hover{border-color:#00aeec;color:#00aeec}
  .blm-btn.on{border-color:#f0a020;color:#b88230;background:#fdf6ec}
  .blm-btn.danger{background:#f56c6c;border-color:#f56c6c;color:#fff}
  .blm-btn.danger:hover{background:#e04c4c;color:#fff}
  .blm-btn:disabled{opacity:.45;cursor:not-allowed}
  .blm-sel{margin-left:auto;font-size:12px;color:#61666d}
  .blm-hint{padding:8px 16px;background:#fdf6ec;color:#a8701f;font-size:12px;line-height:1.6;
    border-bottom:1px solid #f6e3c0}
  .blm-hint b{color:#8a5a10}
  .blm-hint code{background:#f7e6c8;padding:1px 4px;border-radius:3px;font-size:11px}
  .blm-prog{height:2px;background:#f1f2f3;overflow:hidden}
  .blm-prog i{display:block;height:100%;width:0;background:#00aeec;transition:width .2s}
  .blm-body{flex:1;overflow:auto}
  .blm-tip{padding:52px;text-align:center;color:#9499a0}
  table.blm-tbl{width:100%;border-collapse:collapse;font-size:12px}
  table.blm-tbl th{position:sticky;top:0;background:#f6f7f8;z-index:2;text-align:left;padding:8px 10px;font-weight:500;color:#61666d;border-bottom:1px solid #e3e5e7;cursor:pointer;white-space:nowrap}
  table.blm-tbl th.no{cursor:default}
  table.blm-tbl td{padding:6px 10px;border-bottom:1px solid #f1f2f3;vertical-align:middle}
  table.blm-tbl td.blm-uid,table.blm-tbl td.blm-time{white-space:nowrap}
  table.blm-tbl tr:hover td{background:#fafbfc}
  table.blm-tbl img{width:26px;height:26px;border-radius:50%;object-fit:cover;background:#f1f2f3;display:block}
  .blm-uid{color:#9499a0;font-family:ui-monospace,Consolas,monospace;font-size:11px}
  .blm-name{font-weight:500}
  .blm-tag{display:inline-block;padding:1px 6px;border-radius:4px;font-size:11px;margin-left:6px;flex:none;white-space:nowrap}
  .blm-tag.bad{background:#fde2e2;color:#c45656}
  .blm-tag.ban{background:#4a4a55;color:#fff}
  .blm-tag.warn{background:#fdf6ec;color:#b88230}
  .blm-tag.mute{background:#f1f2f3;color:#9499a0}
  .blm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(232px,1fr));gap:10px;padding:12px 12px 48px}
  .blm-card{position:relative;display:flex;gap:10px;align-items:center;border:1px solid #f1f2f3;border-radius:8px;padding:10px;background:#fff;transition:border-color .18s ease,box-shadow .18s ease,border-radius .18s ease}
  .blm-card:hover{border-color:#00aeec;border-bottom-color:transparent;border-radius:8px 8px 0 0;box-shadow:0 6px 18px rgba(0,174,236,.14);z-index:30}
  .blm-card img{width:44px;height:44px;border-radius:50%;object-fit:cover;background:#f1f2f3;flex:none}
  .blm-card-main{flex:1;min-width:0}
  .blm-card-top{display:flex;align-items:center;gap:5px;min-width:0}
  .blm-card-name{font-weight:500;font-size:13px;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .blm-card-sign{font-size:11px;color:#9499a0;line-height:1.45;margin-top:3px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .blm-card-sign.empty{color:#c9ccd0;font-style:italic}
  .blm-card:hover .blm-card-sign{color:#c9ccd0}
  .blm-card-meta{font-size:11px;color:#9499a0;margin-top:4px;display:flex;flex-direction:column;gap:1px;line-height:1.5}
  .blm-card-meta .blm-uid,.blm-card-meta .blm-time{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
  /* 悬停展开层：与卡片下沿无缝衔接，视觉上等同卡片变大，但不影响 grid 布局 */
  .blm-card-pop{position:absolute;top:100%;left:-1px;right:-1px;background:#fafbfc;
    border:1px solid #00aeec;border-top:none;border-radius:0 0 8px 8px;padding:10px 10px 11px;
    box-shadow:0 12px 22px rgba(0,0,0,.10);opacity:0;visibility:hidden;transform:translateY(-5px);
    transition:opacity .18s ease,transform .18s ease,visibility .18s;z-index:31;pointer-events:none}
  .blm-card:hover .blm-card-pop{opacity:1;visibility:visible;transform:translateY(0);pointer-events:auto}
  .blm-card-pop .blm-pop-sign{font-size:12px;line-height:1.65;color:#61666d;max-height:150px;overflow:auto;
    white-space:pre-wrap;word-break:break-word}
  .blm-card-pop .blm-pop-sign.empty{color:#c9ccd0;font-style:italic}
  .blm-pop-foot{display:flex;gap:8px;margin-top:10px;align-items:center}
  .blm-rm{padding:3px 10px;font-size:11px;border:1px solid #e3e5e7;background:#fff;border-radius:4px;cursor:pointer;color:#61666d;transition:.15s}
  .blm-rm:hover{border-color:#f56c6c;color:#f56c6c;background:#fef0f0}
  /* 头像悬停名片（仿 B 站 bili-user-profile） */
  .blm-ucard{position:fixed;z-index:1000005;width:300px;background:#fff;border-radius:10px;overflow:hidden;
    box-shadow:0 10px 32px rgba(0,0,0,.18);border:1px solid #e3e5e7;opacity:0;visibility:hidden;
    transform:translateY(4px);transition:opacity .16s ease,transform .16s ease,visibility .16s;
    pointer-events:none;font:12px/1.5 -apple-system,"Microsoft YaHei",sans-serif;color:#18191c}
  .blm-ucard.on{opacity:1;visibility:visible;transform:translateY(0);pointer-events:auto}
  .blm-uc-bg{height:88px;background:#2f3341 center/cover no-repeat;position:relative}
  .blm-uc-bg::after{content:'';position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.06) 0%,rgba(0,0,0,.38) 100%)}
  .blm-uc-body{padding:0 14px 12px;position:relative}
  .blm-uc-avatar{position:absolute;top:-30px;left:14px;width:58px;height:58px;border-radius:50%;
    border:3px solid #fff;background:#f1f2f3;object-fit:cover;box-shadow:0 2px 8px rgba(0,0,0,.12)}
  .blm-uc-hd{padding-top:34px;display:flex;align-items:center;gap:5px;flex-wrap:wrap}
  .blm-uc-name{font-size:15px;font-weight:600;max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .blm-uc-lv{background:#f1f2f3;color:#61666d;font-size:10px;padding:1px 4px;border-radius:3px;font-weight:400}
  .blm-uc-vip{background:#fb7299;color:#fff;font-size:10px;padding:1px 4px;border-radius:3px;font-weight:400}
  .blm-uc-uid{color:#9499a0;font-size:11px;margin-top:3px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .blm-uc-stats{margin-top:8px;font-size:12px;color:#61666d}
  .blm-uc-stats b{font-weight:600;color:#18191c}
  .blm-uc-off{margin-top:6px;color:#f0a020;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .blm-uc-sign{margin-top:7px;color:#61666d;font-size:12px;line-height:1.55;max-height:66px;overflow:hidden;
    display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;word-break:break-word;white-space:pre-wrap}
  .blm-uc-tip{margin-top:9px;padding-top:8px;border-top:1px solid #f1f2f3;color:#9499a0;font-size:11px}
  .blm-uc-foot{display:flex;gap:8px;margin-top:10px}
  .blm-uc-foot .blm-rm{flex:1;text-align:center;padding:5px 10px}
  /* 自绘确认框（原生 confirm 在脚本猫沙箱里不会弹窗，必须自己实现） */
  .blm-modal-mask{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000010;display:flex;
    align-items:center;justify-content:center;opacity:0;transition:opacity .18s ease}
  .blm-modal-mask.on{opacity:1}
  .blm-modal{width:360px;max-width:88vw;background:#fff;border-radius:8px;overflow:hidden;
    box-shadow:0 12px 36px rgba(0,0,0,.24);transform:scale(.97);transition:transform .18s ease}
  .blm-modal-mask.on .blm-modal{transform:scale(1)}
  .blm-modal-hd{padding:14px 16px 0;font-size:14px;font-weight:600}
  .blm-modal-bd{padding:8px 16px 14px;font-size:12.5px;color:#61666d;line-height:1.6;max-height:300px;overflow:auto}
  .blm-modal-bd b{color:#18191c}
  .blm-modal-list{margin:8px 0 0;padding:0;list-style:none;font-size:12px;color:#9499a0;
    max-height:120px;overflow:auto;border-top:1px solid #f1f2f3;padding-top:6px}
  .blm-modal-list li{padding:2px 0;font-variant-numeric:tabular-nums}
  .blm-modal-ft{display:flex;gap:8px;justify-content:flex-end;padding:0 16px 14px}
  .blm-modal-ft .blm-btn{padding:6px 14px;font-size:12.5px}
  .blm-btn.pri{background:#00aeec;border-color:#00aeec;color:#fff}
  .blm-btn.pri:hover{background:#00a1d6;color:#fff}
  .blm-toast{position:fixed;left:50%;bottom:76px;transform:translateX(-50%) translateY(6px);z-index:1000020;
    background:rgba(24,25,28,.92);color:#fff;padding:7px 14px;border-radius:6px;font-size:12px;
    opacity:0;transition:opacity .18s ease,transform .18s ease;pointer-events:none;max-width:70vw;
    box-shadow:0 4px 16px rgba(0,0,0,.18)}
  .blm-toast.on{opacity:1;transform:translateX(-50%) translateY(0)}
  .blm-ft{display:flex;align-items:center;gap:10px;padding:8px 16px;border-top:1px solid #e3e5e7;font-size:12px;color:#9499a0}
  .blm-pg{display:flex;gap:4px;align-items:center;margin-left:auto}
  .blm-pg button{min-width:28px;height:26px;border:1px solid #e3e5e7;background:#fff;border-radius:4px;cursor:pointer;font-size:12px}
  .blm-pg button.on{background:#00aeec;border-color:#00aeec;color:#fff}
  .blm-pg button:disabled{opacity:.4;cursor:not-allowed}
  .blm-warn{color:#f56c6c}
  `;

  // ---------- 渲染 ----------
  function rebuildView() {
    const q = state.q.trim().toLowerCase();
    let arr = state.list.filter((u) => {
      if (state.onlySus && !isSuspicious(u)) return false;
      if (!q) return true;
      return String(u.uname || '').toLowerCase().includes(q) || String(u.mid).includes(q);
    });
    const k = state.sortKey;
    arr = arr.slice().sort((a, b) => {
      let r;
      if (k === 'uid') r = Number(a.mid) - Number(b.mid);
      else if (k === 'uname') r = String(a.uname || '').localeCompare(String(b.uname || ''), 'zh');
      else r = (a.mtime || 0) - (b.mtime || 0);
      return state.sortDesc ? -r : r;
    });
    state.view = arr;
    const maxPage = Math.max(1, Math.ceil(arr.length / state.pageSize));
    if (state.page > maxPage) state.page = maxPage;
  }

  const pageItems = () => state.view.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);
  const mark = (k) => (state.sortKey === k ? (state.sortDesc ? ' ↓' : ' ↑') : '');

  function renderRows() {
    const items = pageItems();
    // 列表模式 = 多列表格（带表头，表头可排序）
    if (state.mode === 'list') {
      return `<table class="blm-tbl"><thead><tr>
        <th class="no"><input type="checkbox" data-act="selPage" ${items.length && items.every((u) => state.selected.has(u.mid)) ? 'checked' : ''}></th>
        <th class="no">头像</th>
        <th data-sort="uname">昵称${mark('uname')}</th>
        <th data-sort="uid">UID${mark('uid')}</th>
        <th data-sort="mtime">拉黑时间${mark('mtime')}</th>
        <th class="no">操作</th>
      </tr></thead><tbody>
      ${items.map((u) => {
        const c = classify(u);
        return `<tr>
          <td><input type="checkbox" data-mid="${u.mid}" ${state.selected.has(u.mid) ? 'checked' : ''}></td>
          <td><a href="https://space.bilibili.com/${u.mid}" target="_blank" rel="noreferrer"><img data-mid="${u.mid}" src="${esc(u.face)}" loading="lazy" referrerpolicy="no-referrer"></a></td>
          <td><span class="blm-name">${esc(u.uname || '(无昵称)')}</span>${c.tag ? `<span class="blm-tag ${c.cls}">${c.tag}</span>` : ''}</td>
          <td class="blm-uid">${esc(u.mid)}</td>
          <td class="blm-time">${fmtTime(u.mtime)}</td>
          <td><button class="blm-rm" data-remove="${u.mid}">移除</button></td>
        </tr>`;
      }).join('')}
      </tbody></table>`;
    }
    // 表格模式 = 卡片网格（悬停展开签名 + 移除按钮）
    return `<div class="blm-grid">${items.map((u) => {
      const c = classify(u);
      const sign = (u.sign || '').replace(/\s+/g, ' ').trim();
      return `<div class="blm-card">
        <input type="checkbox" data-mid="${u.mid}" ${state.selected.has(u.mid) ? 'checked' : ''}>
        <a href="https://space.bilibili.com/${u.mid}" target="_blank" rel="noreferrer"><img data-mid="${u.mid}" src="${esc(u.face)}" loading="lazy" referrerpolicy="no-referrer"></a>
        <div class="blm-card-main">
          <div class="blm-card-top">
            <span class="blm-card-name" title="${esc(u.uname)}">${esc(u.uname || '(无昵称)')}</span>
            ${c.tag ? `<span class="blm-tag ${c.cls}">${c.tag}</span>` : ''}
          </div>
          ${sign ? `<div class="blm-card-sign">${esc(sign)}</div>` : '<div class="blm-card-sign empty">（无签名）</div>'}
          <div class="blm-card-meta">
            <span class="blm-uid">${esc(u.mid)}</span>
            <span class="blm-time">${fmtTime(u.mtime)}</span>
          </div>
        </div>
        <div class="blm-card-pop">
          ${sign ? `<div class="blm-pop-sign">${esc(u.sign)}</div>` : '<div class="blm-pop-sign empty">（无签名）</div>'}
          <div class="blm-pop-foot">
            <button class="blm-rm" data-remove="${u.mid}">移除</button>
            <a class="blm-rm" href="https://space.bilibili.com/${u.mid}" target="_blank" rel="noreferrer" style="text-decoration:none">主页</a>
          </div>
        </div>
      </div>`;
    }).join('')}</div>`;
  }

  function renderPager() {
    const total = Math.max(1, Math.ceil(state.view.length / state.pageSize));
    const cur = state.page;
    let html = `<button data-page="1" ${cur === 1 ? 'disabled' : ''}>«</button>`;
    const from = Math.max(1, Math.min(cur - 2, total - 4));
    const to = Math.min(total, from + 4);
    for (let p = from; p <= to; p++) html += `<button data-page="${p}" class="${p === cur ? 'on' : ''}" ${p === cur ? 'disabled' : ''}>${p}</button>`;
    html += `<button data-page="${total}" ${cur === total ? 'disabled' : ''}>»</button>`;
    return html;
  }

  // 渲染时统一收起名片（防止重渲染导致 node 移除、mouseout 不触发而卡住）
  let hideUcardRef = () => {};

  function render() {
    hideUcardRef();
    const panel = document.querySelector('.blm-panel');
    if (!panel) return;
    const susCount = state.list.filter(isSuspicious).length;

    panel.querySelector('.blm-quota').textContent = state.loading
      ? `加载中 ${state.list.length} / 5000`
      : `共 ${state.list.length} 人 · 上限 5000`;

    const susBtn = panel.querySelector('[data-act="onlySus"]');
    susBtn.textContent = `只看疑似注销 (${susCount})`;
    susBtn.classList.toggle('on', state.onlySus);

    // 只看疑似注销时，说明判定依据，避免误以为"确定已注销"
    const hint = panel.querySelector('.blm-hint');
    if (hint) {
      hint.style.display = state.onlySus ? 'block' : 'none';
      if (state.onlySus) {
        hint.innerHTML = `当前正在只看 <b>疑似注销</b>（${susCount} 个）。初始判定只看两条特征：`
          + `昵称等于「<b>账号已注销</b>」，或头像为 B 站默认头像 <code>noface.jpg</code>——`
          + `这两条<b>并不代表账号真的注销</b>。点 <b>「核验状态」</b> 可逐个查接口确认：`
          + `<b>已封禁</b>（<code>spacesta=-2</code>）、<b>已注销</b>（等级清零且仍有历史数据）。`;
      }
    }

    // 核验按钮状态
    const verifyBtn = panel.querySelector('[data-act="verify"]');
    if (verifyBtn) {
      const pending = state.list.filter((u) => isSuspicious(u) && !isVerified(u.mid)).length;
      verifyBtn.disabled = state.verifying || state.waiting > 0 || pending === 0;
      verifyBtn.textContent = state.waiting > 0
        ? `限流等待 ${state.waiting}s`
        : state.verifying
          ? `核验中 ${state.verifyDone}/${state.verifyTotal}`
          : (pending ? `核验状态 (${pending})` : '状态已核验');
    }

    // 排序按钮显示当前排序方向（表格模式没有表头可点，靠这里给反馈）
    const sortLabels = { 'sort:time': ['时间', 'mtime'], 'sort:uid': ['UID', 'uid'], 'sort:name': ['昵称', 'uname'] };
    Object.keys(sortLabels).forEach((act) => {
      const b = panel.querySelector(`[data-act="${act}"]`);
      if (b) b.textContent = sortLabels[act][0] + mark(sortLabels[act][1]);
    });

    const body = panel.querySelector('.blm-body');
    if (state.loading && !state.list.length) {
      body.innerHTML = `<div class="blm-tip">正在拉取黑名单…（每页 50 条，共约 100 次请求，约 25 秒）</div>`;
    } else if (!state.list.length) {
      body.innerHTML = `<div class="blm-tip">暂无数据，点「重新加载」</div>`;
    } else {
      body.innerHTML = renderRows();
    }
    panel.querySelector('.blm-pg').innerHTML = renderPager();
    panel.querySelector('.blm-sel').textContent =
      `已选 ${state.selected.size} · 显示 ${state.view.length} / ${state.list.length}`;
    panel.querySelector('[data-act="exec"]').disabled = state.selected.size === 0;
  }

  async function ensureData(force) {
    if (state.loading) return;
    if (!force) {
      const cached = loadCache();
      if (cached && cached.length) {
        state.list = cached;
        rebuildView(); render();
        return;
      }
    }
    state.loading = true;
    state.list = [];
    render();
    try {
      state.list = await fetchAll((loaded, total) => {
        const bar = document.querySelector('.blm-prog i');
        if (bar && total) bar.style.width = Math.min(100, (loaded / total) * 100) + '%';
        const q = document.querySelector('.blm-quota');
        if (q) q.textContent = `加载中 ${loaded} / ${total || 5000}`;
      });
      saveCache(state.list);
    } catch (e) {
      document.querySelector('.blm-body').innerHTML = `<div class="blm-tip blm-warn">加载失败：${esc(e.message)}</div>`;
    } finally {
      state.loading = false;
      rebuildView(); render();
    }
  }

  async function removeOne(mid) {
    const u = state.list.find((x) => Number(x.mid) === mid);
    const name = u ? u.uname : String(mid);
    const confirmed = await askConfirm({
      title: '取消拉黑',
      body: `确定要取消拉黑「<b>${esc(name)}</b>」吗？<br><br>此操作不可撤销，对方将重新能评论、@ 你、给你发私信。`,
      okText: '确定取消拉黑',
      danger: true,
    });
    if (!confirmed) return;
    const btn = document.querySelector(`[data-remove="${mid}"]`);
    if (btn) { btn.disabled = true; btn.textContent = '处理中…'; }
    let ok = false;
    try { ok = await unblockOne(mid); } catch (e) { ok = false; }
    if (ok) {
      state.list = state.list.filter((x) => Number(x.mid) !== mid);
      state.selected.delete(mid);
      saveCache(state.list);
      rebuildView();
      render();
    } else {
      if (btn) { btn.disabled = false; btn.textContent = '移除'; }
      toast('取消失败，可能触发了操作频率限制，稍后再试');
    }
    await sleep(200);
  }

  // 只对「疑似注销」的账号逐个查等级（每人一次请求），用于把"没传头像"和"真注销"区分开
  const isVerified = (mid) => {
    const st = stateCache.get(String(mid));
    return !!(st && !st.failed);
  };

  // 撞墙（-352）后等待 N 秒，期间按钮上显示倒计时
  async function countdown(sec) {
    state.waiting = sec;
    const timer = setInterval(() => {
      state.waiting--;
      if (state.waiting <= 0) clearInterval(timer);
      render();
    }, 1000);
    await sleep(sec * 1000);
    clearInterval(timer);
    state.waiting = 0;
    render();
  }

  // 核验账号状态：只查「疑似注销」那批，一次 card 接口同时拿到封禁状态(spacesta)与等级(level)
  // 撞墙(-352) 立即停止本轮，等待 1 分钟后自动重试，最多 3 轮
  async function verifyStates() {
    if (state.verifying) return;
    const MAX_RETRY = 3;
    for (let round = 0; round <= MAX_RETRY; round++) {
      const targets = state.list.filter((u) => isSuspicious(u) && !isVerified(u.mid));
      if (!targets.length) break;
      state.verifying = true;
      state.verifyDone = 0;
      state.verifyTotal = targets.length;
      state.verifyRound = round + 1;
      render();
      let wall = false;
      for (const u of targets) {
        try {
          const res = await fetch(`https://api.bilibili.com/x/web-interface/card?mid=${u.mid}&photo=true`, { credentials: 'include' });
          const j = await res.json();
          if (j.code === 0 && j.data && j.data.card) {
            const c = j.data.card;
            stateCache.set(String(u.mid), {
              lv: c.level_info ? c.level_info.current_level : null,
              spacesta: c.spacesta,
              fans: c.fans || 0,
              friend: c.friend || 0,
              archive: j.data.archive_count || 0,
              like: j.data.like_num || 0,
            });
          } else if (j.code === -352) {
            wall = true;                       // 撞墙，立刻停，别再空转
            stateCache.set(String(u.mid), { failed: 1 });
            break;
          } else {
            stateCache.set(String(u.mid), { failed: 1, reason: j.code });
          }
        } catch (e) {
          stateCache.set(String(u.mid), { failed: 1 });
        }
        state.verifyDone++;
        if (state.verifyDone % 5 === 0) { saveStates(); render(); }
        await sleep(500);
      }
      saveStates();
      state.verifying = false;
      rebuildView();
      render();
      const left = state.list.filter((u) => isSuspicious(u) && !isVerified(u.mid)).length;
      if (!wall) { toast(left ? `完成，${left} 个未查到` : '核验完成'); break; }
      if (round >= MAX_RETRY) { toast(`已重试 ${MAX_RETRY} 次，${left} 个未查到`); break; }
      toast(`接口限流，60 秒后重试（${round + 1}/${MAX_RETRY}）`);
      await countdown(60);
    }
    // 仍未查到的统一标成「未核验」
    state.list.forEach((u) => {
      if (isSuspicious(u) && !isVerified(u.mid)) stateCache.set(String(u.mid), { failed: 1 });
    });
    saveStates();
    rebuildView();
    render();
  }

  async function execUnblock() {
    const mids = [...state.selected];
    if (!mids.length) return;
    const preview = mids.slice(0, 10).map((mid) => {
      const u = state.list.find((x) => Number(x.mid) === mid);
      return `<li>${esc(u ? u.uname : '(未知)')} &nbsp;·&nbsp; ${esc(mid)}</li>`;
    }).join('');
    const more = mids.length > 10 ? `<div style="margin-top:6px">…以及其余 ${mids.length - 10} 个</div>` : '';
    const ok = await askConfirm({
      title: `批量取消拉黑 ${mids.length} 个账号`,
      body: `此操作不可撤销，这 <b>${mids.length}</b> 个账号将重新能评论、@ 你、给你发私信。<ul class="blm-modal-list">${preview}</ul>${more}`,
      okText: `确定取消 ${mids.length} 个`,
      danger: true,
    });
    if (!ok) return;
    const btn = document.querySelector('[data-act="exec"]');
    btn.disabled = true;
    let done = 0, fail = 0;
    const failed = [];
    for (const mid of mids) {
      let ok = false;
      try { ok = await unblockOne(mid); } catch (e) { ok = false; }
      if (ok) { done++; state.list = state.list.filter((u) => u.mid !== mid); }
      else { fail++; failed.push(mid); }
      btn.textContent = `执行中 ${done + fail}/${mids.length}`;
      await sleep(350);
    }
    state.selected.clear();
    saveCache(state.list);
    rebuildView(); render();
    btn.textContent = '批量取消拉黑';
    toast(`完成：成功 ${done} 个，失败 ${fail} 个${failed.length ? '（失败 UID：' + failed.join(', ') + '）' : ''}`);
  }

  // ---------- 头像名片 ----------
  const ucardCache = new Map();
  const fmtNum = (n) => {
    if (n == null) return '-';
    if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿';
    if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
    return String(n);
  };

  async function fetchCard(mid) {
    if (ucardCache.has(mid)) return ucardCache.get(mid);
    try {
      const r = await fetch(`https://api.bilibili.com/x/web-interface/card?mid=${mid}&photo=true`, { credentials: 'include' });
      const j = await r.json();
      const val = j.code === 0 ? j.data : null;
      ucardCache.set(mid, val);
      return val;
    } catch (e) {
      ucardCache.set(mid, null);
      return null;
    }
  }

  // ---------- 挂载 ----------
  let mounted = false;
  let closeRef = null;   // mount 内注册，供路由切换时收起面板
  function mount() {
    if (document.querySelector('.blm-fab')) return true;
    // document-start 注入时 head / body 可能都还没生成，返回 false 交给外层重试
    if (!document.body) return false;
    const head = document.head || document.documentElement;
    if (!head) return false;
    if (!mounted) { loadStates(); mounted = true; }

    const s = document.createElement('style');
    s.id = 'blm-style';
    s.textContent = CSS;
    head.appendChild(s);

    const fab = document.createElement('button');
    fab.className = 'blm-fab';
    fab.textContent = '⚙ 黑名单增强';
    fab.setAttribute('data-blm-version', VERSION);
    document.body.appendChild(fab);
    document.documentElement.setAttribute('data-blm', VERSION);

    const mask = document.createElement('div');
    mask.className = 'blm-mask';

    const panel = document.createElement('div');
    panel.className = 'blm-panel';
    panel.innerHTML = `
      <div class="blm-hd">
        <h3>黑名单增强管理</h3>
        <button class="blm-btn" data-act="reload">重新加载</button>
        <span class="blm-quota"></span>
        <button class="blm-x" data-act="close">×</button>
      </div>
      <div class="blm-prog"><i></i></div>
      <div class="blm-bar">
        <input class="blm-inp" data-act="q" placeholder="搜索昵称 / UID">
        <button class="blm-btn" data-act="sort:time">时间</button>
        <button class="blm-btn" data-act="sort:uid">UID</button>
        <button class="blm-btn" data-act="sort:name">昵称</button>
        <button class="blm-btn" data-act="onlySus">只看疑似注销</button>
        <button class="blm-btn" data-act="verify" title="逐个查询 card 接口，核实账号的真实状态：已封禁（spacesta=-2）、已注销（等级清零且仍有历史数据）、等级。&#10;&#10;注意：B 站对该接口有时间窗口配额（约 100 次请求），连续查询会触发 -352 限流；被限流的账号不会写入缓存，稍后再点一次即可继续核验，不会重复请求已成功的账号。">核验状态</button>
        <button class="blm-btn" data-act="mode">视图：列表</button>
        <select class="blm-inp" style="width:auto" data-act="size">
          <option value="50">每页 50</option><option value="90">每页 90</option><option value="140">每页 140</option>
        </select>
      </div>
      <div class="blm-bar">
        <button class="blm-btn" data-act="pickNone">取消选择</button>
        <button class="blm-btn danger" data-act="exec">批量取消拉黑</button>
        <span class="blm-sel"></span>
      </div>
      <div class="blm-hint" style="display:none"></div>
      <div class="blm-body"></div>
      <div class="blm-ft"><span>数据缓存 6 小时 · 可点「重新加载」强制刷新</span><span class="blm-pg"></span></div>`;
    document.body.appendChild(mask);
    document.body.appendChild(panel);

    const open = () => {
      state.open = true;
      mask.classList.add('on');
      panel.classList.add('on');
      // 锁住原页面滚动
      document.documentElement.style.overflow = 'hidden';
      document.body.style.overflow = 'hidden';
      ensureData(false);
    };
    const close = () => {
      state.open = false;
      mask.classList.remove('on');
      panel.classList.remove('on');
      document.documentElement.style.overflow = '';
      document.body.style.overflow = '';
      const uc = document.querySelector('.blm-ucard');
      if (uc) uc.classList.remove('on');
    };
    closeRef = close;

    // ---- 头像悬停名片 ----
    const ucard = document.createElement('div');
    ucard.className = 'blm-ucard';
    document.body.appendChild(ucard);
    let hoverTimer = null;
    let hideTimer = null;
    let hoverMid = null;
    const hideUcard = () => { clearTimeout(hoverTimer); clearTimeout(hideTimer); hoverMid = null; ucard.classList.remove('on'); };
    hideUcardRef = hideUcard;

    const showUcard = (img, data, mid) => {
      const r = img.getBoundingClientRect();
      const bg = data && data.space && data.space.s_img ? data.space.s_img : '';
      if (!data || !data.card) {
        ucard.innerHTML = `
          <div class="blm-uc-bg"></div>
          <div class="blm-uc-body">
            <img class="blm-uc-avatar" src="https://i0.hdslb.com/bfs/face/member/noface.jpg" referrerpolicy="no-referrer">
            <div class="blm-uc-hd"><span class="blm-uc-name">资料不可用</span></div>
            <div class="blm-uc-uid">UID ${esc(mid)}</div>
            <div class="blm-uc-tip">该账号可能已注销或存在访问限制</div>
            <div class="blm-uc-foot">
              <a class="blm-rm" href="https://space.bilibili.com/${esc(mid)}" target="_blank" rel="noreferrer" style="text-decoration:none">主页</a>
              <button class="blm-rm" data-ucard-remove="${esc(mid)}">移除</button>
            </div>
          </div>`;
      } else {
        const c = data.card;
        const lv = c.level_info ? c.level_info.current_level : null;
        const vipTxt = c.vip && c.vip.label && c.vip.label.text ? c.vip.label.text : '';
        const off = (c.official_verify && c.official_verify.desc) || (c.Official && c.Official.title) || '';
        ucard.innerHTML = `
          <div class="blm-uc-bg"${bg ? ` style="background-image:url('${esc(bg)}')"` : ''}></div>
          <div class="blm-uc-body">
            <img class="blm-uc-avatar" src="${esc(c.face)}" referrerpolicy="no-referrer">
            <div class="blm-uc-hd">
              <span class="blm-uc-name" title="${esc(c.name)}">${esc(c.name)}</span>
              ${lv ? `<span class="blm-uc-lv">LV${lv}</span>` : ''}
              ${vipTxt ? `<span class="blm-uc-vip">${esc(vipTxt)}</span>` : ''}
            </div>
            <div class="blm-uc-uid">UID ${esc(c.mid)}${data.following ? ' · 已关注' : ''}</div>
            <div class="blm-uc-stats"><b>${fmtNum(c.friend)}</b> 关注 · <b>${fmtNum(c.fans)}</b> 粉丝 · <b>${fmtNum(data.like_num)}</b> 获赞</div>
            ${off ? `<div class="blm-uc-off">▫ ${esc(off)}</div>` : ''}
            <div class="blm-uc-sign">${esc(c.sign || '这个人很懒，什么都没写')}</div>
            ${(data.archive_count || 0) > 0 ? `<div class="blm-uc-tip">投稿 ${fmtNum(data.archive_count)}${(data.article_count || 0) > 0 ? ' · 专栏 ' + fmtNum(data.article_count) : ''}</div>` : ''}
            <div class="blm-uc-foot">
              <a class="blm-rm" href="https://space.bilibili.com/${esc(c.mid)}" target="_blank" rel="noreferrer" style="text-decoration:none">主页</a>
              <button class="blm-rm" data-ucard-remove="${esc(c.mid)}">移除</button>
            </div>
          </div>`;
      }
      ucard.style.left = '0px';
      ucard.style.top = '0px';
      ucard.classList.add('on');
      const w = 300;
      const h = ucard.offsetHeight;
      let left = r.right + 10;
      if (left + w > window.innerWidth - 8) left = r.left - w - 10;
      if (left < 8) left = 8;
      let top = r.top + r.height / 2 - h / 2;
      if (top + h > window.innerHeight - 8) top = window.innerHeight - h - 8;
      if (top < 8) top = 8;
      ucard.style.left = left + 'px';
      ucard.style.top = top + 'px';
    };

    panel.addEventListener('mouseover', (e) => {
      const img = e.target.closest('img[data-mid]');
      if (!img) return;
      // 关键：从一个头像直接移到另一个头像时，上一条 mouseout 排的隐藏任务必须取消，
      // 否则它会在 260ms 后把 hoverMid 清空，导致新头像的名片永远显示不出来
      clearTimeout(hideTimer);
      const mid = img.getAttribute('data-mid');
      hoverMid = mid;
      clearTimeout(hoverTimer);
      ucard.classList.remove('on'); // 先收起上一个头像的名片，避免显示错人
      const delay = ucardCache.has(mid) ? 0 : 220; // 已缓存就立即显示
      hoverTimer = setTimeout(async () => {
        const data = await fetchCard(mid);
        if (hoverMid === mid && document.contains(img)) showUcard(img, data, mid);
      }, delay);
    });
    panel.addEventListener('mouseout', (e) => {
      if (!e.target.closest('img[data-mid]')) return;
      // 宽限期：留时间让指针跨过空隙移进名片
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { hoverMid = null; hideUcard(); }, 260);
    });
    ucard.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    ucard.addEventListener('mouseleave', () => { hoverMid = null; hideUcard(); });
    ucard.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ucard-remove]');
      if (!btn) return;
      e.preventDefault();
      removeOne(Number(btn.getAttribute('data-ucard-remove')));
    });
    panel.querySelector('.blm-body').addEventListener('scroll', () => { hoverMid = null; hideUcard(); });
    fab.addEventListener('click', open);
    mask.addEventListener('click', close);

    panel.addEventListener('click', (e) => {
      const t = e.target;
      const rmBtn = t.closest('[data-remove]');
      if (rmBtn) {
        removeOne(Number(rmBtn.getAttribute('data-remove')));
        return;
      }
      const th = t.closest('[data-sort]');
      if (th) {
        const k = th.getAttribute('data-sort');
        if (state.sortKey === k) state.sortDesc = !state.sortDesc;
        else { state.sortKey = k; state.sortDesc = true; }
        rebuildView(); render(); return;
      }
      const pb = t.closest('[data-page]');
      if (pb) {
        state.page = Number(pb.getAttribute('data-page'));
        render();
        panel.querySelector('.blm-body').scrollTop = 0;
        return;
      }
      const act = t.getAttribute('data-act');
      if (!act) return;
      if (act === 'close') return close();
      if (act === 'reload') return ensureData(true);
      if (act.startsWith('sort:')) {
        const map = { 'sort:time': 'mtime', 'sort:uid': 'uid', 'sort:name': 'uname' };
        const k = map[act];
        if (state.sortKey === k) state.sortDesc = !state.sortDesc;
        else { state.sortKey = k; state.sortDesc = true; }
        rebuildView(); render(); return;
      }
      if (act === 'onlySus') {
        state.onlySus = !state.onlySus;
        state.page = 1;
        rebuildView(); render(); return;
      }
      if (act === 'verify') return verifyStates();
      if (act === 'mode') {
        state.mode = state.mode === 'list' ? 'grid' : 'list';
        t.textContent = '视图：' + (state.mode === 'list' ? '列表' : '表格');
        render(); return;
      }
      if (act === 'pickNone') { state.selected.clear(); render(); return; }
      if (act === 'exec') return execUnblock();
    });

    panel.addEventListener('change', (e) => {
      const t = e.target;
      if (t.getAttribute('data-act') === 'size') {
        state.pageSize = Number(t.value); state.page = 1; render(); return;
      }
      if (t.type === 'checkbox') {
        if (t.getAttribute('data-act') === 'selPage') {
          pageItems().forEach((u) => { if (t.checked) state.selected.add(u.mid); else state.selected.delete(u.mid); });
        } else {
          const mid = Number(t.getAttribute('data-mid'));
          if (t.checked) state.selected.add(mid); else state.selected.delete(mid);
        }
        render();
      }
    });

    panel.addEventListener('input', (e) => {
      if (e.target.getAttribute('data-act') === 'q') {
        state.q = e.target.value; state.page = 1;
        rebuildView(); render();
      }
    });
    return true;
  }

  // 看门狗 + 路由感知：
  //   个人中心是 SPA，从 /account/home 点「黑名单管理」不会重新加载页面，
  //   所以脚本要一直活着，靠路由判断何时挂载、何时隐藏。
  function isBlacklistRoute() {
    return location.pathname.indexOf('/account/blacklist') === 0;
  }
  function syncRoute() {
    const on = isBlacklistRoute();
    document.documentElement.toggleAttribute('data-blm-off', !on);
    if (!on) {
      if (closeRef) closeRef();
      return;
    }
    if (!document.querySelector('.blm-fab') && document.body) mount();
  }

  // 前 10 秒每 250ms 试一次（等 body + 等路由），之后降到 1 秒
  let fastTries = 0;
  const bootTimer = setInterval(() => {
    syncRoute();
    if (++fastTries > 40) clearInterval(bootTimer);
  }, 250);
  syncRoute();
  setInterval(syncRoute, 1000);
  window.addEventListener('popstate', syncRoute);
})();
