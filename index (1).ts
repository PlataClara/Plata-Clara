import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const SEND_HOUR = 10; // hora local del dispositivo

function localParts(tz: string, now: Date) {
  let f: Intl.DateTimeFormat;
  try {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  } catch (_e) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  }
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(now)) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour };
}

function dueReminders(data: any, lp: { y: number; m: number; d: number }) {
  const out = { today: [] as any[], tomorrow: [] as any[] };
  const pad = (n: number) => String(n).padStart(2, '0');
  const key = lp.y + '-' + pad(lp.m);
  const dim = new Date(Date.UTC(lp.y, lp.m, 0)).getUTCDate();
  const todayMs = Date.UTC(lp.y, lp.m - 1, lp.d);
  const ny = lp.m === 12 ? lp.y + 1 : lp.y, nm = lp.m === 12 ? 1 : lp.m + 1;
  const nkey = ny + '-' + pad(nm);
  const dimNext = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const base = (data && (data.home || data.cc)) || 'PEN';
  const cur = (x: any) => (x && x.cc) || base;
  const kindOf = (d: any) => (d.kind === 'mensual' || d.kind === 'unico' ? d.kind : 'cuotas');
  const inRange = (d: any, k: string) => !(d.start && k < d.start) && !(d.end && k > d.end);

  for (const d of (data && data.debts) || []) {
    if (!d) continue;
    const kd = kindOf(d);
    const moves = ((data.moves) || []).filter((m: any) => m && m.debtId === d.id && cur(m) === cur(d));
    const sum = moves.reduce((a: number, m: any) => a + (+m.amount || 0), 0);
    const left = (+d.total || 0) - ((+d.initial || 0) + sum);

    if (kd === 'unico') {                        // un solo pago en una fecha
      if (left <= 0 || !d.date) continue;
      const p = String(d.date).split('-');
      const diff = Math.round((Date.UTC(+p[0], +p[1] - 1, +p[2]) - todayMs) / 86400000);
      if (diff === 0) out.today.push(d); else if (diff === 1) out.tomorrow.push(d);
      continue;
    }

    const day = +d.day;
    if (!day) continue;
    let paidThisMonth: boolean;
    if (kd === 'mensual') {                      // todos los meses, sin total
      if ((+d.monthly || 0) <= 0) continue;
      const monthSum = moves.filter((m: any) => String(m.date || '').slice(0, 7) === key).reduce((a: number, m: any) => a + (+m.amount || 0), 0);
      paidThisMonth = monthSum >= (+d.monthly || 0);
    } else {                                     // en cuotas
      if (left <= 0) continue;
      paidThisMonth = moves.some((m: any) => String(m.date || '').slice(0, 7) === key);
    }

    if (inRange(d, key) && !paidThisMonth) {
      const diff = Math.round((Date.UTC(lp.y, lp.m - 1, Math.min(day, dim)) - todayMs) / 86400000);
      if (diff === 0) out.today.push(d); else if (diff === 1) out.tomorrow.push(d);
    }
    if (inRange(d, nkey) && Math.round((Date.UTC(ny, nm - 1, Math.min(day, dimNext)) - todayMs) / 86400000) === 1 && !out.tomorrow.includes(d)) out.tomorrow.push(d);
  }
  return out;
}

function money(n: number, cc: string, lang: string) {
  try {
    return new Intl.NumberFormat(lang === 'es' ? 'es-PE' : 'en-US', { style: 'currency', currency: cc || 'PEN', currencyDisplay: 'narrowSymbol' }).format(+n || 0);
  } catch (_e) { return String(n); }
}

function buildMessages(data: any, due: { today: any[]; tomorrow: any[] }) {
  const lang = data && data.lang === 'es' ? 'es' : 'en';
  const base = (data && (data.home || data.cc)) || 'PEN';
  const line = (d: any) => {
    const amt = d.kind === 'unico' ? +d.total : +d.monthly;
    return d.name + (amt ? ' (' + money(amt, d.cc || base, lang) + ')' : '');
  };
  const msgs: { tag: string; title: string; body: string }[] = [];
  if (due.tomorrow.length) {
    msgs.push({
      tag: 'cuota-manana',
      title: lang === 'es' ? 'Cuota por vencer' : 'Installment due soon',
      body: (lang === 'es' ? 'Mañana vence: ' : 'Due tomorrow: ') + due.tomorrow.map(line).join(', '),
    });
  }
  if (due.today.length) {
    msgs.push({
      tag: 'cuota-hoy',
      title: lang === 'es' ? 'Hoy vence una cuota' : 'Installment due today',
      body: (lang === 'es' ? 'Hoy vence: ' : 'Due today: ') + due.today.map(line).join(', '),
    });
  }
  return msgs;
}

Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) {
    return new Response('forbidden', { status: 403 });
  }
  const url = new URL(req.url);
  const force = url.searchParams.get('force') === '1';
  const dry = url.searchParams.get('dry') === '1';

  webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT')!, Deno.env.get('VAPID_PUBLIC_KEY')!, Deno.env.get('VAPID_PRIVATE_KEY')!);
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SERVICE_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const now = new Date();
  const stats = { subscriptions: 0, inWindow: 0, sent: 0, removed: 0, errors: 0 };

  const subs: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('push_subscriptions').select('*').range(from, from + 999);
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    subs.push(...data);
    if (data.length < 1000) break;
  }
  stats.subscriptions = subs.length;

  const due = subs.map((s) => ({ s, lp: localParts(s.tz || 'America/Lima', now) })).filter((x) => force || x.lp.h === SEND_HOUR);
  stats.inWindow = due.length;

  const ids = [...new Set(due.map((x) => x.s.user_id))];
  const byUser = new Map<string, any>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await db.from('user_data').select('user_id,data').in('user_id', ids.slice(i, i + 100));
    for (const r of data || []) byUser.set(r.user_id, r.data);
  }

  for (const { s, lp } of due) {
    const data = byUser.get(s.user_id);
    if (!data) continue;
    const msgs = buildMessages(data, dueReminders(data, lp));
    for (const m of msgs) {
      if (dry) { stats.sent++; continue; }
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify({ title: m.title, body: m.body, tag: m.tag, url: './#deudas' }),
          { TTL: 6 * 3600, urgency: 'high' },
        );
        stats.sent++;
      } catch (e: any) {
        if (e && (e.statusCode === 404 || e.statusCode === 410)) {
          await db.from('push_subscriptions').delete().eq('id', s.id);
          stats.removed++;
          break;
        }
        stats.errors++;
      }
    }
  }
  return new Response(JSON.stringify(stats), { headers: { 'Content-Type': 'application/json' } });
});
