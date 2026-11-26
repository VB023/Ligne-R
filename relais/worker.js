/* Relais facultatif (Cloudflare Workers, offre gratuite).
 * À utiliser seulement si le navigateur bloque les appels directs aux API (CORS).
 * Les clés sont stockées comme secrets du Worker : elles ne passent plus par le téléphone.
 *
 * Secrets à définir dans Cloudflare : PRIM_KEY, SNCF_KEY
 * Variable facultative : ORIGINE (ex. https://vb023.github.io) pour n'accepter que votre site.
 */
const CHEMINS_PRIM = [/^stop-monitoring/, /^v2\/navitia\/(places|line_reports)\//];
const CHEMINS_SNCF = [/^coverage\/sncf\/stop_areas\/[^/]+\/departures/];

export default {
  async fetch(req, env) {
    const origine = env.ORIGINE || '*';
    const cors = {
      'Access-Control-Allow-Origin': origine,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Accept',
      'Vary': 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'GET') return new Response('Méthode non autorisée', { status: 405, headers: cors });

    const url = new URL(req.url);
    let cible, entetes = { Accept: 'application/json' };
    if (url.pathname.startsWith('/prim/')) {
      const chemin = url.pathname.slice(6);
      if (!CHEMINS_PRIM.some((r) => r.test(chemin))) return new Response('Chemin refusé', { status: 403, headers: cors });
      cible = 'https://prim.iledefrance-mobilites.fr/marketplace/' + chemin + url.search;
      entetes.apikey = env.PRIM_KEY;
    } else if (url.pathname.startsWith('/sncf/')) {
      const chemin = url.pathname.slice(6);
      if (!CHEMINS_SNCF.some((r) => r.test(chemin))) return new Response('Chemin refusé', { status: 403, headers: cors });
      cible = 'https://api.sncf.com/v1/' + chemin + url.search;
      entetes.Authorization = env.SNCF_KEY;
    } else {
      return new Response('Introuvable', { status: 404, headers: cors });
    }

    const r = await fetch(cible, { headers: entetes, cf: { cacheTtl: 20, cacheEverything: true } });
    const h = new Headers(cors);
    h.set('Content-Type', r.headers.get('Content-Type') || 'application/json');
    return new Response(r.body, { status: r.status, headers: h });
  },
};
