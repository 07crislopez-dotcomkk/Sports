// Baja datos deportivos y los guarda en data.json
// Corre en GitHub Actions (Node 20, sin dependencias).
import { readFile, writeFile } from "node:fs/promises";

// Los partidos se traen hasta este día (el día antes del US Open 2027).
// Cambia esta fecha cuando quieras estirar o acortar el margen.
const HORIZON = "2027-08-29";

const OUT = "data.json";
const ESPN = "https://site.api.espn.com/apis/site/v2/sports";
const ESPN2 = "https://site.api.espn.com/apis/v2/sports";
const now = new Date();
const horizonDate = new Date(HORIZON + "T23:59:59Z");

/* ---------- utilidades ---------- */
async function getJson(url) {
  const r = await fetch(url, { headers: { "user-agent": "deportes-hoy/1.0" } });
  if (!r.ok) throw new Error(r.status + " " + url);
  return r.json();
}
const ymd = d => d.toISOString().slice(0, 10).replaceAll("-", "");
const stat = (e, name) => e.stats?.find(s => s.name === name)?.value;

// Parte el rango en meses para que ESPN no recorte resultados
function monthChunks(from, to) {
  const out = [];
  let s = new Date(from);
  while (s <= to) {
    const e = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 0));
    out.push([ymd(s), ymd(e < to ? e : to)]);
    s = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 1));
  }
  return out;
}

function parseEvents(json) {
  return (json.events || []).map(ev => {
    const c = ev.competitions?.[0];
    const h = c?.competitors?.find(x => x.homeAway === "home");
    const a = c?.competitors?.find(x => x.homeAway === "away");
    if (!h || !a) return null;
    return {
      h: h.team.shortDisplayName || h.team.displayName,
      a: a.team.shortDisplayName || a.team.displayName,
      date: ev.date,
      state: ev.status?.type?.state,
      detail: ev.status?.type?.shortDetail || "",
      sh: Number(h.score ?? 0),
      sa: Number(a.score ?? 0)
    };
  }).filter(Boolean);
}

// Un día atrás (para que los resultados se queden 24h y luego se quiten solos)
// + todo hasta HORIZON (próximos)
const DAY_MS = 24 * 60 * 60 * 1000;
async function collect(path) {
  const from = new Date(now.getTime() - DAY_MS);
  const seen = new Map();
  let ok = 0;
  for (const [s, e] of monthChunks(from, new Date(HORIZON + "T00:00:00Z"))) {
    try {
      const j = await getJson(`${ESPN}/${path}/scoreboard?dates=${s}-${e}&limit=1000`);
      parseEvents(j).forEach(m => seen.set(m.date + m.h + m.a, m));
      ok++;
    } catch (err) {
      console.warn("  chunk falló", path, s, err.message);
    }
  }
  if (!ok) throw new Error("sin datos para " + path);
  const all = [...seen.values()].sort((x, y) => new Date(x.date) - new Date(y.date));
  return {
    live: all.filter(m => m.state === "in"),
    next: all.filter(m => m.state === "pre"),
    // Solo partidos terminados dentro de las últimas 24 horas; después se caen solos.
    results: all.filter(m => m.state === "post" && new Date(m.date).getTime() >= from.getTime()).reverse()
  };
}

/* ---------- NFL ---------- */
async function nfl() {
  const games = await collect("football/nfl");
  const j = await getJson(`${ESPN2}/football/nfl/standings`);
  const conf = { AFC: [], NFC: [] };
  for (const c of j.children || []) {
    const key = /AFC|american/i.test((c.abbreviation || "") + (c.name || "")) ? "AFC" : "NFC";
    conf[key] = (c.standings?.entries || []).map(e => ({
      team: e.team.shortDisplayName || e.team.displayName,
      w: stat(e, "wins") ?? 0,
      l: stat(e, "losses") ?? 0,
      t: stat(e, "ties") ?? 0,
      seed: stat(e, "playoffSeed") ?? 99
    })).sort((a, b) => a.seed - b.seed || b.w - a.w).slice(0, 7);
  }
  return { ...games, conf };
}

/* ---------- Fútbol ---------- */
const LEAGUES = [
  ["epl", "eng.1", "Premier League", "🇬🇧"],
  ["liga", "esp.1", "La Liga", "🇪"],
  ["seria", "ita.1", "Serie A", "🇮"],
  ["bund", "ger.1", "Bundesliga", "🇩"],
  ["ligue1", "fra.1", "Ligue 1", "🇫"],
  ["ucl", "uefa.champions", "Champions", "🏆"],
  ["ligamx", "mex.1", "Liga MX", "🇲"],
  ["mls", "usa.1", "MLS", "🇺🇸"]
];

async function soccerTable(code) {
  const j = await getJson(`${ESPN2}/soccer/${code}/standings`);
  const entries = (j.children || []).flatMap(c => c.standings?.entries || []);
  return entries.map(e => ({
    team: e.team.shortDisplayName || e.team.displayName,
    pj: stat(e, "gamesPlayed") ?? 0,
    pts: stat(e, "points") ?? 0
  })).sort((a, b) => b.pts - a.pts || a.pj - b.pj).slice(0, 10);
}

async function futbol(prev) {
  const leagues = { ...(prev?.leagues || {}) };
  for (const [id, code, name, flag] of LEAGUES) {
    try {
      const g = await collect("soccer/" + code);
      let table = leagues[id]?.table || [];
      try { table = await soccerTable(code); } catch (e) { console.warn("  tabla falló", id, e.message); }
      leagues[id] = { name, flag, ...g, table };
      console.log("  liga ok", id);
    } catch (e) {
      console.warn("  liga falló", id, e.message);
      if (!leagues[id]) leagues[id] = { name, flag, live: [], next: [], results: [], table: [] };
    }
  }
  return { order: LEAGUES.map(l => l[0]), leagues };
}

/* ---------- Tenis ---------- */
async function tennisCalendar(tour) {
  const j = await getJson(`${ESPN}/tennis/${tour}/scoreboard`);
  const cal = j.leagues?.[0]?.calendar || [];
  const events = cal
    .filter(c => c && typeof c === "object" && c.label && c.endDate)
    .map(c => ({ name: c.label, start: c.startDate, end: c.endDate }))
    .filter(e => new Date(e.end) >= now && new Date(e.start) <= horizonDate)
    .sort((a, b) => new Date(a.start) - new Date(b.start));
  const nowPlaying = (j.events || []).map(e => ({ name: e.name || e.shortName })).filter(e => e.name);
  return { events, nowPlaying };
}

async function tennis() {
  const j = await getJson(`${ESPN}/tennis/atp/rankings`);
  const ranks = j.rankings?.[0]?.ranks || [];
  if (ranks.length < 10) throw new Error("ranking incompleto");
  const top = ranks.slice(0, 20).map(r => ({
    rank: r.current,
    prev: r.previous ?? r.current,
    name: r.athlete?.displayName || r.athlete?.shortName,
    points: r.points
  }));
  let atp = [], wta = [], nowPlaying = [];
  try { const t = await tennisCalendar("atp"); atp = t.events; nowPlaying = t.nowPlaying; } catch (e) { console.warn("  calendario ATP falló", e.message); }
  try { wta = (await tennisCalendar("wta")).events; } catch (e) { console.warn("  calendario WTA falló", e.message); }
  return { top, now: nowPlaying, atp, wta };
}

/* ---------- F1 (Jolpica, el sucesor de Ergast) ---------- */
const FLAGS = {
  Italian: "🇮", German: "🇩🇪", British: "🇬🇧", Spanish: "🇪🇸", Dutch: "🇳", Monegasque: "🇲",
  Australian: "🇦🇺", French: "🇫🇷", Thai: "🇹🇭", Mexican: "🇲", Canadian: "🇨🇦", Finnish: "🇫",
  Japanese: "🇯", "New Zealander": "🇳🇿", Brazilian: "🇧", Argentine: "🇦🇷", American: "🇺🇸",
  Chinese: "🇨🇳", Danish: "🇩"
};
const J = "https://api.jolpi.ca/ergast/f1";

async function f1() {
  const year = now.getUTCFullYear();
  let races = [];
  for (const y of [year, year + 1]) {
    try {
      const s = await getJson(`${J}/${y}.json?limit=100`);
      races = races.concat(s.MRData?.RaceTable?.Races || []);
    } catch (e) { console.warn("  calendario F1 falló", y, e.message); }
  }
  const next = races
    .filter(r => new Date(r.date + "T23:59:59Z") >= now && new Date(r.date) <= horizonDate)
    .map(r => ({
      gp: r.raceName,
      date: r.date,
      place: `${r.Circuit?.Location?.locality || ""}, ${r.Circuit?.Location?.country || ""}`,
      mx: /mexico/i.test(r.Circuit?.Location?.country || "")
    }));

  const ds = await getJson(`${J}/current/driverStandings.json`);
  const list = ds.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings || [];
  if (!list.length) throw new Error("sin standings F1");
  const all = list.map(d => ({
    pos: Number(d.position),
    name: `${d.Driver.givenName} ${d.Driver.familyName}`,
    team: d.Constructors?.[0]?.name || "",
    points: Number(d.points),
    flag: FLAGS[d.Driver.nationality] || ""
  }));
  const checo = all.find(d => /P[eé]rez/i.test(d.name)) || null;

  const cs = await getJson(`${J}/current/constructorStandings.json`);
  const teams = (cs.MRData?.StandingsTable?.StandingsLists?.[0]?.ConstructorStandings || [])
    .map(t => ({ name: t.Constructor.name, points: Number(t.points) }));

  let last = null;
  try {
    const l = await getJson(`${J}/current/last/results.json`);
    const race = l.MRData?.RaceTable?.Races?.[0];
    const nm = r => r ? `${r.Driver.givenName} ${r.Driver.familyName} (${r.Constructor.name})` : "";
    if (race) last = { gp: race.raceName, date: race.date, win: nm(race.Results?.[0]), second: nm(race.Results?.[1]) };
  } catch (e) { console.warn("  última carrera falló", e.message); }

  return { last, next, drivers: all.slice(0, 10), teams: teams.slice(0, 10), checo };
}

/* ---------- main ---------- */
let prev = {};
try { prev = JSON.parse(await readFile(OUT, "utf8")); } catch {}
const data = { ...prev };

const jobs = { tennis: () => tennis(), nfl: () => nfl(), f1: () => f1(), futbol: () => futbol(prev.futbol) };
for (const [k, fn] of Object.entries(jobs)) {
  try { data[k] = await fn(); console.log("ok", k); }
  catch (e) { console.error("falló", k, e.message, "(se conservan los datos anteriores)"); }
}
data.horizon = HORIZON;

const strip = o => JSON.stringify({ ...o, generatedAt: 0 });
if (strip(data) === strip(prev)) {
  console.log("Sin cambios, no se escribe data.json");
} else {
  data.generatedAt = new Date().toISOString();
  await writeFile(OUT, JSON.stringify(data));
  console.log("data.json actualizado");
}
