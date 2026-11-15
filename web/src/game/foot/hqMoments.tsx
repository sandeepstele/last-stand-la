"use client";
// "AI moments": big, transient lower-third cards that make the agent the main character (HQ panel).
// One card at a time (~4.5 s), queued in the order they happened, triggered only by NEW messages (tracked by id):
//   HQ'S PLAN (first write_todos) · HQ OPENED A CASE (open_case) · HQ LOOKED AT THE AERIAL (check_evidence with images,
//   for the fortress) · YOUR REPORT MOVED THE ODDS (weigh_case after your report) · HQ IS DRAFTING YOUR CORRECTIONS.
// Never a moment for commit_plan or whether walls held. Every number comes from a tool result; text is scrubbed
// (no pids, no tenant names, hypotheses in words).

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { kind, parse, text, type Msg } from "../radio";
import { CHECK_NAME, caseWords, hypWords, keyOf, namesIn, norm, scrubber, tipSuite } from "./hqModel";
import { SHORT, placeName, plain, subjectOf, sureWords } from "./copy";
import styles from "./hq.module.css";

export type HqMomentsProps = {
  messages: readonly unknown[]; // the laststand thread
  busy: boolean; // a run is in progress
  heroPid: string | null; // the fortress: its aerial reads become moments
};

const HOLD_MS = 4500;

type Base = { id: string; group: string; at: number; title: string; where: string | null };
export type Moment = Base & (
  | { kind: "plan"; todos: string[] }
  | { kind: "case"; headline: string; question: string; answers: string[] }
  | { kind: "aerial"; images: string[]; caption: string; finding: string | null }
  | { kind: "odds"; from: number | null; to: number; words: string; label: string; lead: string }
  | { kind: "drafting"; cases: string[] }
);

/** Shorter hypothesis words for the odds meter ("55% → 72% concrete"). */
const ODDS_WORDS: Record<string, string> = {
  city_list_current: "concrete",
  costar_current: "the recorded material",
  different_structure: "a different structure",
  replaced: "replaced",
  year_is_renovation: "renovated",
};

type Call = { id?: string; name?: string; args?: Record<string, unknown> };
type Effect = { hypothesis: string; delta: number };
type Weighed = {
  property_id?: unknown; suite?: unknown; case?: string; posterior?: Record<string, number>; priors?: Record<string, number>;
  checks_used?: string[]; trail?: { check: string }[]; verdict?: { hypothesis?: string; label?: string; confidence?: number }; status?: string;
};
type Check = { property_id?: unknown; suite?: unknown; check?: string; finding?: string; callout?: string; images?: unknown; effects?: Effect[]; status?: string };
type OpenCase = { property_id?: unknown; suite?: unknown; cases?: { case: string; question: string; hypotheses?: { key: string; claim: string }[] }[] };
type NightCases = { cases?: { n?: number; property_id?: unknown; suite?: unknown; label?: string }[] };

/** An evidence image: a backend file name (served by /evidence/image/{name}); data: URLs pass through (fixtures). */
export const momentImage = (name: string) =>
  name.startsWith("data:") ? name : `/api/backend/evidence/image/${encodeURIComponent(name.split("/").pop() ?? name)}`;

/** Every moment in the thread, in stream order. Pure. */
export function momentsOf(messages: readonly unknown[], heroPid: string | null): Moment[] {
  const ms = messages as readonly Msg[];
  const { labels, tenants } = namesIn(ms);
  const clean = scrubber(labels, tenants);
  const caseNo = new Map<string, number>();
  for (const m of ms) {
    if (kind(m) !== "tool" || m.name !== "night_cases") continue;
    for (const c of parse<NightCases>(m)?.cases ?? []) if (c?.property_id != null && typeof c.n === "number") caseNo.set(keyOf(c.property_id, c.suite), c.n);
  }
  const where = (pid: unknown, suite: unknown): string | null => {
    const n = caseNo.get(keyOf(pid, suite));
    const l = labels.get(norm(pid));
    const s = norm(suite);
    const place = l && l !== "the building" ? `${l}${s ? `, suite ${s}` : ""}` : s ? `suite ${s}` : null;
    return n != null ? `Case #${n}${place ? ` · ${place}` : ""}` : place;
  };
  const idOf = (m: Msg, i: number, tag: string) => `${tag}:${m.id ?? m.tool_call_id ?? i}`;

  const out: Moment[] = [];
  let planned = false;
  let debriefAt = -1;
  let drafted = false;
  const weighs: { w: Weighed; at: number; key: string }[] = [];
  const notes: { key: string; at: number }[] = [];
  const tips: { suite: string; at: number }[] = [];
  ms.forEach((m, i) => {
    const k = kind(m);
    if (k === "human") {
      const t = text(m.content).trim();
      if (/^Debrief the night shift/i.test(t)) { debriefAt = i; drafted = false; }
      else if (/^Tip:/i.test(t)) tips.push({ suite: tipSuite(t), at: i });
      return;
    }
    if (k === "ai") {
      const calls = (m.tool_calls ?? []) as Call[];
      for (const c of calls) {
        if (!c?.name) continue;
        if (c.name === "record_note") notes.push({ key: keyOf(c.args?.property_id, c.args?.suite), at: i });
        if (c.name === "write_todos" && !planned && Array.isArray(c.args?.todos)) {
          const todos = (c.args!.todos as { content?: unknown }[])
            .map((t) => (typeof t?.content === "string" ? clean.full(t.content, 90) : ""))
            .filter(Boolean)
            .slice(0, 4);
          if (todos.length) {
            planned = true;
            out.push({ id: `plan:${c.id ?? m.id ?? i}`, group: "plan", at: i, kind: "plan", title: "HQ wrote its plan", where: null, todos });
          }
        }
      }
      const drafts = calls.filter((c) => c?.name === "draft_correction");
      if (drafts.length && debriefAt >= 0 && i > debriefAt && !drafted) {
        drafted = true;
        // the cases come from every draft_correction call after the debrief (they may arrive one message at a time)
        const cases: string[] = [];
        for (const x of ms.slice(debriefAt + 1)) {
          if (kind(x) !== "ai") continue;
          for (const c of (x.tool_calls ?? []) as Call[]) {
            if (c?.name !== "draft_correction") continue;
            const w = where(c.args?.property_id, c.args?.suite);
            if (w && !cases.includes(w)) cases.push(w);
          }
        }
        out.push({ id: `drafting:${drafts[0].id ?? m.id ?? i}`, group: "drafting", at: i, kind: "drafting", title: "HQ is drafting your corrections", where: null, cases });
      }
      return;
    }
    if (k !== "tool") return;
    switch (m.name) {
      case "open_case": {
        const o = parse<OpenCase>(m);
        const c = o?.cases?.[0];
        if (!o || !c) break;
        out.push({
          id: idOf(m, i, "case"), group: `case:${keyOf(o.property_id, o.suite)}`, at: i, kind: "case", title: "HQ opened a case",
          where: where(o.property_id, o.suite),
          headline: c.case === "material_conflict" ? "Records disagree" : caseWords(c.case),
          question: clean.full(c.question, 200),
          answers: (c.hypotheses ?? []).slice(0, 5).map((h) => hypWords(h.key, h.claim)),
        });
        break;
      }
      case "check_evidence": {
        const c = parse<Check>(m);
        const images = Array.isArray(c?.images) ? (c!.images as unknown[]).filter((x): x is string => typeof x === "string" && !!x) : [];
        if (!c || c.status || !images.length) break;
        if (heroPid != null && norm(c.property_id) !== heroPid) break;
        const title = c.check === "compare_captures" ? "HQ compared old and new aerials"
          : c.check === "suite_tour" ? "HQ looked inside the suite" : c.check === "look_from_above" ? "HQ looked at the aerial" : "HQ looked at the images";
        const caption = c.callout ? clean(c.callout, 110) : c.finding ? clean(c.finding, 140) : CHECK_NAME[c.check ?? ""] ?? "";
        out.push({
          id: idOf(m, i, "aerial"), group: `aerial:${keyOf(c.property_id, c.suite)}:${c.check}`, at: i, kind: "aerial", title,
          where: where(c.property_id, c.suite), images: images.slice(0, c.check === "compare_captures" ? 2 : 1).map(momentImage),
          caption, finding: c.callout && c.finding ? clean(c.finding, 140) : null,
        });
        break;
      }
      case "weigh_case": {
        const w = parse<Weighed>(m);
        if (!w?.posterior || w.status) break;
        const key = keyOf(w.property_id, w.suite);
        const prev = [...weighs].reverse().find((x) => x.key === key && (!x.w.case || !w.case || x.w.case === w.case)) ?? null;
        weighs.push({ w, at: i, key });
        const humanNow = !!w.checks_used?.includes("human_report") || !!w.trail?.some((t) => t.check === "human_report");
        const humanBefore = !!prev?.w.checks_used?.includes("human_report");
        const since = prev?.at ?? -1;
        const suite = key.split("|")[1];
        const reportBetween = notes.some((n) => n.key === key && n.at > since && n.at < i) || tips.some((t) => t.suite === suite && t.at > since && t.at < i);
        if (!((humanNow && !humanBefore) || (reportBetween && humanNow))) break;
        const lead = w.verdict?.hypothesis ?? Object.entries(w.posterior).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
        const to = w.posterior[lead];
        if (typeof to !== "number") break;
        const before = prev?.w.posterior?.[lead] ?? w.priors?.[lead];
        out.push({
          id: idOf(m, i, "odds"), group: `odds:${key}`, at: i, kind: "odds", title: "Your report moved the odds",
          where: where(w.property_id, w.suite), from: typeof before === "number" ? Math.round(before * 100) : null, to: Math.round(to * 100),
          words: ODDS_WORDS[lead] ?? hypWords(lead), label: w.verdict?.label ?? "", lead,
        });
        break;
      }
      // commit_plan: never a moment (the outcome is the director's reveal).
    }
  });
  return out;
}

export function HqMoments({ messages, busy, heroPid }: HqMomentsProps) {
  const all = useMemo(() => momentsOf(messages, heroPid), [messages, heroPid]);
  // Moments already in the thread when this mounts are history, not news: never replayed.
  const [history] = useState(() => new Set(all.map((m) => m.id)));
  const [done, setDone] = useState<readonly string[]>([]);
  const current = useMemo(() => {
    // the newest moment of each group wins (a newer odds move replaces an older one); then first come, first shown
    const newest = new Map<string, number>();
    for (const m of all) newest.set(m.group, Math.max(newest.get(m.group) ?? -1, m.at));
    return all.find((m) => !history.has(m.id) && !done.includes(m.id) && newest.get(m.group) === m.at) ?? null;
  }, [all, history, done]);
  const cid = current?.id;
  useEffect(() => {
    if (!cid) return;
    const t = setTimeout(() => setDone((d) => [...d, cid]), HOLD_MS);
    return () => clearTimeout(t);
  }, [cid]);
  if (!current) return null;
  return (
    <div className={styles.moments} aria-live="polite">
      <MomentCard key={current.id} m={current} busy={busy} />
    </div>
  );
}


function MomentCard({ m, busy }: { m: Moment; busy: boolean }) {
  return (
    <section className={styles.moment} data-kind={m.kind} style={{ animationDuration: `${HOLD_MS}ms` }}>
      {m.where && <span className={styles.momentWhere}>{placeName(plain(m.where))}</span>}
      <h3 className={styles.momentTitle}>{m.title}</h3>
      {m.kind === "plan" && (
        <ol className={styles.momentTodos}>
          {m.todos.map((t, i) => <li key={`${i}-${t}`} style={{ animationDelay: `${0.2 + i * 0.15}s` }}>{plain(t)}</li>)}
        </ol>
      )}
      {m.kind === "case" && (
        <>
          <p className={styles.momentLead}>{plain(m.question)}</p>
          {m.answers.length > 0 && (
            <p className={styles.momentSub}>Possible answers: {m.answers.map((a) => plain(a)).join(" · ")}</p>
          )}
        </>
      )}
      {m.kind === "aerial" && (
        <div className={styles.momentAerial}>
          <div className={styles.momentImgs}>
            {m.images.map((src) => (
              // eslint-disable-next-line @next/next/no-img-element -- a backend evidence file, not a static asset
              <img key={src} src={src} alt="The image HQ read" onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} />
            ))}
          </div>
          <div className={styles.momentAerialText}>
            <p className={styles.momentLead}>{plain(m.caption)}</p>
            {m.finding && <p className={styles.momentSub}>{plain(m.finding)}</p>}
            <p className={styles.momentTag}>Real image on file</p>
          </div>
        </div>
      )}
      {m.kind === "odds" && <OddsMeter m={m} />}
      {m.kind === "drafting" && (
        <>
          <p className={styles.momentLead}>
            {busy && <span className={styles.spin} aria-hidden />}One draft per case, citing the evidence and your reports. A person reviews each one; nothing is sent.
          </p>
          {m.cases.length > 0 && <p className={styles.momentSub}>{m.cases.map((c) => plain(c)).join(" · ")}</p>}
        </>
      )}
      <span className={styles.momentTimer} style={{ animationDuration: `${HOLD_MS}ms` }} aria-hidden />
    </section>
  );
}

function OddsMeter({ m }: { m: Extract<Moment, { kind: "odds" }> }) {
  const from = m.from ?? m.to;
  const d = m.to - from;
  const what = `${subjectOf(m.lead)}: ${SHORT[m.lead] ?? plain(m.words)}`;
  return (
    <div className={styles.odds2}>
      <div className={styles.oddsNums}>
        <span className={styles.oddsWords}>{what}</span>
        {m.from != null && <span className={styles.oddsFrom}>{m.from}%</span>}
        {m.from != null && <span className={styles.oddsArrow}>→</span>}
        <strong className={styles.oddsTo}>{m.to}%</strong>
      </div>
      <div className={styles.oddsTrack} style={{ "--lo": `${Math.min(from, m.to)}%`, "--span": `${Math.abs(d)}%` } as CSSProperties}>
        <span className={styles.oddsBase} />
        <span className={styles.oddsGain} data-sign={d >= 0 ? "up" : "down"} />
      </div>
      <p className={styles.momentSub}>
        {m.from != null && d !== 0 ? `${d > 0 ? "Up" : "Down"} ${Math.abs(d)} after your report` : "Your report is in the evidence"}
        {m.label ? ` · ${sureWords(m.label)}` : ""}
      </p>
    </div>
  );
}
