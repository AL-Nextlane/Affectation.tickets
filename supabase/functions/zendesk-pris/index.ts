// Fonction Supabase « zendesk-pris » : LECTURE SEULE, ne modifie rien dans Zendesk.
// Remplace l'export Excel de la vue « Tickets pris par les consultants ». Reprend les conditions de la vue :
//   - Marqueurs contient « ticket_challenge »
//   - Assigné : affecté à quelqu'un
//   - Produit présent, Catégorie présente
//   - Type d'assistance est « Agent »
//   - Temps écoulé depuis l'affectation < 720 h (30 jours), d'après la date de dernière affectation (assigned_at)
// Renvoie pour chaque ticket : ID, Affecté (date d'affectation), Catégorie, Sujet, Organisation, Demandeur, Assigné.
// Corps : {} ou { "jours": 30 } ou { "depuis": "2026-11-17T08:00:00Z" } (affectés après cette date, 30 jours au plus).
//
// Mêmes secrets que les autres fonctions Zendesk. Test : en-tête « x-cle-admin » = clé secrète du projet.

const TAG = "ticket_challenge";
const SCOPE = "read"; // la recherche Zendesk exige le droit de lecture général

// Champs personnalisés, retrouvés par leur titre (français ou anglais)
const FIELD_TITLES = {
  produit: ["produit", "product"],
  categorie: ["categorie", "category"],
  assistance: ["type d'assistance", "type d’assistance", "type dassistance", "assistance type", "support type", "type of assistance"],
};

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

function frDay(iso: string): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", year: "numeric" })
    .format(new Date(iso));
}

async function namesById(base: string, kind: "users" | "organizations", ids: number[], warn: string[]) {
  const out: Record<string, string> = {};
  const uniq = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 100) {
    try {
      const j = await zget(base, "/api/v2/" + kind + "/show_many.json?ids=" + uniq.slice(i, i + 100).join(","));
      for (const x of j[kind] || []) out[String(x.id)] = x.name;
    } catch (e) {
      warn.push((kind === "users" ? "Noms des personnes" : "Organisations") + " non lus : " + String((e as Error).message || e));
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
  const body = await req.json().catch(() => ({}));
  const days = Math.min(Math.max(Number(body.jours) || 30, 1), 90);
  let since = Date.now() - days * 24 * 3600 * 1000; // 720 h pour 30 jours
  // « depuis » (date ISO, ex. dernier import) : ne garde que les tickets affectés après cette date, dans la limite de « jours »
  const depuis = body.depuis ? new Date(body.depuis).getTime() : NaN;
  if (!isNaN(depuis) && depuis > since) since = depuis;
  const warn: string[] = [];

  try {
    // 1. Champs personnalisés : Produit, Catégorie, Type d'assistance
    const fj = await zget(base, "/api/v2/ticket_fields.json?page[size]=100");
    const all: any[] = fj.ticket_fields || [];
    const active = all.filter((f) => f.active !== false);
    const titled = (titles: string[]) => active.filter((f) => titles.includes(norm(f.title)) || titles.includes(norm(f.title_in_portal)));
    const optNames = (f: any) => (f.custom_field_options || []).map((o: any) => norm(String(o.name).split("::").pop()!));
    // Produit : par son titre
    const fProduit = titled(FIELD_TITLES.produit)[0];
    // Catégorie : plusieurs champs « Category » existent ; on garde celui des catégories françaises (Atelier, Magasin…)
    const cats = titled(FIELD_TITLES.categorie);
    const fCat = cats.find((f) => optNames(f).some((n: string) => ["atelier", "magasin", "comptabilite"].includes(n))) || cats[0];
    // Type d'assistance : identifiant fixé par le secret ZENDESK_CHAMP_ASSISTANCE s'il existe ; sinon son titre,
    // ou le seul champ dont une option s'appelle « Agent »
    const forcedId = Number(Deno.env.get("ZENDESK_CHAMP_ASSISTANCE") || 0);
    const withAgent = active.filter((f) => optNames(f).includes("agent"));
    const fAssist = (forcedId ? active.find((f) => f.id === forcedId) : undefined) ||
      titled(FIELD_TITLES.assistance)[0] || (withAgent.length === 1 ? withAgent[0] : undefined);
    // « Type d'assistance » n'est pas un champ de ticket personnalisé dans ce Zendesk (critère interne des vues).
    // Il reste facultatif : sans lui, le filtre « assigné à un consultant connu » (fait par le programme) en tient lieu.
    const missing = [!fProduit && "Produit", !fCat && "Catégorie", forcedId && !fAssist && "Type d'assistance"].filter(Boolean);
    if (missing.length) {
      // Diagnostic : listes déroulantes dont un titre, une option ou une valeur évoque « agent » ou « assistance »
      const hint = (s: unknown) => /agent|assist|support|type/.test(norm(String(s ?? "")));
      return reply({
        erreur: "Champs Zendesk introuvables : " + missing.join(", ") + ".",
        champs_candidats: active
          .filter((f) => (f.custom_field_options || []).length &&
            (hint(f.title) || hint(f.title_in_portal) || (f.custom_field_options || []).some((o: any) => hint(o.name) || hint(o.value))))
          .map((f) => ({
            id: f.id, titre: f.title, titre_portail: f.title_in_portal,
            options: (f.custom_field_options || []).map((o: any) => o.name + " [" + o.value + "]"),
          })),
      }, 500);
    }
    // Valeur « Agent » du type d'assistance (valeur technique de l'option)
    // Option « Agent » : nom exact, ou valeur technique imposée par le secret ZENDESK_VALEUR_AGENT
    const forcedValue = (Deno.env.get("ZENDESK_VALEUR_AGENT") || "").trim();
    const agentValues: unknown[] = !fAssist ? [] : forcedValue ? [forcedValue] : (fAssist.custom_field_options || [])
      .filter((o: any) => norm(String(o.name).split("::").pop()!) === "agent").map((o: any) => o.value);
    if (!fAssist) warn.push("Critère « Type d'assistance = Agent » non appliqué (pas de champ correspondant) : seuls les tickets assignés à un consultant connu sont comptés.");
    if (fAssist && !agentValues.length) {
      return reply({
        erreur: "Option « Agent » introuvable dans le champ « " + fAssist.title + " ».",
        options_disponibles: (fAssist.custom_field_options || []).map((o: any) => o.name),
      }, 500);
    }
    const champsUtilises = {
      produit: fProduit.title + " (" + fProduit.id + ")",
      categorie: fCat.title + " (" + fCat.id + ")",
      type_assistance: fAssist ? fAssist.title + " (" + fAssist.id + ")" : "non appliqué",
    };

    // 2. Présélection par la recherche : tag + affecté + mis à jour depuis la date limite.
    //    (Une affectation met le ticket à jour : aucun ticket affecté dans la période n'est écarté.
    //     Le vrai filtre sur la date d'affectation est fait ensuite, sur assigned_at.)
    const sinceDay = new Date(since - 24 * 3600 * 1000).toISOString().slice(0, 10); // un jour de marge (fuseaux)
    const query = "type:ticket tags:" + TAG + " -assignee:none updated>" + sinceDay;
    const found: any[] = [];
    let next: string | null = "/api/v2/search.json?per_page=100&query=" + encodeURIComponent(query);
    while (next && found.length < 1000) {
      const j = await zget(base, next);
      found.push(...(j.results || []).filter((t: any) => t.result_type === "ticket" || t.subject !== undefined));
      next = j.next_page ? j.next_page.replace(base, "") : null;
    }
    if (found.length >= 1000) warn.push("Plus de 1000 tickets présélectionnés : la recherche Zendesk s'arrête à 1000, la liste peut être incomplète.");

    // 3. Conditions sur les champs (comme la vue)
    const val = (t: any, f: any) => (t.custom_fields || []).find((c: any) => c.id === f.id)?.value;
    const present = (v: unknown) => v != null && v !== "" && !(Array.isArray(v) && !v.length);
    const candidates = found.filter((t) =>
      t.assignee_id && (t.tags || []).includes(TAG) &&
      present(val(t, fProduit)) && present(val(t, fCat)) && (!fAssist || agentValues.includes(val(t, fAssist)))
    );

    // 4. Date de dernière affectation (métriques du ticket), par paquets de 100
    const assignedAt: Record<string, string> = {};
    const ids = candidates.map((t) => t.id);
    for (let i = 0; i < ids.length; i += 100) {
      const j = await zget(base, "/api/v2/tickets/show_many.json?include=metric_sets&ids=" + ids.slice(i, i + 100).join(","));
      for (const m of j.metric_sets || []) if (m.assigned_at) assignedAt[String(m.ticket_id)] = m.assigned_at;
    }
    const noMetric = candidates.filter((t) => !assignedAt[String(t.id)]).length;
    if (noMetric) warn.push(noMetric + " ticket(s) sans date d'affectation dans Zendesk : écartés.");
    const tickets = candidates.filter((t) => {
      const a = assignedAt[String(t.id)];
      return a && new Date(a).getTime() >= since;
    }).sort((a, b) => assignedAt[String(b.id)].localeCompare(assignedAt[String(a.id)]));

    // 5. Noms (assigné, demandeur, organisation) et libellé de la catégorie
    const users = await namesById(base, "users", tickets.flatMap((t) => [t.assignee_id, t.requester_id]), warn);
    const orgs = await namesById(base, "organizations", tickets.map((t) => t.organization_id), warn);
    const catLabel = (t: any) => {
      const v = val(t, fCat);
      const opt = (fCat.custom_field_options || []).find((o: any) => o.value === v);
      return String(opt ? opt.name : v ?? "").split("::").pop()!.trim();
    };

    return reply({
      total: tickets.length,
      periode: "affectés depuis le " + new Date(since).toLocaleString("fr-FR", { timeZone: "Europe/Paris" }),
      tickets: tickets.map((t) => ({
        id: String(t.id),
        affecte: frDay(assignedAt[String(t.id)]),
        categorie: catLabel(t),
        sujet: t.subject || "",
        organisation: orgs[String(t.organization_id)] || "",
        demandeur: users[String(t.requester_id)] || "",
        assigne: users[String(t.assignee_id)] || "",
      })),
      avertissements: warn.length ? warn : undefined,
      champs_utilises: champsUtilises,
    });
  } catch (e) {
    return reply({ erreur: String((e as Error).message || e), avertissements: warn.length ? warn : undefined }, 502);
  }
});
