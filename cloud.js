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
        if (!user && ev === 'SIGNED_OUT') { lock(); accessSheet(); }
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
      '#pc-ov .pc-lg{margin-top:12px}#pc-ov .pc-lg select{width:auto;min-width:160px;padding:7px 10px;font-size:14px;background:rgba(255,255,255,.2);color:#fff;border:1px solid rgba(255,255,255,.45)}#pc-ov .pc-lg option{color:#14231d}' +
      '#pc-ov select{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:var(--surface2);color:var(--ink);font-size:16px}';
    document.head.appendChild(s);
  }
  function close() { if (ov) { ov.remove(); ov = null; } }
  /* ---- Traducción de la pantalla de registro y acceso ---- */
  var TR = {"en": {"Tus finanzas, claras y en orden": "Your finances, clear and in order", "Acceso privado": "Private access", "Plata Clara es de acceso privado. Para usarla, primero gestiona tu acceso con un ": "Plata Clara is private. To use it, first arrange your access with a ", "pago único": "one-time payment", ". Cuando recibamos tu pago te daremos permiso con tu correo y podrás crear tu cuenta.": ". Once we receive your payment, we will enable your email and you can create your account.", "Gestionar mi acceso": "Get my access", "Pídele el acceso a quien te compartió este enlace.": "Ask for access from whoever shared this link.", "Ya me dieron acceso: crear mi cuenta": "I have access: create my account", "Ya tengo cuenta: ingresar": "I have an account: sign in", "Términos y Condiciones": "Terms and Conditions", "Términos": "Terms", "Política de Privacidad": "Privacy Policy", "Privacidad": "Privacy", " y la ": " and the ", "Recuperar contraseña": "Reset password", "Crear cuenta": "Create account", "Ingresar": "Sign in", "Te enviaremos un enlace a tu correo.": "We will send a link to your email.", "Tus datos se guardan en la nube y los ves en todos tus dispositivos.": "Your data is saved in the cloud and you see it on all your devices.", "Nombre": "First name", "Apellido": "Last name", "Género": "Gender", "Elige una opción": "Choose an option", "Femenino": "Female", "Masculino": "Male", "Otro": "Other", "Prefiero no decirlo": "Prefer not to say", "Fecha de nacimiento": "Date of birth", "Correo de tu mamá, papá o tutor": "Email of your mom, dad or guardian", "Tienes menos de 14 años: le enviaremos un aviso para que autorice que uses la app. Sin su permiso no podrás entrar.": "You are under 14: we will send them a notice so they can authorize you to use the app. Without their permission you will not be able to enter.", "Correo": "Email", "Usa el mismo correo con el que gestionaste tu acceso.": "Use the same email you used to arrange your access.", "Confirma tu correo": "Confirm your email", "Crea una contraseña para la app": "Create a password for the app", "Contraseña": "Password", "Mínimo 8 caracteres. Que sea distinta a la contraseña de tu correo.": "At least 8 characters. Different from your email password.", "Confirma la contraseña": "Confirm the password", "He leído y acepto los ": "I have read and accept the ", ". Si tengo menos de 18 años, mi mamá, papá o tutor sabe que uso la app.": ". If I am under 18, my mom, dad or guardian knows I use the app.", "Enviar enlace": "Send link", "Volver": "Back", "Ya tengo cuenta": "I already have an account", "No tengo cuenta": "I don't have an account", "Olvidé mi contraseña": "I forgot my password", "Completa todos tus datos.": "Fill in all your details.", "Los correos no coinciden.": "The emails do not match.", "La contraseña debe tener al menos 8 caracteres.": "The password must have at least 8 characters.", "Las contraseñas no coinciden.": "The passwords do not match.", "Escribe un correo válido de tu mamá, papá o tutor.": "Enter a valid email for your mom, dad or guardian.", "El correo de tu mamá, papá o tutor debe ser distinto al tuyo.": "The email of your mom, dad or guardian must be different from yours.", "Debes aceptar los Términos y la Política de Privacidad.": "You must accept the Terms and the Privacy Policy.", "Listo. Revisa tu correo.": "Done. Check your email.", "Te enviamos un correo para confirmar tu cuenta. Al entrar, avisaremos a tu mamá, papá o tutor para que autorice.": "We sent you an email to confirm your account. When you sign in, we will notify your mom, dad or guardian to authorize.", "Te enviamos un correo. Toca el enlace para confirmar y luego ingresa.": "We sent you an email. Tap the link to confirm, then sign in.", "Ese correo todavía no tiene acceso. Primero gestiona tu acceso con un pago único.": "That email does not have access yet. First arrange your access with a one-time payment.", "Correo o contraseña incorrectos.": "Incorrect email or password.", "Ese correo ya tiene cuenta. Ingresa con tu contraseña.": "That email already has an account. Sign in with your password.", "La contraseña debe tener al menos 6 caracteres.": "The password must have at least 6 characters.", "Demasiados intentos. Espera unos minutos.": "Too many attempts. Wait a few minutes.", "Confirma tu correo con el enlace que te enviamos y vuelve a ingresar.": "Confirm your email with the link we sent you and sign in again.", "Sin conexión. Revisa tu internet.": "No connection. Check your internet.", "No se pudo completar. Intenta de nuevo.": "Could not complete. Try again.", "No autorizado": "Not authorized", "Tu mamá, papá o tutor no autorizó el uso de la app, así que no puedes entrar.": "Your mom, dad or guardian did not authorize the app, so you cannot enter.", "Cerrar sesión": "Sign out", "Cerrar": "Close", "No se pudo verificar": "Could not verify", "Revisa tu internet e inténtalo de nuevo.": "Check your internet and try again.", "Reintentar": "Retry", "Falta el permiso de tus padres": "Your parents' permission is missing", "Enviamos un aviso a ": "We sent a notice to ", ". Cuando autorice, toca “Ya autorizaron”.": ". When they authorize, tap “They authorized”.", "Ya autorizaron, entrar": "They authorized, enter", "Reenviar el aviso": "Resend the notice", "Todavía no hay respuesta de tus padres.": "No reply from your parents yet.", "Aviso enviado. Revisa que le llegue (también en spam).": "Notice sent. Make sure it arrives (check spam too).", "Espera un par de minutos para reenviar.": "Wait a couple of minutes to resend.", "No se pudo enviar. Intenta de nuevo.": "Could not send. Try again.", "Autorización": "Authorization", "Un momento…": "One moment…", "Enlace no válido": "Invalid link", "Este enlace venció o ya se usó. Pídele a tu hijo/a que reenvíe el aviso desde la app.": "This link expired or was already used. Ask your child to resend the notice from the app.", "¿Autorizas el uso de Plata Clara?": "Do you authorize the use of Plata Clara?", " quiere usar Plata Clara, una app de finanzas personales. Como tiene menos de 14 años, necesitamos tu permiso. Se guardarán sus datos de registro y los movimientos de dinero que anote. Puedes leer los ": " wants to use Plata Clara, a personal finance app. As they are under 14, we need your permission. Their registration data and the money movements they record will be stored. You can read the ", "Sí, autorizo": "Yes, I authorize", "No autorizo": "I do not authorize", "Listo, autorizado": "Done, authorized", "Respuesta enviada": "Reply sent", "Ya puede entrar a la app.": "They can now enter the app.", "No se permitirá el uso de la app.": "Use of the app will not be allowed.", " Puedes cerrar esta página.": " You can close this page.", "Sin conexión. Intenta de nuevo.": "No connection. Try again.", "Sin conexión": "No connection", "Revisa tu internet y abre el enlace de nuevo.": "Check your internet and open the link again.", "Tu cuenta": "Your account", "Sincronizar ahora": "Sync now", "Cargando…": "Loading…"}, "pt": {"Tus finanzas, claras y en orden": "Suas finanças, claras e em ordem", "Acceso privado": "Acesso privado", "Plata Clara es de acceso privado. Para usarla, primero gestiona tu acceso con un ": "O Plata Clara é de acesso privado. Para usá-lo, primeiro providencie seu acesso com um ", "pago único": "pagamento único", ". Cuando recibamos tu pago te daremos permiso con tu correo y podrás crear tu cuenta.": ". Quando recebermos seu pagamento, liberaremos seu e-mail e você poderá criar sua conta.", "Gestionar mi acceso": "Providenciar meu acesso", "Pídele el acceso a quien te compartió este enlace.": "Peça o acesso a quem compartilhou este link.", "Ya me dieron acceso: crear mi cuenta": "Já tenho acesso: criar minha conta", "Ya tengo cuenta: ingresar": "Já tenho conta: entrar", "Términos y Condiciones": "Termos e Condições", "Términos": "Termos", "Política de Privacidad": "Política de Privacidade", "Privacidad": "Privacidade", " y la ": " e a ", "Recuperar contraseña": "Recuperar senha", "Crear cuenta": "Criar conta", "Ingresar": "Entrar", "Te enviaremos un enlace a tu correo.": "Enviaremos um link para seu e-mail.", "Tus datos se guardan en la nube y los ves en todos tus dispositivos.": "Seus dados ficam salvos na nuvem e você os vê em todos os seus dispositivos.", "Nombre": "Nome", "Apellido": "Sobrenome", "Género": "Gênero", "Elige una opción": "Escolha uma opção", "Femenino": "Feminino", "Masculino": "Masculino", "Otro": "Outro", "Prefiero no decirlo": "Prefiro não dizer", "Fecha de nacimiento": "Data de nascimento", "Correo de tu mamá, papá o tutor": "E-mail da sua mãe, pai ou responsável", "Tienes menos de 14 años: le enviaremos un aviso para que autorice que uses la app. Sin su permiso no podrás entrar.": "Você tem menos de 14 anos: enviaremos um aviso para que autorize o uso do app. Sem a permissão não será possível entrar.", "Correo": "E-mail", "Usa el mismo correo con el que gestionaste tu acceso.": "Use o mesmo e-mail com o qual providenciou seu acesso.", "Confirma tu correo": "Confirme seu e-mail", "Crea una contraseña para la app": "Crie uma senha para o app", "Contraseña": "Senha", "Mínimo 8 caracteres. Que sea distinta a la contraseña de tu correo.": "Mínimo de 8 caracteres. Diferente da senha do seu e-mail.", "Confirma la contraseña": "Confirme a senha", "He leído y acepto los ": "Li e aceito os ", ". Si tengo menos de 18 años, mi mamá, papá o tutor sabe que uso la app.": ". Se tenho menos de 18 anos, minha mãe, pai ou responsável sabe que uso o app.", "Enviar enlace": "Enviar link", "Volver": "Voltar", "Ya tengo cuenta": "Já tenho conta", "No tengo cuenta": "Não tenho conta", "Olvidé mi contraseña": "Esqueci minha senha", "Completa todos tus datos.": "Preencha todos os seus dados.", "Los correos no coinciden.": "Os e-mails não coincidem.", "La contraseña debe tener al menos 8 caracteres.": "A senha deve ter pelo menos 8 caracteres.", "Las contraseñas no coinciden.": "As senhas não coincidem.", "Escribe un correo válido de tu mamá, papá o tutor.": "Digite um e-mail válido da sua mãe, pai ou responsável.", "El correo de tu mamá, papá o tutor debe ser distinto al tuyo.": "O e-mail da sua mãe, pai ou responsável deve ser diferente do seu.", "Debes aceptar los Términos y la Política de Privacidad.": "Você deve aceitar os Termos e a Política de Privacidade.", "Listo. Revisa tu correo.": "Pronto. Verifique seu e-mail.", "Te enviamos un correo para confirmar tu cuenta. Al entrar, avisaremos a tu mamá, papá o tutor para que autorice.": "Enviamos um e-mail para confirmar sua conta. Ao entrar, avisaremos sua mãe, pai ou responsável para autorizar.", "Te enviamos un correo. Toca el enlace para confirmar y luego ingresa.": "Enviamos um e-mail. Toque no link para confirmar e depois entre.", "Ese correo todavía no tiene acceso. Primero gestiona tu acceso con un pago único.": "Esse e-mail ainda não tem acesso. Primeiro providencie seu acesso com um pagamento único.", "Correo o contraseña incorrectos.": "E-mail ou senha incorretos.", "Ese correo ya tiene cuenta. Ingresa con tu contraseña.": "Esse e-mail já tem conta. Entre com sua senha.", "La contraseña debe tener al menos 6 caracteres.": "A senha deve ter pelo menos 6 caracteres.", "Demasiados intentos. Espera unos minutos.": "Muitas tentativas. Aguarde alguns minutos.", "Confirma tu correo con el enlace que te enviamos y vuelve a ingresar.": "Confirme seu e-mail pelo link que enviamos e entre novamente.", "Sin conexión. Revisa tu internet.": "Sem conexão. Verifique sua internet.", "No se pudo completar. Intenta de nuevo.": "Não foi possível concluir. Tente novamente.", "No autorizado": "Não autorizado", "Tu mamá, papá o tutor no autorizó el uso de la app, así que no puedes entrar.": "Sua mãe, pai ou responsável não autorizou o uso do app, então você não pode entrar.", "Cerrar sesión": "Sair", "Cerrar": "Fechar", "No se pudo verificar": "Não foi possível verificar", "Revisa tu internet e inténtalo de nuevo.": "Verifique sua internet e tente novamente.", "Reintentar": "Tentar novamente", "Falta el permiso de tus padres": "Falta a permissão dos seus pais", "Enviamos un aviso a ": "Enviamos um aviso para ", ". Cuando autorice, toca “Ya autorizaron”.": ". Quando autorizar, toque em “Já autorizaram”.", "Ya autorizaron, entrar": "Já autorizaram, entrar", "Reenviar el aviso": "Reenviar o aviso", "Todavía no hay respuesta de tus padres.": "Ainda não há resposta dos seus pais.", "Aviso enviado. Revisa que le llegue (también en spam).": "Aviso enviado. Verifique se chegou (também no spam).", "Espera un par de minutos para reenviar.": "Aguarde alguns minutos para reenviar.", "No se pudo enviar. Intenta de nuevo.": "Não foi possível enviar. Tente novamente.", "Autorización": "Autorização", "Un momento…": "Um momento…", "Enlace no válido": "Link inválido", "Este enlace venció o ya se usó. Pídele a tu hijo/a que reenvíe el aviso desde la app.": "Este link expirou ou já foi usado. Peça ao seu filho(a) que reenvie o aviso pelo app.", "¿Autorizas el uso de Plata Clara?": "Você autoriza o uso do Plata Clara?", " quiere usar Plata Clara, una app de finanzas personales. Como tiene menos de 14 años, necesitamos tu permiso. Se guardarán sus datos de registro y los movimientos de dinero que anote. Puedes leer los ": " quer usar o Plata Clara, um app de finanças pessoais. Como tem menos de 14 anos, precisamos da sua permissão. Serão guardados seus dados de cadastro e as movimentações de dinheiro que registrar. Você pode ler os ", "Sí, autorizo": "Sim, autorizo", "No autorizo": "Não autorizo", "Listo, autorizado": "Pronto, autorizado", "Respuesta enviada": "Resposta enviada", "Ya puede entrar a la app.": "Já pode entrar no app.", "No se permitirá el uso de la app.": "O uso do app não será permitido.", " Puedes cerrar esta página.": " Você pode fechar esta página.", "Sin conexión. Intenta de nuevo.": "Sem conexão. Tente novamente.", "Sin conexión": "Sem conexão", "Revisa tu internet y abre el enlace de nuevo.": "Verifique sua internet e abra o link novamente.", "Tu cuenta": "Sua conta", "Sincronizar ahora": "Sincronizar agora", "Cargando…": "Carregando…"}, "fr": {"Tus finanzas, claras y en orden": "Vos finances, claires et en ordre", "Acceso privado": "Accès privé", "Plata Clara es de acceso privado. Para usarla, primero gestiona tu acceso con un ": "Plata Clara est en accès privé. Pour l'utiliser, obtenez d'abord votre accès avec un ", "pago único": "paiement unique", ". Cuando recibamos tu pago te daremos permiso con tu correo y podrás crear tu cuenta.": ". Quand nous recevrons votre paiement, nous activerons votre e-mail et vous pourrez créer votre compte.", "Gestionar mi acceso": "Obtenir mon accès", "Pídele el acceso a quien te compartió este enlace.": "Demandez l'accès à la personne qui vous a partagé ce lien.", "Ya me dieron acceso: crear mi cuenta": "J'ai l'accès : créer mon compte", "Ya tengo cuenta: ingresar": "J'ai un compte : me connecter", "Términos y Condiciones": "Conditions générales", "Términos": "Conditions", "Política de Privacidad": "Politique de confidentialité", "Privacidad": "Confidentialité", " y la ": " et la ", "Recuperar contraseña": "Récupérer le mot de passe", "Crear cuenta": "Créer un compte", "Ingresar": "Se connecter", "Te enviaremos un enlace a tu correo.": "Nous vous enverrons un lien par e-mail.", "Tus datos se guardan en la nube y los ves en todos tus dispositivos.": "Vos données sont enregistrées dans le cloud et visibles sur tous vos appareils.", "Nombre": "Prénom", "Apellido": "Nom de famille", "Género": "Genre", "Elige una opción": "Choisissez une option", "Femenino": "Féminin", "Masculino": "Masculin", "Otro": "Autre", "Prefiero no decirlo": "Je préfère ne pas le dire", "Fecha de nacimiento": "Date de naissance", "Correo de tu mamá, papá o tutor": "E-mail de ta mère, ton père ou ton tuteur", "Tienes menos de 14 años: le enviaremos un aviso para que autorice que uses la app. Sin su permiso no podrás entrar.": "Tu as moins de 14 ans : nous leur enverrons un avis pour qu'ils autorisent ton utilisation de l'app. Sans leur accord, tu ne pourras pas entrer.", "Correo": "E-mail", "Usa el mismo correo con el que gestionaste tu acceso.": "Utilise le même e-mail que pour obtenir ton accès.", "Confirma tu correo": "Confirme ton e-mail", "Crea una contraseña para la app": "Crée un mot de passe pour l'app", "Contraseña": "Mot de passe", "Mínimo 8 caracteres. Que sea distinta a la contraseña de tu correo.": "8 caractères minimum. Différent du mot de passe de ton e-mail.", "Confirma la contraseña": "Confirme le mot de passe", "He leído y acepto los ": "J'ai lu et j'accepte les ", ". Si tengo menos de 18 años, mi mamá, papá o tutor sabe que uso la app.": ". Si j'ai moins de 18 ans, ma mère, mon père ou mon tuteur sait que j'utilise l'app.", "Enviar enlace": "Envoyer le lien", "Volver": "Retour", "Ya tengo cuenta": "J'ai déjà un compte", "No tengo cuenta": "Je n'ai pas de compte", "Olvidé mi contraseña": "J'ai oublié mon mot de passe", "Completa todos tus datos.": "Remplis toutes tes informations.", "Los correos no coinciden.": "Les e-mails ne correspondent pas.", "La contraseña debe tener al menos 8 caracteres.": "Le mot de passe doit contenir au moins 8 caractères.", "Las contraseñas no coinciden.": "Les mots de passe ne correspondent pas.", "Escribe un correo válido de tu mamá, papá o tutor.": "Saisis un e-mail valide de ta mère, ton père ou ton tuteur.", "El correo de tu mamá, papá o tutor debe ser distinto al tuyo.": "L'e-mail de ta mère, ton père ou ton tuteur doit être différent du tien.", "Debes aceptar los Términos y la Política de Privacidad.": "Tu dois accepter les Conditions et la Politique de confidentialité.", "Listo. Revisa tu correo.": "C'est fait. Vérifie ton e-mail.", "Te enviamos un correo para confirmar tu cuenta. Al entrar, avisaremos a tu mamá, papá o tutor para que autorice.": "Nous t'avons envoyé un e-mail pour confirmer ton compte. À ta connexion, nous préviendrons ta mère, ton père ou ton tuteur pour qu'ils autorisent.", "Te enviamos un correo. Toca el enlace para confirmar y luego ingresa.": "Nous t'avons envoyé un e-mail. Touche le lien pour confirmer, puis connecte-toi.", "Ese correo todavía no tiene acceso. Primero gestiona tu acceso con un pago único.": "Cet e-mail n'a pas encore accès. Obtiens d'abord ton accès avec un paiement unique.", "Correo o contraseña incorrectos.": "E-mail ou mot de passe incorrect.", "Ese correo ya tiene cuenta. Ingresa con tu contraseña.": "Cet e-mail a déjà un compte. Connecte-toi avec ton mot de passe.", "La contraseña debe tener al menos 6 caracteres.": "Le mot de passe doit contenir au moins 6 caractères.", "Demasiados intentos. Espera unos minutos.": "Trop de tentatives. Attends quelques minutes.", "Confirma tu correo con el enlace que te enviamos y vuelve a ingresar.": "Confirme ton e-mail avec le lien que nous t'avons envoyé, puis reconnecte-toi.", "Sin conexión. Revisa tu internet.": "Pas de connexion. Vérifie ton internet.", "No se pudo completar. Intenta de nuevo.": "Impossible de terminer. Réessaie.", "No autorizado": "Non autorisé", "Tu mamá, papá o tutor no autorizó el uso de la app, así que no puedes entrar.": "Ta mère, ton père ou ton tuteur n'a pas autorisé l'app, tu ne peux donc pas entrer.", "Cerrar sesión": "Se déconnecter", "Cerrar": "Fermer", "No se pudo verificar": "Vérification impossible", "Revisa tu internet e inténtalo de nuevo.": "Vérifie ton internet et réessaie.", "Reintentar": "Réessayer", "Falta el permiso de tus padres": "L'autorisation de tes parents manque", "Enviamos un aviso a ": "Nous avons envoyé un avis à ", ". Cuando autorice, toca “Ya autorizaron”.": ". Quand ils auront autorisé, touche « Ils ont autorisé ».", "Ya autorizaron, entrar": "Ils ont autorisé, entrer", "Reenviar el aviso": "Renvoyer l'avis", "Todavía no hay respuesta de tus padres.": "Pas encore de réponse de tes parents.", "Aviso enviado. Revisa que le llegue (también en spam).": "Avis envoyé. Vérifie qu'il arrive (aussi dans les spams).", "Espera un par de minutos para reenviar.": "Attends quelques minutes avant de renvoyer.", "No se pudo enviar. Intenta de nuevo.": "Envoi impossible. Réessaie.", "Autorización": "Autorisation", "Un momento…": "Un instant…", "Enlace no válido": "Lien non valide", "Este enlace venció o ya se usó. Pídele a tu hijo/a que reenvíe el aviso desde la app.": "Ce lien a expiré ou a déjà été utilisé. Demande à ton enfant de renvoyer l'avis depuis l'app.", "¿Autorizas el uso de Plata Clara?": "Autorises-tu l'utilisation de Plata Clara ?", " quiere usar Plata Clara, una app de finanzas personales. Como tiene menos de 14 años, necesitamos tu permiso. Se guardarán sus datos de registro y los movimientos de dinero que anote. Puedes leer los ": " veut utiliser Plata Clara, une app de finances personnelles. Ayant moins de 14 ans, nous avons besoin de ton accord. Ses données d'inscription et les mouvements d'argent saisis seront conservés. Tu peux lire les ", "Sí, autorizo": "Oui, j'autorise", "No autorizo": "Je n'autorise pas", "Listo, autorizado": "C'est fait, autorisé", "Respuesta enviada": "Réponse envoyée", "Ya puede entrar a la app.": "Il ou elle peut maintenant entrer dans l'app.", "No se permitirá el uso de la app.": "L'utilisation de l'app ne sera pas autorisée.", " Puedes cerrar esta página.": " Tu peux fermer cette page.", "Sin conexión. Intenta de nuevo.": "Pas de connexion. Réessaie.", "Sin conexión": "Pas de connexion", "Revisa tu internet y abre el enlace de nuevo.": "Vérifie ton internet et ouvre à nouveau le lien.", "Tu cuenta": "Ton compte", "Sincronizar ahora": "Synchroniser maintenant", "Cargando…": "Chargement…"}, "de": {"Tus finanzas, claras y en orden": "Deine Finanzen, klar und in Ordnung", "Acceso privado": "Privater Zugang", "Plata Clara es de acceso privado. Para usarla, primero gestiona tu acceso con un ": "Plata Clara ist privat. Um es zu nutzen, besorge dir zuerst den Zugang mit einer ", "pago único": "Einmalzahlung", ". Cuando recibamos tu pago te daremos permiso con tu correo y podrás crear tu cuenta.": ". Sobald deine Zahlung eingegangen ist, schalten wir deine E-Mail frei und du kannst dein Konto erstellen.", "Gestionar mi acceso": "Meinen Zugang besorgen", "Pídele el acceso a quien te compartió este enlace.": "Frage die Person, die dir diesen Link geschickt hat, nach dem Zugang.", "Ya me dieron acceso: crear mi cuenta": "Ich habe Zugang: Konto erstellen", "Ya tengo cuenta: ingresar": "Ich habe ein Konto: anmelden", "Términos y Condiciones": "Nutzungsbedingungen", "Términos": "Bedingungen", "Política de Privacidad": "Datenschutzerklärung", "Privacidad": "Datenschutz", " y la ": " und die ", "Recuperar contraseña": "Passwort zurücksetzen", "Crear cuenta": "Konto erstellen", "Ingresar": "Anmelden", "Te enviaremos un enlace a tu correo.": "Wir senden dir einen Link per E-Mail.", "Tus datos se guardan en la nube y los ves en todos tus dispositivos.": "Deine Daten werden in der Cloud gespeichert und sind auf allen Geräten sichtbar.", "Nombre": "Vorname", "Apellido": "Nachname", "Género": "Geschlecht", "Elige una opción": "Wähle eine Option", "Femenino": "Weiblich", "Masculino": "Männlich", "Otro": "Divers", "Prefiero no decirlo": "Keine Angabe", "Fecha de nacimiento": "Geburtsdatum", "Correo de tu mamá, papá o tutor": "E-Mail deiner Mutter, deines Vaters oder Vormunds", "Tienes menos de 14 años: le enviaremos un aviso para que autorice que uses la app. Sin su permiso no podrás entrar.": "Du bist unter 14: Wir senden ihnen eine Nachricht, damit sie die Nutzung erlauben. Ohne ihre Erlaubnis kannst du nicht hinein.", "Correo": "E-Mail", "Usa el mismo correo con el que gestionaste tu acceso.": "Verwende dieselbe E-Mail, mit der du den Zugang besorgt hast.", "Confirma tu correo": "Bestätige deine E-Mail", "Crea una contraseña para la app": "Erstelle ein Passwort für die App", "Contraseña": "Passwort", "Mínimo 8 caracteres. Que sea distinta a la contraseña de tu correo.": "Mindestens 8 Zeichen. Anders als dein E-Mail-Passwort.", "Confirma la contraseña": "Bestätige das Passwort", "He leído y acepto los ": "Ich akzeptiere die ", ". Si tengo menos de 18 años, mi mamá, papá o tutor sabe que uso la app.": ". Wenn ich unter 18 bin, wissen meine Eltern oder mein Vormund, dass ich die App nutze.", "Enviar enlace": "Link senden", "Volver": "Zurück", "Ya tengo cuenta": "Ich habe schon ein Konto", "No tengo cuenta": "Ich habe kein Konto", "Olvidé mi contraseña": "Passwort vergessen", "Completa todos tus datos.": "Fülle alle Angaben aus.", "Los correos no coinciden.": "Die E-Mails stimmen nicht überein.", "La contraseña debe tener al menos 8 caracteres.": "Das Passwort muss mindestens 8 Zeichen haben.", "Las contraseñas no coinciden.": "Die Passwörter stimmen nicht überein.", "Escribe un correo válido de tu mamá, papá o tutor.": "Gib eine gültige E-Mail deiner Eltern oder deines Vormunds ein.", "El correo de tu mamá, papá o tutor debe ser distinto al tuyo.": "Die E-Mail deiner Eltern oder deines Vormunds muss sich von deiner unterscheiden.", "Debes aceptar los Términos y la Política de Privacidad.": "Du musst die Nutzungsbedingungen und die Datenschutzerklärung akzeptieren.", "Listo. Revisa tu correo.": "Fertig. Prüfe deine E-Mail.", "Te enviamos un correo para confirmar tu cuenta. Al entrar, avisaremos a tu mamá, papá o tutor para que autorice.": "Wir haben dir eine E-Mail zur Bestätigung gesendet. Beim Anmelden benachrichtigen wir deine Eltern oder deinen Vormund zur Freigabe.", "Te enviamos un correo. Toca el enlace para confirmar y luego ingresa.": "Wir haben dir eine E-Mail gesendet. Tippe auf den Link zum Bestätigen und melde dich dann an.", "Ese correo todavía no tiene acceso. Primero gestiona tu acceso con un pago único.": "Diese E-Mail hat noch keinen Zugang. Besorge dir zuerst den Zugang mit einer Einmalzahlung.", "Correo o contraseña incorrectos.": "E-Mail oder Passwort falsch.", "Ese correo ya tiene cuenta. Ingresa con tu contraseña.": "Diese E-Mail hat bereits ein Konto. Melde dich mit deinem Passwort an.", "La contraseña debe tener al menos 6 caracteres.": "Das Passwort muss mindestens 6 Zeichen haben.", "Demasiados intentos. Espera unos minutos.": "Zu viele Versuche. Warte ein paar Minuten.", "Confirma tu correo con el enlace que te enviamos y vuelve a ingresar.": "Bestätige deine E-Mail mit dem Link, den wir dir geschickt haben, und melde dich erneut an.", "Sin conexión. Revisa tu internet.": "Keine Verbindung. Prüfe dein Internet.", "No se pudo completar. Intenta de nuevo.": "Fehlgeschlagen. Versuche es erneut.", "No autorizado": "Nicht genehmigt", "Tu mamá, papá o tutor no autorizó el uso de la app, así que no puedes entrar.": "Deine Eltern oder dein Vormund haben die Nutzung nicht erlaubt, daher kannst du nicht hinein.", "Cerrar sesión": "Abmelden", "Cerrar": "Schließen", "No se pudo verificar": "Überprüfung fehlgeschlagen", "Revisa tu internet e inténtalo de nuevo.": "Prüfe dein Internet und versuche es erneut.", "Reintentar": "Erneut versuchen", "Falta el permiso de tus padres": "Die Erlaubnis deiner Eltern fehlt", "Enviamos un aviso a ": "Wir haben eine Nachricht gesendet an ", ". Cuando autorice, toca “Ya autorizaron”.": ". Wenn sie erlaubt haben, tippe auf „Sie haben erlaubt“.", "Ya autorizaron, entrar": "Sie haben erlaubt, hinein", "Reenviar el aviso": "Nachricht erneut senden", "Todavía no hay respuesta de tus padres.": "Noch keine Antwort deiner Eltern.", "Aviso enviado. Revisa que le llegue (también en spam).": "Nachricht gesendet. Prüfe, ob sie ankommt (auch im Spam).", "Espera un par de minutos para reenviar.": "Warte ein paar Minuten, bevor du erneut sendest.", "No se pudo enviar. Intenta de nuevo.": "Senden fehlgeschlagen. Versuche es erneut.", "Autorización": "Genehmigung", "Un momento…": "Einen Moment…", "Enlace no válido": "Ungültiger Link", "Este enlace venció o ya se usó. Pídele a tu hijo/a que reenvíe el aviso desde la app.": "Dieser Link ist abgelaufen oder wurde bereits verwendet. Bitte dein Kind, die Nachricht in der App erneut zu senden.", "¿Autorizas el uso de Plata Clara?": "Erlaubst du die Nutzung von Plata Clara?", " quiere usar Plata Clara, una app de finanzas personales. Como tiene menos de 14 años, necesitamos tu permiso. Se guardarán sus datos de registro y los movimientos de dinero que anote. Puedes leer los ": " möchte Plata Clara, eine App für persönliche Finanzen, nutzen. Da er/sie unter 14 ist, brauchen wir deine Erlaubnis. Registrierungsdaten und erfasste Geldbewegungen werden gespeichert. Lies auch die ", "Sí, autorizo": "Ja, ich erlaube", "No autorizo": "Ich erlaube nicht", "Listo, autorizado": "Fertig, erlaubt", "Respuesta enviada": "Antwort gesendet", "Ya puede entrar a la app.": "Er oder sie kann jetzt in die App.", "No se permitirá el uso de la app.": "Die Nutzung der App wird nicht erlaubt.", " Puedes cerrar esta página.": " Du kannst diese Seite schließen.", "Sin conexión. Intenta de nuevo.": "Keine Verbindung. Versuche es erneut.", "Sin conexión": "Keine Verbindung", "Revisa tu internet y abre el enlace de nuevo.": "Prüfe dein Internet und öffne den Link erneut.", "Tu cuenta": "Dein Konto", "Sincronizar ahora": "Jetzt synchronisieren", "Cargando…": "Lädt…"}, "it": {"Tus finanzas, claras y en orden": "Le tue finanze, chiare e in ordine", "Acceso privado": "Accesso privato", "Plata Clara es de acceso privado. Para usarla, primero gestiona tu acceso con un ": "Plata Clara è ad accesso privato. Per usarla, prima gestisci il tuo accesso con un ", "pago único": "pagamento unico", ". Cuando recibamos tu pago te daremos permiso con tu correo y podrás crear tu cuenta.": ". Quando riceveremo il pagamento, abiliteremo la tua email e potrai creare il tuo account.", "Gestionar mi acceso": "Gestisci il mio accesso", "Pídele el acceso a quien te compartió este enlace.": "Chiedi l'accesso a chi ti ha condiviso questo link.", "Ya me dieron acceso: crear mi cuenta": "Ho l'accesso: crea il mio account", "Ya tengo cuenta: ingresar": "Ho un account: accedi", "Términos y Condiciones": "Termini e Condizioni", "Términos": "Termini", "Política de Privacidad": "Informativa sulla privacy", "Privacidad": "Privacy", " y la ": " e l'", "Recuperar contraseña": "Recupera la password", "Crear cuenta": "Crea account", "Ingresar": "Accedi", "Te enviaremos un enlace a tu correo.": "Ti invieremo un link via email.", "Tus datos se guardan en la nube y los ves en todos tus dispositivos.": "I tuoi dati sono salvati nel cloud e li vedi su tutti i tuoi dispositivi.", "Nombre": "Nome", "Apellido": "Cognome", "Género": "Genere", "Elige una opción": "Scegli un'opzione", "Femenino": "Femminile", "Masculino": "Maschile", "Otro": "Altro", "Prefiero no decirlo": "Preferisco non dirlo", "Fecha de nacimiento": "Data di nascita", "Correo de tu mamá, papá o tutor": "Email di tua madre, tuo padre o tutore", "Tienes menos de 14 años: le enviaremos un aviso para que autorice que uses la app. Sin su permiso no podrás entrar.": "Hai meno di 14 anni: invieremo loro un avviso per autorizzarti a usare l'app. Senza il loro permesso non potrai entrare.", "Correo": "Email", "Usa el mismo correo con el que gestionaste tu acceso.": "Usa la stessa email con cui hai gestito il tuo accesso.", "Confirma tu correo": "Conferma la tua email", "Crea una contraseña para la app": "Crea una password per l'app", "Contraseña": "Password", "Mínimo 8 caracteres. Que sea distinta a la contraseña de tu correo.": "Minimo 8 caratteri. Diversa dalla password della tua email.", "Confirma la contraseña": "Conferma la password", "He leído y acepto los ": "Ho letto e accetto i ", ". Si tengo menos de 18 años, mi mamá, papá o tutor sabe que uso la app.": ". Se ho meno di 18 anni, mia madre, mio padre o il mio tutore sa che uso l'app.", "Enviar enlace": "Invia link", "Volver": "Indietro", "Ya tengo cuenta": "Ho già un account", "No tengo cuenta": "Non ho un account", "Olvidé mi contraseña": "Ho dimenticato la password", "Completa todos tus datos.": "Compila tutti i tuoi dati.", "Los correos no coinciden.": "Le email non coincidono.", "La contraseña debe tener al menos 8 caracteres.": "La password deve avere almeno 8 caratteri.", "Las contraseñas no coinciden.": "Le password non coincidono.", "Escribe un correo válido de tu mamá, papá o tutor.": "Inserisci un'email valida di tua madre, tuo padre o tutore.", "El correo de tu mamá, papá o tutor debe ser distinto al tuyo.": "L'email di tua madre, tuo padre o tutore deve essere diversa dalla tua.", "Debes aceptar los Términos y la Política de Privacidad.": "Devi accettare i Termini e l'Informativa sulla privacy.", "Listo. Revisa tu correo.": "Fatto. Controlla la tua email.", "Te enviamos un correo para confirmar tu cuenta. Al entrar, avisaremos a tu mamá, papá o tutor para que autorice.": "Ti abbiamo inviato un'email per confermare l'account. Quando accedi, avviseremo tua madre, tuo padre o tutore per l'autorizzazione.", "Te enviamos un correo. Toca el enlace para confirmar y luego ingresa.": "Ti abbiamo inviato un'email. Tocca il link per confermare e poi accedi.", "Ese correo todavía no tiene acceso. Primero gestiona tu acceso con un pago único.": "Questa email non ha ancora accesso. Prima gestisci l'accesso con un pagamento unico.", "Correo o contraseña incorrectos.": "Email o password errati.", "Ese correo ya tiene cuenta. Ingresa con tu contraseña.": "Questa email ha già un account. Accedi con la tua password.", "La contraseña debe tener al menos 6 caracteres.": "La password deve avere almeno 6 caratteri.", "Demasiados intentos. Espera unos minutos.": "Troppi tentativi. Attendi qualche minuto.", "Confirma tu correo con el enlace que te enviamos y vuelve a ingresar.": "Conferma la tua email con il link che ti abbiamo inviato e accedi di nuovo.", "Sin conexión. Revisa tu internet.": "Nessuna connessione. Controlla internet.", "No se pudo completar. Intenta de nuevo.": "Impossibile completare. Riprova.", "No autorizado": "Non autorizzato", "Tu mamá, papá o tutor no autorizó el uso de la app, así que no puedes entrar.": "Tua madre, tuo padre o tutore non ha autorizzato l'app, quindi non puoi entrare.", "Cerrar sesión": "Esci", "Cerrar": "Chiudi", "No se pudo verificar": "Impossibile verificare", "Revisa tu internet e inténtalo de nuevo.": "Controlla internet e riprova.", "Reintentar": "Riprova", "Falta el permiso de tus padres": "Manca il permesso dei tuoi genitori", "Enviamos un aviso a ": "Abbiamo inviato un avviso a ", ". Cuando autorice, toca “Ya autorizaron”.": ". Quando autorizzano, tocca “Hanno autorizzato”.", "Ya autorizaron, entrar": "Hanno autorizzato, entra", "Reenviar el aviso": "Reinvia l'avviso", "Todavía no hay respuesta de tus padres.": "Nessuna risposta dai tuoi genitori.", "Aviso enviado. Revisa que le llegue (también en spam).": "Avviso inviato. Controlla che arrivi (anche nello spam).", "Espera un par de minutos para reenviar.": "Attendi un paio di minuti per reinviare.", "No se pudo enviar. Intenta de nuevo.": "Invio non riuscito. Riprova.", "Autorización": "Autorizzazione", "Un momento…": "Un momento…", "Enlace no válido": "Link non valido", "Este enlace venció o ya se usó. Pídele a tu hijo/a que reenvíe el aviso desde la app.": "Questo link è scaduto o è già stato usato. Chiedi a tuo figlio/a di reinviare l'avviso dall'app.", "¿Autorizas el uso de Plata Clara?": "Autorizzi l'uso di Plata Clara?", " quiere usar Plata Clara, una app de finanzas personales. Como tiene menos de 14 años, necesitamos tu permiso. Se guardarán sus datos de registro y los movimientos de dinero que anote. Puedes leer los ": " vuole usare Plata Clara, un'app di finanze personali. Avendo meno di 14 anni, serve il tuo permesso. Verranno salvati i dati di registrazione e i movimenti di denaro inseriti. Puoi leggere i ", "Sí, autorizo": "Sì, autorizzo", "No autorizo": "Non autorizzo", "Listo, autorizado": "Fatto, autorizzato", "Respuesta enviada": "Risposta inviata", "Ya puede entrar a la app.": "Ora può entrare nell'app.", "No se permitirá el uso de la app.": "L'uso dell'app non sarà consentito.", " Puedes cerrar esta página.": " Puoi chiudere questa pagina.", "Sin conexión. Intenta de nuevo.": "Nessuna connessione. Riprova.", "Sin conexión": "Nessuna connessione", "Revisa tu internet y abre el enlace de nuevo.": "Controlla internet e riapri il link.", "Tu cuenta": "Il tuo account", "Sincronizar ahora": "Sincronizza ora", "Cargando…": "Caricamento…"}}, TR_RE = {};
  function tr(s) {
    var l = (document.documentElement.lang || 'es').slice(0, 2), d = TR[l];
    if (!d || typeof s !== 'string') return s;
    if (!TR_RE[l]) TR_RE[l] = new RegExp(Object.keys(d).sort(function (a, b) { return b.length - a.length; }).map(function (k) { return k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|'), 'g');
    return s.replace(TR_RE[l], function (m) { return d[m]; });
  }
  function langPick() {
    var P = window.__pc, L = (P && P.langs) || [], cur = (document.documentElement.lang || 'es').slice(0, 2);
    if (!L.length) return '';
    return '<div class="pc-lg"><select id="pc-lg" aria-label="Idioma / Language">' + L.map(function (x) { return '<option value="' + x.c + '"' + (x.c === cur ? ' selected' : '') + '>' + x.n + '</option>'; }).join('') + '</select></div>';
  }
  function show(html, bind, sticky) {
    css(); close();
    var orig = html; html = tr(html);
    var gate = !user || !!sticky;
    ov = document.createElement('div'); ov.id = 'pc-ov'; if (gate) ov.className = 'gate';
    ov.innerHTML = (gate ? '<div class="pc-hero"><div class="pc-logo">S/</div><div class="pc-name">Plata Clara</div><div class="pc-tag">' + tr('Tus finanzas, claras y en orden') + '</div>' + langPick() + '</div>' : '') +
      '<div class="pc-card" role="dialog" aria-modal="true">' + html + '</div>';
    if (!gate) ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    document.body.appendChild(ov);
    if (bind) bind(ov);
    var lg = ov.querySelector('#pc-lg');
    if (lg) lg.onchange = function () { if (window.__pc && window.__pc.setLang) { window.__pc.setLang(lg.value); show(orig, bind, sticky); } };
    var f = ov.querySelector('input'); if (f) f.focus();
  }
  function msg(t, kind) { var m = ov && ov.querySelector('.pc-m'); if (m) { m.textContent = tr(t); m.className = 'pc-m ' + (kind || ''); } }
  function friendly(e) {
    var m = (e && e.message || '').toLowerCase();
    if (m.indexOf('sin_acceso') > -1 || m.indexOf('database error saving new user') > -1) return 'Ese correo todavía no tiene acceso. Primero gestiona tu acceso con un pago único.';
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

  /* Pantalla de entrada: acceso privado con pago único */
  function accessSheet() {
    var u = C.CONTACT_URL || '', wa = u ? u + (u.indexOf('?') > -1 ? '&' : '?') + 'text=' + encodeURIComponent('Hola, quiero gestionar mi acceso a Plata Clara') : '';
    show('<h2>Acceso privado</h2><p>Plata Clara es de acceso privado. Para usarla, primero gestiona tu acceso con un <b>pago único</b>. Cuando recibamos tu pago te daremos permiso con tu correo y podrás crear tu cuenta.</p>' +
      (wa ? '<a class="pc-b" href="' + esc(wa) + '" target="_blank" rel="noopener" style="display:block;text-align:center;text-decoration:none">Gestionar mi acceso</a>' : '<div class="pc-m">Pídele el acceso a quien te compartió este enlace.</div>') +
      '<button class="pc-b alt" data-m="register">Ya me dieron acceso: crear mi cuenta</button>' +
      '<button class="pc-l" data-m="login">Ya tengo cuenta: ingresar</button>' +
      '<p class="pc-m" style="min-height:0;margin-top:10px"><a href="terminos.html" target="_blank" rel="noopener">Términos</a> · <a href="privacidad.html" target="_blank" rel="noopener">Privacidad</a></p>',
      function (o) { o.querySelectorAll('[data-m]').forEach(function (b) { b.onclick = function () { authSheet(b.getAttribute('data-m')); }; }); });
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
      (reg ? '<div class="pc-m" style="min-height:0">Usa el mismo correo con el que gestionaste tu acceso.</div>' : '') +
      (reg ? '<label for="pc-e2">Confirma tu correo</label><input id="pc-e2" type="email" autocomplete="off" required>' : '') +
      (reset ? '' : '<label for="pc-p">' + (reg ? 'Crea una contraseña para la app' : 'Contraseña') + '</label><input id="pc-p" type="password" minlength="' + (reg ? 8 : 6) + '" autocomplete="' + (reg ? 'new-password' : 'current-password') + '" required>') +
      (reg ? '<div class="pc-m" style="min-height:0;margin-top:4px">Mínimo 8 caracteres. Que sea distinta a la contraseña de tu correo.</div><label for="pc-p2">Confirma la contraseña</label><input id="pc-p2" type="password" autocomplete="new-password" required>' : '') +
      (reg ? '<label style="display:flex;gap:8px;align-items:flex-start;margin:12px 0 4px;font-size:13px;line-height:1.45"><input id="pc-t" type="checkbox" style="width:auto;margin-top:3px" required><span>He leído y acepto los <a href="terminos.html" target="_blank" rel="noopener">Términos y Condiciones</a> y la <a href="privacidad.html" target="_blank" rel="noopener">Política de Privacidad</a>. Si tengo menos de 18 años, mi mamá, papá o tutor sabe que uso la app.</span></label>' : '') +
      '<button class="pc-b" type="submit">' + (reset ? 'Enviar enlace' : reg ? 'Crear cuenta' : 'Ingresar') + '</button></form>' +
      '<div class="pc-m" role="status"></div>' +
      (reset ? '<button class="pc-l" data-m="login">Volver</button>' :
        '<button class="pc-l" data-m="' + (reg ? 'login' : 'access') + '">' + (reg ? 'Ya tengo cuenta' : 'No tengo cuenta') + '</button>' +
        (reg ? '' : '<br><button class="pc-l" data-m="reset">Olvidé mi contraseña</button>')) +
      '',
      function (o) {
        o.querySelectorAll('[data-m]').forEach(function (b) { b.onclick = function () { var m = b.getAttribute('data-m'); if (m === 'access') accessSheet(); else authSheet(m); }; });
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
            if (reg) return sb.rpc('can_register', { p_email: email }).then(function (g) {
              if (g.error) throw g.error;
              if (g.data !== true) throw new Error('sin_acceso');
              return sb.auth.signUp({ email: email, password: pw, options: { data: meta, emailRedirectTo: location.origin + location.pathname } });
            }).then(function (r) {
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
      if (user) accountSheet(); else accessSheet();
    }).catch(function () { show('<h2>Sin conexión</h2><p>No se pudo cargar el inicio de sesión. Revisa tu internet.</p><button class="pc-b" data-x>Cerrar</button>', function (o) { o.querySelector('[data-x]').onclick = close; }); });
  });

  /* Compuerta: la app no se ve hasta ingresar. */
  function boot() {
    lock();
    show('<h2>Cargando…</h2><p>Un momento.</p>');
    client().then(function () { return sb.auth.getSession(); }).then(function (r) {
      if (r.data.session) { if (!user) { user = r.data.session.user; } checkConsent().then(function (ok) { if (ok) { paint(); reconcile(); } }); }
      else accessSheet();
    }).catch(function () {
      if (getMark().uid) { unlock(); return; }   // ya ingresó antes en este dispositivo: dejar usar sin internet
      show('<h2>Sin conexión</h2><p>Necesitas internet para ingresar la primera vez.</p><button class="pc-b" data-r>Reintentar</button>',
        function (o) { o.querySelector('[data-r]').onclick = boot; });
    });
  }
  var ctoken = null; try { ctoken = new URLSearchParams(location.search).get('consent'); } catch (e) {}
  if (ctoken) { lock(); consentSheet(ctoken); } else boot();
})();
