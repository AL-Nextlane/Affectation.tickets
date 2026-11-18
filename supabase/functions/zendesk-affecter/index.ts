// Fonction Supabase « zendesk-affecter » : MODIFIE Zendesk (assigné des tickets).
// Corps attendu :
//   { "affectations": [ { "ticket": "12345", "agent_id": 987654, "groupe_id": 360000000, "note": "…" }, ... ], "essai": true }
// - note (facultatif) : écrite en note interne (commentaire privé) sur le ticket, dans la même mise à jour
// - agent_id : identifiant Zendesk de l'agent (renvoyé par la fonction zendesk-verif)
// - groupe_id (facultatif) : groupe de destination (« nouveau_groupe_id » renvoyé par zendesk-verif)
// - essai: true → ne modifie rien, renvoie seulement ce qui serait fait
//
// Mêmes secrets que zendesk-verif (ZENDESK_SUBDOMAIN, ZENDESK_CLIENT_ID, ZENDESK_CLIENT_SECRET).
// Le client OAuth doit autoriser le droit « tickets:write ».
// Dans Zendesk, les modifications apparaissent faites par le compte qui a créé le client OAuth.

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
    if (r.ok) {
      // Compte connecté : il doit aussi être membre de l'application (table members, fonction is_member)
      const m = await fetch(url + "/rest/v1/rpc/is_member", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, apikey: Deno.env.get("SUPABASE_ANON_KEY") || "", "Content-Type": "application/json" },
        body: "{}",
      });
      if (m.ok && (await m.json().catch(() => false)) === true) return true;
    }
  }
  const key = (req.headers.get("x-cle-admin") || "").trim();
  if (!key) return false;
  const h: Record<string, string> = { apikey: key };
  if (key.startsWith("eyJ")) h.Authorization = "Bearer " + key;
  const a = await fetch(url + "/auth/v1/admin/users?per_page=1", { headers: h });
  return a.ok;
}

// Zendesk limite le nombre de requêtes par minute : en cas de refus (429), on attend puis on réessaie (3 fois au plus)
async function zfetch(url: string, init: RequestInit): Promise<Response> {
  for (let i = 0; ; i++) {
    const r = await fetch(url, init);
    if (r.status !== 429 || i >= 3) return r;
    const wait = Math.min(Number(r.headers.get("Retry-After")) || 2 * (i + 1), 30);
    await new Promise((res) => setTimeout(res, wait * 1000));
  }
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
      scope: "read tickets:write", // « read » : nécessaire pour suivre la tâche de mise à jour (job_statuses)
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    throw new Error("Jeton OAuth refusé par Zendesk (" + r.status + ") : " + (j.error_description || j.error || JSON.stringify(j)));
  }
  cached = { token: j.access_token, until: Date.now() + (j.expires_in || 1800) * 1000 - 60_000 };
  return cached.token;
}

async function zcall(base: string, method: string, path: string, body?: unknown) {
  const r = await zfetch(base + path, {
    method,
    headers: { Authorization: "Bearer " + (await zendeskToken(base)), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) cached = null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Zendesk " + r.status + " sur " + path + " : " + JSON.stringify(j));
  return j;
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

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
  const list: any[] = Array.isArray(body.affectations) ? body.affectations : [];
  if (!list.length) return reply({ erreur: "Aucune affectation reçue" }, 400);

  // Contrôle des données reçues avant tout envoi à Zendesk
  const results: Record<string, any> = {};
  // groupe_id (facultatif) : groupe de destination, quand le ticket doit quitter son groupe actuel (file d'arrivée)
  // note (facultative) : texte écrit en NOTE INTERNE (commentaire privé, invisible du client) sur le ticket
  const valid: { id: number; assignee_id: number; group_id?: number; comment?: { body: string; public: false } }[] = [];
  for (const a of list) {
    const t = String(a?.ticket ?? "").trim(), ag = Number(a?.agent_id), gr = a?.groupe_id == null ? null : Number(a.groupe_id);
    const note = typeof a?.note === "string" ? a.note.trim().slice(0, 20000) : "";
    if (!/^\d+$/.test(t)) { results[t] = { ticket: t, ok: false, raison: "pas un numéro de ticket Zendesk" }; continue; }
    if (!Number.isInteger(ag) || ag <= 0) { results[t] = { ticket: t, ok: false, raison: "agent Zendesk inconnu" }; continue; }
    if (gr !== null && (!Number.isInteger(gr) || gr <= 0)) { results[t] = { ticket: t, ok: false, raison: "groupe Zendesk invalide" }; continue; }
    const v: any = { id: Number(t), assignee_id: ag };
    if (gr) v.group_id = gr;
    if (note) v.comment = { body: note, public: false };
    valid.push(v);
  }
  if (body.essai) {
    // Rien n'est modifié, mais on vérifie que Zendesk accorde bien le droit d'écriture (tickets:write)
    let droit_ecriture: unknown = true;
    try { await zendeskToken(base); } catch (e) { droit_ecriture = String((e as Error).message || e); }
    for (const v of valid) results[String(v.id)] = { ticket: String(v.id), ok: true, essai: true, agent_id: v.assignee_id, groupe_id: v.group_id, note: v.comment?.body };
    return reply({ essai: true, droit_ecriture, resultats: Object.values(results) });
  }

  try {
    // Mise à jour en lot (100 tickets max par appel), chaque ticket avec son propre assigné.
    // Zendesk traite le lot en différé : on suit la tâche jusqu'à la fin (60 s max par lot).
    for (let i = 0; i < valid.length; i += 100) {
      const part = valid.slice(i, i + 100);
      const job = (await zcall(base, "PUT", "/api/v2/tickets/update_many.json", { tickets: part })).job_status;
      // À partir d'ici, Zendesk a accepté le lot : une erreur de suivi ne veut pas dire que rien n'a été fait
      let st = job, waited = 0, suivi = "";
      try {
        while (st && !["completed", "failed", "killed"].includes(st.status) && waited < 60_000) {
          await sleep(1500); waited += 1500;
          st = (await zcall(base, "GET", "/api/v2/job_statuses/" + job.id + ".json")).job_status;
        }
      } catch (e) {
        suivi = String((e as Error).message || e);
      }
      if (suivi) {
        for (const p of part) results[String(p.id)] = { ticket: String(p.id), ok: false, raison: "envoyé à Zendesk, résultat non vérifiable (" + suivi + ") : à contrôler dans Zendesk" };
        continue;
      }
      const byId: Record<string, any> = {};
      for (const r of st?.results || []) byId[String(r.id)] = r;
      for (const p of part) {
        const r = byId[String(p.id)];
        results[String(p.id)] = !st || !["completed", "failed", "killed"].includes(st.status)
          ? { ticket: String(p.id), ok: false, raison: "traitement Zendesk toujours en cours, à vérifier" }
          : r && r.success !== false && !r.errors
          ? { ticket: String(p.id), ok: true, agent_id: p.assignee_id }
          : { ticket: String(p.id), ok: false, raison: (r && (r.details || r.errors || r.error)) || st.message || "refusé par Zendesk" };
      }
    }
    const res = Object.values(results);
    return reply({ affectes: res.filter((r: any) => r.ok).length, erreurs: res.filter((r: any) => !r.ok).length, resultats: res });
  } catch (e) {
    return reply({ resultats: Object.values(results), erreur: String((e as Error).message || e) }, 502);
  }
});
