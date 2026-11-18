// Fonction Supabase « zendesk-orgs » : LECTURE SEULE, ne modifie rien dans Zendesk.
// Liste les organisations Zendesk et leur code de groupe client, porté par un tag « grp_c… » (ex. grp_c100517).
// Sert à rassembler automatiquement les organisations d'un même groupe dans l'onglet Statistiques client.
// Corps : {} → { total, avec_groupe, sans_groupe, plusieurs_groupes, organisations: [{ nom, groupe }] }
//
// Mêmes secrets que les autres fonctions Zendesk. Test : en-tête « x-cle-admin » = clé secrète du projet.

const SCOPE = "read";
const GRP = /^grp_c/i;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cle-admin",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

// Utilisateur connecté au programme, ou test du tableau de bord avec l'en-tête « x-cle-admin » = clé secrète du projet
async function allowed(req: Request): Promise<boolean> {
  const url = Deno.env.get("SUPABASE_URL");
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (token) {
    const r = await fetch(url + "/auth/v1/user", {
      headers: { Authorization: "Bearer " + token, apikey: Deno.env.get("SUPABASE_ANON_KEY") || "" },
    });
    if (r.ok) return true;
  }
  const key = (req.headers.get("x-cle-admin") || "").trim();
  if (!key) return false;
  const h: Record<string, string> = { apikey: key };
  if (key.startsWith("eyJ")) h.Authorization = "Bearer " + key;
  const a = await fetch(url + "/auth/v1/admin/users?per_page=1", { headers: h });
  return a.ok;
}

let cached: { token: string; until: number } | null = null;
async function zendeskToken(base: string): Promise<string> {
  if (cached && Date.now() < cached.until) return cached.token;
  const r = await fetch(base + "/oauth/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: Deno.env.get("ZENDESK_CLIENT_ID"),
      client_secret: Deno.env.get("ZENDESK_CLIENT_SECRET"),
      scope: SCOPE,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    throw new Error("Jeton OAuth refusé par Zendesk (" + r.status + ") : " + (j.error_description || j.error || JSON.stringify(j)));
  }
  cached = { token: j.access_token, until: Date.now() + (j.expires_in || 1800) * 1000 - 60_000 };
  return cached.token;
}

async function zget(base: string, path: string) {
  const r = await fetch(base + path, { headers: { Authorization: "Bearer " + (await zendeskToken(base)) } });
  if (r.status === 401) cached = null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Zendesk " + r.status + " sur " + path.split("?")[0] + " : " + JSON.stringify(j));
  return j;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply({ erreur: "Méthode non autorisée" }, 405);
  if (!(await allowed(req))) return reply({ erreur: "Non connecté" }, 401);

  const sub = Deno.env.get("ZENDESK_SUBDOMAIN");
  if (!sub || !Deno.env.get("ZENDESK_CLIENT_ID") || !Deno.env.get("ZENDESK_CLIENT_SECRET")) {
    return reply({ erreur: "Secrets Zendesk manquants" }, 500);
  }
  const base = "https://" + sub.replace(/\.zendesk\.com.*$/i, "") + ".zendesk.com";

  try {
    // Toutes les organisations, par pages de 100 (pagination par curseur)
    const orgs: any[] = [];
    let next: string | null = "/api/v2/organizations.json?page[size]=100";
    while (next) {
      const j = await zget(base, next);
      orgs.push(...(j.organizations || []));
      next = j.meta?.has_more && j.links?.next ? j.links.next.replace(base, "") : null;
    }
    const out = orgs.map((o) => {
      const grps = (o.tags || []).filter((t: string) => GRP.test(t));
      return { nom: o.name, groupe: grps[0] || null, autres_groupes: grps.length > 1 ? grps.slice(1) : undefined };
    }).sort((a, b) => String(a.nom).localeCompare(String(b.nom), "fr"));
    return reply({
      total: out.length,
      avec_groupe: out.filter((o) => o.groupe).length,
      sans_groupe: out.filter((o) => !o.groupe).length,
      plusieurs_groupes: out.filter((o) => o.autres_groupes).length,
      groupes_distincts: new Set(out.filter((o) => o.groupe).map((o) => o.groupe)).size,
      organisations: out,
    });
  } catch (e) {
    return reply({ erreur: String((e as Error).message || e) }, 502);
  }
});
