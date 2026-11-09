/* 위아 WIA 시범 운영 서버
   - 선생님 화면(/teacher)과 학생 화면(/)을 함께 서비스해요.
   - 수업 상태와 학생 답은 Socket.IO로 실시간 주고받고, data/wia-data.json에 저장해요. */
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'wia-data.json');
const DB_KEY = 'wia-teacher-draft-v5';
const LIVE_KEY = 'wia-live';
const STU = 'wia-stu:';
const SESSION_DAYS = 14;

/* ---------- 저장소 ----------
   DATABASE_URL이 있으면 PostgreSQL(예: Neon 무료)에, 없으면 DATA_DIR의 파일에 저장해요.
   서버는 모든 값을 메모리에 들고 있고, 바뀐 것만 0.5초마다 모아서 저장해요. */
let store = { kv: {}, account: null, sessions: {} };
const PG_URL = process.env.DATABASE_URL || '';
let pool = null;
const dirtyKV = new Set(); let dirtyMeta = false; let flushTimer = null; let flushing = Promise.resolve();

async function loadStore() {
  if (PG_URL) {
    const { Pool } = require('pg');
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(PG_URL);
    pool = new Pool({ connectionString: PG_URL, ssl: local ? false : { rejectUnauthorized: false }, max: 4 });
    await pool.query('CREATE TABLE IF NOT EXISTS wia_store (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())');
    const { rows } = await pool.query('SELECT k, v FROM wia_store');
    rows.forEach(r => {
      if (r.k === 'meta:account') store.account = JSON.parse(r.v);
      else if (r.k === 'meta:sessions') store.sessions = JSON.parse(r.v);
      else if (r.k.startsWith('kv:')) store.kv[r.k.slice(3)] = r.v;
    });
    console.log(`[위아] PostgreSQL에 연결했어요 (저장된 항목 ${rows.length}개)`);
  } else {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    try { store = Object.assign(store, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch (e) { /* 처음 실행 */ }
    console.log(`[위아] 파일에 저장해요: ${DATA_FILE}`);
  }
  if (!store.account) {
    const salt = crypto.randomBytes(16).toString('hex');
    const id = process.env.TEACHER_ID || 'wia2026';
    const pw = process.env.TEACHER_PW || '12345678';
    store.account = { id, salt, hash: hashPw(pw, salt) };
    metaChanged();
    console.log(`[위아] 처음 실행이라 선생님 계정을 만들었어요: 아이디 ${id}`);
  }
}
function scheduleFlush() { if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flushing = flushing.then(flush); }, 500); }
async function flush() {
  if (!PG_URL) {
    const tmp = DATA_FILE + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(store)); fs.renameSync(tmp, DATA_FILE); } catch (e) { console.error('[위아] 저장 실패', e.message); }
    dirtyKV.clear(); dirtyMeta = false; return;
  }
  const keys = Array.from(dirtyKV); dirtyKV.clear();
  const meta = dirtyMeta; dirtyMeta = false;
  const up = [], del = [];
  keys.forEach(k => { if (Object.prototype.hasOwnProperty.call(store.kv, k)) up.push(['kv:' + k, store.kv[k]]); else del.push('kv:' + k); });
  if (meta) { up.push(['meta:account', JSON.stringify(store.account)]); up.push(['meta:sessions', JSON.stringify(store.sessions)]); }
  try {
    if (up.length) {
      const params = [], vals = up.map((r, i) => { params.push(r[0], r[1]); return `($${i * 2 + 1}, $${i * 2 + 2}, now())`; });
      await pool.query(`INSERT INTO wia_store (k, v, updated_at) VALUES ${vals.join(',')} ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated_at = now()`, params);
    }
    if (del.length) await pool.query('DELETE FROM wia_store WHERE k = ANY($1)', [del]);
  } catch (e) {
    console.error('[위아] 저장 실패, 다시 시도해요', e.message);
    keys.forEach(k => dirtyKV.add(k)); if (meta) dirtyMeta = true;
    setTimeout(scheduleFlush, 2000);
  }
}
function kvSet(k, v) { store.kv[k] = v; dirtyKV.add(k); scheduleFlush(); }
function kvDel(k) { delete store.kv[k]; dirtyKV.add(k); scheduleFlush(); }
function metaChanged() { dirtyMeta = true; scheduleFlush(); }
function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 32).toString('hex'); }
async function shutdown() {
  clearTimeout(flushTimer); flushTimer = null;
  try { await flushing; await flush(); if (pool) await pool.end(); } catch (e) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function live() { try { return JSON.parse(store.kv[LIVE_KEY] || 'null'); } catch (e) { return null; } }
function liveOpen(code) { const lv = live(); return lv && lv.code === code && (lv.status === 'open' || lv.status === 'running') ? lv : null; }

/* ---------- 선생님 로그인 (쿠키 세션) ---------- */
function parseCookies(h) { const o = {}; String(h || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return o; }
function sessionOf(cookieHeader) {
  const t = parseCookies(cookieHeader).wia_s; if (!t) return null;
  const s = store.sessions[t]; if (!s) return null;
  if (s.exp < Date.now()) { delete store.sessions[t]; metaChanged(); return null; }
  return t;
}
function isHttps(req) { return req.secure || req.headers['x-forwarded-proto'] === 'https'; }
function setSession(req, res, token) {
  const max = token ? SESSION_DAYS * 86400 : 0;
  res.setHeader('Set-Cookie', `wia_s=${token || ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${max}${isHttps(req) ? '; Secure' : ''}`);
}
const fails = new Map();
function tooMany(ip, max) { const f = fails.get(ip); return f && f.n >= (max || 8) && Date.now() - f.t < 5 * 60000; }
function failed(ip) { const f = fails.get(ip) || { n: 0, t: Date.now() }; if (Date.now() - f.t > 5 * 60000) { f.n = 0; f.t = Date.now(); } f.n++; fails.set(ip, f); }
function safeEq(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function checkPw(pw) { return safeEq(hashPw(pw, store.account.salt), store.account.hash); }

/* ---------- 웹 서버 ---------- */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(compression());
app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});
const INDEX = path.join(__dirname, 'public', 'index.html');
const sendIndex = (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(INDEX); };
app.get('/', sendIndex);
app.get('/teacher', sendIndex);
app.get('/j/:code', (req, res) => res.redirect('/?code=' + encodeURIComponent(String(req.params.code).replace(/\D/g, '').slice(0, 6))));

/* 페이지가 처음 열릴 때 필요한 데이터 (선생님: 전체 / 학생: 자기 수업만) */
app.get('/api/snapshot', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const tok = sessionOf(req.headers.cookie);
  if (tok) return res.json({ teacher: true, me: store.account.id, kv: store.kv });
  const code = String(req.query.code || ''), sid = String(req.query.sid || '');
  const kv = {};
  const lv = live();
  if (lv && /^\d{6}$/.test(code) && lv.code === code) {
    kv[LIVE_KEY] = store.kv[LIVE_KEY];
    if (sid && store.kv[STU + sid]) kv[STU + sid] = store.kv[STU + sid];
  }
  res.json({ teacher: false, kv });
});
app.get('/api/live', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const code = String(req.query.code || '');
  if (!/^\d{6}$/.test(code)) return res.json({ live: null });
  if (tooMany('code:' + req.ip, 80)) return res.status(429).json({ live: null, error: '잠시 뒤에 다시 해 주세요.' });
  const lv = liveOpen(code);
  if (!lv) failed('code:' + req.ip);
  res.json({ live: lv ? store.kv[LIVE_KEY] : null });
});
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (tooMany(ip)) return res.status(429).json({ ok: false, error: '로그인을 여러 번 틀렸어요. 5분 뒤에 다시 해 주세요.' });
  const { id, pw } = req.body || {};
  if (String(id || '').trim() !== store.account.id || !checkPw(pw || '')) { failed(ip); return res.status(401).json({ ok: false, error: '아이디 또는 비밀번호가 맞지 않아요.' }); }
  fails.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  store.sessions[token] = { exp: Date.now() + SESSION_DAYS * 86400000 };
  metaChanged(); setSession(req, res, token); res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  const tok = sessionOf(req.headers.cookie); if (tok) { delete store.sessions[tok]; metaChanged(); }
  setSession(req, res, ''); res.json({ ok: true });
});
app.post('/api/account', (req, res) => {
  const tok = sessionOf(req.headers.cookie);
  if (!tok) return res.status(401).json({ ok: false, error: '다시 로그인해 주세요.' });
  const { id, cur, next } = req.body || {};
  if (tooMany('acc:' + req.ip)) return res.status(429).json({ ok: false, error: '잠시 뒤에 다시 해 주세요.' });
  if (!checkPw(cur || '')) { failed('acc:' + req.ip); return res.status(400).json({ ok: false, error: '현재 비밀번호가 맞지 않아요.' }); }
  if (!/^[A-Za-z0-9]{4,20}$/.test(String(id || ''))) return res.status(400).json({ ok: false, error: '아이디는 영문과 숫자로 4~20자를 써 주세요.' });
  if (next && String(next).length < 8) return res.status(400).json({ ok: false, error: '새 비밀번호는 8자 이상으로 써 주세요.' });
  store.account.id = String(id);
  if (next) {
    store.account.salt = crypto.randomBytes(16).toString('hex');
    store.account.hash = hashPw(next, store.account.salt);
    store.sessions = { [tok]: store.sessions[tok] }; // 다른 기기의 로그인은 끊음
  }
  metaChanged(); res.json({ ok: true, me: store.account.id });
});
/* 학생 입장용 QR (선생님 화면에서 씀) */
app.get('/qr/:code.svg', async (req, res) => {
  const code = String(req.params.code).replace(/\D/g, '').slice(0, 6);
  const origin = (process.env.PUBLIC_URL || `${isHttps(req) ? 'https' : 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`).replace(/\/$/, '');
  try {
    const svg = await QRCode.toString(`${origin}/j/${code}`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#1d2447', light: '#ffffff' } });
    res.setHeader('Content-Type', 'image/svg+xml'); res.setHeader('Cache-Control', 'no-cache'); res.send(svg);
  } catch (e) { res.status(500).end(); }
});
app.get('/healthz', (req, res) => res.json({ ok: true, live: !!live() }));
app.use((req, res) => res.status(404).send('페이지를 찾을 수 없어요.'));

/* ---------- 실시간 연결 ---------- */
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 6e6, pingInterval: 10000, pingTimeout: 8000 });
const room = code => 'code:' + code;
function clip(s, n) { return String(s == null ? '' : s).slice(0, n); }

io.on('connection', socket => {
  const teacher = !!sessionOf(socket.handshake.headers.cookie);
  const a = socket.handshake.auth || {};
  const sCode = /^\d{6}$/.test(a.code || '') ? a.code : '', sSid = /^[a-z0-9]{6,24}$/.test(a.sid || '') ? a.sid : '';
  if (teacher) socket.join('teacher');
  if (sCode) socket.join(room(sCode));

  function broadcastLive(prevCode) {
    const lv = live();
    socket.to('teacher').emit('kv', { key: LIVE_KEY, value: store.kv[LIVE_KEY] });
    const codes = new Set([lv && lv.code, prevCode].filter(Boolean));
    codes.forEach(c => socket.to(room(c)).emit('kv', { key: LIVE_KEY, value: store.kv[LIVE_KEY] }));
  }

  socket.on('set', (msg, ack) => {
    const done = r => { if (typeof ack === 'function') ack(r); };
    if (!msg || typeof msg.key !== 'string' || typeof msg.value !== 'string') return done({ ok: false });
    const { key, value } = msg;
    if (teacher) {
      if (key === DB_KEY) { if (value.length > 5e6) return done({ ok: false }); kvSet(key, value); socket.to('teacher').emit('kv', { key, value }); return done({ ok: true }); }
      if (key === LIVE_KEY) { const prev = live(); kvSet(key, value); broadcastLive(prev && prev.code); return done({ ok: true }); }
      if (key.startsWith(STU)) { kvSet(key, value); socket.to('teacher').emit('kv', { key, value }); return done({ ok: true }); }
      return done({ ok: false });
    }
    /* 학생은 자기 기록만, 지금 열린 수업에만 쓸 수 있어요 */
    if (key !== STU + sSid || !sSid) return done({ ok: false });
    let r; try { r = JSON.parse(value); } catch (e) { return done({ ok: false }); }
    const lv = live();
    if (!lv || lv.status === 'ended' || r.code !== lv.code || r.epoch !== lv.epoch || r.sid !== sSid) return done({ ok: false });
    const clean = {
      sid: sSid, code: lv.code, epoch: lv.epoch, joinedAt: +r.joinedAt || Date.now(), nick: clip(r.nick, 20),
      picks: Array.isArray(r.picks) ? r.picks.slice(0, 3).map(v => (v === null || v === undefined) ? null : +v) : [null, null, null],
      rp: Array.isArray(r.rp) ? r.rp.slice(0, 6).map(v => v === 'ok' || v === 'sus' ? v : null) : [null, null, null],
      ans: clip(r.ans, 1000), step: +r.step || 0, fin: !!r.fin
    };
    const v = JSON.stringify(clean);
    kvSet(key, v); io.to('teacher').emit('kv', { key, value: v });
    done({ ok: true });
  });

  /* 앞서 보낸 저장이 서버에 반영됐는지 확인 (순서대로 처리되므로 이 답이 오면 앞의 저장도 끝난 것) */
  socket.on('sync-check', ack => { if (typeof ack === 'function') ack({ ok: true }); });

  socket.on('del', (msg, ack) => {
    const done = r => { if (typeof ack === 'function') ack(r); };
    const key = msg && msg.key;
    if (typeof key !== 'string') return done({ ok: false });
    const allowed = teacher ? (key.startsWith(STU) || key === LIVE_KEY) : (sSid && key === STU + sSid);
    if (!allowed) return done({ ok: false });
    kvDel(key);
    io.to('teacher').except(socket.id).emit('kv', { key, value: null });
    done({ ok: true });
  });
});

loadStore().then(() => server.listen(PORT, () => console.log(`[위아] http://localhost:${PORT} 에서 실행 중 (학생: /  선생님: /teacher  TV: /teacher?tv=1)`))).catch(e => { console.error('[위아] 시작하지 못했어요:', e.message); process.exit(1); });
