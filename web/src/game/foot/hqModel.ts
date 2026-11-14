// OWNER: builder F (HQ panel). Pure: (messages, heroPid, busy) -> what the HQ panel shows.
// Every number here comes from a tool result (computed server-side); this file only picks, labels and words them.

import { firstSentence, kind, parse, text, type Msg } from "../radio";

type Call = { id?: string; name?: string; args?: Record<string, unknown> };

// ---------------------------------------------------------------- words (never keys, never pids)

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
  still_there: "the tenant is still there",
  gone_dark: "the tenant has left",
  subleasing: "the tenant is subleasing",
  moved_within: "moved within the building",
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
  gone_dark: "left",
  subleasing: "subleasing",
  moved_within: "moved within",
  listing_stale: "stale listing",
};
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
/** A hypothesis in words: the known phrase, else the claim's first clause, never the key. */
function hypWords(key: string, claim?: string): string {
  if (HYP_WORDS[key]) return HYP_WORDS[key];
  const c = (claim ?? "").split(/[:;]/)[0].trim();
  return c ? c.charAt(0).toLowerCase() + c.slice(1) : "another explanation";
}
const hypShort = (key: string, claim?: string) => HYP_SHORT[key] ?? firstSentence(hypWords(key, claim), 22);
const checkName = (key: string) => CHECK_NAME[key] ?? (humanize(key).charAt(0).toUpperCase() + humanize(key).slice(1));

/** Text safe to show: known pids become labels, hypothesis keys become words, vendor names become what they are. */
function scrubber(labels: Map<string, string>) {
  const pids = [...labels.keys()].filter((p) => p.length >= 3).sort((a, b) => b.length - a.length);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pidRe = pids.length ? new RegExp(`\\b(?:property\\s+(?:id\\s+)?)?(?:${pids.map(esc).join("|")})\\b`, "gi") : null;
  const keyRe = new RegExp(`\\b(${Object.keys(HYP_WORDS).join("|")})\\b`, "g");
  return (s: string, max = 150): string => {
    let t = s;
    if (pidRe) t = t.replace(pidRe, (m) => labels.get(m.replace(/^property\s+(?:id\s+)?/i, "")) ?? "the building");
    t = t
      .replace(/\bproperty\s+(?:id\s+)?#?\d{5,}\b/gi, "the building")
      .replace(keyRe, (k) => `"${HYP_SHORT[k]}"`)
      .replace(/\bVexcel\b/g, "aerial imagery")
      .replace(/\bMatterport\b/g, "the 3D tour");
    return firstSentence(t, max);
  };
}

// ---------------------------------------------------------------- the view

export type SquadView = { key: SquadKey; label: string; state: "idle" | "working" | "done" | "silent"; finding: string | null };
export type TodoView = { text: string; status: "pending" | "in_progress" | "completed" };
export type BarView = { key: string; words: string; pct: number; lead: boolean };
export type CaseView = {
  question: string;
  bars: BarView[];
  weighed: boolean; // false: the starting odds (priors), before HQ has weighed anything
  verdict: { label: "likely" | "leaning" | "unresolved"; words: string; pct: number; text: string | null } | null;
  delta: { pts: number; why: string; key: string } | null; // how the leader moved on the latest weigh
  chose: { ran: number; of: number } | null;
};
export type EffectView = { sign: "up" | "down"; text: string };
export type EvidenceView = {
  id: string; at: number; name: string; finding: string | null; effects: EffectView[];
  pending: boolean; vision: boolean; human: boolean;
};
export type HqView = {
  started: boolean;
  status: string; // what the agent is doing right now, in words
  squads: SquadView[];
  todos: TodoView[];
  current: TodoView | null; // the in-progress todo, if any
  noCase: boolean; // open_case ran for the building and found nothing to settle
  caseView: CaseView | null;
  evidence: EvidenceView[];
  waiting: { proposal: string } | null; // commit_plan is waiting for the player's HOLD or RUN
};

type OpenCase = { property_id?: unknown; cases?: { case: string; question: string; hypotheses: { key: string; claim: string; prior: number }[]; checks?: unknown[] }[] };
type Check = { property_id?: unknown; case?: string; check?: string; finding?: string; effects?: { hypothesis: string; delta: number }[]; status?: string };
type Weighed = {
  property_id?: unknown; case?: string; posterior?: Record<string, number>; checks_used?: string[];
  trail?: { check: string; finding?: string; effects?: { hypothesis: string; delta: number }[] }[];
  verdict?: { hypothesis?: string; claim?: string; confidence?: number; label?: string; text?: string };
  status?: string;
};

const VISION = new Set(["look_from_above", "compare_captures", "suite_tour"]);
const PRIORITY = ["commit_plan", "task", "check_evidence", "weigh_case", "record_note", "find_fallback", "horde_status", "open_case", "fortress_dossier", "write_todos"];
const STATUS_BY_CALL: Record<string, string> = {
  write_todos: "writing its plan",
  task: "sending out the squads",
  fortress_dossier: "pulling the building's file",
  open_case: "opening the case",
  check_evidence: "checking the evidence it chose",
  weigh_case: "weighing the case",
  record_note: "logging your report",
  horde_status: "reading the horde",
  find_fallback: "looking for a fallback",
  commit_plan: "deciding: hold or run",
};

function effectsOf(list: Check["effects"], words: (k: string) => string): EffectView[] {
  return (list ?? [])
    .filter((e) => e && typeof e.delta === "number" && Math.round(e.delta * 100) !== 0)
    .map((e) => {
      const pts = Math.round(e.delta * 100);
      return { sign: pts > 0 ? "up" : "down", text: `${pts > 0 ? "+" : "−"}${Math.abs(pts)} ${words(e.hypothesis)}` } as EffectView;
    });
}

export function hqModel(messages: readonly unknown[], heroPid: string | null, busy: boolean): HqView {
  const ms = messages as readonly Msg[];
  const same = (pid: unknown) => heroPid == null || String(pid) === heroPid;

  // One pass: index tool results, remember the newest of everything we draw.
  const resultById = new Map<string, number>();
  const labels = new Map<string, string>();
  let scoutAt = -1;
  let lastAi = -1;
  let todos: TodoView[] = [];
  const tasks: { call: Call; at: number }[] = [];
  const checkCalls: { call: Call; at: number }[] = [];
  const recordNotes: number[] = [];
  const tips: { at: number; text: string }[] = [];
  ms.forEach((m, i) => {
    const k = kind(m);
    if (k === "human") {
      const t = text(m.content).trim();
      if (/^Scout property /.test(t)) {
        scoutAt = i;
        const pid = t.match(/^Scout property (\S+)/)?.[1];
        if (pid && !labels.has(pid)) labels.set(pid, "the building");
      } else if (/^Tip:/i.test(t)) tips.push({ at: i, text: t.replace(/^Tip:\s*/i, "") });
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
        else if (c.name === "record_note") recordNotes.push(i);
      }
      return;
    }
    if (k === "tool") {
      if (m.tool_call_id) resultById.set(m.tool_call_id, i);
      if (m.name === "fortress_dossier") {
        const d = parse<{ pid?: unknown; label?: string }>(m);
        if (d?.pid != null && d.label) labels.set(String(d.pid), d.label);
      } else if (m.name === "find_fallback") {
        const f = parse<{ to_pid?: unknown; to_label?: string }>(m);
        if (f?.to_pid != null && f.to_label) labels.set(String(f.to_pid), f.to_label);
      }
    }
  });
  if (heroPid && !labels.has(heroPid)) labels.set(heroPid, "the building");
  const clean = scrubber(labels);

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

  // ---- the case for the building: newest open_case for heroPid
  let openAt = -1;
  let opened: OpenCase | null = null;
  for (let i = ms.length - 1; i >= 0; i--) {
    const m = ms[i];
    if (kind(m) !== "tool" || m.name !== "open_case") continue;
    const o = parse<OpenCase>(m);
    if (o && same(o.property_id)) {
      openAt = i;
      opened = o;
      break;
    }
  }
  const after = openAt >= 0 ? ms.slice(openAt + 1) : [];
  const offset = openAt + 1;
  const checks: { c: Check; at: number; callId?: string }[] = [];
  const weighs: { w: Weighed; at: number }[] = [];
  after.forEach((m, j) => {
    if (kind(m) !== "tool") return;
    if (m.name === "check_evidence") {
      const c = parse<Check>(m);
      if (c?.check && !c.status && same(c.property_id)) checks.push({ c, at: offset + j, callId: m.tool_call_id });
    } else if (m.name === "weigh_case") {
      const w = parse<Weighed>(m);
      if (w?.posterior && !w.status && same(w.property_id)) weighs.push({ w, at: offset + j });
    }
  });
  const working = weighs[weighs.length - 1]?.w.case ?? checks[checks.length - 1]?.c.case;
  const spec = opened?.cases?.find((x) => x.case === working) ?? opened?.cases?.[0] ?? null;
  const noCase = !!opened && !spec;

  let caseView: CaseView | null = null;
  const evidence: EvidenceView[] = [];
  if (spec) {
    const hyps = spec.hypotheses ?? [];
    const claimOf = (k: string) => hyps.find((h) => h.key === k)?.claim;
    const short = (k: string) => hypShort(k, claimOf(k));
    const mine = weighs.filter((x) => x.w.case === spec.case);
    const last = mine[mine.length - 1] ?? null;
    const prev = mine[mine.length - 2] ?? null;
    const odds: Record<string, number> = last?.w.posterior ?? Object.fromEntries(hyps.map((h) => [h.key, h.prior]));
    const lead = last?.w.verdict?.hypothesis ?? hyps.reduce((a, h) => ((odds[h.key] ?? 0) > (odds[a] ?? -1) ? h.key : a), hyps[0]?.key ?? "");
    const bars = hyps.map((h) => ({ key: h.key, words: hypWords(h.key, h.claim), pct: Math.round((odds[h.key] ?? 0) * 100), lead: h.key === lead }));
    let verdict: CaseView["verdict"] = null;
    let delta: CaseView["delta"] = null;
    if (last?.w.verdict) {
      const v = last.w.verdict;
      const label = v.label === "likely" || v.label === "leaning" ? v.label : "unresolved";
      verdict = {
        label, words: hypWords(lead, v.claim), pct: Math.round((v.confidence ?? odds[lead] ?? 0) * 100),
        text: v.text ? clean(v.text.replace(/\s*\(\d+%\)\s*$/, ""), 160) : null,
      };
      const base = prev ? prev.w.posterior?.[lead] : hyps.find((h) => h.key === lead)?.prior;
      if (typeof base === "number") {
        const pts = Math.round(((odds[lead] ?? 0) - base) * 100);
        const tipBetween = tips.some((t) => t.at > (prev?.at ?? openAt) && t.at < last.at);
        const humanUsed = !!last.w.checks_used?.includes("human_report") && !prev?.w.checks_used?.includes("human_report");
        const why = tipBetween || humanUsed ? "after your report" : prev ? "since HQ last weighed" : "from the evidence";
        if (pts !== 0) delta = { pts, why, key: `${last.at}` };
      }
    }
    const offered = Array.isArray(spec.checks) ? spec.checks.length : 0;
    const ran = new Set(checks.filter((x) => x.c.case === spec.case).map((x) => x.c.check));
    caseView = {
      question: clean(spec.question, 200),
      bars, weighed: !!last, verdict, delta,
      chose: offered && ran.size ? { ran: ran.size, of: offered } : null,
    };

    // ---- evidence the agent chose: results (newest per check), checks still running, and the player's report
    const seen = new Set<string>();
    const cards: EvidenceView[] = [];
    for (let i = checks.length - 1; i >= 0; i--) {
      const { c, at } = checks[i];
      if (c.case !== spec.case || seen.has(c.check!)) continue;
      seen.add(c.check!);
      cards.push({
        id: `c-${c.check}`, name: checkName(c.check!), finding: c.finding ? clean(c.finding, 140) : null,
        effects: effectsOf(c.effects, short), pending: false, vision: VISION.has(c.check!), human: c.check === "human_report", at,
      });
    }
    if (busy) {
      for (const { call, at } of checkCalls) {
        const a = call.args ?? {};
        const name = typeof a.check === "string" ? a.check : "";
        if (at <= openAt || !name || seen.has(name) || !same(a.property_id)) continue;
        if (call.id && resultById.has(call.id)) continue;
        seen.add(name);
        cards.push({ id: `p-${name}`, name: checkName(name), finding: null, effects: [], pending: true, vision: VISION.has(name), human: name === "human_report", at });
      }
    }
    // The player's report: weigh_case counts it as human_report (in its trail), after record_note saved it.
    if (!seen.has("human_report")) {
      const trail = last?.w.trail?.find((t) => t.check === "human_report");
      const noteAt = recordNotes.filter((i) => i > openAt).pop();
      const tip = tips.filter((t) => t.at > openAt).pop();
      if (trail || (noteAt !== undefined && tip)) {
        const t = tip?.text.replace(/\s+/g, " ").trim() ?? "";
        const said = t ? `"${t.length > 160 ? `${t.slice(0, 159).trimEnd()}…` : t}"` : null;
        cards.push({
          id: "c-human_report", name: CHECK_NAME.human_report,
          finding: said ?? (trail?.finding ? clean(trail.finding, 140) : null),
          effects: effectsOf(trail?.effects, short), pending: false, vision: false, human: true,
          at: Math.max(noteAt ?? -1, tip?.at ?? -1, last && trail ? last.at : -1),
        });
      }
    }
    cards.sort((a, b) => b.at - a.at);
    evidence.push(...cards);
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
  const started = ms.some((m) => kind(m) === "ai" || kind(m) === "tool") || scoutAt >= 0;
  let status = started ? "standing by" : "standing by for the scout";
  if (waiting) status = "waiting for your call";
  else if (busy) {
    const newest = ms[ms.length - 1];
    const nk = newest ? kind(newest) : "";
    const out = tasks.filter((t) => t.at > scoutAt && !(t.call.id && resultById.has(t.call.id))).length;
    const open = lastAi >= 0 ? ((ms[lastAi].tool_calls ?? []) as Call[]).filter((c) => c?.name && !(c.id && resultById.has(c.id))) : [];
    const pick = (calls: Call[]) => PRIORITY.find((n) => calls.some((c) => c.name === n));
    if (nk === "human") status = "reading your message";
    else if (nk === "ai" && !(newest.tool_calls ?? []).length) status = "on the radio";
    else if (out) status = `${out} squad${out === 1 ? "" : "s"} out`;
    else {
      const n = pick(open);
      status = n ? STATUS_BY_CALL[n] : "thinking it over";
    }
  }
  return { started, status, squads, todos, current, noCase, caseView, evidence, waiting };
}
