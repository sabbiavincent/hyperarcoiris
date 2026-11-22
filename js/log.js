// Registro personale delle osservazioni (positive E negative), per una futura taratura dell'indice.
// Ogni voce conserva i predittori calcolati dall'app in quel momento: senza di essi il registro non serve a tarare.

export const LOG_KEY = 'ha.log';
export const SCHEMA = 1;

export const FIELDS = [
  'id', 'schema', 'creato', 't', 'lat', 'lon', 'esito', 'primario', 'secondario', 'completezza', 'qualita', 'note',
  'sole_az', 'sole_el', 'S', 'O', 'R', 'I', 'classe', 'fonte', 'modello', 'cielo_frac',
];

/** Voce dal modulo e dalla valutazione corrente (evaluate di likelihood.js), o null se assente. */
export function makeEntry(form, ev, extra = {}) {
  const r = (x, d = 3) => (x == null || !isFinite(x) ? null : +x.toFixed(d));
  return {
    id: extra.id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    schema: SCHEMA,
    creato: extra.creato ?? new Date().toISOString(),
    t: new Date(form.t).toISOString(),
    lat: r(form.lat, 5), lon: r(form.lon, 5),
    esito: form.esito,                       // 'visto' | 'non visto'
    primario: !!form.primario, secondario: !!form.secondario,
    completezza: form.completezza == null || form.completezza === '' ? null : +form.completezza,  // % dell'arco visibile
    qualita: form.qualita == null || form.qualita === '' ? null : +form.qualita,                  // 1–5
    note: (form.note || '').slice(0, 500),
    sole_az: r(ev?.sun?.az, 2), sole_el: r(ev?.sun?.el, 2),
    S: r(ev?.S), O: r(ev?.O), R: r(ev?.R), I: r(ev?.I),
    classe: ev?.cls?.key ?? null, fonte: ev?.source ?? null, modello: extra.modello ?? null,
    cielo_frac: r(ev?.skyFraction),
  };
}

export function validate(e) {
  const errs = [];
  if (!['visto', 'non visto'].includes(e.esito)) errs.push('esito');
  if (!(Math.abs(e.lat) <= 90 && Math.abs(e.lon) <= 180)) errs.push('coordinate');
  if (isNaN(Date.parse(e.t))) errs.push('istante');
  if (e.qualita != null && !(e.qualita >= 1 && e.qualita <= 5)) errs.push('qualità');
  if (e.completezza != null && !(e.completezza >= 0 && e.completezza <= 100)) errs.push('completezza');
  return errs;
}

export function load(storage = localStorage) {
  try { const a = JSON.parse(storage.getItem(LOG_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}
export function save(list, storage = localStorage) {
  storage.setItem(LOG_KEY, JSON.stringify(list));
}

/** Unione per id (le voci importate non sovrascrivono quelle esistenti), ordinata per istante. */
export function merge(list, incoming) {
  const ids = new Set(list.map((e) => e.id));
  const add = incoming.filter((e) => e && e.id && !ids.has(e.id) && validate(e).length === 0);
  return { list: [...list, ...add].sort((a, b) => Date.parse(a.t) - Date.parse(b.t)), added: add.length, skipped: incoming.length - add.length };
}

const csvCell = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCSV = (list) => [FIELDS.join(','), ...list.map((e) => FIELDS.map((f) => csvCell(e[f])).join(','))].join('\n') + '\n';

/** Sintesi utile alla taratura: tassi di avvistamento per classe dell'indice. */
export function summary(list) {
  const by = {};
  for (const e of list) {
    const k = e.classe || 'senza indice';
    by[k] ??= { visti: 0, non: 0 };
    if (e.esito === 'visto') by[k].visti++; else by[k].non++;
  }
  return by;
}
