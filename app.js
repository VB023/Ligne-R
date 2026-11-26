/* Ligne R · départs de Paris Gare de Lyon
 * Croise deux sources temps réel :
 *   - Île-de-France Mobilités (PRIM) : prochains passages SIRI + info trafic Navitia
 *   - SNCF (api.sncf.com, Navitia) : départs temps réel + perturbations par train
 * Aucune donnée n'est envoyée ailleurs que vers ces API (ou votre relais si configuré).
 */
'use strict';

const CLE_STOCKAGE = 'ligneR.reglages.v1';
const DEFAUTS = {
  primKey: '', sncfKey: '', proxy: '',
  zdc: '',                                   // résolu automatiquement au 1er lancement
  ligne: 'C01731',                           // ligne R dans le référentiel IDFM
  gareSncf: 'stop_area:SNCF:87686006',       // Paris Gare de Lyon (UIC 87686006)
  freq: 60, demo: false,
};
const ECART_MIN = 2;  // minutes d'écart à partir desquelles on signale un désaccord

let cfg = chargerReglages();
let minuteur = null;
let enCours = false;

/* ---------- réglages ---------- */
function chargerReglages() {
  try { return { ...DEFAUTS, ...JSON.parse(localStorage.getItem(CLE_STOCKAGE) || '{}') }; }
  catch { return { ...DEFAUTS }; }
}
function enregistrerReglages() {
  try { localStorage.setItem(CLE_STOCKAGE, JSON.stringify(cfg)); } catch { /* navigation privée */ }
}

/* ---------- utilitaires ---------- */
const $ = (s) => document.querySelector(s);
const txt = (v) => v == null ? '' : typeof v === 'string' ? v : Array.isArray(v) ? txt(v[0]) : (v.value ?? '');
const hm = (d) => d ? d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '—';
const minutes = (a, b) => Math.round((a - b) / 60000);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sansHtml = (s) => {
  const d = document.createElement('div');
  d.innerHTML = String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n');
  return (d.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
};
// "20261126T143000" (heure locale Navitia) -> Date
function dateNavitia(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(s || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}
const normDest = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
const memeDest = (a, b) => {
  const x = normDest(a), y = normDest(b);
  return !x || !y || x.includes(y.slice(0, 6)) || y.includes(x.slice(0, 6));
};

/* ---------- accès réseau ---------- */
function urlPrim(chemin) {
  return cfg.proxy ? cfg.proxy.replace(/\/$/, '') + '/prim/' + chemin
                   : 'https://prim.iledefrance-mobilites.fr/marketplace/' + chemin;
}
function urlSncf(chemin) {
  return cfg.proxy ? cfg.proxy.replace(/\/$/, '') + '/sncf/' + chemin
                   : 'https://api.sncf.com/v1/' + chemin;
}
const entetesPrim = () => cfg.proxy ? { Accept: 'application/json' } : { Accept: 'application/json', apikey: cfg.primKey };
const entetesSncf = () => cfg.proxy ? { Accept: 'application/json' } : { Accept: 'application/json', Authorization: cfg.sncfKey };

async function getJSON(url, headers) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  let r;
  try {
    r = await fetch(url, { headers, signal: ctrl.signal, cache: 'no-store' });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('pas de réponse en 15 s');
    throw new Error(navigator.onLine ? 'bloqué par le navigateur : configurer le relais' : 'hors connexion');
  } finally { clearTimeout(t); }
  if (r.status === 401 || r.status === 403) throw new Error('clé refusée (' + r.status + ')');
  if (r.status === 429) throw new Error('quota du jour atteint');
  if (!r.ok) throw new Error('erreur ' + r.status);
  return r.json();
}

/* ---------- source 1 : IDFM / PRIM ---------- */
async function resoudreZdc() {
  if (cfg.zdc) return cfg.zdc;
  const j = await getJSON(urlPrim('v2/navitia/places?q=' + encodeURIComponent('Paris Gare de Lyon') + '&type%5B%5D=stop_area&count=10'), entetesPrim());
  const lieux = (j.places || []).filter((p) => /gare de lyon/i.test(p.name || ''));
  const choix = lieux.find((p) => /paris/i.test(p.name)) || lieux[0];
  const id = /(\d+)$/.exec(choix?.stop_area?.id || choix?.id || '')?.[1];
  if (!id) throw new Error('gare introuvable dans le référentiel IDFM');
  cfg.zdc = id; enregistrerReglages();
  return id;
}

async function sourceIdfm() {
  const zdc = await resoudreZdc();
  const ref = `STIF:StopArea:SP:${zdc}:`;
  const ligne = `STIF:Line::${cfg.ligne}:`;
  const j = await getJSON(urlPrim(`stop-monitoring?MonitoringRef=${encodeURIComponent(ref)}&LineRef=${encodeURIComponent(ligne)}`), entetesPrim());
  const passages = j?.Siri?.ServiceDelivery?.StopMonitoringDelivery?.[0]?.MonitoredStopVisit || [];
  const out = [];
  for (const v of passages) {
    const mvj = v.MonitoredVehicleJourney || {};
    const lr = txt(mvj.LineRef);
    if (lr && !lr.includes(cfg.ligne)) continue;
    const c = mvj.MonitoredCall || {};
    const prevu = c.AimedDepartureTime ? new Date(c.AimedDepartureTime) : null;
    const estime = c.ExpectedDepartureTime ? new Date(c.ExpectedDepartureTime) : prevu;
    if (!prevu && !estime) continue;                 // arrivée seule (terminus)
    const ref = mvj.FramedVehicleJourneyRef?.DatedVehicleJourneyRef || '';
    const statut = (c.DepartureStatus || '').toLowerCase();
    out.push({
      num: txt(mvj.TrainNumbers?.TrainNumberRef) || (/(\d{5,6})/.exec(ref)?.[1] ?? ''),
      mission: txt(mvj.JourneyNote),
      dest: txt(mvj.DestinationName) || txt(c.DestinationDisplay) || txt(mvj.DirectionName),
      voie: txt(c.DeparturePlatformName) || txt(c.ArrivalPlatformName),
      prevu: prevu || estime, estime,
      supprime: statut === 'cancelled',
      aQuai: !!c.VehicleAtStop,
    });
  }
  return out;
}

async function traficIdfm() {
  const id = 'line:IDFM:' + cfg.ligne;
  const j = await getJSON(urlPrim(`v2/navitia/line_reports/lines/${id}/line_reports?count=50`), entetesPrim());
  return (j.disruptions || []).map((d) => perturbationNavitia(d, 'IDFM'));
}

/* ---------- source 2 : SNCF ---------- */
async function sourceSncf() {
  const chemin = `coverage/sncf/stop_areas/${cfg.gareSncf}/departures?count=150&duration=10800&data_freshness=realtime&depth=1`;
  const j = await getJSON(urlSncf(chemin), entetesSncf());
  const perturbs = new Map((j.disruptions || []).map((d) => [d.id, d]));
  const trains = [];
  const liees = new Map();
  for (const d of j.departures || []) {
    const di = d.display_informations || {};
    const code = (di.code || '').toUpperCase();
    const estR = code === 'R' && /transilien/i.test(`${di.commercial_mode} ${di.network} ${di.physical_mode}`)
              || code === 'R' && !di.commercial_mode;
    if (!estR) continue;
    const sdt = d.stop_date_time || {};
    const prevu = dateNavitia(sdt.base_departure_date_time || sdt.departure_date_time);
    const estime = dateNavitia(sdt.departure_date_time);
    const lp = (di.links || []).filter((l) => l.type === 'disruption').map((l) => perturbs.get(l.id)).filter(Boolean);
    let supprime = false;
    for (const p of lp) {
      liees.set(p.id, p);
      if (p.severity?.effect === 'NO_SERVICE') supprime = true;
      for (const io of p.impacted_objects || []) {
        for (const s of io.impacted_stops || []) {
          if (s.stop_point?.stop_area?.id === cfg.gareSncf && s.departure_status === 'deleted') supprime = true;
        }
      }
    }
    trains.push({
      num: di.headsign || di.trip_short_name || '',
      dest: (di.direction || '').replace(/\s*\(.*\)\s*$/, ''),
      prevu, estime, supprime,
      tempsReel: sdt.data_freshness === 'realtime',
      notes: lp.map((p) => sansHtml(p.messages?.[0]?.text)).filter(Boolean),
    });
  }
  return { trains, perturbations: [...liees.values()].map((d) => perturbationNavitia(d, 'SNCF')) };
}

function perturbationNavitia(d, source) {
  const msgs = d.messages || [];
  const titre = msgs.find((m) => (m.channel?.types || []).includes('title'))?.text;
  const corps = msgs.find((m) => (m.channel?.types || []).some((t) => t === 'web' || t === 'mobile'))?.text || msgs[0]?.text;
  const periodes = d.application_periods || [];
  return {
    id: d.disruption_id || d.id, source,
    statut: d.status || 'active',
    effet: d.severity?.effect || '',
    gravite: d.severity?.name || '',
    titre: sansHtml(titre || d.cause || d.severity?.name || 'Perturbation'),
    corps: sansHtml(corps),
    debut: dateNavitia(periodes[0]?.begin), fin: dateNavitia(periodes[periodes.length - 1]?.end),
  };
}

/* ---------- croisement ---------- */
function croiser(idfm, sncf, etat) {
  const pris = new Set();
  const lignes = [];
  for (const a of idfm || []) {
    let i = a.num ? (sncf || []).findIndex((s, k) => !pris.has(k) && s.num && s.num === a.num) : -1;
    if (i < 0) i = (sncf || []).findIndex((s, k) => !pris.has(k) && s.prevu && Math.abs(s.prevu - a.prevu) <= 60000 && memeDest(a.dest, s.dest));
    const b = i >= 0 ? sncf[i] : null;
    if (b) pris.add(i);
    lignes.push(fusion(a, b, etat));
  }
  (sncf || []).forEach((s, k) => { if (!pris.has(k)) lignes.push(fusion(null, s, etat)); });
  const seuil = Date.now() - 60000;
  return lignes.filter((l) => (l.affiche || l.prevu) >= seuil).sort((x, y) => x.prevu - y.prevu);
}

function fusion(a, b, etat) {
  const prevu = a?.prevu || b?.prevu;
  const estimes = [a && !a.supprime ? a.estime : null, b && !b.supprime ? b.estime : null].filter(Boolean);
  const affiche = estimes.length ? new Date(Math.max(...estimes)) : prevu;  // hypothèse prudente
  let verdict, libelle;
  if (a?.supprime || b?.supprime) {
    const les2 = a && b && a.supprime && b.supprime;
    const seul = a?.supprime ? 'IDFM' : 'SNCF';
    verdict = 'supp';
    libelle = les2 || !(a && b) ? 'Supprimé' : `Supprimé selon ${seul} seulement`;
  } else if (a && b) {
    const e = Math.abs(minutes(a.estime, b.estime));
    if (e >= ECART_MIN) { verdict = 'ecart'; libelle = `Écart de ${e} min entre sources`; }
    else { verdict = 'ok'; libelle = 'Sources d’accord'; }
  } else {
    const present = a ? 'IDFM' : 'SNCF';
    const autre = a ? 'sncf' : 'idfm';
    verdict = 'seul';
    libelle = etat[autre] === 'ok' ? `Absent côté ${a ? 'SNCF' : 'IDFM'}` : `${present} uniquement`;
  }
  return {
    prevu, affiche,
    retard: prevu && affiche ? minutes(affiche, prevu) : 0,
    dest: a?.dest || b?.dest || '',
    mission: a?.mission || '',
    num: a?.num || b?.num || '',
    voie: a?.voie || '',
    aQuai: a?.aQuai,
    idfm: a, sncf: b,
    supprime: verdict === 'supp' && (!(a && b) || (a.supprime && b.supprime)),
    verdict, libelle,
    notes: b?.notes || [],
  };
}

/* ---------- mode démo ---------- */
function demo() {
  const base = new Date(); base.setSeconds(0, 0);
  const t = (m) => new Date(base.getTime() + m * 60000);
  const dests = [['Montereau', 'ZOVA'], ['Montargis', 'GAMO'], ['Montereau', 'ZOVA'], ['Montargis', 'GAMA'], ['Melun', 'KOHO']];
  const idfm = [], sncf = [];
  [4, 19, 26, 41, 49, 64, 79, 86, 101].forEach((m, i) => {
    const [dest, mission] = dests[i % dests.length];
    const num = String(164500 + i * 2);
    const r1 = i === 2 ? 6 : i === 5 ? 3 : 0;
    const r2 = i === 2 ? 3 : i === 5 ? 3 : 0;
    idfm.push({ num, mission, dest, voie: i < 2 ? 'M' : i === 2 ? 'L' : '', prevu: t(m), estime: t(m + r1), supprime: i === 4, aQuai: i === 0 });
    if (i !== 7) sncf.push({ num, dest, prevu: t(m), estime: t(m + r2), supprime: i === 4, tempsReel: true, notes: i === 4 ? ['Train supprimé en raison d’un incident technique.'] : [] });
  });
  const trafic = [{ id: 'd1', source: 'IDFM', statut: 'active', effet: 'SIGNIFICANT_DELAYS', titre: 'Trafic perturbé entre Melun et Montereau', corps: 'Exemple de message : un incident à Bois-le-Roi ralentit les trains. Reprise estimée vers 18 h.', debut: t(-40), fin: t(80) }];
  return { idfm, sncf, trafic };
}

/* ---------- rendu ---------- */
function rendreSources(etat, erreurs) {
  const nom = { idfm: 'IDFM horaires', trafic: 'IDFM info trafic', sncf: 'SNCF horaires' };
  $('#sources').innerHTML = Object.keys(nom).map((k) => {
    const e = etat[k];
    const t = e === 'err' ? `${nom[k]} : ${erreurs[k]}` : e === 'off' ? `${nom[k]} : clé manquante` : nom[k];
    return `<span class="src" data-etat="${e}">${esc(t)}</span>`;
  }).join('');
}

function rendreTrafic(liste, etat) {
  const zone = $('#trafic');
  const vues = new Set();
  const actives = (liste || []).filter((p) => p.statut !== 'past').filter((p) => {
    const k = normDest(p.titre).slice(0, 40);
    if (vues.has(k)) return false; vues.add(k); return true;
  });
  // en cours d'abord, puis à venir
  actives.sort((x, y) => (x.statut === 'future') - (y.statut === 'future'));
  if (!actives.length) {
    zone.innerHTML = etat.trafic === 'ok' ? '<p class="calme">Aucune perturbation signalée sur la ligne R.</p>' : '';
    return;
  }
  zone.innerHTML = actives.map((p) => {
    const grave = ['NO_SERVICE', 'REDUCED_SERVICE', 'SIGNIFICANT_DELAYS'].includes(p.effet);
    const quand = p.statut === 'future' ? 'À venir' : 'En cours';
    const per = p.debut ? ` · ${p.debut.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} ${hm(p.debut)}${p.fin ? ' → ' + hm(p.fin) : ''}` : '';
    return `<details class="perturb${grave ? ' grave' : ''}"><summary>${esc(p.titre)}</summary>
      <div class="meta">${quand} · source ${p.source}${esc(per)}</div>
      ${p.corps && p.corps !== p.titre ? `<div class="corps">${esc(p.corps)}</div>` : ''}</details>`;
  }).join('');
}

function rendreTableau(trains, etat) {
  const ol = $('#tableau');
  if (!trains.length) {
    const sansCle = etat.idfm === 'off' && etat.sncf === 'off';
    const aucuneSource = etat.idfm !== 'ok' && etat.sncf !== 'ok';
    const bouton = '<br><button class="btn" id="ouvrir-reglages">Ouvrir les réglages</button>';
    ol.innerHTML = `<li class="vide-etat">${sansCle
      ? 'Ajoutez vos clés API IDFM et SNCF dans les réglages pour afficher les départs, ou essayez le mode démo.' + bouton
      : aucuneSource
        ? 'Aucune source n’a répondu. Le motif est indiqué en rouge ci-dessus.' + bouton
        : 'Aucun départ de la ligne R dans les 3 prochaines heures.'}</li>`;
    $('#ouvrir-reglages')?.addEventListener('click', ouvrirReglages);
    $('#resume').textContent = '';
    return;
  }
  const comparables = trains.filter((t) => t.idfm && t.sncf);
  const accord = comparables.filter((t) => t.verdict === 'ok').length;
  $('#resume').textContent = comparables.length
    ? `${trains.length} départs · ${accord} sur ${comparables.length} identiques dans les deux sources`
    : `${trains.length} départs`;

  ol.innerHTML = trains.map((t) => {
    const s = (src, x) => x ? `<span class="t">${src} ${x.supprime ? 'supprimé' : hm(x.estime)}</span>` : '';
    const voie = t.voie
      ? `<div class="voie" aria-label="Voie ${esc(t.voie)}"><div><small>voie</small><b>${esc(t.voie)}</b></div></div>`
      : `<div class="voie vide" aria-label="Voie pas encore affichée"><div><small>voie</small><b>?</b></div></div>`;
    const retard = !t.supprime && t.retard > 0 ? ` · <span class="retard">+${t.retard} min</span>` : '';
    const infos = [t.mission, t.num && `train ${t.num}`, t.aQuai && 'à quai'].filter(Boolean).join(' · ');
    return `<li class="train${t.supprime ? ' supprime' : ''}">
      <div class="heure">${hm(t.affiche)}${t.retard > 0 && !t.supprime ? `<s>${hm(t.prevu)}</s>` : ''}</div>
      <div><div class="dest">${esc(t.dest)}</div><div class="info">${esc(infos)}${retard}</div></div>
      ${voie}
      <div class="croise"><span class="verdict v-${t.verdict}">${esc(t.libelle)}</span><span class="paire">${s('IDFM', t.idfm)} ${s('SNCF', t.sncf)}</span></div>
      ${t.notes.length ? `<div class="notes">${esc(t.notes.join(' '))}</div>` : ''}
    </li>`;
  }).join('');
}

/* ---------- cycle principal ---------- */
async function actualiser() {
  if (enCours) return;
  enCours = true;
  $('#btn-maj').classList.add('tourne');
  const etat = {}, erreurs = {};
  let idfm = null, sncf = null, trafic = [];
  try {
    if (cfg.demo) {
      const d = demo();
      idfm = d.idfm; sncf = d.sncf; trafic = d.trafic;
      etat.idfm = etat.sncf = etat.trafic = 'ok';
    } else {
      const aPrim = !!(cfg.primKey || cfg.proxy), aSncf = !!(cfg.sncfKey || cfg.proxy);
      const [r1, r2, r3] = await Promise.allSettled([
        aPrim ? sourceIdfm() : Promise.reject(null),
        aSncf ? sourceSncf() : Promise.reject(null),
        aPrim ? traficIdfm() : Promise.reject(null),
      ]);
      const lire = (k, r, actif) => {
        if (!actif) { etat[k] = 'off'; return null; }
        if (r.status === 'fulfilled') { etat[k] = 'ok'; return r.value; }
        etat[k] = 'err'; erreurs[k] = r.reason?.message || 'erreur'; return null;
      };
      idfm = lire('idfm', r1, aPrim);
      const s = lire('sncf', r2, aSncf);
      sncf = s?.trains || null;
      trafic = [...(lire('trafic', r3, aPrim) || []), ...(s?.perturbations || [])];
    }
    rendreSources(etat, erreurs);
    rendreTrafic(trafic, etat);
    rendreTableau(croiser(idfm, sncf, etat), etat);
    $('#maj').textContent = (cfg.demo ? 'Mode démo · ' : '') + 'Mis à jour à ' + new Date().toLocaleTimeString('fr-FR');
  } catch (e) {
    $('#maj').textContent = 'Échec de la mise à jour : ' + e.message;
  } finally {
    enCours = false;
    $('#btn-maj').classList.remove('tourne');
  }
}

function programmer() {
  clearInterval(minuteur);
  minuteur = setInterval(() => { if (document.visibilityState === 'visible') actualiser(); }, Math.max(30, +cfg.freq || 60) * 1000);
}

/* ---------- réglages : dialogue ---------- */
function ouvrirReglages() {
  const d = $('#reglages');
  $('#f-prim').value = cfg.primKey; $('#f-sncf').value = cfg.sncfKey; $('#f-proxy').value = cfg.proxy;
  $('#f-demo').checked = cfg.demo; $('#f-zdc').value = cfg.zdc; $('#f-ligne').value = cfg.ligne;
  $('#f-gare').value = cfg.gareSncf; $('#f-freq').value = cfg.freq;
  d.showModal();
}
$('#reglages').addEventListener('close', () => {
  if ($('#reglages').returnValue !== 'ok') return;
  cfg.primKey = $('#f-prim').value.trim();
  cfg.sncfKey = $('#f-sncf').value.trim();
  cfg.proxy = $('#f-proxy').value.trim();
  cfg.demo = $('#f-demo').checked;
  cfg.zdc = $('#f-zdc').value.trim().replace(/\D/g, '');
  cfg.ligne = $('#f-ligne').value.trim() || DEFAUTS.ligne;
  cfg.gareSncf = $('#f-gare').value.trim() || DEFAUTS.gareSncf;
  cfg.freq = Math.max(30, +$('#f-freq').value || 60);
  enregistrerReglages();
  programmer();
  actualiser();
});

$('#btn-reglages').addEventListener('click', ouvrirReglages);
$('#btn-maj').addEventListener('click', actualiser);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') actualiser(); });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// premier lancement sans clé : on ouvre les réglages
if (!cfg.primKey && !cfg.sncfKey && !cfg.proxy && !cfg.demo) {
  rendreSources({ idfm: 'off', sncf: 'off', trafic: 'off' }, {});
  rendreTableau([], { idfm: 'off', sncf: 'off' });
  $('#maj').textContent = 'Ajoutez vos clés API pour commencer';
} else {
  actualiser();
}
programmer();
