// Edge Function "parent-consent": avisa a los padres y registra su decisión.
// Desplegar con "Verify JWT" DESACTIVADO (el padre no tiene cuenta; la función valida por su cuenta).
// Secretos: RESEND_API_KEY, FROM_EMAIL, SITE_URL (ej. https://TUUSUARIO.github.io/Plata-Clara/)
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

async function byToken(token: string) {
  if (!token || token.length < 32) return null;
  const { data } = await sb.from('profiles').select('user_id,nombre,consent_sent_at')
    .eq('consent_token', token).eq('consent_status', 'pending').maybeSingle();
  if (!data || !data.consent_sent_at) return null;
  if (Date.now() - new Date(data.consent_sent_at).getTime() > 7 * 86400000) return null; // vence a los 7 días
  return data;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    if (req.method === 'GET') {
      const p = await byToken(new URL(req.url).searchParams.get('token') || '');
      return p ? json({ ok: true, nombre: p.nombre }) : json({ error: 'invalid' }, 404);
    }
    const body = await req.json();

    if (body.action === 'decide') {
      const p = await byToken(String(body.token || ''));
      if (!p) return json({ error: 'invalid' }, 404);
      await sb.from('profiles').update({
        consent_status: body.decision === 'approve' ? 'approved' : 'rejected',
        consent_token: null, consent_decided_at: new Date().toISOString(),
      }).eq('user_id', p.user_id);
      return json({ ok: true });
    }

    if (body.action === 'request') {
      const jwt = (req.headers.get('Authorization') || '').replace('Bearer ', '');
      const { data: u, error } = await sb.auth.getUser(jwt);
      if (error || !u?.user) return json({ error: 'auth' }, 401);
      const { data: p } = await sb.from('profiles')
        .select('nombre,parent_email,consent_status,consent_sent_at').eq('user_id', u.user.id).maybeSingle();
      if (!p || p.consent_status !== 'pending' || !p.parent_email) return json({ ok: true });
      if (p.consent_sent_at) {
        if (!body.force) return json({ ok: true, already: true });
        if (Date.now() - new Date(p.consent_sent_at).getTime() < 120000) return json({ error: 'wait' }, 429);
      }
      const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
      await sb.from('profiles').update({ consent_token: token, consent_sent_at: new Date().toISOString() }).eq('user_id', u.user.id);
      const link = `${Deno.env.get('SITE_URL')}?consent=${token}`;
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${Deno.env.get('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: `Plata Clara <${Deno.env.get('FROM_EMAIL')}>`,
          to: [p.parent_email],
          subject: `Autoriza a ${p.nombre} a usar Plata Clara`,
          html: `<p>Hola,</p><p><b>${esc(p.nombre)}</b> quiere usar <b>Plata Clara</b>, una app de finanzas personales, y como tiene menos de 14 años necesitamos tu autorización.</p><p><a href="${link}" style="background:#0E6B50;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;display:inline-block">Revisar y responder</a></p><p style="color:#666;font-size:13px">El enlace vence en 7 días. Si no reconoces esta solicitud, ignora este correo.</p>`,
        }),
      });
      return res.ok ? json({ ok: true }) : json({ error: 'mail' }, 502);
    }
    return json({ error: 'bad' }, 400);
  } catch (_e) {
    return json({ error: 'server' }, 500);
  }
});
