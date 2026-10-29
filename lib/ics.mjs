// Lecture d'un agenda au format iCal (.ics), par exemple l'« adresse secrète
// au format iCal » de Google Agenda. Gère les événements récurrents courants
// (quotidiens, hebdomadaires avec jours précis, mensuels, annuels), les
// exceptions (EXDATE) et les occurrences modifiées (RECURRENCE-ID).
// Les heures avec TZID sont lues comme heures locales du Mac (Europe/Paris).

function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

function unescapeText(v) {
  return v.replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\').trim();
}

function parseLine(line) {
  const i = line.indexOf(':');
  if (i < 0) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const [name, ...rawParams] = head.split(';');
  const params = {};
  for (const p of rawParams) {
    const j = p.indexOf('=');
    if (j > 0) params[p.slice(0, j).toUpperCase()] = p.slice(j + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value };
}

// → { time: ms, allDay: bool }
function parseDate(value, params = {}) {
  const v = value.trim();
  if (params.VALUE === 'DATE' || /^\d{8}$/.test(v)) {
    const y = +v.slice(0, 4), m = +v.slice(4, 6) - 1, d = +v.slice(6, 8);
    return { time: new Date(y, m, d).getTime(), allDay: true };
  }
  const mt = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!mt) return null;
  const [, y, mo, d, h, mi, s, z] = mt;
  if (z) return { time: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s), allDay: false };
  return { time: new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime(), allDay: false };
}

function parseRRule(value) {
  const r = {};
  for (const part of value.split(';')) {
    const [k, v] = part.split('=');
    if (k && v) r[k.toUpperCase()] = v;
  }
  return r;
}

const DAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function addDays(t, n) {
  const d = new Date(t);
  d.setDate(d.getDate() + n);
  return d.getTime();
}
function addMonths(t, n) {
  const d = new Date(t);
  d.setMonth(d.getMonth() + n);
  return d.getTime();
}

// Liste des débuts d'occurrence dans [from, to]
function expand(ev, from, to) {
  if (!ev.rrule) return ev.start >= from - (ev.end - ev.start) && ev.start <= to ? [ev.start] : [];
  const r = parseRRule(ev.rrule);
  const freq = r.FREQ;
  const interval = Math.max(1, Number(r.INTERVAL || 1));
  const count = r.COUNT ? Number(r.COUNT) : Infinity;
  const until = r.UNTIL ? (parseDate(r.UNTIL) || {}).time : Infinity;
  const out = [];
  let n = 0;
  const push = (t) => {
    if (t < ev.start || t > until || n >= count) return false;
    n += 1;
    if (t >= from - (ev.end - ev.start) && t <= to && !ev.exdates.has(t)) out.push(t);
    return true;
  };
  let guard = 0;
  if (freq === 'WEEKLY' && r.BYDAY) {
    const days = r.BYDAY.split(',').map((d) => DAY[d.slice(-2)]).filter((d) => d !== undefined)
      .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    const s = new Date(ev.start);
    let weekStart = addDays(ev.start, -((s.getDay() + 6) % 7)); // lundi de la 1re semaine, même heure
    while (weekStart <= to && n < count && guard++ < 2000) {
      for (const d of days) {
        const t = addDays(weekStart, (d + 6) % 7);
        if (t > until) return out;
        push(t);
      }
      weekStart = addDays(weekStart, 7 * interval);
    }
    return out;
  }
  let t = ev.start;
  while (t <= to && t <= until && n < count && guard++ < 5000) {
    push(t);
    if (freq === 'DAILY') t = addDays(t, interval);
    else if (freq === 'WEEKLY') t = addDays(t, 7 * interval);
    else if (freq === 'MONTHLY') t = addMonths(t, interval);
    else if (freq === 'YEARLY') t = addMonths(t, 12 * interval);
    else break;
  }
  return out;
}

export function parseIcs(text, calendarName, from, to) {
  const lines = unfold(text).split('\n');
  const events = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line === 'BEGIN:VEVENT') { cur = { exdates: new Set() }; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const p = parseLine(line);
    if (!p) continue;
    switch (p.name) {
      case 'UID': cur.uid = p.value; break;
      case 'SUMMARY': cur.title = unescapeText(p.value); break;
      case 'LOCATION': cur.location = unescapeText(p.value); break;
      case 'STATUS': cur.status = p.value.toUpperCase(); break;
      case 'RRULE': cur.rrule = p.value; break;
      case 'DTSTART': { const d = parseDate(p.value, p.params); if (d) { cur.start = d.time; cur.allDay = d.allDay; } break; }
      case 'DTEND': { const d = parseDate(p.value, p.params); if (d) cur.endRaw = d.time; break; }
      case 'EXDATE':
        for (const v of p.value.split(',')) { const d = parseDate(v, p.params); if (d) cur.exdates.add(d.time); }
        break;
      case 'RECURRENCE-ID': { const d = parseDate(p.value, p.params); if (d) cur.recurrenceId = d.time; break; }
      default: break;
    }
  }

  // Occurrences modifiées : elles remplacent l'occurrence d'origine.
  const overrides = new Map();
  for (const ev of events) {
    if (ev.recurrenceId != null && ev.uid) {
      if (!overrides.has(ev.uid)) overrides.set(ev.uid, new Set());
      overrides.get(ev.uid).add(ev.recurrenceId);
    }
  }

  const out = [];
  for (const ev of events) {
    if (ev.start == null || ev.status === 'CANCELLED') continue;
    ev.end = ev.endRaw != null ? ev.endRaw : ev.allDay ? addDays(ev.start, 1) : ev.start + 3600 * 1000;
    const duration = Math.max(0, ev.end - ev.start);
    if (ev.rrule && overrides.has(ev.uid)) for (const t of overrides.get(ev.uid)) ev.exdates.add(t);
    for (const t of expand(ev, from, to)) {
      out.push({
        title: ev.title || '(sans titre)',
        location: ev.location || '',
        start: t,
        end: t + duration,
        allDay: !!ev.allDay,
        calendar: calendarName
      });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
