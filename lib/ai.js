/* 위아 AI: 선생님이 올린 수업 자료로 교육 화면과 "AI에게 잘 묻기" 활동을 만들어요.
   - Claude API(Messages)에 자료를 그대로 넣고, 정해진 모양(JSON)으로만 답하게 해요(도구 강제 호출).
   - PDF·이미지는 Claude가 직접 읽고, 워드·PPT·한글(hwpx)·TXT는 서버에서 글만 뽑아 넣어요. */
'use strict';
const JSZip = require('jszip');
const mammoth = require('mammoth');

/* 1백만 토큰당 달러 (입력 / 출력). 2026년 11월 Anthropic 가격표 기준이며, 관리자 화면의 비용은 추정치예요. */
const PRICES = {
  'claude-sonnet-5-5': [2, 10],
  'claude-opus-5-5': [4, 20],
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-fable-5-2': [8, 40]
};
const MODELS = Object.keys(PRICES);
function costOf(model, u) {
  const p = PRICES[model] || PRICES['claude-sonnet-5-5'];
  if (!u) return 0;
  const inp = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) * 1.25 + (u.cache_read_input_tokens || 0) * 0.1;
  return (inp * p[0] + (u.output_tokens || 0) * p[1]) / 1e6;
}

const DEFAULT_SYSTEM = `너는 한국 초·중·고등학교 선생님이 올린 수업 자료로 학생용 교육 화면과 "AI에게 잘 묻기" 활동을 만드는 도우미야.

꼭 지킬 규칙
1. 첨부된 수업 자료에 있는 내용만 쓴다. 자료에 없는 사실, 숫자, 날짜, 인물, 예문, 출처를 새로 만들지 않는다. 일반 상식이라도 자료에 없으면 쓰지 않는다.
2. 자료만으로 채울 수 없는 칸은 지어내지 말고 "(확인 필요: 무엇이 더 필요한지)"라고 쓴다. 빈칸을 억지로 채우는 것보다 "(확인 필요: …)"가 낫다.
3. 각 장의 src에는 근거가 된 파일 이름과 쪽·슬라이드 번호를 쓴다(예: "3단원_교과서.pdf 42쪽"). 근거를 못 찾으면 "(확인 필요: 근거 쪽)"이라고 쓴다.
4. 선생님의 부탁은 자료 범위 안에서만 반영한다. 자료 밖 내용을 요구하면 "(확인 필요: …)"로 남기고 gaps에 적는다.
5. 학생 화면 문장은 해당 학년이 읽기 쉽게 짧게 쓴다. body는 한 줄에 한 문장, 3~5줄.
6. 확인 문제(check)는 자료 내용으로만 만들고, 보기 3개 중 정답은 하나, why에 자료 근거를 쓴다.
7. 활동(activity)
   - firstAnswer: 학생이 대충 물었을 때 AI가 하는 길고 두루뭉술한 답. 자료 주제를 다루되 학년·개수·근거가 없는 답으로 쓴다.
   - newAnswer: 학년·개수(3가지)·근거를 넣어 다시 물었을 때의 답. 자료 내용만으로 3가지를 정리하고 마지막 줄에 "출처: 파일 이름 쪽"을 쓴다.
   - cards: AI 답의 문장 3개. right가 "ok"인 카드는 자료와 맞는 문장, "sus"인 카드는 자료와 비교하면 틀린(일부러 바꾼) 숫자·사실·출처 문장이다. why에 자료의 올바른 내용을 쓴다. 최소 1개는 ok, 1개는 sus.
   - tpl에는 [빈칸1] [빈칸2] [빈칸3]을 꼭 한 번씩 넣는다. slots의 보기 3개는 q가 good, ok, weak 하나씩이다.
8. 학생 개인정보(실명, 연락처 등)는 자료에 있더라도 쓰지 않는다.
9. 결과는 반드시 make_lesson 도구로만 제출한다.`;

const DEFAULT_USER = `아래 정보와 첨부 자료로 교육 화면 {count}장과 활동을 만들어 주세요.

- 수업 자료 제목: {title}
- 학년: {grade}
- 과목: {subject}
- 숙제 유형: {kind}
- 선생님의 부탁: {req}
- 장 구성(순서대로, 이 종류와 개수를 지켜 주세요): {plan}
- 첨부 파일: {files}

장 종류 설명: cover=표지(제목과 한 줄 소개), goal=학습 목표 3개, concept=개념 설명, example=예시, check=확인 문제(q, opts 3개, ans, why), summary=정리.`;

const KINDS = ['cover', 'goal', 'concept', 'example', 'check', 'summary'];

const TOOL = {
  name: 'make_lesson',
  description: '수업 자료만을 근거로 만든 교육 화면(pages)과 AI 활용 활동(activity)을 제출해요.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '수업 자료 제목 (선생님이 정한 제목이 있으면 그대로)' },
      summary: { type: 'string', description: '자료의 핵심을 2~3문장으로 요약 (관리자 확인용)' },
      pages: {
        type: 'array',
        description: '교육 화면. 요청한 장 구성과 같은 순서·개수',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: KINDS },
            title: { type: 'string' },
            body: { type: 'string', description: '한 줄에 한 문장, 줄바꿈(\\n)으로 구분' },
            key: { type: 'string', description: '이 장의 핵심 한 줄' },
            src: { type: 'string', description: '근거 파일 이름과 쪽' },
            note: { type: 'string', description: '선생님께 드리는 진행 팁 (자료 근거 안에서)' },
            q: { type: 'string', description: 'check일 때 문제' },
            opts: { type: 'array', items: { type: 'string' }, description: 'check일 때 보기 3개' },
            ans: { type: 'integer', description: 'check일 때 정답 번호 0~2' },
            why: { type: 'string', description: 'check일 때 정답 이유와 자료 근거' }
          },
          required: ['kind', 'title', 'body', 'src']
        }
      },
      activity: {
        type: 'object',
        properties: {
          hw: { type: 'string', description: '오늘의 숙제 한 문장' },
          firstAnswer: { type: 'string' },
          tpl: { type: 'string', description: '[빈칸1] [빈칸2] [빈칸3]이 들어간 부탁 문장 틀' },
          slots: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: '빈칸 이름 (예: 나 알려주기, 개수·범위, 확인 단서)' },
                opts: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { text: { type: 'string' }, q: { type: 'string', enum: ['good', 'ok', 'weak'] }, fb: { type: 'string' } },
                    required: ['text', 'q', 'fb']
                  }
                }
              },
              required: ['name', 'opts']
            }
          },
          newAnswer: { type: 'string' },
          take: { type: 'array', items: { type: 'string' }, description: '오늘 배운 점 3개' },
          cards: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' }, pre: { type: 'string' }, tgt: { type: 'string', description: '확인할 부분' }, post: { type: 'string' },
                right: { type: 'string', enum: ['ok', 'sus'] }, why: { type: 'string' }
              },
              required: ['label', 'tgt', 'right', 'why']
            }
          },
          q7: { type: 'string', description: '마지막 질문' },
          q7ph: { type: 'string', description: '마지막 질문 입력칸 예시' },
          done: { type: 'string', description: '마무리 한 줄' }
        },
        required: ['hw', 'firstAnswer', 'tpl', 'slots', 'newAnswer', 'take', 'cards', 'q7', 'done']
      },
      gaps: { type: 'array', items: { type: 'string' }, description: '자료가 부족해 선생님 확인이 필요한 점' }
    },
    required: ['title', 'pages', 'activity']
  }
};

/* ---------- 파일에서 글 뽑기 ---------- */
function xmlText(xml, tag) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'g');
  const paras = xml.split(/<\/(?:a:p|hp:p|w:p)>/);
  return paras.map(p => { let out = '', m; re.lastIndex = 0; while ((m = re.exec(p))) out += m[1]; return out; })
    .map(s => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&').trim())
    .filter(Boolean).join('\n');
}
async function zipSlides(buf, re, tag, label) {
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files).filter(n => re.test(n)).sort((a, b) => (+(a.match(/(\d+)\.xml$/) || [0, 0])[1]) - (+(b.match(/(\d+)\.xml$/) || [0, 0])[1]));
  const out = [];
  for (let i = 0; i < names.length; i++) {
    const t = xmlText(await zip.files[names[i]].async('string'), tag);
    if (t) out.push(label ? `[${label} ${i + 1}]\n${t}` : t);
  }
  return out.join('\n\n');
}
function extOf(n) { const m = String(n).toLowerCase().match(/\.([a-z0-9]+)$/); return m ? m[1] : ''; }
const IMG = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/* 올린 파일 → Claude에 넣을 블록 + 기록용 정보 */
async function prepareFiles(files, maxChars, names) {
  const blocks = [], info = [];
  let chars = 0;
  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi];
    const name = String((names && names[fi]) || f.originalname).slice(0, 200);
    const ext = extOf(name), rec = { name, size: f.size, kind: ext, chars: 0, note: '' };
    info.push(rec);
    try {
      if (ext === 'pdf') {
        blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.buffer.toString('base64') }, title: name });
        rec.note = 'PDF를 그대로 읽었어요';
        continue;
      }
      if (IMG[ext]) {
        blocks.push({ type: 'text', text: `[그림 파일: ${name}]` });
        blocks.push({ type: 'image', source: { type: 'base64', media_type: IMG[ext], data: f.buffer.toString('base64') } });
        rec.note = '그림을 그대로 읽었어요';
        continue;
      }
      let text = '';
      if (ext === 'txt' || ext === 'md' || ext === 'csv') text = f.buffer.toString('utf8');
      else if (ext === 'docx') text = (await mammoth.extractRawText({ buffer: f.buffer })).value;
      else if (ext === 'pptx') text = await zipSlides(f.buffer, /^ppt\/slides\/slide\d+\.xml$/, 'a:t', '슬라이드');
      else if (ext === 'hwpx') text = await zipSlides(f.buffer, /^Contents\/section\d+\.xml$/, 'hp:t', '');
      else { rec.note = '이 형식은 읽지 못해요. PDF로 저장해서 올려 주세요.'; rec.skip = true; continue; }
      text = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
      if (!text) { rec.note = '글을 찾지 못했어요 (그림만 있는 파일일 수 있어요). PDF로 올려 주세요.'; rec.skip = true; continue; }
      const room = Math.max(0, maxChars - chars);
      if (text.length > room) { text = text.slice(0, room); rec.note = '글이 너무 길어 앞부분만 읽었어요'; }
      chars += text.length; rec.chars = text.length; rec.text = text;
      if (!rec.note) rec.note = '글 ' + text.length.toLocaleString() + '자를 읽었어요';
      if (text) blocks.push({ type: 'document', source: { type: 'text', media_type: 'text/plain', data: text }, title: name });
    } catch (e) {
      rec.note = '파일을 여는 중 문제가 생겼어요: ' + e.message.slice(0, 80); rec.skip = true;
    }
  }
  return { blocks, info };
}

function fill(tpl, vars) { return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)); }

/* ---------- 결과 다듬기: 모양이 어긋나도 화면이 깨지지 않게 ---------- */
const s = (v, n) => String(v == null ? '' : v).slice(0, n || 2000);
function normalize(r, plan) {
  r = r || {};
  const pages = Array.isArray(r.pages) ? r.pages : [];
  const out = { title: s(r.title, 120), summary: s(r.summary, 1000), gaps: (Array.isArray(r.gaps) ? r.gaps : []).slice(0, 20).map(x => s(x, 300)) };
  out.pages = pages.slice(0, 30).map((p, i) => {
    p = p || {};
    const kind = KINDS.includes(p.kind) ? p.kind : (plan && plan[i]) || 'concept';
    const o = { kind, title: s(p.title, 200), body: s(p.body, 2000), key: s(p.key, 300), src: s(p.src, 300), note: s(p.note, 600), q: '', opts: ['', '', ''], ans: 0, why: '' };
    if (kind === 'check') {
      o.q = s(p.q, 500);
      const op = Array.isArray(p.opts) ? p.opts.slice(0, 3).map(x => s(x, 300)) : [];
      while (op.length < 3) op.push('(확인 필요: 보기)');
      o.opts = op; o.ans = Math.min(2, Math.max(0, +p.ans || 0)); o.why = s(p.why, 600);
    }
    return o;
  });
  const a = r.activity || {};
  const act = {};
  if (a.hw) act.hw = s(a.hw, 300);
  if (a.firstAnswer) act.firstAnswer = s(a.firstAnswer, 3000);
  if (a.newAnswer) act.newAnswer = s(a.newAnswer, 3000);
  if (typeof a.tpl === 'string' && /\[빈칸1\]/.test(a.tpl) && /\[빈칸2\]/.test(a.tpl) && /\[빈칸3\]/.test(a.tpl)) act.tpl = s(a.tpl, 400);
  if (Array.isArray(a.slots) && a.slots.length >= 3) {
    const sl = a.slots.slice(0, 3).map(x => ({
      name: s(x && x.name, 40),
      opts: (Array.isArray(x && x.opts) ? x.opts : []).slice(0, 3).map(o => ({ text: s(o && o.text, 80), q: ['good', 'ok', 'weak'].includes(o && o.q) ? o.q : 'ok', fb: s(o && o.fb, 200) }))
    }));
    if (sl.every(x => x.opts.length === 3 && x.opts.every(o => o.text))) act.slots = sl;
  }
  if (Array.isArray(a.take) && a.take.length) { const t = a.take.slice(0, 3).map(x => s(x, 200)); while (t.length < 3) t.push(t[t.length - 1]); act.take = t; }
  if (Array.isArray(a.cards) && a.cards.length >= 3) {
    act.cards = a.cards.slice(0, 3).map(c => ({ label: s(c && c.label, 30), pre: s(c && c.pre, 300), tgt: s(c && c.tgt, 300), post: s(c && c.post, 300), right: (c && c.right) === 'sus' ? 'sus' : 'ok', why: s(c && c.why, 400) }));
  }
  ['q7', 'q7ph', 'done'].forEach(k => { if (a[k]) act[k] = s(a[k], 300); });
  out.activity = act;
  return out;
}

/* ---------- Claude 부르기 ---------- */
async function generate({ apiKey, model, maxTokens, temperature, system, userText, blocks, timeoutMs }) {
  const body = {
    model, max_tokens: maxTokens || 16000, system,
    tools: [TOOL], tool_choice: { type: 'tool', name: TOOL.name },
    messages: [{ role: 'user', content: blocks.concat([{ type: 'text', text: userText }]) }]
  };
  if (typeof temperature === 'number') body.temperature = temperature;
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), timeoutMs || 280000);
  let res, data;
  try {
    res = await fetch((process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    data = await res.json().catch(() => null);
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'AI 응답이 너무 오래 걸려서 멈췄어요.' : 'AI 서버에 연결하지 못했어요: ' + e.message);
  } finally { clearTimeout(tm); }
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || ('HTTP ' + res.status);
    const err = new Error('AI 요청이 실패했어요: ' + msg); err.status = res.status; err.usage = data && data.usage; throw err;
  }
  const tu = (data.content || []).find(c => c.type === 'tool_use' && c.name === TOOL.name);
  if (!tu) { const err = new Error('AI가 정해진 모양으로 답하지 않았어요.'); err.usage = data.usage; throw err; }
  return { input: tu.input, usage: data.usage || {}, stop: data.stop_reason, id: data.id };
}

module.exports = { PRICES, MODELS, costOf, DEFAULT_SYSTEM, DEFAULT_USER, KINDS, TOOL, prepareFiles, fill, normalize, generate };
