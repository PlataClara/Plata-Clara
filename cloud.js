/* Plata Clara - cuenta y sincronización en la nube (Supabase).
   Si config.js está vacío, esto no hace nada y la app funciona igual que antes (solo local). */
(function () {
  'use strict';
  var C = window.PC_CONFIG || {};
  if (!C.SUPABASE_URL || !C.SUPABASE_ANON_KEY) return;

  var SYNC_KEY = 'plataclara.sync', consentOK = false;
  var sb = null, user = null, pushTimer = null, pushing = false, pending = false, status = 'idle', applying = false;
  var btn = document.getElementById('b-account');
  if (btn) btn.hidden = false;

  var root = document.documentElement;
  function lock() { root.classList.add('pc-lock'); }
  function unlock() { if (!root.classList.contains('pc-lock')) return; root.classList.remove('pc-lock'); if (ov) close(); }
  function wipeLocal() {
    applying = true;
    try { window.__pc.apply(window.__pc.empty()); } finally { applying = false; }
    setMark({});
  }
  function getMark() { try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || {}; } catch (e) { return {}; } }
  function setMark(o) { try { localStorage.setItem(SYNC_KEY, JSON.stringify(o)); } catch (e) {} }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function st() { return window.__pc && window.__pc.get(); }
  function hasUserData(d) { return !!(d && !d.demo && ((d.moves && d.moves.length) || (d.goals && d.goals.length) || (d.debts && d.debts.length))); }

  /* ---------- carga de la librería ---------- */
  function loadLib() {
    return new Promise(function (ok, fail) {
      if (window.supabase) return ok();
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';
      s.onload = ok; s.onerror = function () { fail(new Error('lib')); };
      document.head.appendChild(s);
    });
  }
  function client() {
    if (sb) return Promise.resolve(sb);
    return loadLib().then(function () {
      sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
      sb.auth.onAuthStateChange(function (ev, session) {
        var prev = user && user.id;
        user = session ? session.user : null;
        if (!user) { consentOK = false; window.PCPlan = null; window.PCAdmin = false; window.dispatchEvent(new Event('pcplan')); }
        if (!user && ev === 'SIGNED_OUT') { lock(); authSheet('login'); }
        paint();
        if (user && user.id !== prev && ev !== 'TOKEN_REFRESHED') { checkConsent().then(function (ok) { if (ok) { paint(); reconcile(); refreshPushTz(); } }); }
      });
      return sb;
    });
  }

  /* ---------- sincronización ---------- */
  function setStatus(s) { status = s; paint(); }

  function pushNow() {
    if (!user || !sb) return Promise.resolve();
    if (pushing) { pending = true; return Promise.resolve(); }
    pushing = true; setStatus('saving');
    var now = new Date().toISOString();
    return sb.from('user_data').upsert({ user_id: user.id, data: st(), updated_at: now }).then(function (r) {
      pushing = false;
      if (r.error) { setStatus('error'); return; }
      setMark({ uid: user.id, at: now });
      setStatus('ok');
      if (pending) { pending = false; schedulePush(); }
    }, function () { pushing = false; setStatus('error'); });
  }
  function schedulePush() { clearTimeout(pushTimer); pushTimer = setTimeout(pushNow, 1500); }

  /* La app llama a esto cada vez que guarda. */
  window.__pcPush = function () { if (user && !applying) schedulePush(); };

  function applyRemote(row) {
    applying = true;
    try { window.__pc.apply(row.data); } finally { applying = false; }
    setMark({ uid: user.id, at: row.updated_at });
    setStatus('ok');
  }

  window.PCRpc = function (n, a) { return sb ? sb.rpc(n, a) : Promise.reject(new Error('sin nube')); };
  function loadPlan() {
    if (!sb || !user) return;
    try { var k = JSON.parse(localStorage.getItem('plataclara.plan') || 'null'); if (k && k.uid === user.id) window.PCPlan = k; } catch (e) {}
    sb.rpc('my_plan').then(function (r) {
      if (r.error || !r.data) return;           // si la función aún no existe, no se aplican límites
      var p = r.data; p.uid = user.id; window.PCPlan = p;
      try { localStorage.setItem('plataclara.plan', JSON.stringify(p)); } catch (e) {}
      window.dispatchEvent(new Event('pcplan'));
    }, function () {});
    sb.rpc('is_admin').then(function (r) { window.PCAdmin = r.data === true; window.dispatchEvent(new Event('pcplan')); }, function () {});
  }
  function reconcile() {
    loadPlan();
    if (!user) return Promise.resolve();
    setStatus('saving');
    return sb.from('user_data').select('data,updated_at').eq('user_id', user.id).maybeSingle().then(function (r) {
      if (r.error) { setStatus('error'); return; }
      var row = r.data, mark = getMark(), local = st();
      if (!row) { return pushNow(); }                          // primera vez en la nube: subir lo de este dispositivo
      if (mark.uid === user.id) {                              // este dispositivo ya se había sincronizado antes
        if (row.updated_at > (mark.at || '')) return applyRemote(row);   // la nube es más nueva
        return pushNow();                                      // lo local es igual o más nuevo
      }
      if (!hasUserData(local)) return applyRemote(row);        // dispositivo sin datos propios: bajar la nube
      setStatus('ok'); chooseSheet(row);                       // ambos tienen datos: que decida la persona
    }, function () { setStatus('error'); });
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && user && !pushing && !pushTimer) reconcile();
  });
  window.addEventListener('online', function () { if (user) reconcile(); });

  /* ---------- avisos de cuotas (notificaciones push) ---------- */
  var VAPID = C.VAPID_PUBLIC_KEY || '';
  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  var standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  function pushSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
  function b64ToU8(s) {
    var p = '='.repeat((4 - s.length % 4) % 4), b = (s + p).replace(/-/g, '+').replace(/_/g, '/'), r = atob(b), o = new Uint8Array(r.length);
    for (var i = 0; i < r.length; i++) o[i] = r.charCodeAt(i);
    return o;
  }
  function myTz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Lima'; } catch (e) { return 'America/Lima'; } }
  function currentSub() {
    if (!pushSupported()) return Promise.resolve(null);
    return navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); }).catch(function () { return null; });
  }
  function enablePush() {
    return enablePush0().then(function () { return refreshNotif(); });
  }
  function enablePush0() {
    return Notification.requestPermission().then(function (p) {
      if (p !== 'granted') throw new Error('denied');
      return navigator.serviceWorker.ready;
    }).then(function (reg) {
      return reg.pushManager.getSubscription().then(function (s) {
        return s || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(VAPID) });
      });
    }).then(function (sub) {
      var j = sub.toJSON();
      return sb.from('push_subscriptions').upsert({ user_id: user.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, tz: myTz() }, { onConflict: 'endpoint' });
    }).then(function (r) { if (r.error) throw r.error; });
  }
  function disablePush() {
    return disablePush0().then(function () { return refreshNotif(); }, function (e) { refreshNotif(); throw e; });
  }
  function disablePush0() {
    return currentSub().then(function (s) {
      if (!s) return;
      return sb.from('push_subscriptions').delete().eq('endpoint', s.endpoint).then(function () { return s.unsubscribe(); });
    });
  }
  /* Si viajas o cambias de zona horaria, el aviso de las 10:00 sigue la hora de tu dispositivo. */
  function refreshPushTz() {
    if (!VAPID || !user || !pushSupported() || Notification.permission !== 'granted') return;
    currentSub().then(function (s) {
      if (!s) return;
      var j = s.toJSON();
      return sb.from('push_subscriptions').upsert({ user_id: user.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, tz: myTz() }, { onConflict: 'endpoint' });
    }).catch(function () {});
  }
  function testPush() {
    return navigator.serviceWorker.ready.then(function (reg) {
      return reg.showNotification('Plata Clara', { body: 'Así te avisaremos: “Mañana vence tu cuota”.', icon: 'icon-192.png', badge: 'badge.png', vibrate: [250, 120, 250, 120, 500], tag: 'prueba', data: { url: './#deudas' } });
    });
  }


  /* ---------- aviso pequeño con interruptor (Resumen y Deudas) ---------- */
  var nt = { on: false, busy: false, err: '' };
  function T(k, v) { try { return window.__pc && window.__pc.t ? window.__pc.t(k, v) : k; } catch (e) { return k; } }
  function refreshNotif() {
    if (!VAPID || !user || !pushSupported()) { paintNotif(); return Promise.resolve(); }
    return currentSub().then(function (s) {
      nt.on = !!(s && Notification.permission === 'granted');
    }).catch(function () { nt.on = false; }).then(paintNotif);
  }
  function paintNotif() {
    var el = document.getElementById('notif');
    if (!el) return;
    var v = window.__pc && window.__pc.view && window.__pc.view();
    if (!VAPID || !user || (v !== 'resumen' && v !== 'deudas')) { el.hidden = true; el.innerHTML = ''; return; }
    var blocked = pushSupported() && Notification.permission === 'denied';
    var needIOS = isIOS && !standalone;
    var unsupported = !pushSupported() || needIOS;
    var sub = unsupported
      ? (needIOS ? T('En iPhone, agrega la app a tu pantalla de inicio y ábrela desde ese ícono para activar los avisos.') : T('Este navegador no permite avisos.'))
      : blocked ? T('Los avisos están bloqueados en este dispositivo. Actívalos en los ajustes del navegador.')
      : nt.err ? nt.err
      : nt.on ? T('Activados: te avisamos 1 día antes y el mismo día de cada cuota.')
      : T('Te avisamos 1 día antes y el mismo día de cada cuota, a las 10:00 a. m.');
    el.hidden = false;
    el.innerHTML =
      '<span class="ic" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9M10 20a2 2 0 0 0 4 0"/></svg></span>' +
      '<span class="tx"><b id="nt-l">' + esc(T('Avisos de cuotas')) + '</b><small' + ((blocked || nt.err) ? ' class="e"' : '') + '>' + esc(sub) + '</small></span>' +
      '<button type="button" class="sw" role="switch" aria-labelledby="nt-l" aria-checked="' + (nt.on ? 'true' : 'false') + '"' + ((unsupported || blocked || nt.busy) ? ' disabled' : '') + '></button>';
    var sw = el.querySelector('.sw');
    if (sw) sw.onclick = toggleNotif;
  }
  function toggleNotif() {
    if (nt.busy || !user) return;
    nt.busy = true; nt.err = ''; paintNotif();
    var job = nt.on ? disablePush() : enablePush();
    Promise.resolve(job).catch(function (e) {
      nt.err = (e && e.message === 'denied') ? T('No diste permiso. Vuelve a intentar y elige “Permitir”.') : T('No se pudo cambiar. Intenta de nuevo.');
    }).then(function () { nt.busy = false; return refreshNotif(); });
  }
  document.addEventListener('pc-render', paintNotif);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && user) refreshNotif(); });

  /* ---------- interfaz ---------- */
  var ov = null;
  function css() {
    if (document.getElementById('pc-cloud-css')) return;
    var s = document.createElement('style'); s.id = 'pc-cloud-css';
    s.textContent =
      '#pc-ov{position:fixed;inset:0;z-index:100;background:rgba(10,20,15,.5);display:flex;align-items:center;justify-content:center;padding:16px}' +
      '#pc-ov .pc-card{background:var(--surface);color:var(--ink);border-radius:18px;box-shadow:var(--shadow);width:100%;max-width:400px;padding:22px;max-height:92vh;overflow:auto;font-family:var(--f-body)}' +
      '#pc-ov h2{font-size:21px;margin:0 0 4px}#pc-ov p{color:var(--muted);margin:0 0 14px;font-size:14px}' +
      '#pc-ov label{display:block;font-size:13px;font-weight:600;margin:10px 0 4px}' +
      '#pc-ov input{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:var(--surface2);font-size:16px}' +
      '#pc-ov .pc-b{display:block;width:100%;margin-top:14px;padding:12px;border:0;border-radius:12px;background:var(--accent);color:var(--accent-ink);font-weight:600}' +
      '#pc-ov .pc-b.alt{background:var(--surface2);color:var(--ink);border:1px solid var(--line)}#pc-ov .pc-b[disabled]{opacity:.6}' +
      '#pc-ov .pc-l{background:none;border:0;color:var(--accent);padding:6px 0;margin-top:8px;font-size:14px;text-decoration:underline}' +
      '#pc-ov .pc-m{margin-top:10px;font-size:14px;min-height:18px}#pc-ov .pc-m.e{color:var(--exp)}#pc-ov .pc-m.o{color:var(--inc)}' +
      '#pc-ov.gate{z-index:1000;flex-direction:column;gap:18px;overflow:auto;background:radial-gradient(circle at 12% 8%,rgba(255,206,84,.55),transparent 38%),radial-gradient(circle at 92% 92%,rgba(40,220,170,.55),transparent 45%),linear-gradient(160deg,#0A5A43 0%,#0E8A67 55%,#13B98D 100%)}' +
      '#pc-ov .pc-hero{text-align:center;color:#fff;margin-top:auto}' +
      '#pc-ov .pc-logo{width:68px;height:68px;border-radius:22px;background:#fff;color:#0E6B50;font:800 30px/68px var(--f-display);margin:0 auto 12px;box-shadow:0 12px 30px rgba(0,0,0,.28)}' +
      '#pc-ov .pc-name{font:700 32px var(--f-display);letter-spacing:-.01em}' +
      '#pc-ov .pc-tag{opacity:.92;font-size:15.5px;margin-top:3px}' +
      '#pc-ov.gate .pc-card{margin-bottom:auto;--surface:#fff;--surface2:#F3F8F5;--ink:#12201A;--muted:#566860;--line:#D3DED8;--accent:#0E6B50;--accent-ink:#fff;border-radius:24px;box-shadow:0 24px 60px rgba(0,0,0,.35);padding:24px}' +
      '#pc-ov.gate .pc-b{background:linear-gradient(135deg,#0E6B50,#12A37A);box-shadow:0 8px 18px rgba(14,107,80,.35)}' +
      '#pc-ov.gate input:focus{outline:2px solid #12A37A;border-color:#12A37A}' +
      '#b-account.on{color:var(--accent)}' +
      '#pc-ov select{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:var(--surface2);color:var(--ink);font-size:16px}';
    document.head.appendChild(s);
  }
  function close() { if (ov) { ov.remove(); ov = null; } }
  function show(html, bind, sticky) {
    css(); close();
    var gate = !user || !!sticky;
    ov = document.createElement('div'); ov.id = 'pc-ov'; if (gate) ov.className = 'gate';
    ov.innerHTML = (gate ? '<div class="pc-hero"><div class="pc-logo">S/</div><div class="pc-name">Plata Clara</div><div class="pc-tag">Tus finanzas, claras y en orden</div></div>' : '') +
      '<div class="pc-card" role="dialog" aria-modal="true">' + html + '</div>';
    if (!gate) ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    document.body.appendChild(ov);
    if (bind) bind(ov);
    var f = ov.querySelector('input'); if (f) f.focus();
  }
  function msg(t, kind) { var m = ov && ov.querySelector('.pc-m'); if (m) { m.textContent = t; m.className = 'pc-m ' + (kind || ''); } }
  function friendly(e) {
    var m = (e && e.message || '').toLowerCase();
    if (m.indexOf('invalid login') > -1) return 'Correo o contraseña incorrectos.';
    if (m.indexOf('already registered') > -1) return 'Ese correo ya tiene cuenta. Ingresa con tu contraseña.';
    if (m.indexOf('password') > -1 && m.indexOf('6') > -1) return 'La contraseña debe tener al menos 6 caracteres.';
    if (m.indexOf('rate limit') > -1 || m.indexOf('too many') > -1) return 'Demasiados intentos. Espera unos minutos.';
    if (m.indexOf('email not confirmed') > -1) return 'Confirma tu correo con el enlace que te enviamos y vuelve a ingresar.';
    if (m.indexOf('fetch') > -1 || m.indexOf('network') > -1) return 'Sin conexión. Revisa tu internet.';
    return 'No se pudo completar. Intenta de nuevo.';
  }

  function age(s) {
    var p = String(s || '').split('-'); if (p.length !== 3) return null;
    var n = new Date(), a = n.getFullYear() - (+p[0]), m = n.getMonth() + 1 - (+p[1]);
    if (m < 0 || (m === 0 && n.getDate() < (+p[2]))) a--;
    return isFinite(a) ? a : null;
  }
  var MAILRE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function maskMail(e) { var p = String(e || '').split('@'); return p.length === 2 ? p[0].slice(0, 2) + '***@' + p[1] : ''; }
  function callConsent(body, jwt) {
    return fetch(C.SUPABASE_URL + '/functions/v1/parent-consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: C.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + (jwt || C.SUPABASE_ANON_KEY) },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); });
  }

  /* ---------- permiso de padres (menores de 14) ---------- */
  function checkConsent(silent) {
    if (!user || !sb) return Promise.resolve(false);
    return sb.from('profiles').select('consent_status,parent_email,consent_sent_at').eq('user_id', user.id).maybeSingle().then(function (r) {
      if (r.error) {
        var code = String(r.error.code || '') + String(r.error.message || '');
        if (/PGRST205|42P01|does not exist/.test(code) || getMark().uid === user.id) { consentOK = true; return true; }
        if (!silent) waitSheet('error');
        return false;
      }
      var p = r.data, s = p && p.consent_status;
      if (s === 'pending' || s === 'rejected') {
        consentOK = false;
        if (!silent) {
          if (s === 'pending' && !p.consent_sent_at) {
            sb.auth.getSession().then(function (x) { return callConsent({ action: 'request' }, x.data.session && x.data.session.access_token); }).catch(function () {});
          }
          waitSheet(s, p);
        }
        return false;
      }
      consentOK = true; return true;     // adulto/14+, aprobado o cuenta anterior sin perfil
    }, function () { return false; });
  }
  function waitSheet(s, p) {
    lock();
    var out = function (o) {
      var b = o.querySelector('[data-o]');
      if (b) b.onclick = function () { consentOK = false; sb.auth.signOut().then(function () { wipeLocal(); }); };
    };
    if (s === 'rejected') {
      show('<h2>No autorizado</h2><p>Tu mamá, papá o tutor no autorizó el uso de la app, así que no puedes entrar.</p><button class="pc-b alt" data-o>Cerrar sesión</button>', out, true);
      return;
    }
    if (s === 'error') {
      show('<h2>No se pudo verificar</h2><p>Revisa tu internet e inténtalo de nuevo.</p><div class="pc-m"></div><button class="pc-b" data-r>Reintentar</button><button class="pc-l" data-o>Cerrar sesión</button>', function (o) {
        out(o); o.querySelector('[data-r]').onclick = function () { checkConsent().then(function (ok) { if (ok) { paint(); reconcile(); } }); };
      }, true);
      return;
    }
    show('<h2>Falta el permiso de tus padres</h2><p>Enviamos un aviso a <b>' + esc(maskMail(p && p.parent_email)) + '</b>. Cuando autorice, toca “Ya autorizaron”.</p><div class="pc-m" role="status"></div>' +
      '<button class="pc-b" data-r>Ya autorizaron, entrar</button><button class="pc-b alt" data-s>Reenviar el aviso</button><button class="pc-l" data-o>Cerrar sesión</button>', function (o) {
      out(o);
      o.querySelector('[data-r]').onclick = function () {
        checkConsent(true).then(function (ok) { if (ok) { paint(); reconcile(); refreshPushTz(); } else msg('Todavía no hay respuesta de tus padres.', 'e'); });
      };
      o.querySelector('[data-s]').onclick = function () {
        sb.auth.getSession().then(function (x) { return callConsent({ action: 'request', force: true }, x.data.session && x.data.session.access_token); })
          .then(function (j) { if (j && j.ok) msg('Aviso enviado. Revisa que le llegue (también en spam).', 'o'); else if (j && j.error === 'wait') msg('Espera un par de minutos para reenviar.', 'e'); else msg('No se pudo enviar. Intenta de nuevo.', 'e'); })
          .catch(function () { msg('Sin conexión. Revisa tu internet.', 'e'); });
      };
    }, true);
  }
  /* Pantalla que ve el padre/madre al abrir el enlace del correo (no necesita cuenta) */
  function consentSheet(token) {
    show('<h2>Autorización</h2><p>Un momento…</p>');
    fetch(C.SUPABASE_URL + '/functions/v1/parent-consent?token=' + encodeURIComponent(token), { headers: { apikey: C.SUPABASE_ANON_KEY } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) { show('<h2>Enlace no válido</h2><p>Este enlace venció o ya se usó. Pídele a tu hijo/a que reenvíe el aviso desde la app.</p>'); return; }
        show('<h2>¿Autorizas el uso de Plata Clara?</h2><p><b>' + esc(j.nombre) + '</b> quiere usar Plata Clara, una app de finanzas personales. Como tiene menos de 14 años, necesitamos tu permiso. Se guardarán sus datos de registro y los movimientos de dinero que anote. Puedes leer los <a href="terminos.html" target="_blank" rel="noopener">Términos</a> y la <a href="privacidad.html" target="_blank" rel="noopener">Política de Privacidad</a>.</p>' +
          '<button class="pc-b" data-d="approve">Sí, autorizo</button><button class="pc-b alt" data-d="reject">No autorizo</button><div class="pc-m" role="status"></div>', function (o) {
          o.querySelectorAll('[data-d]').forEach(function (b) {
            b.onclick = function () {
              o.querySelectorAll('[data-d]').forEach(function (x) { x.disabled = true; });
              var ok = b.getAttribute('data-d') === 'approve';
              callConsent({ action: 'decide', token: token, decision: b.getAttribute('data-d') }).then(function (r) {
                if (r && r.ok) show('<h2>' + (ok ? 'Listo, autorizado' : 'Respuesta enviada') + '</h2><p>' + (ok ? 'Ya puede entrar a la app.' : 'No se permitirá el uso de la app.') + ' Puedes cerrar esta página.</p>');
                else { msg('No se pudo enviar. Intenta de nuevo.', 'e'); o.querySelectorAll('[data-d]').forEach(function (x) { x.disabled = false; }); }
              }).catch(function () { msg('Sin conexión. Intenta de nuevo.', 'e'); o.querySelectorAll('[data-d]').forEach(function (x) { x.disabled = false; }); });
            };
          });
        });
      })
      .catch(function () { show('<h2>Sin conexión</h2><p>Revisa tu internet y abre el enlace de nuevo.</p>'); });
  }

  function authSheet(mode) {
    var reg = mode === 'register', reset = mode === 'reset', today = new Date().toISOString().slice(0, 10);
    var personal = reg ?
      '<label for="pc-n">Nombre</label><input id="pc-n" maxlength="40" autocomplete="given-name" required>' +
      '<label for="pc-a">Apellido</label><input id="pc-a" maxlength="40" autocomplete="family-name" required>' +
      '<label for="pc-g">Género</label><select id="pc-g" required><option value="">Elige una opción</option><option value="F">Femenino</option><option value="M">Masculino</option><option value="O">Otro</option><option value="N">Prefiero no decirlo</option></select>' +
      '<label for="pc-d">Fecha de nacimiento</label><input id="pc-d" type="date" min="1900-01-01" max="' + today + '" required>' +
      '<div id="pc-par" hidden><label for="pc-pe">Correo de tu mamá, papá o tutor</label><input id="pc-pe" type="email" autocomplete="off"><div class="pc-m" style="min-height:0">Tienes menos de 14 años: le enviaremos un aviso para que autorice que uses la app. Sin su permiso no podrás entrar.</div></div>' : '';
    show(
      '<h2>' + (reset ? 'Recuperar contraseña' : reg ? 'Crear cuenta' : 'Ingresar') + '</h2>' +
      '<p>' + (reset ? 'Te enviaremos un enlace a tu correo.' : 'Tus datos se guardan en la nube y los ves en todos tus dispositivos.') + '</p>' +
      '<form id="pc-f">' + personal +
      '<label for="pc-e">Correo</label><input id="pc-e" type="email" autocomplete="email" required>' +
      (reg ? '<label for="pc-e2">Confirma tu correo</label><input id="pc-e2" type="email" autocomplete="off" required>' : '') +
      (reset ? '' : '<label for="pc-p">' + (reg ? 'Crea una contraseña para la app' : 'Contraseña') + '</label><input id="pc-p" type="password" minlength="' + (reg ? 8 : 6) + '" autocomplete="' + (reg ? 'new-password' : 'current-password') + '" required>') +
      (reg ? '<div class="pc-m" style="min-height:0;margin-top:4px">Mínimo 8 caracteres. Que sea distinta a la contraseña de tu correo.</div><label for="pc-p2">Confirma la contraseña</label><input id="pc-p2" type="password" autocomplete="new-password" required>' : '') +
      (reg ? '<label style="display:flex;gap:8px;align-items:flex-start;margin:12px 0 4px;font-size:13px;line-height:1.45"><input id="pc-t" type="checkbox" style="width:auto;margin-top:3px" required><span>He leído y acepto los <a href="terminos.html" target="_blank" rel="noopener">Términos y Condiciones</a> y la <a href="privacidad.html" target="_blank" rel="noopener">Política de Privacidad</a>. Si tengo menos de 18 años, mi mamá, papá o tutor sabe que uso la app.</span></label>' : '') +
      '<button class="pc-b" type="submit">' + (reset ? 'Enviar enlace' : reg ? 'Crear cuenta' : 'Ingresar') + '</button></form>' +
      '<div class="pc-m" role="status"></div>' +
      (reset ? '<button class="pc-l" data-m="login">Volver</button>' :
        '<button class="pc-l" data-m="' + (reg ? 'login' : 'register') + '">' + (reg ? 'Ya tengo cuenta' : 'No tengo cuenta, crear una') + '</button>' +
        (reg ? '' : '<br><button class="pc-l" data-m="reset">Olvidé mi contraseña</button>')) +
      '',
      function (o) {
        o.querySelectorAll('[data-m]').forEach(function (b) { b.onclick = function () { authSheet(b.getAttribute('data-m')); }; });
        var dI = o.querySelector('#pc-d');
        if (dI) { var tog = function () { var a = age(dI.value), par = o.querySelector('#pc-par'), pe = o.querySelector('#pc-pe'); var minor = a != null && a >= 0 && a < 14; par.hidden = !minor; pe.required = minor; }; dI.onchange = tog; dI.oninput = tog; }
        var val = function (id) { var x = o.querySelector(id); return x ? x.value.trim() : ''; };
        o.querySelector('#pc-f').onsubmit = function (ev) {
          ev.preventDefault(); ev.stopPropagation();   // que el manejador global de la app no lo tome como suyo
          var email = val('#pc-e'), pw = (o.querySelector('#pc-p') || {}).value, go = o.querySelector('.pc-b'), meta = null, minor = false, bad = '';
          if (reg) {
            var nm = val('#pc-n'), ap = val('#pc-a'), ge = val('#pc-g'), fd = val('#pc-d'), ag = age(fd), pe = val('#pc-pe');
            minor = ag != null && ag < 14;
            if (!nm || !ap || !ge || !fd || ag == null || ag < 0 || ag > 120) bad = 'Completa todos tus datos.';
            else if (email.toLowerCase() !== val('#pc-e2').toLowerCase()) bad = 'Los correos no coinciden.';
            else if (!pw || pw.length < 8) bad = 'La contraseña debe tener al menos 8 caracteres.';
            else if (pw !== o.querySelector('#pc-p2').value) bad = 'Las contraseñas no coinciden.';
            else if (minor && !MAILRE.test(pe)) bad = 'Escribe un correo válido de tu mamá, papá o tutor.';
            else if (minor && pe.toLowerCase() === email.toLowerCase()) bad = 'El correo de tu mamá, papá o tutor debe ser distinto al tuyo.';
            else if (!o.querySelector('#pc-t').checked) bad = 'Debes aceptar los Términos y la Política de Privacidad.';
            meta = { nombre: nm, apellido: ap, genero: ge, fecha_nacimiento: fd, terms_version: '2026-10-22' };
            if (minor) meta.parent_email = pe;
          }
          if (bad) { msg(bad, 'e'); return; }
          go.disabled = true; msg('');
          client().then(function () {
            if (reset) return sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }).then(function (r) { if (r.error) throw r.error; msg('Listo. Revisa tu correo.', 'o'); });
            if (reg) return sb.auth.signUp({ email: email, password: pw, options: { data: meta, emailRedirectTo: location.origin + location.pathname } }).then(function (r) {
              if (r.error) throw r.error;
              if (!r.data.session) { msg(minor ? 'Te enviamos un correo para confirmar tu cuenta. Al entrar, avisaremos a tu mamá, papá o tutor para que autorice.' : 'Te enviamos un correo. Toca el enlace para confirmar y luego ingresa.', 'o'); }
            });
            return sb.auth.signInWithPassword({ email: email, password: pw }).then(function (r) { if (r.error) throw r.error; });
          }).catch(function (e) { msg(friendly(e), 'e'); }).then(function () { go.disabled = false; });
        };
      });
  }

  function chooseSheet(row) {
    var cnt = function (d) { return ((d.moves || []).length) + ' movimientos'; };
    show(
      '<h2>Ya tienes datos en la nube</h2>' +
      '<p>Este dispositivo también tiene datos (' + cnt(st()) + '). La nube tiene ' + cnt(row.data) + '. ¿Cuáles quieres conservar?</p>' +
      '<button class="pc-b" data-c="cloud">Usar los de la nube</button>' +
      '<button class="pc-b alt" data-c="local">Subir los de este dispositivo</button>' +
      '<div class="pc-m">Lo que no elijas se reemplaza. Si dudas, usa los de la nube.</div>',
      function (o) {
        o.querySelectorAll('[data-c]').forEach(function (b) {
          b.onclick = function () {
            var c = b.getAttribute('data-c'); close();
            if (c === 'cloud') applyRemote(row); else pushNow();
          };
        });
      });
  }

  function pushBlock(sub) {
    if (!VAPID) return '';
    var h = '<h3 style="font-size:16px;margin:18px 0 4px">Avisos de cuotas</h3>';
    h += '<p style="margin:0 0 8px">Te avisamos al celular 1 día antes y el mismo día de cada cuota, a las 10:00 a. m.</p>';
    if (!pushSupported() || (isIOS && !standalone)) {
      h += '<div class="pc-m">' + (isIOS && !standalone
        ? 'En iPhone, primero agrega la app a tu pantalla de inicio (Compartir → “Agregar a pantalla de inicio”) y ábrela desde ese ícono. Luego vuelve aquí para activar los avisos.'
        : 'Este navegador no permite avisos. Prueba con Chrome en Android o instala la app en tu pantalla de inicio.') + '</div>';
    } else if (Notification.permission === 'denied') {
      h += '<div class="pc-m e">Los avisos están bloqueados en este dispositivo. Actívalos en los ajustes del navegador o de la app y vuelve aquí.</div>';
    } else if (sub && Notification.permission === 'granted') {
      h += '<div class="pc-m o">Avisos activados en este dispositivo.</div>' +
        '<button class="pc-b alt" data-pt>Probar aviso</button><button class="pc-b alt" data-pd>Desactivar avisos</button>';
    } else {
      h += '<button class="pc-b" data-pe>Activar avisos en este dispositivo</button><div class="pc-m" data-pm></div>';
    }
    return h;
  }

  function accountSheet() {
    var label = { saving: 'Guardando…', ok: 'Todo guardado en la nube', error: 'No se pudo guardar. Se reintentará al guardar de nuevo.', idle: '' }[status];
    currentSub().then(function (sub) {
      show(
        '<h2>Tu cuenta</h2><p>' + esc(user.email) + '</p>' +
        '<div class="pc-m ' + (status === 'error' ? 'e' : 'o') + '">' + label + '</div>' +
        '<button class="pc-b alt" data-s>Sincronizar ahora</button>' +
        pushBlock(sub) +
        '<button class="pc-b alt" data-o>Cerrar sesión</button>' +
        '<button class="pc-b alt" data-x>Cerrar</button>',
        function (o) {
          o.querySelector('[data-s]').onclick = function () { reconcile().then(function () { if (ov) accountSheet(); }); };
          o.querySelector('[data-o]').onclick = function () {
            clearTimeout(pushTimer); pushTimer = null;
            Promise.resolve(disablePush()).catch(function () {})            // este dispositivo deja de recibir avisos de esta cuenta
              .then(function () { return pushNow(); })
              .then(function () { return sb.auth.signOut(); })
              .then(function () { wipeLocal(); });
          };
          o.querySelector('[data-x]').onclick = close;
          var pe = o.querySelector('[data-pe]'), pd = o.querySelector('[data-pd]'), pt = o.querySelector('[data-pt]');
          if (pe) pe.onclick = function () {
            pe.disabled = true;
            enablePush().then(function () { accountSheet(); }).catch(function (e) {
              pe.disabled = false;
              var m = o.querySelector('[data-pm]');
              if (m) { m.className = 'pc-m e'; m.textContent = (e && e.message === 'denied') ? 'No diste permiso. Pulsa de nuevo y elige “Permitir”.' : 'No se pudieron activar los avisos. Intenta de nuevo.'; }
            });
          };
          if (pd) pd.onclick = function () { pd.disabled = true; disablePush().then(function () { accountSheet(); }, function () { accountSheet(); }); };
          if (pt) pt.onclick = function () { testPush(); };
        });
    });
  }

  var lastUid = null;
  function paint() {
    if (user && consentOK) unlock();
    if ((user && user.id) !== lastUid) { lastUid = user && user.id; nt.err = ''; refreshNotif(); }
    if (!btn) return;
    btn.classList.toggle('on', !!user);
    btn.setAttribute('aria-label', user ? 'Tu cuenta' : 'Ingresar');
    btn.title = user ? (status === 'error' ? 'Error al sincronizar' : 'Sincronizado') : 'Ingresar';
  }

  if (btn) btn.addEventListener('click', function () {
    client().then(function () { return sb.auth.getSession(); }).then(function (r) {
      user = r.data.session ? r.data.session.user : null;
      if (user) accountSheet(); else authSheet('login');
    }).catch(function () { show('<h2>Sin conexión</h2><p>No se pudo cargar el inicio de sesión. Revisa tu internet.</p><button class="pc-b" data-x>Cerrar</button>', function (o) { o.querySelector('[data-x]').onclick = close; }); });
  });

  /* Compuerta: la app no se ve hasta ingresar. */
  function boot() {
    lock();
    show('<h2>Cargando…</h2><p>Un momento.</p>');
    client().then(function () { return sb.auth.getSession(); }).then(function (r) {
      if (r.data.session) { if (!user) { user = r.data.session.user; } checkConsent().then(function (ok) { if (ok) { paint(); reconcile(); } }); }
      else authSheet('login');
    }).catch(function () {
      if (getMark().uid) { unlock(); return; }   // ya ingresó antes en este dispositivo: dejar usar sin internet
      show('<h2>Sin conexión</h2><p>Necesitas internet para ingresar la primera vez.</p><button class="pc-b" data-r>Reintentar</button>',
        function (o) { o.querySelector('[data-r]').onclick = boot; });
    });
  }
  var ctoken = null; try { ctoken = new URLSearchParams(location.search).get('consent'); } catch (e) {}
  if (ctoken) { lock(); consentSheet(ctoken); } else boot();
})();
