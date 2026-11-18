// Fonction Supabase « zendesk-challenge » : LECTURE SEULE, ne modifie rien dans Zendesk.
// Recherche les tickets portant le tag « ticket_challenge », sans agent affecté, au statut Nouveau ou Ouvert,
// et renvoie pour chacun : ID, Créé le, Catégorie, Sujet, Organisation, Demandeur.
// Corps : {} (aucun paramètre). Réponse : { tickets: [...], total, avertissements? }
//
// Mêmes secrets que zendesk-verif (ZENDESK_SUBDOMAIN, ZENDESK_CLIENT_ID, ZENDESK_CLIENT_SECRET).
// Test depuis le tableau de bord : en-tête « x-cle-admin » = clé secrète du projet.

const TAG = "ticket_challenge";
// Droits demandés : si Zendesk en exige d'autres, son message d'erreur les nomme (« missing the following required scopes »)
const SCOPE = "tickets:read users:read organizations:read";

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

const norm = (s: string) =>
  String(s || "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ");

// Date de création au format jj/mm/aaaa, heure de Paris (même format que la saisie manuelle)
function frDay(iso: string): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", year: "numeric" })
    .format(new Date(iso));
}

// Récupère des objets par paquets de 100 (show_many), en ignorant les erreurs : un nom manquant n'empêche pas l'import
async function namesById(base: string, kind: "users" | "organizations", ids: number[], warn: string[]) {
  const out: Record<string, string> = {};
  const uniq = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 100) {
    try {
      const j = await zget(base, "/api/v2/" + kind + "/show_many.json?ids=" + uniq.slice(i, i + 100).join(","));
      for (const x of j[kind] || []) out[String(x.id)] = x.name;
    } catch (e) {
      warn.push((kind === "users" ? "Demandeurs" : "Organisations") + " non lus : " + String((e as Error).message || e));
      break;
    }
  }
  return out;
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
  const warn: string[] = [];

  try {
    // 1. Recherche : tag, sans assigné, statut Nouveau ou Ouvert (status<pending = new + open)
    const query = "type:ticket tags:" + TAG + " assignee:none status<pending";
    const found: any[] = [];
    let next: string | null = "/api/v2/search.json?per_page=100&sort_by=created_at&sort_order=asc&query=" + encodeURIComponent(query);
    while (next && found.length < 1000) { // la recherche Zendesk plafonne à 1000 résultats
      const j = await zget(base, next);
      found.push(...(j.results || []));
      next = j.next_page ? j.next_page.replace(base, "") : null;
    }
    // Double contrôle : l'index de recherche Zendesk peut avoir quelques minutes de retard
    const tickets = found.filter((t) =>
      t.result_type !== "user" && !t.assignee_id && (t.status === "new" || t.status === "open") && (t.tags || []).includes(TAG)
    );

    // 2. Catégorie : champ personnalisé « Catégorie » (valeur technique → libellé affiché)
    let catField: any = null;
    try {
      const j = await zget(base, "/api/v2/ticket_fields.json?page[size]=100");
      catField = (j.ticket_fields || []).find((f: any) => ["categorie", "category"].includes(norm(f.title)));
      if (!catField) warn.push("Aucun champ « Catégorie » trouvé dans Zendesk : colonne laissée vide.");
    } catch (e) {
      warn.push("Champs Zendesk non lus : " + String((e as Error).message || e));
    }
    const catLabel = (t: any) => {
      if (!catField) return "";
      const v = (t.custom_fields || []).find((c: any) => c.id === catField.id)?.value;
      if (v == null || v === "") return "";
      const opt = (catField.custom_field_options || []).find((o: any) => o.value === v);
      return String(opt ? opt.name : v).split("::").pop()!.trim(); // options imbriquées « A::B » → « B »
    };

    // 3. Noms des demandeurs et des organisations
    const users = await namesById(base, "users", tickets.map((t) => t.requester_id), warn);
    const orgs = await namesById(base, "organizations", tickets.map((t) => t.organization_id), warn);

    return reply({
      total: tickets.length,
      tickets: tickets.map((t) => ({
        id: String(t.id),
        cree_le: frDay(t.created_at),
        categorie: catLabel(t),
        sujet: t.subject || "",
        organisation: orgs[String(t.organization_id)] || "",
        demandeur: users[String(t.requester_id)] || "",
        statut: t.status,
      })),
      avertissements: warn.length ? warn : undefined,
      categorie_champ: catField ? catField.title : undefined,
    });
  } catch (e) {
    return reply({ erreur: String((e as Error).message || e), avertissements: warn.length ? warn : undefined }, 502);
  }
});
