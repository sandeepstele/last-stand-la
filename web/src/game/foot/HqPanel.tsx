"use client";
// OWNER: builder F (HQ panel). Keep the props type.
// "The agent at work": its own todo list, the four squads, the evidence it chose, the case odds. All from the stream.
// Parsing is pure and memoised (hqModel.ts); nothing here computes a number, it only shows the tools' numbers.

import { useMemo } from "react";
import { hqModel, type BriefCase, type BriefView, type CaseView, type EvidenceView, type HqView, type SquadView } from "./hqModel";
import styles from "./hq.module.css";

export type HqProps = {
  messages: readonly unknown[]; // the laststand thread (LangChain messages, as in useGame)
  busy: boolean; // a run is in progress
  heroPid: string | null; // the building being scouted
  compact: boolean; // true while walking (small), false when there's room (inside, night decision)
};

const MAX_CARDS = 4;

export function HqPanel({ messages, busy, heroPid, compact }: HqProps) {
  const view = useMemo(() => hqModel(messages, heroPid, busy), [messages, heroPid, busy]);
  return (
    <section
      className={styles.panel}
      data-compact={compact}
      data-busy={busy}
      aria-label="HQ, the AI commander: its plan, its squads, the evidence it chose and the odds"
    >
      <Header view={view} busy={busy} />
      {compact ? <Compact view={view} busy={busy} /> : <Full view={view} busy={busy} />}
    </section>
  );
}

function Header({ view, busy }: { view: HqView; busy: boolean }) {
  return (
    <header className={styles.head}>
      <div className={styles.titleRow}>
        <span className={styles.dot} data-live={busy} data-wait={!!view.waiting} aria-hidden />
        <span className={styles.title}>HQ · AI commander</span>
        <span className={styles.sub}>(LangChain deep agent)</span>
      </div>
      <div className={styles.status} data-busy={busy && !view.waiting} aria-live="polite">
        {view.status}
      </div>
    </header>
  );
}

// ---------------------------------------------------------------- compact: while walking or fighting

function Compact({ view, busy }: { view: HqView; busy: boolean }) {
  const c = view.caseView;
  // one strip: the squads while they work (or when there is no night brief), else tonight's cases
  const squadsLive = view.squads.some((s) => s.state === "working");
  return (
    <>
      {view.brief && !squadsLive ? <BriefStrip brief={view.brief} busy={busy} /> : <Squads squads={view.squads} compact />}
      {c && <CompactOdds c={c} />}
      {view.waiting ? (
        <div className={styles.now} data-wait>
          <span>HQ is waiting for your call:</span>
          <span><b>HOLD</b> or <b>RUN</b></span>
        </div>
      ) : view.current ? (
        <div className={styles.now}>
          <span className={styles.spin} aria-hidden />
          <span>{view.current.text}</span>
        </div>
      ) : null}
    </>
  );
}

function CompactOdds({ c }: { c: CaseView }) {
  const lead = c.bars.find((b) => b.lead) ?? c.bars[0];
  if (!lead) return null;
  const label = c.verdict?.label ?? "starting odds";
  return (
    <div className={styles.odds} title={c.question}>
      <span className={styles.label} data-label={c.verdict?.label}>{label}</span>
      <span className={styles.words}>
        {lead.words}
        {c.delta && (
          <span key={c.delta.key} className={styles.delta} data-sign={c.delta.pts > 0 ? "up" : "down"} style={{ marginLeft: 6 }}>
            {c.delta.pts > 0 ? "+" : "−"}{Math.abs(c.delta.pts)}
          </span>
        )}
      </span>
      <strong key={lead.pct} className={styles.pct}>{lead.pct}%</strong>
      <span className={styles.track}><span className={styles.fill} style={{ width: `${lead.pct}%` }} /></span>
    </div>
  );
}

// ---------------------------------------------------------------- full: inside, or the night decision

function Full({ view, busy }: { view: HqView; busy: boolean }) {
  const shown = view.evidence.slice(0, MAX_CARDS);
  const more = view.evidence.length - shown.length;
  return (
    <>
      {view.waiting && (
        <div className={styles.waiting} role="status">
          <strong>HQ is waiting for your call: HOLD or RUN</strong>
          {view.waiting.proposal && <span>{view.waiting.proposal}. You decide.</span>}
        </div>
      )}

      {view.brief && <Brief brief={view.brief} busy={busy} hasOdds={!!view.caseView?.weighed} />}

      {(view.squadsSent || !view.brief) && (
        <div className={styles.section}>
          <h4 className={styles.h}>Squads <em>· subagents, sent in parallel</em></h4>
          {/* once every squad has reported and the case is open, their findings are on the radio: chips only */}
          <Squads squads={view.squads} compact={!!view.caseView && view.squads.every((s) => s.state !== "working")} />
        </div>
      )}

      {(view.todos.length > 0 || view.started) && (
        <div className={styles.section}>
          <h4 className={styles.h}>HQ&apos;s plan <em>(written by the agent)</em></h4>
          {view.todos.length ? (
            <ol className={styles.todos}>
              {view.todos.map((t, i) => (
                <li key={`${i}-${t.text}`} className={styles.todo} data-status={t.status}>
                  <span className={styles.tick} aria-hidden />
                  <span>{t.text}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className={styles.muted}>No plan written yet.</p>
          )}
        </div>
      )}

      {view.caseView && <CaseBlock c={view.caseView} />}
      {view.noCase && <p className={styles.muted}>The records agree on this building: no case to open.</p>}

      {shown.length > 0 && (
        <div className={styles.section}>
          <h4 className={styles.h}>
            Evidence HQ chose
            {view.caseView?.chose && <em> · {view.caseView.chose.ran} of {view.caseView.chose.of} checks</em>}
          </h4>
          <ul className={styles.cards}>
            {shown.map((e) => <EvidenceCard key={e.id} e={e} />)}
          </ul>
          {more > 0 && <p className={styles.muted}>+{more} earlier</p>}
        </div>
      )}

      {!view.started && <p className={styles.muted}>HQ is standing by for orders.</p>}
    </>
  );
}

function Squads({ squads, compact = false }: { squads: SquadView[]; compact?: boolean }) {
  return (
    <div className={styles.squads} data-compact={compact}>
      {squads.map((s) => (
        <div key={s.key} className={styles.squad} data-state={s.state} title={s.finding ?? undefined}>
          <span className={styles.chip}>
            <span className={styles.icon} aria-hidden />
            {s.label}
          </span>
          {!compact && (
            s.state === "done" ? <span className={styles.finding}>{s.finding}</span>
            : <span className={styles.squadNote}>{s.state === "working" ? "working…" : s.state === "silent" ? "no report" : "not sent"}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function CaseBlock({ c }: { c: CaseView }) {
  return (
    <div className={styles.section} title={c.question || undefined}>
      <h4 className={styles.h}>Now weighing <em>· {c.title}</em></h4>
      {/* in the night shift the brief row already says what the case asks; the question stays as a tooltip */}
      {!c.inBrief && c.question && <p className={styles.question}>{c.question}</p>}
      <ul className={styles.bars}>
        {c.bars.map((b) => (
          <li key={b.key} className={styles.bar} data-lead={b.lead}>
            <span className={styles.words}>{b.words}</span>
            <span className={styles.track}><span className={styles.fill} style={{ width: `${b.pct}%` }} /></span>
            <strong key={b.pct} className={styles.pct}>{b.pct}%</strong>
          </li>
        ))}
      </ul>
      <div className={styles.verdict}>
        {c.verdict ? (
          <>
            <span className={styles.label} data-label={c.verdict.label}>{c.verdict.label}</span>
            {c.delta ? (
              // the top bar already names the lead; this row says how far the latest weighing moved it, and why
              <span key={c.delta.key} className={styles.delta} data-sign={c.delta.pts > 0 ? "up" : "down"} title={c.verdict.text ?? undefined}>
                {c.delta.pts > 0 ? "+" : "−"}{Math.abs(c.delta.pts)} {c.delta.why}
              </span>
            ) : (
              <span title={c.verdict.text ?? undefined}>
                {c.verdict.label === "unresolved" ? "the evidence doesn't separate them yet" : c.verdict.words}
              </span>
            )}
          </>
        ) : (
          <span>Starting odds, before any evidence. HQ is choosing checks.</span>
        )}
      </div>
    </div>
  );
}

function EvidenceCard({ e }: { e: EvidenceView }) {
  return (
    <li className={styles.card} data-pending={e.pending} data-vision={e.vision} data-human={e.human}>
      <div className={styles.cardHead}>
        {e.pending && <span className={styles.spin} aria-hidden />}
        <span>{e.name}</span>
        {e.pending ? <small>checking</small> : (
          <span className={styles.effects}>
            {e.effects.map((x) => <span key={x.text} data-sign={x.sign}>{x.text}</span>)}
            {!e.effects.length && !e.human && <span>no shift</span>}
          </span>
        )}
      </div>
      {e.finding && <p>{e.finding}</p>}
    </li>
  );
}

// ---------------------------------------------------------------- tonight's cases (the night shift brief)

const STATE_WORDS: Record<BriefCase["state"], string> = { open: "open", checking: "being checked", report: "report logged", weighed: "weighed" };

function Brief({ brief, busy, hasOdds }: { brief: BriefView; busy: boolean; hasOdds: boolean }) {
  return (
    <div className={styles.section}>
      <h4 className={styles.h}>
        Tonight&apos;s cases <em>· from CoStar&apos;s open-case queue{brief.total != null ? ` (${brief.total})` : ""}</em>
      </h4>
      {brief.cases.length ? (
        <ul className={styles.brief}>
          {brief.cases.map((c) => (
            <li key={c.id} className={styles.case} data-active={c.active} data-state={c.state} title={c.question ?? undefined}>
              <div className={styles.caseTop}>
                <strong>{c.type}</strong>
                <span className={styles.state} data-state={c.state}>
                  {c.state === "checking" && c.active && busy && <span className={styles.spin} aria-hidden />}
                  {STATE_WORDS[c.state]}
                </span>
              </div>
              <div className={styles.caseWhere}>
                {c.n != null && <b>Case #{c.n}{brief.total != null ? ` of ${brief.total}` : ""}</b>}
                {c.n != null && " · "}
                {c.where}
                {c.stakes && <span> · {c.stakes}</span>}
              </div>
              {/* the active case's odds are drawn in full just below: its row keeps the state only */}
              {c.verdict && !(c.active && hasOdds) && (
                <div className={styles.caseVerdict}>
                  <span className={styles.label} data-label={c.verdict.label}>{c.verdict.label}</span>
                  <span className={styles.caseLead}>{c.verdict.label === "unresolved" ? "not settled yet" : c.verdict.words}</span>
                  <strong key={c.verdict.pct}>{c.verdict.pct}%</strong>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.muted}>{brief.loading ? "HQ is reading the queue…" : "No open cases in the queue tonight."}</p>
      )}
    </div>
  );
}

function BriefStrip({ brief, busy }: { brief: BriefView; busy: boolean }) {
  return (
    <div className={styles.strip}>
      {!brief.cases.length && (
        <span className={styles.pill}>
          {brief.loading ? <span className={styles.spin} aria-hidden /> : null}
          <em>{brief.loading ? "reading tonight's cases" : "no open cases tonight"}</em>
        </span>
      )}
      {brief.cases.map((c) => (
        <span key={c.id} className={styles.pill} data-active={c.active} data-state={c.state} title={`${c.type} · ${c.where}`}>
          {c.state === "checking" && c.active && busy ? <span className={styles.spin} aria-hidden /> : <span className={styles.icon} aria-hidden />}
          {c.n != null ? `#${c.n} ` : ""}{c.short}
          <em>{c.verdict && c.state === "weighed" ? `${c.verdict.label} ${c.verdict.pct}%` : STATE_WORDS[c.state]}</em>
        </span>
      ))}
    </div>
  );
}
