// scripts/update.mjs — baja datos de Tenis, NFL, F1 y Fútbol y los guarda en data.json
import { readFile, writeFile } from 'node:fs/promises';

const OUT = 'data.json';
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
const ESPN2 = 'https://site.api.espn.com/apis/v2/sports';
const JOLPICA = 'https://api.jolpi.ca/ergast/f1';
const US_OPEN_LIMIT = new Date('2027-09-14T00:00:00Z');

// Las 8 ligas de fútbol. Para cambiar una, cambia el código "id" (códigos de ESPN).
const LIGAS = [
  { id: 'eng.1', name: 'Premier League', cc: 'GB' },
  { id: 'esp.1', name: 'La Liga', cc: 'ES' },
  { id: 'ita.1', name: 'Serie A', cc: 'IT' },
  { id: 'ger.1', name: 'Bundesliga', cc: 'DE' },
  { id: 'fra.1', name: 'Ligue 1', cc: 'FR' },
  { id: 'mex.1', name: 'Liga MX', cc: 'MX' },
  { id: 'uefa.champions', name: 'Champions League', cc: '' },
  { id: 'por.1', name: 'Primeira Liga', cc: 'PT' },
];

const NFL_WEEKS = 18;

async function getJSON(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'deportes-hoy' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const addDays = (d, n) => new Date(d.getTime() + n * 864e5);
const norm = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const stat = (e, name) => {
  const s = (e.stats || []).find((x) => x.name === name);
  return s && s.value != null ? s.value : null;
};

function parseGame(ev) {
  const c = ev.competitions?.[0];
  const cs = c?.competitors || [];
  const side = (h) => {
    const x = cs.find((y) => y.homeAway === h) || {};
    const sc = x.score;
    return {
      name: x.team?.displayName || '',
      abbr: x.team?.abbreviation || '',
      score: sc != null && sc !== '' ? Number(sc) : null,
      record: x.records?.[0]?.summary || '',
      winner: !!x.winner,
    };
  };
  return {
    id: ev.id,
    date: ev.date,
    state: ev.status?.type?.state || c?.status?.type?.state || 'pre',
    detail: ev.status?.type?.shortDetail || '',
    home: side('home'),
    away: side('away'),
  };
}

/* ---------------- TENIS ---------------- */
function parseCalendar(arr) {
  const now = Date.now() - 864e5;
  const out = (arr || [])
    .map((c) => (c && typeof c === 'object' ? { name: c.label || c.name, start: c.startDate, end: c.endDate } : null))
    .filter((c) => c && c.name && c.start)
    .filter((c) => new Date(c.end || c.start).getTime() >= now && new Date(c.start) <= US_OPEN_LIMIT);
  const seen = new Set();
  return out
    .filter((c) => {
      const k = c.name + c.start;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => new Date(a.start) - new Date(b.start))
    .map((c) => {
      let big = '';
      if (/us open|australian open|roland|french open|wimbledon/i.test(c.name)) big = 'Grand Slam';
      else if (/atp finals/i.test(c.name)) big = 'Finales';
      else if (/masters|indian wells|miami open|monte.carlo|madrid open|italian open|internazionali|canadian open|national bank open|cincinnati/i.test(c.name)) big = 'Masters / 1000';
      return { ...c, big };
    });
}

async function tenis() {
  const rk = await getJSON(`${ESPN}/tennis/atp/rankings`);
  const ranking = (rk.rankings?.[0]?.ranks || []).slice(0, 20).map((r) => ({
    rank: r.current,
    prev: r.previous,
    name: r.athlete?.displayName || r.athlete?.fullName || '',
    pts: r.points,
  }));
  const top = new Set(ranking.map((r) => norm(r.name)));

  const tournaments = new Map();
  let calendarMen = [];
  const today = new Date();
  for (let i = -1; i <= 10; i++) {
    let sb;
    try {
      sb = await getJSON(`${ESPN}/tennis/atp/scoreboard?dates=${ymd(addDays(today, i))}`);
    } catch {
      continue;
    }
    if (!calendarMen.length) calendarMen = parseCalendar(sb.leagues?.[0]?.calendar);
    for (const ev of sb.events || []) {
      let t = tournaments.get(ev.id);
      if (!t) {
        t = { id: ev.id, name: ev.name || ev.shortName, start: ev.date, end: ev.endDate, matches: new Map() };
        tournaments.set(ev.id, t);
      }
      for (const g of ev.groupings || []) {
        const slug = `${g.grouping?.slug || ''} ${g.grouping?.displayName || ''}`;
        if (!/singles/i.test(slug) || /women|doubles/i.test(slug)) continue;
        for (const c of g.competitions || []) {
          const cs = c.competitors || [];
          if (cs.length < 2) continue;
          const names = cs.map((x) => x.athlete?.displayName || x.athlete?.fullName || '');
          if (!names.some((n) => top.has(norm(n)))) continue;
          const sets = (cs[0].linescores || []).map((l, k) => `${l.value}-${cs[1].linescores?.[k]?.value ?? ''}`);
          t.matches.set(c.id, {
            id: c.id,
            date: c.date || c.startDate,
            round: c.round?.displayName || '',
            state: c.status?.type?.state || 'pre',
            detail: c.status?.type?.shortDetail || '',
            score: sets.join(' '),
            p: cs.map((x, k) => ({ name: names[k], winner: !!x.winner })),
          });
        }
      }
    }
  }

  let calendarWomen = [];
  try {
    const w = await getJSON(`${ESPN}/tennis/wta/scoreboard`);
    calendarWomen = parseCalendar(w.leagues?.[0]?.calendar);
  } catch {}

  const list = [...tournaments.values()]
    .map((t) => ({
      id: t.id,
      name: t.name,
      start: t.start,
      end: t.end,
      matches: [...t.matches.values()].sort((a, b) => new Date(a.date) - new Date(b.date)),
    }))
    .filter((t) => t.matches.length)
    // quita torneos que ya terminaron hace más de 2 días
    .filter((t) => t.matches.some((m) => m.state !== 'post' || new Date(m.date).getTime() > Date.now() - 48 * 36e5));

  return { ranking, tournaments: list, calendarMen, calendarWomen };
}

/* ---------------- NFL ---------------- */
async function nfl() {
  const cur = await getJSON(`${ESPN}/football/nfl/scoreboard`);
  const type = cur.season?.type;
  const week = cur.week?.number || 1;
  const weeks = [];
  const pull = async (w, t) => {
    try {
      const d = await getJSON(`${ESPN}/football/nfl/scoreboard?seasontype=${t}&week=${w}`);
      const games = (d.events || []).map(parseGame);
      if (games.length) weeks.push({ week: w, type: t, label: t === 3 ? `Playoffs ${w}` : `Semana ${w}`, games });
    } catch {}
  };
  if (type === 2) {
    for (let w = Math.max(1, week - 1); w <= NFL_WEEKS; w++) await pull(w, 2);
  } else if (type === 3) {
    await pull(week, 3);
  } else {
    for (let w = 1; w <= NFL_WEEKS; w++) await pull(w, 2);
  }

  const standings = { AFC: [], NFC: [] };
  try {
    const st = await getJSON(`${ESPN2}/football/nfl/standings`);
    for (const ch of st.children || []) {
      const key = /afc|american/i.test(`${ch.name} ${ch.abbreviation}`) ? 'AFC' : 'NFC';
      standings[key] = (ch.standings?.entries || [])
        .map((e) => ({
          team: e.team?.displayName || '',
          abbr: e.team?.abbreviation || '',
          w: stat(e, 'wins') ?? 0,
          l: stat(e, 'losses') ?? 0,
          t: stat(e, 'ties') ?? 0,
          pct: stat(e, 'winPercent') ?? 0,
        }))
        .sort((a, b) => b.pct - a.pct || b.w - a.w || a.l - b.l);
    }
  } catch {}
  return { weeks, standings };
}

/* ---------------- F1 ---------------- */
const iso = (d, t) => (d ? `${d}T${t || '12:00:00Z'}` : null);

async function f1() {
  const [sch, std] = await Promise.all([
    getJSON(`${JOLPICA}/current.json`),
    getJSON(`${JOLPICA}/current/driverStandings.json`),
  ]);
  const now = Date.now();
  const all = sch.MRData?.RaceTable?.Races || [];
  const races = all
    .map((r) => {
      const sessions = [];
      if (r.Qualifying) sessions.push({ name: 'Clasificación', at: iso(r.Qualifying.date, r.Qualifying.time) });
      if (r.Sprint) sessions.push({ name: 'Sprint', at: iso(r.Sprint.date, r.Sprint.time) });
      return {
        round: Number(r.round),
        name: r.raceName,
        circuit: r.Circuit?.circuitName || '',
        place: [r.Circuit?.Location?.locality, r.Circuit?.Location?.country].filter(Boolean).join(', '),
        country: r.Circuit?.Location?.country || '',
        race: iso(r.date, r.time),
        sessions,
      };
    })
    .filter((r) => r.race && new Date(r.race).getTime() + 3 * 36e5 >= now);

  let last = null;
  try {
    const l = await getJSON(`${JOLPICA}/current/last/results.json`);
    const r = l.MRData?.RaceTable?.Races?.[0];
    if (r)
      last = {
        name: r.raceName,
        date: r.date,
        podium: (r.Results || []).slice(0, 3).map((x) => ({
          pos: x.position,
          name: `${x.Driver.givenName} ${x.Driver.familyName}`,
          team: x.Constructor?.name || '',
        })),
        results: (r.Results || []).map((x) => ({
          pos: x.position,
          name: `${x.Driver.givenName} ${x.Driver.familyName}`,
          team: x.Constructor?.name || '',
          time: x.Time?.time || x.status || '',
          points: Number(x.points),
        })),
      };
  } catch {}

  const drivers = (std.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings || []).map((d) => ({
    pos: Number(d.position),
    name: `${d.Driver.givenName} ${d.Driver.familyName}`,
    team: d.Constructors?.[0]?.name || '',
    nationality: d.Driver.nationality || '',
    points: Number(d.points),
    wins: Number(d.wins),
  }));
  return { last, races, drivers };
}

/* ---------------- FÚTBOL ---------------- */
async function liga(l) {
  // Un request por día (más confiable que un rango de fechas)
  const today = new Date();
  const days = [];
  for (let i = -3; i <= 10; i++) days.push(addDays(today, i));
  const byId = new Map();
  let fails = 0;
  await Promise.all(
    days.map(async (d) => {
      try {
        const sb = await getJSON(`${ESPN}/soccer/${l.id}/scoreboard?dates=${ymd(d)}`);
        for (const ev of sb.events || []) byId.set(ev.id, parseGame(ev));
      } catch (e) {
        fails++;
      }
    })
  );
  if (fails === days.length) console.warn(`Liga ${l.name}: ningún día cargó partidos`);
  const matches = [...byId.values()].sort((a, b) => new Date(a.date) - new Date(b.date));
  let table = [];
  try {
    const st = await getJSON(`${ESPN2}/soccer/${l.id}/standings`);
    const child = (st.children || []).find((c) => c.standings?.entries?.length);
    const entries = child?.standings?.entries || [];
    table = entries.map((e) => ({
      team: e.team?.displayName || '',
      rank: stat(e, 'rank'),
      pj: stat(e, 'gamesPlayed') ?? 0,
      g: stat(e, 'wins') ?? 0,
      e: stat(e, 'ties') ?? 0,
      p: stat(e, 'losses') ?? 0,
      dg: stat(e, 'pointDifferential') ?? 0,
      pts: stat(e, 'points') ?? 0,
    }));
    table.sort((a, b) =>
      a.rank != null && b.rank != null ? a.rank - b.rank : b.pts - a.pts || b.dg - a.dg
    );
  } catch {}
  if (!matches.length && !table.length) throw new Error(`sin datos ${l.id}`);
  return { id: l.id, name: l.name, cc: l.cc, matches, table };
}

async function futbol() {
  const ligas = [];
  for (const l of LIGAS) {
    try {
      ligas.push(await liga(l));
    } catch (e) {
      console.warn('Liga falló:', l.name, e?.message);
      ligas.push({ ...l, matches: [], table: [] });
    }
  }
  if (ligas.every((l) => !l.matches.length && !l.table.length)) throw new Error('fútbol sin datos');
  return { ligas };
}

/* ---------------- MAIN ---------------- */
let old = {};
try {
  old = JSON.parse(await readFile(OUT, 'utf8'));
} catch {}
if (old.v !== 2) old = {};

const keys = ['tenis', 'nfl', 'f1', 'futbol'];
const res = await Promise.allSettled([tenis(), nfl(), f1(), futbol()]);
const out = { v: 2, updated: new Date().toISOString() };
let fallos = 0;
res.forEach((r, i) => {
  if (r.status === 'fulfilled') out[keys[i]] = r.value;
  else {
    fallos++;
    console.warn(`Falló ${keys[i]}:`, r.reason?.message || r.reason);
    if (old[keys[i]]) out[keys[i]] = old[keys[i]];
  }
});
if (fallos === keys.length) {
  console.error('Fallaron todas las secciones');
  process.exit(1);
}
await writeFile(OUT, JSON.stringify(out));
console.log('data.json listo. Secciones con error:', fallos);
