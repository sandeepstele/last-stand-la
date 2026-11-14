// OWNER: builder F (HQ panel). Pure: (messages, heroPid, busy) -> what the HQ panel shows.
// Every number here comes from a tool result (computed server-side); this file only picks, labels and words them.
// Two flows share it: the night shift ("Brief the night shift" -> night_cases, then a case at a time) and the
// fortress scout ("Scout property <pid>"). The active case is read from the stream (newest open_case / weigh_case).

import { firstSentence, kind, parse, text, type Msg } from "../radio";

type Call = { id?: string; name?: string; args?: Record<string, unknown> };

// ---------------------------------------------------------------- words (never keys, never pids, never companies)

export type SquadKey = "records" | "aerial" | "interior" | "civic";
export const SQUADS: { key: SquadKey; label: string }[] = [
  { key: "records", label: "Records" },
  { key: "aerial", label: "Aerial" },
  { key: "interior", label: "Interior" },
  { key: "civic", label: "City" },
];

/** Hypotheses in words, for the odds bars. */
const HYP_WORDS: Record<string, string> = {
  city_list_current: "concrete, as the city lists it",
  costar_current: "the material CoStar records",
  different_structure: "a different structure",
  replaced: "replaced since it was listed",
  year_is_renovation: "the same building, renovated",
  still_there: "still there",
  gone_dark: "gone; the record is out of date",
  subleasing: "subleasing its own space",
  moved_within: "moved to another suite",
  listing_stale: "the listing is stale",
};
/** Hypotheses in a word or two, for the +/- chips. */
const HYP_SHORT: Record<string, string> = {
  city_list_current: "city's concrete",
  costar_current: "recorded material",
  different_structure: "different structure",
  replaced: "replaced",
  year_is_renovation: "renovated",
  still_there: "still there",
  gone_dark: "gone",
  subleasing: "subleasing",
  moved_within: "moved suites",
  listing_stale: "stale listing",
};
export const CASE_WORDS: Record<string, string> = {
  material_conflict: "Records disagree on the walls",
  ghost_tenant: "Is the office on record still there?",
  stale_entry: "Was the listed building replaced?",
};
const CASE_SHORT: Record<string, string> = { material_conflict: "walls", ghost_tenant: "office", stale_entry: "replaced?" };
export const CHECK_NAME: Record<string, string> = {
  compliance_filings: "City retrofit filings",
  permit_text: "Permit wording",
  replacement_permits: "Demolition / new-building permits",
  era_and_height: "Era and floor height",
  site_structures: "Structures on the parcel",
  look_from_above: "Vision: looked at the aerial",
  compare_captures: "Vision: old vs new aerial",
  human_report: "Your report",
  listing_timeline: "Listing and tenancy dates",
  lease_terms: "Lease terms",
  tenancy_trail: "Where the tenant went",
  lot_activity: "Cars on the lot over time",
  suite_tour: "Vision: looked inside the suite",
};

const humanize = (s: string) => s.replace(/_+/g, " ").trim();
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** A hypothesis in words: the known phrase, else the claim's first clause, never the key. */
function hypWords(key: string, claim?: string): string {
  if (HYP_WORDS[key]) return HYP_WORDS[key];
  const c = (claim ?? "").split(/[:;]/)[0].trim();
  return c ? c.charAt(0).toLowerCase() + c.slice(1) : "another explanation";
}
const hypShort = (key: string, claim?: string) => HYP_SHORT[key] ?? firstSentence(hypWords(key, claim), 22);
const checkName = (key: string) => CHECK_NAME[key] ?? cap(humanize(key));
const caseWords = (c: string | undefined) => (c && CASE_WORDS[c]) || (c ? cap(humanize(c)) : "Open case");

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Text safe to show: known pids become labels, tenant names become "a tenant", hypothesis keys become words. */
function scrubber(labels: Map<string, string>, tenants: Set<string>) {
  const pids = [...labels.keys()].filter((p) => p.length >= 3).sort((a, b) => b.length - a.length);
  const pidRe = pids.length ? new RegExp(`\\b(?:property\\s+(?:id\\s+)?)?(?:${pids.map(esc).join("|")})\\b`, "gi") : null;
  const names = [...tenants].filter((t) => t.length >= 3).sort((a, b) => b.length - a.length);
  const nameRe = names.length ? new RegExp(names.map(esc).join("|"), "gi") : null;
  const keyRe = new RegExp(`\\b(${Object.keys(HYP_WORDS).join("|")})\\b`, "g");
  const safe = (s: string): string => {
    let t = s;
    if (nameRe) t = t.replace(nameRe, "a tenant");
    if (pidRe) t = t.replace(pidRe, (m) => labels.get(m.replace(/^property\s+(?:id\s+)?/i, "")) ?? "the building");
    return t
      .replace(/\bCoStar records (?!a tenant\b)(.{1,80}?) here since\b/g, "CoStar records a tenant here since")
      .replace(/\boccupied by (?!a tenant\b)(.{1,80}?) since\b/g, "occupied by a tenant since")
      .replace(/\bproperty\s+(?:id\s+)?#?\d{5,}\b/gi, "the building")
      .replace(keyRe, (k) => `"${HYP_SHORT[k]}"`)
      .replace(/\bVexcel\b/g, "aerial imagery")
      .replace(/\bMatterport\b/g, "the 3D tour");
  };
  const line = (s: string, max = 150): string => firstSentence(safe(s), max);
  /** Several sentences kept (a draft correction), markdown stripped, capped. */
  line.full = (s: string, max = 480): string => {
    const t = safe(s).replace(/[#*`>]+/g, "").replace(/\s+/g, " ").trim();
    return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
  };
  return line;
}

/** Labels (pid -> address) and tenant names (to hide) from anywhere in the thread. */
function namesIn(ms: readonly Msg[]): { labels: Map<string, string>; tenants: Set<string> } {
  const labels = new Map<string, string>();
  const tenants = new Set<string>();
  for (const m of ms) {
    if (kind(m) !== "tool") continue;
    if (m.name === "night_cases") {
      const r = parse<NightCases>(m);
      for (const c of r?.cases ?? []) if (c?.property_id != null && c.label) labels.set(String(c.property_id), c.label);
    } else if (m.name === "fortress_dossier" || m.name === "draft_correction") {
      const d = parse<{ pid?: unknown; property_id?: unknown; label?: string }>(m);
      const pid = d?.pid ?? d?.property_id;
      if (pid != null && d?.label) labels.set(String(pid), d.label);
    } else if (m.name === "open_case") {
      const o = parse<OpenCase>(m);
      if (typeof o?.tenant === "string" && !/^\d+ tenants on record/.test(o.tenant)) tenants.add(o.tenant);
    }
  }
  return { labels, tenants };
}

const norm = (v: unknown) => (v == null ? "" : String(v).trim());
/** A suite as the tools and the model may write it ("1100", "Suite 1100", "#1100", 1100) -> "1100". */
const suiteOf = (v: unknown) => norm(v).replace(/^(suite|ste\.?)\s*/i, "").replace(/^#\s*/, "").toLowerCase();
const keyOf = (pid: unknown, suite: unknown) => `${norm(pid)}|${suiteOf(suite)}`;
/** The suite a tip is about ("Tip: I'm inside suite 1100. ..."), or "" for the building. */
const tipSuite = (t: string) => suiteOf(t.match(/\bsuite\s+#?([\w-]+)/i)?.[1]);

// ---------------------------------------------------------------- the view

export type SquadView = { key: SquadKey; label: string; state: "idle" | "working" | "done" | "silent"; finding: string | null };
export type TodoView = { text: string; status: "pending" | "in_progress" | "completed" };
export type BarView = { key: string; words: string; pct: number; lead: boolean };
export type VerdictView = { label: "likely" | "leaning" | "unresolved"; words: string; pct: number; text: string | null };
export type CaseView = {
  title: string; // "#7 · 122 7th St, suite 1100" in the night shift; "the records disagree" otherwise
  inBrief: boolean; // the case is one of tonight's cases (its row already shows what it asks)
  question: string;
  bars: BarView[];
  weighed: boolean; // false: the starting odds (priors), before HQ has weighed anything
  verdict: VerdictView | null;
  delta: { pts: number; why: string; key: string } | null; // how the leader moved on the latest weigh
  chose: { ran: number; of: number } | null;
};
export type EffectView = { sign: "up" | "down"; text: string };
export type EvidenceView = {
  id: string; at: number; name: string; finding: string | null; effects: EffectView[];
  pending: boolean; vision: boolean; human: boolean;
};
export type BriefCase = {
  id: string; n: number | null; type: string; short: string; where: string; stakes: string | null; question: string | null;
  state: "open" | "checking" | "report" | "weighed" | "drafting" | "drafted"; verdict: VerdictView | null; active: boolean;
};
export type BriefView = { total: number | null; cases: BriefCase[]; loading: boolean };
export type HqView = {
  started: boolean;
  status: string; // what the agent is doing right now, in words
  brief: BriefView | null; // tonight's cases, from night_cases
  squadsSent: boolean; // any task call in the thread
  squads: SquadView[];
  todos: TodoView[];
  current: TodoView | null; // the in-progress todo, if any
  noCase: boolean; // open_case ran and found nothing to settle
  caseView: CaseView | null;
  evidence: EvidenceView[];
  waiting: { proposal: string } | null; // commit_plan is waiting for the player's HOLD or RUN
  drafts: DraftsView; // the dawn debrief: draft corrections, one per case worked
};

type Spec = { case: string; question: string; hypotheses: { key: string; claim: string; prior: number }[]; checks?: unknown[] };
type OpenCase = { property_id?: unknown; suite?: unknown; tenant?: unknown; cases?: Spec[] };
type Effect = { hypothesis: string; delta: number };
type Check = { property_id?: unknown; suite?: unknown; case?: string; check?: string; finding?: string; effects?: Effect[]; status?: string };
type Weighed = {
  property_id?: unknown; suite?: unknown; case?: string; posterior?: Record<string, number>; checks_used?: string[];
  trail?: { check: string; finding?: string; effects?: Effect[] }[];
  verdict?: { hypothesis?: string; claim?: string; confidence?: number; label?: string; text?: string };
  status?: string;
};
type NightCase = { n?: number; case?: string; property_id?: unknown; suite?: unknown; label?: string; question?: string; stakes?: string };
type NightCases = { total?: number; cases?: NightCase[] };

const VISION = new Set(["look_from_above", "compare_captures", "suite_tour"]);
const PRIORITY = ["commit_plan", "draft_correction", "task", "check_evidence", "weigh_case", "record_note", "open_case", "night_cases",
  "find_fallback", "horde_status", "fortress_dossier", "write_todos"];
const STATUS_BY_CALL: Record<string, string> = {
  draft_correction: "drafting tonight's corrections",
  night_cases: "reading tonight's case queue",
  write_todos: "writing its plan",
  task: "sending out the squads",
  fortress_dossier: "pulling the building's file",
  open_case: "opening a case",
  check_evidence: "checking the evidence it chose",
  weigh_case: "weighing the case",
  record_note: "logging your report",
  horde_status: "reading the horde",
  find_fallback: "looking for a fallback",
  commit_plan: "deciding: hold or run",
};

function effectsOf(list: Effect[] | undefined, words: (k: string) => string): EffectView[] {
  return (list ?? [])
    .filter((e) => e && typeof e.delta === "number" && Math.round(e.delta * 100) !== 0)
    .map((e) => {
      const pts = Math.round(e.delta * 100);
      return { sign: pts > 0 ? "up" : "down", text: `${pts > 0 ? "+" : "−"}${Math.abs(pts)} ${words(e.hypothesis)}` } as EffectView;
    });
}

function verdictOf(w: Weighed, claimOf: (k: string) => string | undefined, clean: (s: string, max?: number) => string): VerdictView | null {
  const v = w.verdict;
  if (!v) return null;
  const lead = v.hypothesis ?? "";
  return {
    label: v.label === "likely" || v.label === "leaning" ? v.label : "unresolved",
    words: hypWords(lead, v.claim ?? claimOf(lead)),
    pct: Math.round((v.confidence ?? w.posterior?.[lead] ?? 0) * 100),
    text: v.text ? clean(v.text.replace(/\s*\(\d+%\)\s*$/, ""), 160) : null,
  };
}

export function hqModel(messages: readonly unknown[], heroPid: string | null, busy: boolean): HqView {
  const ms = messages as readonly Msg[];

  // ---- one pass: index tool results and calls; remember everything we draw, with where it sits in the thread
  const resultById = new Map<string, number>();
  const labels = new Map<string, string>();
  const tenants = new Set<string>();
  let scoutAt = -1;
  let briefAt = -1;
  let lastAi = -1;
  let todos: TodoView[] = [];
  const nightRef: { v: NightCases | null } = { v: null }; // a holder: assigned inside the forEach below
  const tasks: { call: Call; at: number }[] = [];
  const checkCalls: { call: Call; at: number }[] = [];
  const openCalls: { call: Call; at: number }[] = [];
  const noteCalls: { call: Call; at: number }[] = [];
  const draftCalls: { call: Call; at: number }[] = [];
  const tips: { at: number; text: string; suite: string }[] = [];
  const opens: { o: OpenCase; at: number }[] = [];
  const checks: { c: Check; at: number }[] = [];
  const weighs: { w: Weighed; at: number }[] = [];
  ms.forEach((m, i) => {
    const k = kind(m);
    if (k === "human") {
      const t = text(m.content).trim();
      if (/^Brief the night shift/i.test(t)) briefAt = i;
      else if (/^Scout property /.test(t)) {
        scoutAt = i;
        const pid = t.match(/^Scout property (\S+)/)?.[1];
        if (pid && !labels.has(pid)) labels.set(pid, "the building");
      } else if (/^Tip:/i.test(t)) {
        const body = t.replace(/^Tip:\s*/i, "");
        tips.push({ at: i, text: body, suite: tipSuite(body) });
      }
      return;
    }
    if (k === "ai") {
      lastAi = i;
      for (const c of (m.tool_calls ?? []) as Call[]) {
        if (!c?.name) continue;
        const a = c.args ?? {};
        if (c.name === "write_todos" && Array.isArray(a.todos)) {
          const next = (a.todos as unknown[])
            .map((t) => t as { content?: unknown; status?: unknown })
            .filter((t) => t && typeof t.content === "string" && t.content.trim())
            .map((t) => ({
              text: String(t.content).trim(),
              status: t.status === "completed" || t.status === "in_progress" ? t.status : "pending",
            }) as TodoView);
          if (next.length) todos = next;
        } else if (c.name === "task") tasks.push({ call: c, at: i });
        else if (c.name === "check_evidence") checkCalls.push({ call: c, at: i });
        else if (c.name === "open_case") openCalls.push({ call: c, at: i });
        else if (c.name === "record_note") noteCalls.push({ call: c, at: i });
        else if (c.name === "draft_correction") draftCalls.push({ call: c, at: i });
      }
      return;
    }
    if (k !== "tool") return;
    if (m.tool_call_id) resultById.set(m.tool_call_id, i);
    switch (m.name) {
      case "fortress_dossier": {
        const d = parse<{ pid?: unknown; label?: string }>(m);
        if (d?.pid != null && d.label) labels.set(String(d.pid), d.label);
        break;
      }
      case "find_fallback": {
        const f = parse<{ to_pid?: unknown; to_label?: string }>(m);
        if (f?.to_pid != null && f.to_label) labels.set(String(f.to_pid), f.to_label);
        break;
      }
      case "night_cases": {
        const r = parse<NightCases>(m);
        if (r && Array.isArray(r.cases)) {
          nightRef.v = r;
          for (const c of r.cases) if (c?.property_id != null && c.label) labels.set(String(c.property_id), c.label);
        }
        break;
      }
      case "open_case": {
        const o = parse<OpenCase>(m);
        if (o && o.property_id != null) {
          opens.push({ o, at: i });
          if (typeof o.tenant === "string" && !/^\d+ tenants on record/.test(o.tenant)) tenants.add(o.tenant);
        }
        break;
      }
      case "check_evidence": {
        const c = parse<Check>(m);
        if (c?.check && !c.status) checks.push({ c, at: i });
        break;
      }
      case "weigh_case": {
        const w = parse<Weighed>(m);
        if (w?.posterior && !w.status) weighs.push({ w, at: i });
        break;
      }
    }
  });
  if (heroPid && !labels.has(heroPid)) labels.set(heroPid, "the building");
  const clean = scrubber(labels, tenants);
  const drafts = draftsModel(ms, busy);
  const where = (pid: unknown, suite: unknown) => {
    const l = labels.get(norm(pid));
    const s = norm(suite);
    return `${l && l !== "the building" ? l : "a building"}${s ? `, suite ${s}` : ""}`;
  };

  // ---- squads: the task calls since the newest scout order
  const squads: SquadView[] = SQUADS.map(({ key, label }) => {
    const t = [...tasks].reverse().find((x) => x.at > scoutAt && x.call.args?.subagent_type === key);
    if (!t) return { key, label, state: "idle", finding: null };
    const r = t.call.id ? resultById.get(t.call.id) : undefined;
    if (r === undefined) return { key, label, state: busy ? "working" : "silent", finding: null };
    const raw = text(ms[r].content).trim();
    let finding: string | null = null;
    if (raw) {
      // a squad's report: plain text (usually), or a JSON object; first sentence, never a pid
      let body = raw;
      if (raw.startsWith("{")) {
        try {
          const o = JSON.parse(raw) as Record<string, unknown>;
          const f = ["summary", "headline", "finding", "note", "result", "text", "answer", "message"].find((x) => typeof o[x] === "string" && o[x]);
          body = f ? String(o[f]) : "";
        } catch { /* plain text after all */ }
      }
      body = body.replace(/[#*`>]+/g, "").replace(/^\s*(records|aerial|interior|civic|city)( squad| team| desk)?\s*[:\-–]\s*/i, "");
      finding = body ? clean(body, 120) : null;
    }
    return { key, label, state: "done", finding: finding || "Report in." };
  });

  // ---- the active case: the newest open_case or weigh_case in the stream
  let activeKey: string | null = null;
  let activeAt = -1;
  for (const { o, at } of opens) if (at > activeAt) { activeAt = at; activeKey = keyOf(o.property_id, o.suite); }
  for (const { w, at } of weighs) if (at > activeAt) { activeAt = at; activeKey = keyOf(w.property_id, w.suite); }
  const night = nightRef.v;
  const nightList: NightCase[] = night?.cases?.filter((c) => c && c.property_id != null) ?? [];
  const nightTotal = night?.total ?? null;
  const nightOf = (key: string) => nightList.find((c) => keyOf(c.property_id, c.suite) === key) ?? null;

  let caseView: CaseView | null = null;
  let noCase = false;
  const evidence: EvidenceView[] = [];
  if (activeKey) {
    const ak = activeKey;
    const opened = [...opens].reverse().find((x) => keyOf(x.o.property_id, x.o.suite) === ak) ?? null;
    const mineW = weighs.filter((x) => keyOf(x.w.property_id, x.w.suite) === ak);
    const mineC = checks.filter((x) => keyOf(x.c.property_id, x.c.suite) === ak);
    const working = mineW[mineW.length - 1]?.w.case ?? mineC[mineC.length - 1]?.c.case;
    const nc = nightOf(ak);
    let spec: Spec | null = opened?.o.cases?.find((x) => x.case === working) ?? opened?.o.cases?.[0] ?? null;
    if (!spec && mineW.length) {
      // weighed without an open_case result in view: the hypotheses are the posterior's keys
      const w = mineW[mineW.length - 1].w;
      spec = { case: w.case ?? "", question: nc?.question ?? "", hypotheses: Object.keys(w.posterior ?? {}).map((key) => ({ key, claim: "", prior: NaN })) };
    }
    noCase = !!opened && !spec && !nc;
    if (spec) {
      const sp = spec;
      const hyps = sp.hypotheses ?? [];
      const claimOf = (k: string) => hyps.find((h) => h.key === k)?.claim;
      const short = (k: string) => hypShort(k, claimOf(k));
      const ws = mineW.filter((x) => !x.w.case || x.w.case === sp.case);
      const last = ws[ws.length - 1] ?? null;
      const prev = ws[ws.length - 2] ?? null;
      const odds: Record<string, number> = last?.w.posterior ?? Object.fromEntries(hyps.map((h) => [h.key, h.prior || 0]));
      const lead = last?.w.verdict?.hypothesis ?? hyps.reduce((a, h) => ((odds[h.key] ?? 0) > (odds[a] ?? -1) ? h.key : a), hyps[0]?.key ?? "");
      const bars = hyps.map((h) => ({ key: h.key, words: hypWords(h.key, h.claim), pct: Math.round((odds[h.key] ?? 0) * 100), lead: h.key === lead }));
      const caseSuite = ak.split("|")[1];
      const myTips = tips.filter((t) => t.suite === caseSuite);
      const verdict = last ? verdictOf(last.w, claimOf, clean) : null;
      let delta: CaseView["delta"] = null;
      if (last && verdict) {
        const base = prev ? prev.w.posterior?.[lead] : hyps.find((h) => h.key === lead)?.prior;
        if (typeof base === "number" && !Number.isNaN(base)) {
          const pts = Math.round(((odds[lead] ?? 0) - base) * 100);
          const from = prev?.at ?? opened?.at ?? -1;
          const tipBetween = myTips.some((t) => t.at > from && t.at < last.at);
          const humanUsed = !!last.w.checks_used?.includes("human_report") && !prev?.w.checks_used?.includes("human_report");
          const why = tipBetween || humanUsed ? "after your report" : prev ? "since HQ last weighed" : "from the evidence";
          if (pts !== 0) delta = { pts, why, key: `${last.at}` };
        }
      }
      const offered = Array.isArray(sp.checks) ? sp.checks.length : 0;
      const ran = new Set(mineC.filter((x) => x.c.case === sp.case).map((x) => x.c.check));
      caseView = {
        title: nc ? `${nc.n != null ? `#${nc.n} · ` : ""}${where(nc.property_id, nc.suite)}` : "the records disagree",
        inBrief: !!nc,
        question: clean(sp.question || nc?.question || "", 200),
        bars, weighed: !!last, verdict, delta,
        chose: offered && ran.size ? { ran: ran.size, of: offered } : null,
      };

      // ---- evidence the agent chose: results (newest per check), checks still running, and the player's report
      const seen = new Set<string>();
      const cards: EvidenceView[] = [];
      for (let i = mineC.length - 1; i >= 0; i--) {
        const { c, at } = mineC[i];
        if (c.case !== sp.case || seen.has(c.check!)) continue;
        seen.add(c.check!);
        cards.push({
          id: `c-${c.check}`, at, name: checkName(c.check!), finding: c.finding ? clean(c.finding, 140) : null,
          effects: effectsOf(c.effects, short), pending: false, vision: VISION.has(c.check!), human: c.check === "human_report",
        });
      }
      if (busy) {
        for (const { call, at } of checkCalls) {
          const a = call.args ?? {};
          const name = typeof a.check === "string" ? a.check : "";
          if (!name || seen.has(name) || keyOf(a.property_id, a.suite) !== ak || (opened && at < opened.at)) continue;
          if (call.id && resultById.has(call.id)) continue;
          seen.add(name);
          cards.push({ id: `p-${name}`, at, name: checkName(name), finding: null, effects: [], pending: true, vision: VISION.has(name), human: name === "human_report" });
        }
      }
      // The player's report: record_note saves it; weigh_case counts it as human_report (in its trail).
      if (!seen.has("human_report")) {
        const trail = last?.w.trail?.find((t) => t.check === "human_report");
        const note = [...noteCalls].reverse().find((x) => keyOf(x.call.args?.property_id, x.call.args?.suite) === ak);
        const tip = [...myTips].reverse().find((t) => !note || t.at <= note.at) ?? null;
        if (trail || note) {
          const said = tip?.text.replace(/\s+/g, " ").trim() || (typeof note?.call.args?.note === "string" ? note.call.args.note : "");
          cards.push({
            id: "c-human_report", name: CHECK_NAME.human_report,
            finding: said ? `"${said.length > 160 ? `${said.slice(0, 159).trimEnd()}…` : said}"` : trail?.finding ? clean(trail.finding, 140) : null,
            effects: effectsOf(trail?.effects, short), pending: false, vision: false, human: true,
            at: Math.max(note?.at ?? -1, tip?.at ?? -1, last && trail ? last.at : -1),
          });
        }
      }
      cards.sort((a, b) => b.at - a.at);
      evidence.push(...cards);
    }
  }

  // ---- tonight's cases: each row's state is the newest thing the agent did on it
  let brief: BriefView | null = null;
  if (night) {
    const caseRows = nightList.map((nc, i) => {
      const k = keyOf(nc.property_id, nc.suite);
      let state: BriefCase["state"] = "open";
      let at = -1;
      const bump = (s: BriefCase["state"], j: number) => { if (j >= at) { at = j; state = s; } };
      for (const x of openCalls) if (keyOf(x.call.args?.property_id, x.call.args?.suite) === k) bump("checking", x.at);
      for (const x of opens) if (keyOf(x.o.property_id, x.o.suite) === k) bump("checking", x.at);
      for (const x of checkCalls) if (keyOf(x.call.args?.property_id, x.call.args?.suite) === k) bump("checking", x.at);
      for (const x of noteCalls) if (keyOf(x.call.args?.property_id, x.call.args?.suite) === k) bump("report", x.at);
      const ws = weighs.filter((x) => keyOf(x.w.property_id, x.w.suite) === k);
      for (const x of ws) bump("weighed", x.at);
      for (const x of draftCalls) if (keyOf(x.call.args?.property_id, x.call.args?.suite) === k && !(x.call.id && resultById.has(x.call.id))) bump("drafting", x.at);
      const myDraft = drafts.drafts.filter((d) => d.key === k).pop();
      if (myDraft) bump("drafted", myDraft.at);
      const lastW = ws[ws.length - 1]?.w;
      return {
        id: `${k}|${i}`, n: typeof nc.n === "number" ? nc.n : null, type: caseWords(nc.case ?? lastW?.case),
        short: CASE_SHORT[nc.case ?? lastW?.case ?? ""] ?? "case", where: where(nc.property_id, nc.suite),
        stakes: nc.stakes ? clean(nc.stakes, 60) : null, question: nc.question ? clean(nc.question, 200) : null,
        state, verdict: lastW ? verdictOf(lastW, () => undefined, clean) : myDraft?.verdict ?? null, active: k === activeKey,
      } as BriefCase;
    });
    brief = { total: typeof nightTotal === "number" ? nightTotal : null, cases: caseRows, loading: false };
  } else if (briefAt >= 0) {
    brief = { total: null, cases: [], loading: busy };
  }

  // ---- waiting for the human: the newest AI message proposes commit_plan and nothing answered it yet
  let waiting: HqView["waiting"] = null;
  if (lastAi >= 0) {
    const plan = ((ms[lastAi].tool_calls ?? []) as Call[]).find((c) => c?.name === "commit_plan");
    const answered = plan && ((plan.id && resultById.has(plan.id)) || ms.slice(lastAi + 1).some((m) => kind(m) === "tool" && m.name === "commit_plan"));
    if (plan && !answered) {
      const a = plan.args ?? {};
      const to = a.to_pid != null ? labels.get(String(a.to_pid)) : undefined;
      waiting = { proposal: a.action === "run" ? `HQ proposes RUN to ${to && to !== "the building" ? to : "the fallback"}` : a.action === "hold" ? "HQ proposes HOLD" : "" };
    }
  }

  const current = todos.find((t) => t.status === "in_progress") ?? null;
  const started = ms.some((m) => kind(m) === "ai" || kind(m) === "tool") || scoutAt >= 0 || briefAt >= 0;
  let status = "standing by";
  if (waiting) status = "waiting for your call";
  else if (busy) {
    const newest = ms[ms.length - 1];
    const nk = newest ? kind(newest) : "";
    const out = tasks.filter((t) => t.at > scoutAt && !(t.call.id && resultById.has(t.call.id))).length;
    const open = lastAi >= 0 ? ((ms[lastAi].tool_calls ?? []) as Call[]).filter((c) => c?.name && !(c.id && resultById.has(c.id))) : [];
    const pick = PRIORITY.find((n) => open.some((c) => c.name === n));
    if (nk === "human") status = "reading your message";
    else if (nk === "ai" && !(newest.tool_calls ?? []).length) status = "on the radio";
    else if (out) status = `${out} squad${out === 1 ? "" : "s"} out`;
    else status = pick ? STATUS_BY_CALL[pick] : "thinking it over";
  }
  return { started, status, brief, squadsSent: tasks.length > 0, squads, todos, current, noCase, caseView, evidence, waiting, drafts };
}

// ---------------------------------------------------------------- the dawn debrief: draft corrections

export type DraftView = {
  id: string; key: string; at: number; n: number | null; type: string; where: string;
  verdict: VerdictView | null; text: string; evidence: string[]; yourReport: string | null;
};
export type DraftsView = {
  requested: boolean; // "Debrief the night shift" is on the thread
  drafting: boolean; // the debrief run is in progress
  done: number;
  expected: number | null; // draft_correction calls made so far (one per case worked)
  drafts: DraftView[]; // in the order HQ drafted them
};
type Draft = {
  n?: number; case?: string; property_id?: unknown; suite?: unknown; label?: string; hypothesis?: string;
  label_verdict?: string; confidence?: number; text?: string; evidence?: { check?: string; finding?: string }[];
  your_report?: string | null; status?: string;
};

/** The debrief, from the stream: draft_correction calls and results since the newest "Debrief the night shift". */
export function draftsModel(messages: readonly unknown[], busy: boolean): DraftsView {
  const ms = messages as readonly Msg[];
  let from = -1;
  ms.forEach((m, i) => {
    if (kind(m) === "human" && /^Debrief the night shift/i.test(text(m.content).trim())) from = i;
  });
  const { labels, tenants } = namesIn(ms);
  const clean = scrubber(labels, tenants);
  let calls = 0;
  const byKey = new Map<string, DraftView>();
  ms.forEach((m, i) => {
    if (i <= from) return;
    const k = kind(m);
    if (k === "ai") calls += ((m.tool_calls ?? []) as Call[]).filter((c) => c?.name === "draft_correction").length;
    if (k !== "tool" || m.name !== "draft_correction") return;
    const d = parse<Draft>(m);
    if (!d || d.status || d.property_id == null || !d.text) return;
    const key = keyOf(d.property_id, d.suite);
    const lead = d.hypothesis ?? "";
    const label = d.label_verdict === "likely" || d.label_verdict === "leaning" ? d.label_verdict : "unresolved";
    const human = !!d.your_report;
    const names = [...new Set((d.evidence ?? []).map((e) => e?.check).filter((c): c is string => !!c && !(human && c === "human_report")))];
    const suite = norm(d.suite);
    const place = d.label ?? labels.get(norm(d.property_id));
    byKey.set(key, {
      id: `d-${key}`, key, at: i, n: typeof d.n === "number" ? d.n : null, type: caseWords(d.case),
      where: `${place && place !== "the building" ? place : "a building"}${suite ? `, suite ${suite}` : ""}`,
      verdict: lead ? { label, words: hypWords(lead), pct: Math.round((d.confidence ?? 0) * 100), text: null } : null,
      text: clean.full(d.text.replace(/^\s*DRAFT\b[:\s]*/i, "")), // the card carries its own DRAFT badge
      evidence: names.slice(0, 3).map(checkName),
      yourReport: d.your_report ? clean.full(d.your_report, 220) : null,
    });
  });
  const drafts = [...byKey.values()].sort((a, b) => a.at - b.at);
  const requested = from >= 0;
  return { requested, drafting: requested && busy, done: drafts.length, expected: calls || null, drafts };
}
