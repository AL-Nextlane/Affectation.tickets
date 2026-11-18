// Fonction Supabase « zendesk-verif » : LECTURE SEULE, ne modifie rien dans Zendesk.
// - Corps vide {}                       → test de connexion : obtient un jeton OAuth et renvoie le compte utilisé
// - { tickets: ["123", ...] }           → état de chaque ticket dans Zendesk (statut, assigné, groupe)
// - { agents: ["Prénom Nom", ...] }     → retrouve chaque consultant parmi les agents Zendesk (par nom), avec ses groupes
// - + { verifier: [{ ticket, agent }] } → dit pour chaque paire si l'affectation sera acceptée par Zendesk
// - { groupe: "360003100139" }          → liste des membres du groupe (nom exact, e-mail, actif)
//
// Secrets à créer dans Supabase (Edge Functions > Secrets) :
//   ZENDESK_SUBDOMAIN      (la partie xxx de xxx.zendesk.com)
//   ZENDESK_CLIENT_ID      (identifiant du client OAuth, confidentiel)
//   ZENDESK_CLIENT_SECRET  (secret du client OAuth)
// SUPABASE_URL, SUPABASE_ANON_KEY et SUPABASE_SERVICE_ROLE_KEY sont fournis automatiquement par Supabase.

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

// Seuls peuvent appeler la fonction :
// - un utilisateur connecté au programme (sa session Supabase est vérifiée) ;
// - un test depuis le tableau de bord, avec l'en-tête « x-cle-admin » = clé secrète du projet (sb_secret_… ou service_role).
async function allowed(req: Request): Promise<boolean> {
  const url = Deno.env.get("SUPABASE_URL");
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (token) {
    const r = await fetch(url + "/auth/v1/user", {
      headers: { Authorization: "Bearer " + token, apikey: Deno.env.get("SUPABASE_ANON_KEY") || "" },
    });
    if (r.ok) return true;
  }
  // Clé secrète : seule une clé d'administration peut lister les comptes
  const key = (req.headers.get("x-cle-admin") || "").trim();
  if (!key) return false;
  const h: Record<string, string> = { apikey: key };
  if (key.startsWith("eyJ")) h.Authorization = "Bearer " + key; // ancienne clé service_role (JWT)
  const a = await fetch(url + "/auth/v1/admin/users?per_page=1", { headers: h });
  return a.ok;
}

// Jeton OAuth « client credentials » : valable 30 minutes, gardé en mémoire tant que l'instance vit
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
      scope: "tickets:read users:read groups:read",
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    throw new Error("Jeton OAuth refusé par Zendesk (" + r.status + ") : " + (j.error_description || j.error || JSON.stringify(j)));
  }
  const life = (j.expires_in || 1800) * 1000;
  cached = { token: j.access_token, until: Date.now() + life - 60_000 };
  return cached.token;
}

async function zget(base: string, path: string) {
  const r = await fetch(base + path, { headers: { Authorization: "Bearer " + (await zendeskToken(base)) } });
  if (r.status === 401) cached = null; // jeton expiré : le prochain appel en redemande un
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Zendesk " + r.status + " sur " + path + " : " + JSON.stringify(j));
  return j;
}

const norm = (s: string) =>
  String(s || "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply({ erreur: "Méthode non autorisée" }, 405);
  if (!(await allowed(req))) return reply({ erreur: "Non connecté" }, 401);

  const sub = Deno.env.get("ZENDESK_SUBDOMAIN");
  if (!sub || !Deno.env.get("ZENDESK_CLIENT_ID") || !Deno.env.get("ZENDESK_CLIENT_SECRET")) {
    return reply({ erreur: "Secrets Zendesk manquants (ZENDESK_SUBDOMAIN, ZENDESK_CLIENT_ID, ZENDESK_CLIENT_SECRET)" }, 500);
  }
  const base = "https://" + sub.replace(/\.zendesk\.com.*$/i, "") + ".zendesk.com";
  const body = await req.json().catch(() => ({}));
  const out: Record<string, unknown> = {};

  try {
    // Test de connexion : compte Zendesk au nom duquel la fonction agit
    const me = (await zget(base, "/api/v2/users/me.json")).user;
    out.connexion = { ok: true, compte: me?.name, role: me?.role };

    // Tickets : par paquets de 100 (limite de show_many)
    if (Array.isArray(body.tickets) && body.tickets.length) {
      const raw = body.tickets.map((x: unknown) => String(x).trim());
      const ids = raw.filter((x: string) => /^\d+$/.test(x));
      const found: Record<string, any> = {};
      for (let i = 0; i < ids.length; i += 100) {
        const part = ids.slice(i, i + 100);
        const j = await zget(base, "/api/v2/tickets/show_many.json?ids=" + part.join(","));
        for (const t of j.tickets || []) found[String(t.id)] = t;
      }
      out.tickets = raw.map((id: string) => {
        if (!/^\d+$/.test(id)) return { id, ok: false, raison: "pas un numéro de ticket Zendesk" };
        const t = found[id];
        if (!t) return { id, ok: false, raison: "introuvable dans Zendesk" };
        return {
          id, ok: t.status !== "closed", statut: t.status,
          raison: t.status === "closed" ? "ticket fermé, ne pourra pas être réaffecté" : undefined,
          assigne_id: t.assignee_id, groupe_id: t.group_id, sujet: t.subject,
        };
      });
    }

    // Consultants : comparaison par nom avec les agents et administrateurs Zendesk
    if (Array.isArray(body.agents) && body.agents.length) {
      const agents: any[] = [];
      let next: string | null = "/api/v2/users.json?role[]=agent&role[]=admin&page[size]=100";
      while (next) {
        const j = await zget(base, next);
        agents.push(...(j.users || []));
        next = j.meta?.has_more && j.links?.next ? j.links.next.replace(base, "") : null;
      }
      const byName: Record<string, any[]> = {};
      for (const a of agents) if (a.active !== false) (byName[norm(a.name)] ||= []).push(a);
      const list = body.agents.map((n: string) => {
        const m = byName[norm(n)] || [];
        if (m.length === 1) return { nom: n, ok: true, zendesk_id: m[0].id, email: m[0].email } as any;
        return { nom: n, ok: false, raison: m.length ? "plusieurs agents portent ce nom" : "aucun agent Zendesk à ce nom" } as any;
      });
      // Groupes de chaque agent retrouvé : Zendesk refuse d'assigner un ticket hors des groupes de l'agent
      for (const a of list) {
        if (!a.ok) continue;
        try {
          const j = await zget(base, "/api/v2/users/" + a.zendesk_id + "/group_memberships.json");
          a.groupes = (j.group_memberships || []).map((g: any) => g.group_id);
        } catch (e) {
          a.groupes_erreur = String((e as Error).message || e);
        }
      }
      out.agents = list;
    }

    // Membres d'un groupe : { "groupe": "360003100139" } → agents du groupe (nom exact dans Zendesk, e-mail)
    if (body.groupe) {
      const gid = String(body.groupe).trim();
      if (!/^\d+$/.test(gid)) throw new Error("Identifiant de groupe invalide : " + gid);
      const ids: number[] = [];
      let next: string | null = "/api/v2/groups/" + gid + "/memberships.json?page[size]=100";
      while (next) {
        const j = await zget(base, next);
        for (const m of j.group_memberships || []) ids.push(m.user_id);
        next = j.meta?.has_more && j.links?.next ? j.links.next.replace(base, "") : null;
      }
      const members: any[] = [];
      for (let i = 0; i < ids.length; i += 100) {
        const j = await zget(base, "/api/v2/users/show_many.json?ids=" + ids.slice(i, i + 100).join(","));
        members.push(...(j.users || []));
      }
      out.membres = members
        .map((u) => ({ nom: u.name, email: u.email, zendesk_id: u.id, actif: u.active !== false && !u.suspended }))
        .sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
    }

    // Noms des groupes cités (tickets et agents), pour un affichage lisible
    const gids = new Set<number>();
    for (const t of (out.tickets as any[]) || []) if (t.groupe_id) gids.add(t.groupe_id);
    for (const a of (out.agents as any[]) || []) for (const g of a.groupes || []) gids.add(g);
    if (body.groupe && /^\d+$/.test(String(body.groupe).trim())) gids.add(Number(String(body.groupe).trim()));
    if (gids.size) {
      try {
        const names: Record<string, string> = {};
        let next: string | null = "/api/v2/groups.json?page[size]=100";
        while (next) {
          const j = await zget(base, next);
          for (const g of j.groups || []) names[String(g.id)] = g.name;
          next = j.meta?.has_more && j.links?.next ? j.links.next.replace(base, "") : null;
        }
        out.groupes = Object.fromEntries([...gids].map((id) => [String(id), names[String(id)] || "?"]));
      } catch (e) {
        out.groupes_erreur = String((e as Error).message || e);
      }
    }

    // Contrôle croisé : { "verifier": [ { "ticket": "123", "agent": "Prénom Nom" } ] } (avec tickets et agents fournis)
    if (Array.isArray(body.verifier) && out.tickets && out.agents) {
      const tk: Record<string, any> = {}, ag: Record<string, any> = {};
      for (const t of out.tickets as any[]) tk[t.id] = t;
      for (const a of out.agents as any[]) ag[norm(a.nom)] = a;
      out.verification = body.verifier.map((v: any) => {
        const t = tk[String(v.ticket).trim()], a = ag[norm(v.agent)];
        const r: any = { ticket: String(v.ticket), agent: v.agent };
        if (!t || !t.ok) return { ...r, ok: false, raison: t ? t.raison : "ticket non vérifié" };
        if (!a || !a.ok) return { ...r, ok: false, raison: a ? a.raison : "agent non vérifié" };
        const gname = (id: number) => ((out.groupes as any) || {})[String(id)] || String(id);
        if (t.groupe_id && a.groupes && !a.groupes.includes(t.groupe_id)) {
          // Ticket hors des groupes de l'agent : il faudra le déplacer dans le groupe de l'agent
          if (a.groupes.length === 1) {
            return { ...r, ok: true, nouveau_groupe_id: a.groupes[0], note: "le ticket passera du groupe « " + gname(t.groupe_id) + " » au groupe « " + gname(a.groupes[0]) + " »" };
          }
          return { ...r, ok: false, raison: a.groupes.length ? "l'agent est dans plusieurs groupes : groupe de destination à choisir" : "l'agent n'est dans aucun groupe" };
        }
        return { ...r, ok: true };
      });
    }

    return reply(out);
  } catch (e) {
    return reply({ ...out, erreur: String((e as Error).message || e) }, 502);
  }
});
