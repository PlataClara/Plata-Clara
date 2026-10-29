// Configuración de la nube (Supabase).
// La clave "publishable" es pública por diseño: la seguridad la da el SQL (RLS), no ocultar esta clave.
// NUNCA pegues aquí la "secret key" ni la "service_role key".
window.PC_CONFIG = {
  SUPABASE_URL: 'https://dcjbvvdpudodzxbaohkj.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_ZecwuyRNL2X27mnC3qG0sg_VhKbWvBn',
  // Clave PÚBLICA para los avisos al celular (la privada va solo en Supabase, nunca aquí).
  VAPID_PUBLIC_KEY: 'BARf8Jn-y1C-HE4QYXOzp4qIAYnbUnEiayDwP6W9IAb09e9_w1zhwyp9ziCjQDKQRpGr_DzKwktDclgaFeXI4mQ',
  // Enlace para que te pidan activar un plan, ej. 'https://wa.me/519XXXXXXXX'. Vacío = se oculta el botón.
  CONTACT_URL: 'https://wa.me/51924159231',
  // Redes sociales: pega el enlace completo (empieza con https://). Vacío = no se muestra.
  INSTAGRAM_URL: 'https://www.instagram.com/plataclara.app',
  FACEBOOK_URL: 'https://www.facebook.com/share/19rUz3jHFN/',
  TIKTOK_URL: 'https://www.tiktok.com/@plataclara.app',
  YOUTUBE_URL: ''
};
