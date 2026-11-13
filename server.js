/* 위아 WIA 서버
   - 학생(/), 선생님(/teacher), 회원가입(/signup), 관리자 모니터링(/admin)을 함께 서비스해요.
   - 선생님마다 데이터(클래스·콘텐츠·수업·학생 기록)를 따로 저장하고, 수업은 Socket.IO로 실시간 주고받아요.
   - 저장: DATABASE_URL이 있으면 PostgreSQL, 없으면 DATA_DIR/wia-data.json 파일. */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const multer = require('multer');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const AI = require('./lib/ai');
const MAIL = require('./lib/mail');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'wia-data.json');
const DB_KEY = 'wia-teacher-draft-v5';
const LIVE_KEY = 'wia-live';
const STU = 'wia-stu:';
const SESSION_DAYS = 14;
const ADMIN_ID = process.env.ADMIN_ID || 'admin';
const ADMIN_PW = process.env.ADMIN_PW || '';
const ANTHROPIC_KEY = () => process.env.ANTHROPIC_API_KEY || '';
const STARTED = Date.now();

/* ================= 저장소 =================
   모든 값은 "행(k → 문자열)"으로 저장해요. 서버는 메모리에 다 들고 있고 바뀐 행만 0.5초마다 저장해요.
   t:<tid>            선생님 계정
   kv:<tid>:<key>     선생님별 화면 데이터 (wia-teacher-draft-v5, wia-live, wia-stu:*)
   meta:sessions      로그인 세션
   meta:cfg           관리자 설정 (제한, AI 모델, 프롬프트)
   log:<id>           AI 생성 기록
   mail:<id>          보낸 메일 기록 */
const rows = new Map();
const PG_URL = process.env.DATABASE_URL || '';
let pool = null;
const dirty = new Set(); let flushTimer = null; let flushing = Promise.resolve();
function put(k, v) { rows.set(k, v); dirty.add(k); scheduleFlush(); }
function drop(k) { if (rows.delete(k)) { dirty.add(k); scheduleFlush(); } }

let teachers = {};          // tid → 계정
let tkv = {};               // tid → Map(key → value)
let sessions = {};          // token → { tid | admin, exp }
let cfg = null;
let logs = [];              // AI 기록 (최신이 앞)
let mails = [];             // 메일 기록 (최신이 앞)

const DEFAULT_CFG = () => ({
  limits: { maxStudents: 40, aiPerDay: 10, aiPerMonth: 100, maxFiles: 5, maxUploadMB: 20, maxPages: 20, maxLessons: 60 },
  global: { signupOpen: true, autoApproveDomains: [], monthlyBudgetUSD: 30, maxTotalStudents: 300, aiConcurrent: 3, aiEnabled: true, maxTextChars: 200000 },
  ai: { model: 'claude-sonnet-5-5', maxTokens: 16000, temperature: null },
  prompts: [{ v: 1, at: Date.now(), note: '처음 기본 프롬프트', system: AI.DEFAULT_SYSTEM, user: AI.DEFAULT_USER }],
  promptActive: 1
});

async function loadStore() {
  let legacy = null;
  if (PG_URL) {
    const { Pool } = require('pg');
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(PG_URL);
    pool = new Pool({ connectionString: PG_URL, ssl: local ? false : { rejectUnauthorized: false }, max: 4 });
    await pool.query('CREATE TABLE IF NOT EXISTS wia_store (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())');
    const { rows: rs } = await pool.query('SELECT k, v FROM wia_store');
    rs.forEach(r => rows.set(r.k, r.v));
    console.log(`[위아] PostgreSQL에 연결했어요 (저장된 행 ${rs.length}개)`);
  } else {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    try {
      const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (j.rows) Object.keys(j.rows).forEach(k => rows.set(k, j.rows[k]));
      else legacy = j; // 예전 파일 형식 { kv, account, sessions }
    } catch (e) { /* 처음 실행 */ }
    console.log(`[위아] 파일에 저장해요: ${DATA_FILE}`);
  }
  /* 예전 버전(선생님 한 명) 데이터를 첫 선생님(t1) 것으로 옮겨요 */
  if (legacy) {
    if (legacy.account) rows.set('meta:account', JSON.stringify(legacy.account));
    if (legacy.sessions) rows.set('meta:sessions', JSON.stringify(legacy.sessions));
    Object.keys(legacy.kv || {}).forEach(k => rows.set('kv:' + k, legacy.kv[k]));
    legacy = null;
  }
  const oldAcc = rows.get('meta:account');
  const oldKv = Array.from(rows.keys()).filter(k => /^kv:wia-/.test(k));
  if (oldAcc || oldKv.length) {
    if (!rows.has('t:t1')) {
      const a = oldAcc ? JSON.parse(oldAcc) : null;
      const t = newTeacher({ id: 't1', login: (a && a.id) || process.env.TEACHER_ID || 'wia2026', name: '', status: 'active', emailVerified: true });
      if (a) { t.salt = a.salt; t.hash = a.hash; } else setPw(t, process.env.TEACHER_PW || '12345678');
      put('t:t1', JSON.stringify(t));
    }
    oldKv.forEach(k => { put('kv:t1:' + k.slice(3), rows.get(k)); drop(k); });
    if (oldAcc) drop('meta:account');
    console.log(`[위아] 예전 데이터를 첫 선생님 계정(t1)으로 옮겼어요 (${oldKv.length}개)`);
  }
  /* 메모리 구조 만들기 */
  for (const [k, v] of rows) {
    try {
      if (k.startsWith('t:')) { const t = JSON.parse(v); teachers[t.id] = t; }
      else if (k.startsWith('kv:')) { const m = k.match(/^kv:(t[a-z0-9]+):(.*)$/); if (m) { (tkv[m[1]] || (tkv[m[1]] = new Map())).set(m[2], v); } }
      else if (k === 'meta:sessions') sessions = JSON.parse(v) || {};
      else if (k === 'meta:cfg') cfg = JSON.parse(v);
      else if (k.startsWith('log:')) logs.push(JSON.parse(v));
      else if (k.startsWith('mail:')) mails.push(JSON.parse(v));
    } catch (e) { console.error('[위아] 읽지 못한 행', k, e.message); }
  }
  /* 예전 세션(선생님 한 명 시절)은 첫 선생님 것으로 */
  let sesCh = false; Object.keys(sessions).forEach(k => { const x = sessions[k]; if (x && !x.tid && !x.admin) { x.tid = 't1'; sesCh = true; } }); if (sesCh) saveSessions();
  logs.sort((a, b) => b.at - a.at); mails.sort((a, b) => b.at - a.at);
  const d = DEFAULT_CFG();
  if (!cfg) { cfg = d; saveCfg(); }
  else {
    cfg.limits = Object.assign(d.limits, cfg.limits); cfg.global = Object.assign(d.global, cfg.global); cfg.ai = Object.assign(d.ai, cfg.ai);
    if (!Array.isArray(cfg.prompts) || !cfg.prompts.length) { cfg.prompts = d.prompts; cfg.promptActive = 1; }
  }
  /* 계정이 하나도 없으면 첫 선생님 계정을 만들어요 */
  if (!Object.keys(teachers).length) {
    const t = newTeacher({ id: 't1', login: process.env.TEACHER_ID || 'wia2026', name: '', status: 'active', emailVerified: true });
    setPw(t, process.env.TEACHER_PW || '12345678'); saveTeacher(t);
    console.log(`[위아] 처음 실행이라 선생님 계정을 만들었어요: 아이디 ${t.login}`);
  }
  /* 메일·기록은 최근 것만 남겨요 */
  while (mails.length > 300) drop('mail:' + mails.pop().id);
  while (logs.length > 2000) drop('log:' + logs.pop().id);
}
function scheduleFlush() { if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flushing = flushing.then(flush); }, 500); }
async function flush() {
  if (!PG_URL) {
    const tmp = DATA_FILE + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify({ rows: Object.fromEntries(rows) })); fs.renameSync(tmp, DATA_FILE); } catch (e) { console.error('[위아] 저장 실패', e.message); }
    dirty.clear(); return;
  }
  const keys = Array.from(dirty); dirty.clear();
  const up = [], del = [];
  keys.forEach(k => { if (rows.has(k)) up.push([k, rows.get(k)]); else del.push(k); });
  try {
    for (let i = 0; i < up.length; i += 100) {
      const part = up.slice(i, i + 100), params = [];
      const vals = part.map((r, j) => { params.push(r[0], r[1]); return `($${j * 2 + 1}, $${j * 2 + 2}, now())`; });
      await pool.query(`INSERT INTO wia_store (k, v, updated_at) VALUES ${vals.join(',')} ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated_at = now()`, params);
    }
    if (del.length) await pool.query('DELETE FROM wia_store WHERE k = ANY($1)', [del]);
  } catch (e) {
    console.error('[위아] 저장 실패, 다시 시도해요', e.message);
    keys.forEach(k => dirty.add(k));
    setTimeout(scheduleFlush, 2000);
  }
}
async function shutdown() {
  clearTimeout(flushTimer); flushTimer = null;
  try { await flushing; await flush(); if (pool) await pool.end(); } catch (e) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/* ---------- 데이터 도우미 ---------- */
function rid(p) { return p + crypto.randomBytes(6).toString('hex'); }
function newTeacher(o) {
  return Object.assign({ id: rid('t'), login: '', email: '', name: '', school: '', subject: '', grade: '', memo: '', salt: '', hash: '', status: 'pending_email', emailVerified: false, createdAt: Date.now(), approvedAt: 0, lastLoginAt: 0, lastSeenAt: 0, limits: {}, note: '' }, o);
}
function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 32).toString('hex'); }
function setPw(t, pw) { t.salt = crypto.randomBytes(16).toString('hex'); t.hash = hashPw(pw, t.salt); }
function safeEq(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function checkPw(t, pw) { return !!(t && t.hash) && safeEq(hashPw(pw, t.salt), t.hash); }
function saveTeacher(t) { teachers[t.id] = t; put('t:' + t.id, JSON.stringify(t)); }
function saveSessions() { put('meta:sessions', JSON.stringify(sessions)); }
function saveCfg() { put('meta:cfg', JSON.stringify(cfg)); }
function sha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function findByLogin(v) {
  v = String(v || '').trim().toLowerCase(); if (!v) return null;
  return Object.values(teachers).find(t => (t.email && t.email.toLowerCase() === v) || (t.login && t.login.toLowerCase() === v)) || null;
}
function limitsOf(t) { return Object.assign({}, cfg.limits, (t && t.limits) || {}); }
function pubTeacher(t) {
  const o = {}; ['id', 'login', 'email', 'name', 'school', 'subject', 'grade', 'memo', 'status', 'emailVerified', 'createdAt', 'approvedAt', 'lastLoginAt', 'lastSeenAt', 'limits', 'note'].forEach(k => { o[k] = t[k]; });
  return o;
}

function kvMap(tid) { return tkv[tid] || (tkv[tid] = new Map()); }
function kvGet(tid, k) { const m = tkv[tid]; return m ? m.get(k) : undefined; }
function kvSet(tid, k, v) { kvMap(tid).set(k, v); put(`kv:${tid}:${k}`, v); }
function kvDel(tid, k) { const m = tkv[tid]; if (m) m.delete(k); drop(`kv:${tid}:${k}`); }
function kvObj(tid) { const o = {}; const m = tkv[tid]; if (m) for (const [k, v] of m) o[k] = v; return o; }
function live(tid) { try { return JSON.parse(kvGet(tid, LIVE_KEY) || 'null'); } catch (e) { return null; } }
function isOpen(lv) { return lv && (lv.status === 'open' || lv.status === 'running'); }
/* 수업 코드 → 선생님. 같은 코드가 여럿이면 열린 수업, 그다음 최근 것을 골라요. */
function ownerOf(code, openOnly) {
  if (!/^\d{6}$/.test(code || '')) return null;
  let best = null, bestScore = -1;
  for (const tid of Object.keys(tkv)) {
    const lv = live(tid);
    if (!lv || lv.code !== code) continue;
    if (openOnly && !isOpen(lv)) continue;
    const t = teachers[tid]; if (!t || t.status !== 'active') continue;
    const sc = (isOpen(lv) ? 1e15 : 0) + (+lv.epoch || 0);
    if (sc > bestScore) { bestScore = sc; best = tid; }
  }
  return best;
}
function studentsIn(tid, lv) {
  let n = 0; const m = tkv[tid]; if (!m || !lv) return 0;
  for (const [k, v] of m) {
    if (!k.startsWith(STU)) continue;
    try { const r = JSON.parse(v); if (r.code === lv.code && r.epoch === lv.epoch) n++; } catch (e) {}
  }
  return n;
}
function lessonsOf(tid) { try { const d = JSON.parse(kvGet(tid, DB_KEY) || 'null'); return (d && Array.isArray(d.lessons)) ? d.lessons : []; } catch (e) { return []; } }

/* ---------- 세션 (쿠키) ---------- */
function parseCookies(h) { const o = {}; String(h || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return o; }
function sessionOf(cookieHeader, name) {
  const tok = parseCookies(cookieHeader)[name || 'wia_s']; if (!tok) return null;
  const s = sessions[tok]; if (!s) return null;
  if (s.exp < Date.now()) { delete sessions[tok]; saveSessions(); return null; }
  return Object.assign({ tok }, s);
}
function teacherOf(req) {
  const s = sessionOf(req.headers.cookie); if (!s || !s.tid) return null;
  const t = teachers[s.tid]; if (!t || t.status !== 'active') return null;
  return t;
}
function adminOf(req) { const s = sessionOf(req.headers.cookie, 'wia_a'); return s && s.admin ? s : null; }
function isHttps(req) { return req.secure || req.headers['x-forwarded-proto'] === 'https'; }
function setCookie(req, res, name, token, days) {
  const max = token ? Math.round(days * 86400) : 0;
  res.append('Set-Cookie', `${name}=${token || ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${max}${isHttps(req) ? '; Secure' : ''}`);
}
function newSession(o, days) { const tok = crypto.randomBytes(32).toString('hex'); sessions[tok] = Object.assign({ exp: Date.now() + days * 86400000, at: Date.now() }, o); saveSessions(); return tok; }
function dropSessions(tid, keep) { let ch = false; Object.keys(sessions).forEach(k => { if (sessions[k].tid === tid && k !== keep) { delete sessions[k]; ch = true; } }); if (ch) saveSessions(); }
function baseUrl(req) { return (process.env.PUBLIC_URL || `${isHttps(req) ? 'https' : 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`).replace(/\/$/, ''); }

/* ---------- 잠깐 막기 (여러 번 틀림) ---------- */
const fails = new Map();
function tooMany(key, max, winMs) { const f = fails.get(key); return !!f && f.n >= (max || 8) && Date.now() - f.t < (winMs || 5 * 60000); }
function failed(key, winMs) { const f = fails.get(key) || { n: 0, t: Date.now() }; if (Date.now() - f.t > (winMs || 5 * 60000)) { f.n = 0; f.t = Date.now(); } f.n++; fails.set(key, f); }
setInterval(() => { const now = Date.now(); for (const [k, f] of fails) if (now - f.t > 3600000) fails.delete(k); }, 600000).unref();

/* ---------- 메일 ---------- */
async function sendMail(kind, to, tpl, tid) {
  const r = await MAIL.send({ to, subject: tpl.subject, html: tpl.html, text: tpl.text });
  const link = (tpl.text.match(/https?:\/\/\S+/) || [''])[0];
  const m = { id: rid('m'), at: Date.now(), kind, to, tid: tid || '', subject: tpl.subject, mode: r.mode, ok: r.ok, error: r.error || '', link };
  mails.unshift(m); put('mail:' + m.id, JSON.stringify(m));
  while (mails.length > 300) drop('mail:' + mails.pop().id);
  if (!r.ok) console.error('[위아] 메일 실패', to, r.error);
  return m;
}

/* ================= 사용량 측정 ================= */
const conn = { teacher: new Map(), student: new Map() };   // tid → Map(socketId → 정보)
const usage = {};                                            // tid → { ev, bytes } (지금 1분)
const usageHist = {};                                        // tid → [{ m, ev, bytes }] 24시간
let reqCount = 0, evCount = 0;
const hist = [];                                             // 1분마다 서버 상태 (24시간)
let cpuPrev = process.cpuUsage(), cpuAt = Date.now(), cpuPct = 0;
function addUse(tid, bytes) { if (!tid) return; const u = usage[tid] || (usage[tid] = { ev: 0, bytes: 0 }); u.ev++; u.bytes += bytes || 0; evCount++; }
function countConn(kind, tid) { const m = conn[kind].get(tid); return m ? m.size : 0; }
function totalConn(kind) { let n = 0; for (const m of conn[kind].values()) n += m.size; return n; }
function sample() {
  const now = Date.now(), c = process.cpuUsage(cpuPrev);
  cpuPct = Math.min(100, ((c.user + c.system) / 1000) / Math.max(1, now - cpuAt) * 100);
  cpuPrev = process.cpuUsage(); cpuAt = now;
  const mu = process.memoryUsage();
  let liveN = 0; Object.keys(tkv).forEach(tid => { if (isOpen(live(tid))) liveN++; });
  hist.push({ t: now, tch: Array.from(conn.teacher.values()).filter(m => m.size).length, stu: totalConn('student'), live: liveN, rss: Math.round(mu.rss / 1048576), cpu: Math.round(cpuPct * 10) / 10, req: reqCount, ev: evCount });
  reqCount = 0; evCount = 0;
  while (hist.length > 1440) hist.shift();
  const m = Math.floor(now / 60000);
  Object.keys(usage).forEach(tid => { const h = usageHist[tid] || (usageHist[tid] = []); h.push(Object.assign({ m }, usage[tid])); while (h.length && h[0].m < m - 1440) h.shift(); });
  Object.keys(usage).forEach(k => delete usage[k]);
}
setInterval(sample, 60000).unref();
function useSum(tid, mins) {
  const h = usageHist[tid] || [], from = Math.floor(Date.now() / 60000) - mins, u = usage[tid] || { ev: 0, bytes: 0 };
  return h.reduce((a, x) => { if (x.m >= from) { a.ev += x.ev; a.bytes += x.bytes; } return a; }, { ev: u.ev, bytes: u.bytes });
}

/* AI 사용량 */
const DAY = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);     // 한국 날짜
const MONTH = () => DAY().slice(0, 7);
function kDay(at) { return new Date(at + 9 * 3600000).toISOString().slice(0, 10); }
function aiUse(tid) {
  const d = DAY(), m = MONTH(); let day = 0, month = 0, cost = 0, tokIn = 0, tokOut = 0;
  logs.forEach(l => {
    if (tid && l.tid !== tid) return;
    if (l.mode !== 'ai') return;
    const ld = kDay(l.at);
    if (ld.slice(0, 7) === m) { month++; cost += l.cost || 0; tokIn += (l.usage && l.usage.input_tokens) || 0; tokOut += (l.usage && l.usage.output_tokens) || 0; if (ld === d) day++; }
  });
  return { day, month, cost, tokIn, tokOut };
}
function aiCount(tid) { // 한도 계산용: 시범 모드도 한 번으로 셈
  const d = DAY(), m = MONTH(); let day = 0, month = 0;
  logs.forEach(l => { if (l.tid !== tid || l.status === 'error') return; const ld = kDay(l.at); if (ld.slice(0, 7) === m) { month++; if (ld === d) day++; } });
  return { day, month };
}

/* ================= 웹 서버 ================= */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(compression());
app.use((req, res, next) => {
  reqCount++;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});
app.use(express.json({ limit: '2mb' }));
const PUB = path.join(__dirname, 'public');
const page = f => (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(PUB, f)); };
app.get('/', page('index.html'));
app.get('/teacher', page('index.html'));
['/signup', '/forgot', '/reset'].forEach(p => app.get(p, page('account.html')));
app.get('/admin', page('admin.html'));
app.get('/j/:code', (req, res) => res.redirect('/?code=' + encodeURIComponent(String(req.params.code).replace(/\D/g, '').slice(0, 6))));

/* 페이지가 처음 열릴 때 필요한 데이터 (선생님: 자기 데이터 전체 / 학생: 자기 수업만) */
function teacherInfo(t) {
  const L = limitsOf(t);
  return { teacher: true, me: t.email || t.login, name: t.name || '', tid: t.id, ai: !!(ANTHROPIC_KEY() && cfg.global.aiEnabled), aiTest: !ANTHROPIC_KEY(), limits: { maxFiles: L.maxFiles, maxUploadMB: L.maxUploadMB, maxPages: L.maxPages, maxStudents: L.maxStudents, maxLessons: L.maxLessons } };
}
app.get('/api/snapshot', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const t = teacherOf(req);
  if (t) { t.lastSeenAt = Date.now(); saveTeacher(t); return res.json(Object.assign(teacherInfo(t), { kv: kvObj(t.id) })); }
  const code = String(req.query.code || ''), sid = String(req.query.sid || '');
  const kv = {}, tid = ownerOf(code);
  if (tid) {
    kv[LIVE_KEY] = kvGet(tid, LIVE_KEY);
    if (/^[a-z0-9]{6,24}$/.test(sid) && kvGet(tid, STU + sid)) kv[STU + sid] = kvGet(tid, STU + sid);
  }
  res.json({ teacher: false, kv });
});
app.get('/api/live', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const code = String(req.query.code || '');
  if (!/^\d{6}$/.test(code)) return res.json({ live: null });
  if (tooMany('code:' + req.ip, 80)) return res.status(429).json({ live: null, error: '잠시 뒤에 다시 해 주세요.' });
  const tid = ownerOf(code, true);
  if (!tid) { failed('code:' + req.ip); return res.json({ live: null }); }
  const lv = live(tid), L = limitsOf(teachers[tid]);
  if (studentsIn(tid, lv) >= L.maxStudents) return res.json({ live: null, error: `이 수업은 정원(${L.maxStudents}명)이 다 찼어요. 선생님께 알려 주세요.` });
  if (totalConn('student') >= cfg.global.maxTotalStudents) return res.json({ live: null, error: '지금 위아에 접속한 학생이 너무 많아요. 잠시 뒤에 다시 해 주세요.' });
  res.json({ live: kvGet(tid, LIVE_KEY) });
});

/* ---------- 선생님 로그인·계정 ---------- */
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (tooMany(ip)) return res.status(429).json({ ok: false, error: '로그인을 여러 번 틀렸어요. 5분 뒤에 다시 해 주세요.' });
  const { id, pw } = req.body || {};
  const t = findByLogin(id);
  if (!t || !checkPw(t, pw || '')) { failed(ip); return res.status(401).json({ ok: false, error: '이메일(아이디) 또는 비밀번호가 맞지 않아요.' }); }
  fails.delete(ip);
  if (t.status === 'pending_email') return res.status(403).json({ ok: false, state: 'pending_email', error: MAIL.mode() === 'test' ? '가입 신청을 받았어요. 관리자가 확인한 뒤 계정을 열어 드려요.' : '아직 이메일 인증을 하지 않았어요. 가입할 때 받은 메일의 버튼을 눌러 주세요. (메일이 없으면 스팸함을 확인하거나 회원가입 화면에서 다시 신청해 주세요.)' });
  if (t.status === 'pending_approval') return res.status(403).json({ ok: false, state: 'pending_approval', error: '관리자가 계정을 확인하고 있어요. 승인되면 메일로 알려 드릴게요.' });
  if (t.status === 'suspended') return res.status(403).json({ ok: false, state: 'suspended', error: '이 계정은 잠시 멈춰 있어요. 관리자에게 문의해 주세요.' });
  if (t.status !== 'active') return res.status(403).json({ ok: false, error: '로그인할 수 없는 계정이에요.' });
  t.lastLoginAt = Date.now(); saveTeacher(t);
  setCookie(req, res, 'wia_s', newSession({ tid: t.id }, SESSION_DAYS), SESSION_DAYS);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  const s = sessionOf(req.headers.cookie); if (s) { delete sessions[s.tok]; saveSessions(); }
  setCookie(req, res, 'wia_s', '', 0); res.json({ ok: true });
});
app.post('/api/account', (req, res) => {
  const s = sessionOf(req.headers.cookie), t = teacherOf(req);
  if (!t) return res.status(401).json({ ok: false, error: '다시 로그인해 주세요.' });
  const { id, cur, next, name } = req.body || {};
  if (tooMany('acc:' + req.ip)) return res.status(429).json({ ok: false, error: '잠시 뒤에 다시 해 주세요.' });
  if (!checkPw(t, cur || '')) { failed('acc:' + req.ip); return res.status(400).json({ ok: false, error: '현재 비밀번호가 맞지 않아요.' }); }
  if (next && String(next).length < 8) return res.status(400).json({ ok: false, error: '새 비밀번호는 8자 이상으로 써 주세요.' });
  const newId = String(id || '').trim();
  if (!t.email) { // 예전 아이디 계정만 아이디를 바꿀 수 있어요 (이메일 계정은 이메일이 아이디)
    if (!/^[A-Za-z0-9]{4,20}$/.test(newId)) return res.status(400).json({ ok: false, error: '아이디는 영문과 숫자로 4~20자를 써 주세요.' });
    const other = findByLogin(newId); if (other && other.id !== t.id) return res.status(400).json({ ok: false, error: '이미 쓰고 있는 아이디예요.' });
    t.login = newId;
  }
  if (typeof name === 'string' && name.trim()) t.name = name.trim().slice(0, 30);
  if (next) { setPw(t, next); dropSessions(t.id, s.tok); }
  saveTeacher(t); res.json({ ok: true, me: t.email || t.login, name: t.name });
});

/* ---------- 회원가입 · 이메일 인증 · 비밀번호 찾기 ---------- */
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
function domainOk(email) {
  const d = email.split('@')[1].toLowerCase();
  return (cfg.global.autoApproveDomains || []).some(x => { x = String(x).trim().toLowerCase().replace(/^@/, ''); return x && (d === x || d.endsWith('.' + x)); });
}
async function issueVerify(req, t) {
  const tok = crypto.randomBytes(24).toString('hex');
  t.verify = { h: sha(tok), exp: Date.now() + 24 * 3600000 }; saveTeacher(t);
  return sendMail('verify', t.email, MAIL.T.verify(t.name, `${baseUrl(req)}/api/verify?token=${tok}`), t.id);
}
app.get('/api/signup-info', (req, res) => res.json({ open: !!cfg.global.signupOpen, mail: MAIL.mode() }));
app.post('/api/signup', async (req, res) => {
  if (!cfg.global.signupOpen) return res.status(403).json({ ok: false, error: '지금은 회원가입을 받지 않아요. 관리자에게 문의해 주세요.' });
  if (tooMany('signup:' + req.ip, 6, 3600000)) return res.status(429).json({ ok: false, error: '가입 신청이 너무 많아요. 1시간 뒤에 다시 해 주세요.' });
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 30), email = String(b.email || '').trim().toLowerCase().slice(0, 200);
  const school = String(b.school || '').trim().slice(0, 60), subject = String(b.subject || '').trim().slice(0, 40), grade = String(b.grade || '').trim().slice(0, 40), memo = String(b.memo || '').trim().slice(0, 300);
  const pw = String(b.pw || '');
  if (!name) return res.status(400).json({ ok: false, field: 'name', error: '이름을 써 주세요.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ ok: false, field: 'email', error: '이메일 주소를 다시 확인해 주세요.' });
  if (pw.length < 8) return res.status(400).json({ ok: false, field: 'pw', error: '비밀번호는 8자 이상으로 써 주세요.' });
  if (!school) return res.status(400).json({ ok: false, field: 'school', error: '학교 이름을 써 주세요.' });
  if (!b.agree) return res.status(400).json({ ok: false, field: 'agree', error: '개인정보 수집·이용에 동의해 주세요.' });
  failed('signup:' + req.ip, 3600000);
  let t = findByLogin(email);
  if (t && t.status !== 'pending_email') return res.status(400).json({ ok: false, field: 'email', error: '이미 가입한 이메일이에요. 로그인하거나 비밀번호 찾기를 해 주세요.' });
  if (!t) t = newTeacher({ email, login: email });
  /* 메일 시범 모드에서는 인증 메일이 못 가니 바로 '승인 대기'로 (관리자가 확인) */
  if (MAIL.mode() === 'test') t.status = 'pending_approval';
  Object.assign(t, { name, school, subject, grade, memo, agreeAt: Date.now() });
  setPw(t, pw);
  saveTeacher(t);
  const m = await issueVerify(req, t);
  if (t.status === 'pending_approval' && process.env.ADMIN_EMAIL && MAIL.mode() === 'live') sendMail('admin', process.env.ADMIN_EMAIL, MAIL.T.adminNew(t, baseUrl(req) + '/admin'), t.id);
  res.json({ ok: true, mail: m.mode, sent: m.ok });
});
app.post('/api/resend', async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (tooMany('resend:' + email, 3, 600000)) return res.status(429).json({ ok: false, error: '잠시 뒤에 다시 보내 주세요.' });
  failed('resend:' + email, 600000);
  const t = findByLogin(email);
  if (t && t.status === 'pending_email' && t.email) await issueVerify(req, t);
  res.json({ ok: true, mail: MAIL.mode() });
});
app.get('/api/verify', async (req, res) => {
  const tok = String(req.query.token || '');
  const t = tok && Object.values(teachers).find(x => x.verify && safeEq(x.verify.h, sha(tok)));
  if (!t) return res.redirect('/signup?v=bad');
  if (t.verify.exp < Date.now()) return res.redirect('/signup?v=expired&email=' + encodeURIComponent(t.email));
  delete t.verify; t.emailVerified = true;
  if (t.status === 'pending_email' || (t.status === 'pending_approval' && !t.approvedAt)) {
    if (domainOk(t.email)) { t.status = 'active'; t.approvedAt = Date.now(); t.note = (t.note ? t.note + ' · ' : '') + '학교 도메인 자동 승인'; }
    else t.status = 'pending_approval';
  }
  saveTeacher(t);
  if (t.status === 'pending_approval' && process.env.ADMIN_EMAIL) sendMail('admin', process.env.ADMIN_EMAIL, MAIL.T.adminNew(t, baseUrl(req) + '/admin'), t.id);
  res.redirect('/signup?v=' + (t.status === 'active' ? 'active' : 'ok'));
});
app.post('/api/forgot', async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (tooMany('forgot:' + req.ip, 5, 600000)) return res.status(429).json({ ok: false, error: '잠시 뒤에 다시 해 주세요.' });
  failed('forgot:' + req.ip, 600000);
  const t = findByLogin(email);
  if (t && t.email && t.status !== 'pending_email') {
    const tok = crypto.randomBytes(24).toString('hex');
    t.reset = { h: sha(tok), exp: Date.now() + 3600000 }; saveTeacher(t);
    await sendMail('reset', t.email, MAIL.T.reset(t.name, `${baseUrl(req)}/reset?token=${tok}`), t.id);
  }
  res.json({ ok: true, mail: MAIL.mode() }); // 가입 여부는 알려 주지 않아요
});
app.post('/api/reset', (req, res) => {
  const { token, pw } = req.body || {};
  const t = token && Object.values(teachers).find(x => x.reset && safeEq(x.reset.h, sha(token)));
  if (!t || t.reset.exp < Date.now()) return res.status(400).json({ ok: false, error: '링크가 만료됐거나 맞지 않아요. 비밀번호 찾기를 다시 해 주세요.' });
  if (String(pw || '').length < 8) return res.status(400).json({ ok: false, error: '비밀번호는 8자 이상으로 써 주세요.' });
  setPw(t, pw); delete t.reset; saveTeacher(t); dropSessions(t.id);
  res.json({ ok: true });
});

/* ---------- AI 콘텐츠 만들기 ---------- */
const upload = multer({ storage: multer.memoryStorage(), defParamCharset: 'utf8', limits: { fileSize: 60 * 1048576, files: 20, fields: 20 } });
let aiRunning = 0; const aiBusy = new Set();
function planOf(n) {
  const head = ['cover'], tail = ['summary'], mid = [];
  if (n >= 4) head.push('goal');
  if (n >= 5) tail.unshift('check');
  for (let i = 0, m = n - head.length - tail.length; i < m; i++) mid.push(i % 3 === 2 ? 'example' : 'concept');
  return head.concat(mid, tail);
}
function activePrompt() { return cfg.prompts.find(p => p.v === cfg.promptActive) || cfg.prompts[cfg.prompts.length - 1]; }
function monthCost() { return aiUse(null).cost; }
app.post('/api/ai/generate', (req, res, next) => {
  const t = teacherOf(req); if (!t) return res.status(401).json({ ok: false, error: '다시 로그인해 주세요.' });
  req.teacher = t; next();
}, upload.array('files', 20), async (req, res) => {
  const t = req.teacher, L = limitsOf(t), files = req.files || [];
  let meta = {}; try { meta = JSON.parse(req.body.meta || '{}'); } catch (e) {}
  const count = Math.min(L.maxPages, Math.max(3, +meta.count || 8));
  const fail = (code, msg) => res.status(code).json({ ok: false, error: msg });
  if (!files.length) return fail(400, '수업 자료를 하나 이상 올려 주세요.');
  if (files.length > L.maxFiles) return fail(400, `자료는 한 번에 ${L.maxFiles}개까지 올릴 수 있어요.`);
  const total = files.reduce((a, f) => a + f.size, 0);
  if (total > L.maxUploadMB * 1048576) return fail(400, `자료 크기가 모두 합쳐 ${L.maxUploadMB}MB를 넘었어요. 파일을 나눠 주세요.`);
  if (+meta.count > L.maxPages) return fail(400, `교육 자료는 ${L.maxPages}장까지 만들 수 있어요.`);
  const used = aiCount(t.id);
  if (used.day >= L.aiPerDay) return fail(429, `오늘 AI로 만들 수 있는 횟수(${L.aiPerDay}번)를 다 썼어요. 내일 다시 해 주세요.`);
  if (used.month >= L.aiPerMonth) return fail(429, `이번 달 AI로 만들 수 있는 횟수(${L.aiPerMonth}번)를 다 썼어요.`);
  if (lessonsOf(t.id).length >= L.maxLessons) return fail(400, `콘텐츠는 ${L.maxLessons}개까지 만들 수 있어요. 안 쓰는 콘텐츠를 지워 주세요.`);
  if (aiBusy.has(t.id)) return fail(429, '이미 만들고 있는 자료가 있어요. 끝난 뒤에 다시 해 주세요.');

  const plan = planOf(count), P = activePrompt();
  const log = { id: rid('g'), tid: t.id, tname: t.name || t.login, at: Date.now(), mode: 'test', status: 'ok', model: '', promptV: P.v, ms: 0,
    input: { title: String(meta.title || '').slice(0, 120), grade: String(meta.grade || '').slice(0, 20), subject: String(meta.subject || '').slice(0, 20), kind: String(meta.kind || '').slice(0, 40), req: String(meta.req || '').slice(0, 1000), count, plan },
    files: [], usage: null, cost: 0, output: null, error: '' };
  const finish = () => { log.ms = Date.now() - log.at; logs.unshift(log); put('log:' + log.id, JSON.stringify(log)); while (logs.length > 2000) drop('log:' + logs.pop().id); };

  aiBusy.add(t.id);
  try {
    const names = Array.isArray(meta.names) ? meta.names : null;
    const prep = await AI.prepareFiles(files, cfg.global.maxTextChars, names);
    log.files = prep.info.map(f => ({ name: f.name, size: f.size, kind: f.kind, chars: f.chars, note: f.note, skip: !!f.skip, text: f.text ? f.text.slice(0, 20000) : '' }));
    const readable = prep.info.filter(f => !f.skip);
    if (!readable.length) { log.status = 'error'; log.error = '읽을 수 있는 자료가 없어요'; finish(); return res.status(400).json({ ok: false, files: log.files, error: '올린 자료를 읽지 못했어요. PDF·워드(docx)·PPT(pptx)·한글(hwpx)·TXT·그림 파일로 올려 주세요. (HWP·PPT·DOC 옛 형식은 PDF로 저장해서 올려 주세요.)' }); }

    const aiOn = !!(ANTHROPIC_KEY() && cfg.global.aiEnabled);
    if (!aiOn) { finish(); return res.json({ ok: true, mode: 'test', id: log.id, files: log.files, note: ANTHROPIC_KEY() ? '관리자가 AI 만들기를 꺼 두었어요. 예시 틀로 만들었어요.' : '아직 AI 키가 없어서 예시 틀로 만들었어요.' }); }
    if (monthCost() >= cfg.global.monthlyBudgetUSD) { log.status = 'error'; log.error = '이번 달 AI 예산을 다 썼어요'; finish(); return fail(429, '이번 달 AI 사용 예산을 다 썼어요. 관리자에게 문의해 주세요.'); }
    if (aiRunning >= cfg.global.aiConcurrent) { log.status = 'error'; log.error = '동시에 만드는 사람이 많아요'; finish(); return fail(429, '지금 다른 선생님들이 자료를 만들고 있어요. 1~2분 뒤에 다시 해 주세요.'); }

    log.mode = 'ai'; log.model = cfg.ai.model;
    const vars = Object.assign({}, log.input, { req: log.input.req || '(없음)', plan: plan.map((k, i) => `${i + 1}.${k}`).join(', '), files: readable.map(f => f.name).join(', ') });
    aiRunning++;
    let out;
    try {
      out = await AI.generate({ apiKey: ANTHROPIC_KEY(), model: cfg.ai.model, maxTokens: cfg.ai.maxTokens, temperature: cfg.ai.temperature, system: P.system, userText: AI.fill(P.user, vars), blocks: prep.blocks });
    } finally { aiRunning--; }
    log.usage = out.usage; log.cost = AI.costOf(cfg.ai.model, out.usage); log.stop = out.stop;
    const result = AI.normalize(out.input, plan);
    log.output = result;
    if (!result.pages.length) { log.status = 'error'; log.error = 'AI가 교육 화면을 만들지 않았어요'; finish(); return fail(502, 'AI가 자료를 만들지 못했어요. 다시 해 주세요.'); }
    finish();
    res.json({ ok: true, mode: 'ai', id: log.id, files: log.files, result });
  } catch (e) {
    log.status = 'error'; log.error = e.message; if (e.usage) { log.usage = e.usage; log.cost = AI.costOf(log.model || cfg.ai.model, e.usage); }
    finish();
    console.error('[위아] AI 만들기 실패', e.message);
    res.status(502).json({ ok: false, error: e.message.startsWith('AI') ? e.message : '자료를 만드는 중 문제가 생겼어요: ' + e.message });
  } finally { aiBusy.delete(t.id); }
});
app.use('/api/ai', (err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ ok: false, error: '파일 하나가 너무 커요 (60MB까지).' });
  next(err);
});

/* ---------- 학생 입장용 QR ---------- */
app.get('/qr/:code.svg', async (req, res) => {
  try {
    const svg = await QRCode.toString(`${baseUrl(req)}/`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#1d2447', light: '#ffffff' } });
    res.setHeader('Content-Type', 'image/svg+xml'); res.setHeader('Cache-Control', 'no-cache'); res.send(svg);
  } catch (e) { res.status(500).end(); }
});
app.get('/healthz', (req, res) => res.json({ ok: true }));

/* ================= 관리자 (모니터링) ================= */
app.post('/api/admin/login', (req, res) => {
  if (!ADMIN_PW) return res.status(503).json({ ok: false, error: '서버에 ADMIN_PW 환경 변수가 없어요. Render의 Environment에 ADMIN_ID와 ADMIN_PW를 넣어 주세요.' });
  if (tooMany('adm:' + req.ip, 6)) return res.status(429).json({ ok: false, error: '여러 번 틀렸어요. 5분 뒤에 다시 해 주세요.' });
  const { id, pw } = req.body || {};
  if (!safeEq(String(id || ''), ADMIN_ID) || !safeEq(String(pw || ''), ADMIN_PW)) { failed('adm:' + req.ip); return res.status(401).json({ ok: false, error: '아이디 또는 비밀번호가 맞지 않아요.' }); }
  fails.delete('adm:' + req.ip);
  setCookie(req, res, 'wia_a', newSession({ admin: true }, 0.5), 0.5);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => { const s = adminOf(req); if (s) { delete sessions[s.tok]; saveSessions(); } setCookie(req, res, 'wia_a', '', 0); res.json({ ok: true }); });
app.use('/api/admin', (req, res, next) => { if (!adminOf(req)) return res.status(401).json({ ok: false, error: '관리자 로그인이 필요해요.' }); res.setHeader('Cache-Control', 'no-store'); next(); });

let dbSize = { at: 0, v: null };
async function dbBytes() {
  if (Date.now() - dbSize.at < 60000) return dbSize.v;
  dbSize.at = Date.now();
  try {
    if (pool) { const r = await pool.query('SELECT pg_database_size(current_database()) AS n'); dbSize.v = +r.rows[0].n; }
    else dbSize.v = fs.statSync(DATA_FILE).size;
  } catch (e) { dbSize.v = null; }
  return dbSize.v;
}
function teacherRow(t) {
  const lv = live(t.id), L = limitsOf(t), u = aiUse(t.id), c = aiCount(t.id), h1 = useSum(t.id, 60), d1 = useSum(t.id, 1440);
  const les = lessonsOf(t.id);
  return Object.assign(pubTeacher(t), {
    online: countConn('teacher', t.id), students: countConn('student', t.id),
    live: lv ? { code: lv.code, status: lv.status, step: lv.step, title: (lv.lesson && lv.lesson.title) || '', cls: lv.clsName || '', joined: studentsIn(t.id, lv), startedAt: lv.epoch } : null,
    lessons: les.length, classes: (() => { try { const d = JSON.parse(kvGet(t.id, DB_KEY) || 'null'); return d && Array.isArray(d.classes) ? d.classes.length : 0; } catch (e) { return 0; } })(),
    dataKB: Math.round(Array.from((tkv[t.id] || new Map()).values()).reduce((a, v) => a + v.length, 0) / 1024),
    ai: { day: c.day, month: c.month, cost: u.cost, tokIn: u.tokIn, tokOut: u.tokOut },
    use: { ev1h: h1.ev, kb1h: Math.round(h1.bytes / 1024), ev24h: d1.ev, kb24h: Math.round(d1.bytes / 1024) },
    eff: L
  });
}
app.get('/api/admin/overview', async (req, res) => {
  const mu = process.memoryUsage(), all = Object.values(teachers), u = aiUse(null);
  const lives = all.map(t => ({ t, lv: live(t.id) })).filter(x => isOpen(x.lv));
  res.json({
    now: Date.now(), startedAt: STARTED, node: process.version, host: { cpus: os.cpus().length, load: os.loadavg(), totalMemMB: Math.round(os.totalmem() / 1048576), freeMemMB: Math.round(os.freemem() / 1048576) },
    mem: { rssMB: Math.round(mu.rss / 1048576), heapMB: Math.round(mu.heapUsed / 1048576) }, cpu: Math.round(cpuPct * 10) / 10,
    storage: PG_URL ? 'postgres' : 'file', dbBytes: await dbBytes(), rows: rows.size,
    teachers: { total: all.length, active: all.filter(t => t.status === 'active').length, pending: all.filter(t => t.status === 'pending_approval').length, unverified: all.filter(t => t.status === 'pending_email').length, suspended: all.filter(t => t.status === 'suspended').length, online: all.filter(t => countConn('teacher', t.id)).length },
    students: totalConn('student'), sockets: io.engine.clientsCount, liveClasses: lives.length,
    ai: { enabled: !!cfg.global.aiEnabled, hasKey: !!ANTHROPIC_KEY(), model: cfg.ai.model, running: aiRunning, monthCost: u.cost, monthCount: u.month, dayCount: u.day, tokIn: u.tokIn, tokOut: u.tokOut, budget: cfg.global.monthlyBudgetUSD },
    mail: { mode: MAIL.mode(), from: MAIL.FROM() },
    hist: hist.slice(-1440)
  });
});
app.get('/api/admin/teachers', (req, res) => res.json({ teachers: Object.values(teachers).sort((a, b) => b.createdAt - a.createdAt).map(teacherRow) }));
app.post('/api/admin/teachers', (req, res) => { // 관리자가 직접 계정 만들기
  const b = req.body || {}, email = String(b.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ ok: false, error: '이메일을 확인해 주세요.' });
  if (findByLogin(email)) return res.status(400).json({ ok: false, error: '이미 있는 이메일이에요.' });
  if (String(b.pw || '').length < 8) return res.status(400).json({ ok: false, error: '임시 비밀번호는 8자 이상이에요.' });
  const t = newTeacher({ email, login: email, name: String(b.name || '').slice(0, 30) || email.split('@')[0], school: String(b.school || '').slice(0, 60), status: 'active', emailVerified: false, approvedAt: Date.now(), note: '관리자가 만든 계정' });
  setPw(t, b.pw); saveTeacher(t); res.json({ ok: true, teacher: teacherRow(t) });
});
function kick(tid) { dropSessions(tid); io.to('teacher:' + tid).emit('kicked'); setTimeout(() => io.in('teacher:' + tid).disconnectSockets(true), 400); }
app.post('/api/admin/teachers/:id', async (req, res) => {
  const t = teachers[req.params.id]; if (!t) return res.status(404).json({ ok: false, error: '없는 계정이에요.' });
  const b = req.body || {};
  switch (b.action) {
    case 'approve': {
      const was = t.status; t.status = 'active'; t.approvedAt = Date.now(); if (!t.emailVerified && b.force) t.note = (t.note ? t.note + ' · ' : '') + '메일 인증 없이 승인'; saveTeacher(t);
      if (was !== 'active' && t.email) await sendMail('approved', t.email, MAIL.T.approved(t.name, baseUrl(req) + '/teacher'), t.id);
      break;
    }
    case 'suspend': t.status = 'suspended'; saveTeacher(t); kick(t.id); break;
    case 'logout': kick(t.id); break;
    case 'verify': t.emailVerified = true; delete t.verify; if (t.status === 'pending_email') t.status = 'pending_approval'; saveTeacher(t); break;
    case 'resend': if (t.email) await issueVerify(req, t); break;
    case 'setpw': if (String(b.pw || '').length < 8) return res.status(400).json({ ok: false, error: '8자 이상으로 정해 주세요.' }); setPw(t, b.pw); saveTeacher(t); kick(t.id); break;
    case 'limits': {
      const L = {}; Object.keys(cfg.limits).forEach(k => { const v = b.limits && b.limits[k]; if (v !== '' && v != null && isFinite(+v) && +v >= 0) L[k] = Math.round(+v); });
      t.limits = L; saveTeacher(t); break;
    }
    case 'note': t.note = String(b.note || '').slice(0, 500); saveTeacher(t); break;
    case 'delete': {
      if (b.confirm !== t.id) return res.status(400).json({ ok: false, error: '확인 값이 맞지 않아요.' });
      kick(t.id);
      Array.from((tkv[t.id] || new Map()).keys()).forEach(k => kvDel(t.id, k)); delete tkv[t.id];
      delete teachers[t.id]; drop('t:' + t.id);
      return res.json({ ok: true, deleted: true });
    }
    default: return res.status(400).json({ ok: false, error: '알 수 없는 작업이에요.' });
  }
  res.json({ ok: true, teacher: teacherRow(t) });
});
app.get('/api/admin/teachers/:id/content', (req, res) => {
  const t = teachers[req.params.id]; if (!t) return res.status(404).json({ ok: false });
  let d = null; try { d = JSON.parse(kvGet(t.id, DB_KEY) || 'null'); } catch (e) {}
  const lessons = (d && d.lessons) || [];
  if (req.query.lesson) return res.json({ lesson: lessons.find(l => l.id === req.query.lesson) || null });
  res.json({
    teacher: pubTeacher(t),
    classes: ((d && d.classes) || []).map(c => ({ id: c.id, name: c.name, les: c.les || c.lesson || '' })),
    lessons: lessons.map(l => ({ id: l.id, title: l.title, grade: l.grade, subject: l.subject, kind: l.kind, pages: (l.pages || []).length, files: (l.files || []).map(f => f.name), made: l.made, updatedAt: l.updatedAt, ai: l.aiGen || null })),
    results: ((d && d.results) || []).length,
    logs: logs.filter(l => l.tid === t.id).slice(0, 50).map(logRow)
  });
});
function logRow(l) { return { id: l.id, tid: l.tid, tname: (teachers[l.tid] && (teachers[l.tid].name || teachers[l.tid].login)) || l.tname || '(지운 계정)', at: l.at, mode: l.mode, status: l.status, model: l.model, promptV: l.promptV, ms: l.ms, title: l.input && l.input.title, count: l.input && l.input.count, files: (l.files || []).map(f => f.name), usage: l.usage, cost: l.cost, error: l.error, gaps: l.output && l.output.gaps ? l.output.gaps.length : 0 }; }
app.get('/api/admin/live', (req, res) => {
  const out = [];
  Object.values(teachers).forEach(t => {
    const lv = live(t.id); if (!lv) return;
    const stu = []; const m = tkv[t.id];
    if (m) for (const [k, v] of m) { if (!k.startsWith(STU)) continue; try { const r = JSON.parse(v); if (r.code === lv.code && r.epoch === lv.epoch) stu.push({ nick: r.nick, step: r.step, fin: !!r.fin }); } catch (e) {} }
    out.push({ tid: t.id, tname: t.name || t.login, school: t.school, code: lv.code, status: lv.status, step: lv.step, title: (lv.lesson && lv.lesson.title) || '', cls: lv.clsName || '', startedAt: lv.epoch, joined: stu.length, connected: countConn('student', t.id), teacherDevices: countConn('teacher', t.id), max: limitsOf(t).maxStudents, students: stu });
  });
  out.sort((a, b) => (isOpen(b) - isOpen(a)) || (b.startedAt - a.startedAt));
  res.json({ live: out });
});
app.get('/api/admin/ai/logs', (req, res) => {
  const tid = String(req.query.tid || ''), lim = Math.min(500, +req.query.limit || 100);
  res.json({ logs: logs.filter(l => !tid || l.tid === tid).slice(0, lim).map(logRow), total: logs.length });
});
app.get('/api/admin/ai/logs/:id', (req, res) => { const l = logs.find(x => x.id === req.params.id); if (!l) return res.status(404).json({ ok: false }); res.json({ log: Object.assign(logRow(l), { input: l.input, files: l.files, output: l.output, stop: l.stop }) }); });
app.get('/api/admin/settings', (req, res) => res.json({ cfg, models: AI.MODELS, prices: AI.PRICES, tool: AI.TOOL, defaults: { system: AI.DEFAULT_SYSTEM, user: AI.DEFAULT_USER }, env: { ai: !!ANTHROPIC_KEY(), resend: MAIL.mode() === 'live', mailFrom: MAIL.FROM(), publicUrl: process.env.PUBLIC_URL || '', adminEmail: process.env.ADMIN_EMAIL || '' } }));
app.post('/api/admin/settings', (req, res) => {
  const b = req.body || {};
  const num = (v, lo, hi) => (v === '' || v == null || !isFinite(+v)) ? null : Math.min(hi, Math.max(lo, +v));
  if (b.limits) Object.keys(cfg.limits).forEach(k => { const v = num(b.limits[k], 0, 100000); if (v !== null) cfg.limits[k] = Math.round(v); });
  if (b.global) {
    const g = b.global;
    if ('signupOpen' in g) cfg.global.signupOpen = !!g.signupOpen;
    if ('aiEnabled' in g) cfg.global.aiEnabled = !!g.aiEnabled;
    if ('autoApproveDomains' in g) cfg.global.autoApproveDomains = String(g.autoApproveDomains || '').split(/[\s,]+/).map(x => x.trim().toLowerCase().replace(/^@/, '')).filter(Boolean).slice(0, 50);
    [['monthlyBudgetUSD', 0, 100000], ['maxTotalStudents', 1, 100000], ['aiConcurrent', 1, 20], ['maxTextChars', 10000, 2000000]].forEach(([k, lo, hi]) => { const v = num(g[k], lo, hi); if (v !== null) cfg.global[k] = v; });
  }
  if (b.ai) {
    if (AI.MODELS.includes(b.ai.model)) cfg.ai.model = b.ai.model;
    const mt = num(b.ai.maxTokens, 1000, 128000); if (mt !== null) cfg.ai.maxTokens = Math.round(mt);
    if ('temperature' in b.ai) cfg.ai.temperature = (b.ai.temperature === '' || b.ai.temperature == null) ? null : num(b.ai.temperature, 0, 1);
  }
  saveCfg(); res.json({ ok: true, cfg });
});
app.post('/api/admin/prompts', (req, res) => {
  const b = req.body || {};
  if (b.activate) { if (!cfg.prompts.some(p => p.v === +b.activate)) return res.status(400).json({ ok: false, error: '없는 버전이에요.' }); cfg.promptActive = +b.activate; saveCfg(); return res.json({ ok: true, cfg }); }
  const system = String(b.system || '').trim(), user = String(b.user || '').trim();
  if (system.length < 20 || user.length < 20) return res.status(400).json({ ok: false, error: '프롬프트가 너무 짧아요.' });
  const v = Math.max(...cfg.prompts.map(p => p.v)) + 1;
  cfg.prompts.push({ v, at: Date.now(), note: String(b.note || '').slice(0, 100), system: system.slice(0, 20000), user: user.slice(0, 10000) });
  while (cfg.prompts.length > 30) { const i = cfg.prompts.findIndex(p => p.v !== cfg.promptActive && p.v !== v); cfg.prompts.splice(i, 1); }
  if (b.use !== false) cfg.promptActive = v;
  saveCfg(); res.json({ ok: true, cfg });
});
app.get('/api/admin/mails', (req, res) => res.json({ mails: mails.slice(0, 200), mode: MAIL.mode(), from: MAIL.FROM() }));
app.post('/api/admin/mail-test', async (req, res) => {
  const to = String((req.body || {}).to || '').trim(); if (!EMAIL_RE.test(to)) return res.status(400).json({ ok: false, error: '받는 이메일을 확인해 주세요.' });
  const m = await sendMail('test', to, { subject: '[위아] 메일 보내기 시험', html: '<p>위아 서버에서 보낸 시험 메일이에요. 이 메일이 보이면 메일 설정이 잘 된 거예요.</p>', text: '위아 서버 시험 메일' });
  res.json({ ok: m.ok, mail: m });
});

app.use((req, res) => res.status(404).send('페이지를 찾을 수 없어요.'));

/* ================= 실시간 연결 ================= */
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 6e6, pingInterval: 10000, pingTimeout: 8000 });
const room = code => 'code:' + code;
function clip(s, n) { return String(s == null ? '' : s).slice(0, n); }
function track(kind, tid, socket, info) {
  if (!tid) return;
  const m = conn[kind].get(tid) || new Map(); conn[kind].set(tid, m); m.set(socket.id, info || {});
  socket.on('disconnect', () => { m.delete(socket.id); if (!m.size) conn[kind].delete(tid); });
}

io.on('connection', socket => {
  const ses = sessionOf(socket.handshake.headers.cookie);
  const tch = ses && ses.tid && teachers[ses.tid] && teachers[ses.tid].status === 'active' ? ses.tid : null;
  const a = socket.handshake.auth || {};
  const sCode = /^\d{6}$/.test(a.code || '') ? a.code : '', sSid = /^[a-z0-9]{6,24}$/.test(a.sid || '') ? a.sid : '';
  const stuTid = !tch && sCode ? ownerOf(sCode) : null;
  if (tch) { socket.join('teacher:' + tch); track('teacher', tch, socket, { tv: !!a.tv, at: Date.now() }); }
  if (sCode) socket.join(room(sCode));
  if (stuTid) track('student', stuTid, socket, { code: sCode, sid: sSid, at: Date.now() });
  const notice = text => socket.emit('notice', { text });

  function broadcastLive(tid, prevCode) {
    const lv = live(tid), v = kvGet(tid, LIVE_KEY);
    socket.to('teacher:' + tid).emit('kv', { key: LIVE_KEY, value: v });
    new Set([lv && lv.code, prevCode].filter(Boolean)).forEach(c => socket.to(room(c)).emit('kv', { key: LIVE_KEY, value: v }));
  }

  socket.on('set', (msg, ack) => {
    const done = r => { if (typeof ack === 'function') ack(r); };
    if (!msg || typeof msg.key !== 'string' || typeof msg.value !== 'string') return done({ ok: false });
    const { key, value } = msg;
    if (tch) {
      addUse(tch, value.length);
      if (key === DB_KEY) {
        if (value.length > 5e6) { notice('저장할 데이터가 너무 커요 (5MB). 안 쓰는 콘텐츠를 지워 주세요.'); return done({ ok: false }); }
        const L = limitsOf(teachers[tch]);
        try {
          const n = (JSON.parse(value).lessons || []).length, before = lessonsOf(tch).length;
          if (n > L.maxLessons && n > before) { notice(`콘텐츠는 ${L.maxLessons}개까지 저장할 수 있어요. 안 쓰는 콘텐츠를 지워 주세요.`); socket.emit('kv', { key, value: kvGet(tch, DB_KEY) || null }); return done({ ok: false }); }
        } catch (e) { return done({ ok: false }); }
        kvSet(tch, key, value); socket.to('teacher:' + tch).emit('kv', { key, value }); return done({ ok: true });
      }
      if (key === LIVE_KEY) { const prev = live(tch); kvSet(tch, key, value); broadcastLive(tch, prev && prev.code); return done({ ok: true }); }
      if (key.startsWith(STU)) { kvSet(tch, key, value); socket.to('teacher:' + tch).emit('kv', { key, value }); return done({ ok: true }); }
      return done({ ok: false });
    }
    /* 학생은 자기 기록만, 지금 열린 수업에만 쓸 수 있어요 */
    if (!sSid || key !== STU + sSid || !stuTid) return done({ ok: false });
    addUse(stuTid, value.length);
    let r; try { r = JSON.parse(value); } catch (e) { return done({ ok: false }); }
    const lv = live(stuTid);
    if (!lv || lv.status === 'ended' || r.code !== lv.code || r.epoch !== lv.epoch || r.sid !== sSid) return done({ ok: false });
    if (!kvGet(stuTid, key)) {
      const max = limitsOf(teachers[stuTid]).maxStudents;
      if (studentsIn(stuTid, lv) >= max) { notice(`이 수업은 정원(${max}명)이 다 찼어요. 선생님께 알려 주세요.`); return done({ ok: false, full: true }); }
    }
    const clean = {
      sid: sSid, code: lv.code, epoch: lv.epoch, joinedAt: +r.joinedAt || Date.now(), nick: clip(r.nick, 20),
      picks: Array.isArray(r.picks) ? r.picks.slice(0, 3).map(v => (v === null || v === undefined) ? null : +v) : [null, null, null],
      rp: Array.isArray(r.rp) ? r.rp.slice(0, 6).map(v => v === 'ok' || v === 'sus' ? v : null) : [null, null, null],
      ans: clip(r.ans, 1000), step: +r.step || 0, fin: !!r.fin
    };
    const v = JSON.stringify(clean);
    kvSet(stuTid, key, v); io.to('teacher:' + stuTid).emit('kv', { key, value: v });
    done({ ok: true });
  });

  /* 앞서 보낸 저장이 서버에 반영됐는지 확인 (순서대로 처리되므로 이 답이 오면 앞의 저장도 끝난 것) */
  socket.on('sync-check', ack => { if (typeof ack === 'function') ack({ ok: true }); });

  socket.on('del', (msg, ack) => {
    const done = r => { if (typeof ack === 'function') ack(r); };
    const key = msg && msg.key;
    if (typeof key !== 'string') return done({ ok: false });
    const tid = tch || stuTid;
    const allowed = tch ? (key.startsWith(STU) || key === LIVE_KEY) : (stuTid && sSid && key === STU + sSid);
    if (!allowed) return done({ ok: false });
    addUse(tid, key.length);
    kvDel(tid, key);
    io.to('teacher:' + tid).except(socket.id).emit('kv', { key, value: null });
    done({ ok: true });
  });
});

loadStore().then(() => server.listen(PORT, () => {
  console.log(`[위아] http://localhost:${PORT} 에서 실행 중 (학생: /  선생님: /teacher  가입: /signup  관리자: /admin)`);
  console.log(`[위아] AI: ${ANTHROPIC_KEY() ? 'Claude 연결됨 (' + cfg.ai.model + ')' : '시범 모드 (ANTHROPIC_API_KEY 없음)'} · 메일: ${MAIL.mode() === 'live' ? 'Resend 연결됨' : '시범 모드 (RESEND_API_KEY 없음)'} · 관리자: ${ADMIN_PW ? '사용 가능' : 'ADMIN_PW 없음'}`);
  cpuPrev = process.cpuUsage(); cpuAt = Date.now();
})).catch(e => { console.error('[위아] 시작하지 못했어요:', e.message); process.exit(1); });
