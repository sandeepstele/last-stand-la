"use client";
// Keep the props type. HQ, the AI commander, always on screen: what it is doing right now, and the case odds in words.
// Squads and its plan show only while it works. Parsing is pure and memoised (hqModel.ts); nothing here computes a
// number, it only words the tools' numbers.

import { useMemo } from "react";
import { kind, type Msg } from "../radio";
import { hqModel, type BriefView, type CaseView, type EvidenceView, type HqView, type SquadView } from "./hqModel";
import { cap, fmtDates, moveWords, oddsLine, placeName, plain, subjectOf, sureWords } from "./copy";
import styles from "./hq.module.css";
import { DraftList } from "./hqDrafts";

export type HqProps = {
  messages: readonly unknown[]; // the laststand thread (LangChain messages, as in useGame)
  busy: boolean; // a run is in progress
  heroPid: string | null; // the building being scouted
  compact: boolean; // true while walking or fighting (one strip), false when there's room (the night call, the briefing)
};

const MAX_CARDS = 3;

/** "HQ proposes RUN to 755 Spring St" -> "Proposes a run to 755 Spring St." (the header already says HQ). */
const proposalWords = (p: string) =>
  /^HQ proposes RUN to (.+)$/.test(p) ? p.replace(/^HQ proposes RUN to (.+)$/, "Proposes a run to $1.")
  : /^HQ proposes HOLD/.test(p) ? "Proposes holding here."
  : "Hold or run?";

/** True when the agent's newest plan was written after the newest order it got (else its in-progress item is stale). */
function planIsFresh(messages: readonly unknown[]): boolean {
  let human = -1;
  let todos = -1;
  messages.forEach((raw, i) => {
    const m = raw as Msg;
    const k = kind(m);
    if (k === "human") human = i;
    else if (k === "ai" && (m.tool_calls ?? []).some((c) => c?.name === "write_todos")) todos = i;
  });
  return todos > human;
}

export function HqPanel({ messages, busy, heroPid, compact }: HqProps) {
  const view = useMemo(() => hqModel(messages, heroPid, busy), [messages, heroPid, busy]);
  const fresh = useMemo(() => planIsFresh(messages), [messages]);
  const working = view.squads.some((s) => s.state === "working");
  return (
    <section className={styles.panel} data-compact={compact} data-busy={busy} aria-label="HQ, the AI commander: what it is doing now">
      <header className={styles.head}>
        <span className={styles.dot} data-live={busy} data-wait={!!view.waiting} aria-hidden />
        <b className={styles.who}>HQ</b>
        <span className={styles.status} aria-live="polite">{cap(view.status)}</span>
      </header>
      {view.waiting && <p className={styles.wait}>{proposalWords(view.waiting.proposal)}</p>}
      {view.drafts.drafting && !!view.drafts.expected && (
        <p className={styles.line}>
          {view.drafts.done} of {view.drafts.expected} drafted
        </p>
      )}
      {/* its own plan item, only while it is working on it and the plan is current: never a stale to-do */}
      {compact && busy && fresh && view.current && !view.waiting && !view.drafts.drafting && (
        <p className={styles.line}><span className={styles.k}>Now</span> {plain(view.current.text)}</p>
      )}
      {working && <Squads squads={view.squads} />}
      {view.caseView && (compact || !view.caseView.bars.length ? <OddsLine c={view.caseView} /> : <CaseBlock c={view.caseView} />)}
      {view.noCase && <p className={styles.muted}>The records agree on this building. No case to open.</p>}
      {!compact && <Full view={view} busy={busy} fresh={fresh} />}
    </section>
  );
}

/** "Walls: concrete, 54%" and how the latest weighing moved it, in words; a thin bar. */
function OddsLine({ c }: { c: CaseView }) {
  const lead = c.bars.find((b) => b.lead) ?? c.bars[0];
  if (!lead) return null;
  return (
    <div className={styles.odds} title={c.question}>
      <span key={lead.pct} className={styles.oddsText}>
        {oddsLine(lead.key, lead.pct, c.verdict?.label)}
        {!c.weighed && <span className={styles.muted}> · starting odds</span>}
      </span>
      {c.delta && <span key={c.delta.key} className={styles.move}>{moveWords(c.delta.pts, c.delta.why)}</span>}
      <span className={styles.track}><span className={styles.fill} style={{ width: `${lead.pct}%` }} /></span>
    </div>
  );
}

function CaseBlock({ c }: { c: CaseView }) {
  const lead = c.bars.find((b) => b.lead) ?? c.bars[0];
  return (
    <div className={styles.section} title={c.question || undefined}>
      <h4 className={styles.h}>
        {subjectOf(lead?.key ?? "")}
        {c.inBrief && <span> · {placeName(plain(c.title.replace(/^#/, "Case #")))}</span>}
      </h4>
      <ul className={styles.bars}>
        {c.bars.map((b) => (
          <li key={b.key} className={styles.bar} data-lead={b.lead}>
            <span className={styles.words}>{cap(plain(b.words))}</span>
            <span className={styles.track}><span className={styles.fill} style={{ width: `${b.pct}%` }} /></span>
            <strong key={b.pct} className={styles.pct}>{b.pct}%</strong>
          </li>
        ))}
      </ul>
      <p className={styles.verdict}>
        {c.verdict ? cap(sureWords(c.verdict.label)) : "Starting odds, before any evidence"}
        {c.delta && <span key={c.delta.key} className={styles.move}> · {moveWords(c.delta.pts, c.delta.why)}</span>}
      </p>
    </div>
  );
}

function Squads({ squads }: { squads: SquadView[] }) {
  const sent = squads.filter((s) => s.state !== "idle");
  return (
    <p className={styles.squads}>
      {sent.map((s) => (
        <span key={s.key} data-state={s.state} title={s.finding ?? undefined}>
          {s.state === "you" ? "You" : s.label}
          <i>{s.state === "working" ? "…" : s.state === "silent" ? " –" : " ✓"}</i>
        </span>
      ))}
    </p>
  );
}

// ---------------------------------------------------------------- full: the night call, the briefing
function Full({ view, busy, fresh }: { view: HqView; busy: boolean; fresh: boolean }) {
  const shown = view.evidence.slice(0, MAX_CARDS);
  return (
    <>
      {view.brief && <Brief brief={view.brief} busy={busy} />}
      <DraftList view={view.drafts} variant="panel" />
      {shown.length > 0 && (
        <div className={styles.section}>
          <h4 className={styles.h}>
            Evidence HQ chose
            {view.caseView?.chose && <span> · {view.caseView.chose.ran} of {view.caseView.chose.of} checks</span>}
          </h4>
          <ul className={styles.cards}>
            {shown.map((e, i) => <EvidenceRow key={e.id} e={e} why={i === 0} />)}
          </ul>
        </div>
      )}
      {busy && fresh && view.todos.length > 0 && !view.drafts.drafting && (
        <div className={styles.section}>
          <h4 className={styles.h}>HQ&apos;s plan</h4>
          <ol className={styles.todos}>
            {view.todos.map((t, i) => (
              <li key={`${i}-${t.text}`} data-status={t.status}>
                <i aria-hidden>{t.status === "completed" ? "✓" : t.status === "in_progress" ? "›" : "·"}</i>
                {plain(t.text)}
              </li>
            ))}
          </ol>
        </div>
      )}
    </>
  );
}

function EvidenceRow({ e, why }: { e: EvidenceView; why: boolean }) {
  return (
    <li className={styles.card} data-pending={e.pending}>
      <div className={styles.cardHead}>
        <span>{cap(plain(e.name).replace(/^Vision: /, ""))}</span>
        <span className={styles.effects}>
          {e.pending ? "checking…" : e.effects.length ? e.effects.map((x) => plain(x.text).replace("city's concrete", "concrete")).join(", ") : e.human ? "" : "no change"}
        </span>
      </div>
      {e.finding && <p>{plain(fmtDates(e.finding))}</p>}
      {why && e.why && <p className={styles.why}>Why: {plain(e.why)}</p>}
    </li>
  );
}

// ---------------------------------------------------------------- tonight's cases (the night shift brief)
const STATE_WORDS: Record<string, string> = {
  open: "open", checking: "checking…", report: "your report logged", weighed: "weighed", drafting: "drafting…", drafted: "drafted",
};

function Brief({ brief, busy }: { brief: BriefView; busy: boolean }) {
  return (
    <div className={styles.section}>
      <h4 className={styles.h}>
        Tonight&apos;s cases{brief.total != null && <span> · from {brief.total} open in the queue</span>}
      </h4>
      {brief.cases.length ? (
        <ul className={styles.brief}>
          {brief.cases.map((c) => (
            <li key={c.id} data-active={c.active} title={c.question ?? undefined}>
              <span className={styles.caseWhere}>
                {c.n != null ? `Case #${c.n} · ` : ""}
                {placeName(plain(c.where))}
              </span>
              <span className={styles.state} data-busy={busy && (c.state === "checking" || c.state === "drafting")}>
                {c.verdict && (c.state === "weighed" || c.state === "drafted")
                  ? `${cap(plain(c.verdict.words))}, ${c.verdict.pct}%`
                  : STATE_WORDS[c.state]}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.muted}>{brief.loading ? "Reading the queue…" : "No open cases in the queue tonight."}</p>
      )}
    </div>
  );
}
