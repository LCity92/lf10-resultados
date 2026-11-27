// Actualiza cal/eventos.json y cal/noticias.json.
// Corre en GitHub Actions cada 3 horas (Node 20+, sin dependencias).
// Fuentes: calendario público de ESPN (partidos) y Google Noticias RSS (noticias).
import { readFile, writeFile } from 'node:fs/promises';

const RAIZ = new URL('../cal/', import.meta.url);
const leer = async (f) => JSON.parse(await readFile(new URL(f, RAIZ), 'utf8'));
const guardar = (f, d) => writeFile(new URL(f, RAIZ), JSON.stringify(d, null, 1) + '\n');

const cfg = await leer('config.json');
const manual = await leer('manual.json');
const bloqueados = (cfg.bloqueados || []).map((s) => s.toLowerCase());
const ahora = new Date();
const errores = [];

const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const diasDesde = (n) => new Date(ahora.getTime() + n * 864e5);
const sinTildes = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const bloqueado = (txt) => bloqueados.some((b) => sinTildes(txt).includes(sinTildes(b)));

async function traer(url, tipo = 'json') {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (LF10 calendario)' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 160).replace(/\s+/g, ' ')}`);
  return tipo === 'json' ? r.json() : r.text();
}

// Fecha y hora en Bogotá
function bogota(iso) {
  const d = new Date(iso);
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const p = Object.fromEntries(f.map((x) => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
}

// Equipo seguido (por alias)
const equipos = cfg.equipos || [];
function equipoSeguido(nombre) {
  const n = sinTildes(nombre);
  return equipos.find((e) => (e.alias || [e.nombre]).some((a) => {
    const x = sinTildes(a);
    return n === x || n.startsWith(x + ' ') || (x.length > 6 && n.includes(x));
  }));
}

const FASE = /final|semifinal|cuartos|quarter|semi|play-?off|cuadrangular|octavos|round of 16|knockout/i;

// ---------- Partidos (ESPN) ----------
const partidos = [];

// ESPN no acepta rangos de días, pero sí meses completos (dates=AAAAMM).
const meses = [];
for (let d = new Date(Date.UTC(diasDesde(-(cfg.dias_atras ?? 2)).getUTCFullYear(), diasDesde(-(cfg.dias_atras ?? 2)).getUTCMonth(), 1)); d <= diasDesde(cfg.dias_adelante ?? 120); d.setUTCMonth(d.getUTCMonth() + 1)) {
  meses.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
}
const minFecha = diasDesde(-(cfg.dias_atras ?? 2)).toISOString(), maxFecha = diasDesde(cfg.dias_adelante ?? 120).toISOString();
async function eventosLiga(id) {
  const out = new Map();
  let fallos = 0, ultimo = '';
  for (const m of meses) {
    const base = `https://site.api.espn.com/apis/site/v2/sports/soccer/${id}/scoreboard?dates=${m}`;
    try {
      let j;
      try { j = await traer(base + '&limit=500'); } catch { j = await traer(base); }
      (j.events || []).forEach((e) => { if (e.date >= minFecha && e.date <= maxFecha) out.set(e.id, e); });
    } catch (e) { fallos++; ultimo = e.message; }
  }
  if (fallos === meses.length) throw new Error(ultimo || 'sin respuesta');
  return [...out.values()];
}
for (const liga of cfg.ligas || []) {
  try {
    const lista = await eventosLiga(liga.id);
    for (const ev of lista) {
      const comp = (ev.competitions || [])[0] || {};
      const lados = (comp.competitors || []).map((c) => ({
        nombre: c.team?.displayName || c.team?.name || '?',
        local: c.homeAway === 'home',
        goles: c.score,
      }));
      const local = lados.find((x) => x.local) || lados[0] || { nombre: '?' };
      const visita = lados.find((x) => !x.local) || lados[1] || { nombre: '?' };
      const seguidos = lados.map((l) => equipoSeguido(l.nombre)).filter(Boolean);
      const nota = [(comp.notes || [])[0]?.headline, ev.season?.slug, comp.type?.abbreviation].filter(Boolean).join(' ');
      const esFase = FASE.test(nota) || FASE.test(ev.name || '');
      if (liga.modo === 'seguidos' && !seguidos.length && !esFase) continue;
      const titulo = `${local.nombre} vs ${visita.nombre}`;
      if (bloqueado(titulo)) continue;
      const { fecha, hora } = bogota(ev.date);
      const esColombia = seguidos.some((s) => s.nombre === 'Colombia');
      let prioridad = liga.peso || 1;
      if (seguidos.length) prioridad = Math.max(prioridad, 2);
      if (esFase) prioridad = Math.max(prioridad, liga.peso >= 2 ? 3 : 2);
      if (esColombia) prioridad = 3;
      const estado = comp.status?.type || ev.status?.type || {};
      partidos.push({
        id: `espn-${liga.id}-${ev.id}`,
        fecha, hora,
        tipo: esColombia ? 'seleccion' : 'partido',
        competencia: liga.nombre,
        titulo,
        detalle: [(comp.notes || [])[0]?.headline, comp.venue?.fullName].filter(Boolean).join(' · '),
        prioridad,
        motivos: [...new Set(seguidos.map((s) => s.motivo))],
        estado: estado.state === 'post' ? `Final: ${local.goles ?? ''}-${visita.goles ?? ''}` : (estado.state === 'in' ? 'En juego' : ''),
        fuente: 'ESPN',
      });
    }
  } catch (e) {
    errores.push(`Partidos ${liga.nombre}: ${e.message}`);
  }
}

// Manuales (comerciales, mercados, hitos)
const manuales = (manual.eventos || []).filter((e) => !bloqueado(e.titulo)).map((e) => ({ ...e, fuente: e.fuente || 'LF10' }));

const eventos = [...manuales, ...partidos].sort((a, b) => (a.fecha + (a.hora || '00:00')).localeCompare(b.fecha + (b.hora || '00:00')));
await guardar('eventos.json', { actualizado: ahora.toISOString(), errores, total: eventos.length, eventos });

// ---------- Noticias (Google Noticias RSS) ----------
const FICHAJE = /fichaj|traspaso|refuerz|contrat|nuevo club|firm[aó] con|cedid|pr[eé]stamo|mercado de pases|transfer|llega a|se va a|oferta por|renov/i;
const decodificar = (s) => (s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
const etiqueta = (x, t) => decodificar((x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1]);

const consultas = [
  ...(cfg.jugadores || []).map((j) => ({ etiqueta: j.nombre, grupo: 'jugador', q: j.busqueda || `"${j.nombre}"` })),
  ...(cfg.temas || []).map((t) => ({ etiqueta: t.nombre, grupo: t.tipo || 'noticia', q: t.busqueda })),
];
const vistas = new Map();
const limite = ahora.getTime() - 7 * 864e5;
for (const c of consultas) {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(c.q + ' when:7d')}&hl=es-419&gl=CO&ceid=CO:es-419`;
    const xml = await traer(url, 'text');
    const items = xml.split('<item>').slice(1, 11);
    for (const it of items) {
      let titulo = etiqueta(it, 'title');
      const medio = etiqueta(it, 'source');
      if (medio && titulo.endsWith(' - ' + medio)) titulo = titulo.slice(0, -(medio.length + 3));
      const fecha = new Date(etiqueta(it, 'pubDate'));
      if (!titulo || isNaN(fecha) || fecha.getTime() < limite || bloqueado(titulo)) continue;
      const clave = sinTildes(titulo).replace(/[^a-z0-9]/g, '').slice(0, 80);
      const previa = vistas.get(clave);
      if (previa) { if (!previa.etiquetas.includes(c.etiqueta)) previa.etiquetas.push(c.etiqueta); continue; }
      vistas.set(clave, {
        titulo, medio, enlace: etiqueta(it, 'link'), fecha: fecha.toISOString(),
        etiquetas: [c.etiqueta],
        fichaje: c.grupo === 'fichaje' || FICHAJE.test(titulo),
      });
    }
  } catch (e) {
    errores.push(`Noticias ${c.etiqueta}: ${e.message}`);
  }
}
const noticias = [...vistas.values()].sort((a, b) => b.fecha.localeCompare(a.fecha)).slice(0, 250);
await guardar('noticias.json', { actualizado: ahora.toISOString(), errores, total: noticias.length, noticias });

console.log(`Eventos: ${eventos.length} (partidos ${partidos.length}). Noticias: ${noticias.length}. Errores: ${errores.length}`);
errores.forEach((e) => console.log(' - ' + e));
