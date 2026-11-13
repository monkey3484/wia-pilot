/* 위아 메일 보내기 (Resend)
   RESEND_API_KEY가 없으면 "시범 모드": 메일을 실제로 보내지 않고 관리자 화면의 메일함에만 남겨요.
   Resend는 도메인을 인증하기 전에는 Resend 가입 이메일로만 보낼 수 있어요. */
'use strict';

const KEY = () => process.env.RESEND_API_KEY || '';
const FROM = () => process.env.MAIL_FROM || '위아 WIA <onboarding@resend.dev>';
function mode() { return KEY() ? 'live' : 'test'; }

async function send({ to, subject, html, text }) {
  if (!KEY()) return { ok: true, mode: 'test' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KEY(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM(), to: [to], subject, html, text })
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, mode: 'live', error: (d && (d.message || d.name)) || ('HTTP ' + res.status) };
    return { ok: true, mode: 'live', id: d.id };
  } catch (e) {
    return { ok: false, mode: 'live', error: e.message };
  }
}

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function layout(title, lines, btn) {
  const b = btn ? `<p style="margin:28px 0"><a href="${esc(btn.url)}" style="background:#3b82f6;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700;display:inline-block">${esc(btn.label)}</a></p><p style="color:#5d6b8f;font-size:13px">버튼이 안 눌리면 이 주소를 복사해 열어 주세요:<br><span style="word-break:break-all">${esc(btn.url)}</span></p>` : '';
  return `<div style="font-family:-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1d2447;line-height:1.6">
<p style="font-weight:800;color:#3b82f6;margin:0 0 16px">위아 WIA</p>
<h1 style="font-size:20px;margin:0 0 12px">${esc(title)}</h1>
${lines.map(l => `<p style="margin:0 0 8px">${esc(l)}</p>`).join('')}
${b}
<p style="color:#5d6b8f;font-size:12px;margin-top:32px">이 메일은 위아 선생님 계정 안내를 위해 보내드렸어요. 직접 요청하지 않으셨다면 무시하셔도 돼요.</p></div>`;
}

const T = {
  verify: (name, url) => ({
    subject: '[위아] 이메일 인증을 완료해 주세요',
    html: layout(`${name} 선생님, 반가워요!`, ['아래 버튼을 눌러 이메일 인증을 마쳐 주세요. 링크는 24시간 동안 쓸 수 있어요.', '인증이 끝나면 관리자가 확인한 뒤 계정을 열어 드려요.'], { label: '이메일 인증하기', url }),
    text: `${name} 선생님, 아래 주소를 열어 이메일 인증을 마쳐 주세요 (24시간 유효).\n${url}`
  }),
  approved: (name, url) => ({
    subject: '[위아] 선생님 계정이 열렸어요',
    html: layout(`${name} 선생님, 계정이 열렸어요`, ['이제 가입한 이메일과 비밀번호로 로그인할 수 있어요.'], { label: '위아 로그인', url }),
    text: `${name} 선생님, 계정이 열렸어요. 로그인: ${url}`
  }),
  reset: (name, url) => ({
    subject: '[위아] 비밀번호 다시 정하기',
    html: layout(`${name} 선생님, 비밀번호를 다시 정해 주세요`, ['아래 버튼을 눌러 새 비밀번호를 정해 주세요. 링크는 1시간 동안 쓸 수 있어요.'], { label: '새 비밀번호 정하기', url }),
    text: `아래 주소에서 새 비밀번호를 정해 주세요 (1시간 유효).\n${url}`
  }),
  adminNew: (t, url) => ({
    subject: `[위아] 승인 대기: ${t.name} (${t.school || '학교 미입력'})`,
    html: layout('새 선생님이 이메일 인증을 마쳤어요', [`${t.name} · ${t.email}`, `${t.school || ''} ${t.subject || ''} ${t.grade || ''}`.trim()], { label: '관리자 화면에서 승인하기', url }),
    text: `${t.name} (${t.email}) 승인 대기. ${url}`
  })
};

module.exports = { send, mode, T, FROM };
