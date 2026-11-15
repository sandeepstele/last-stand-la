"use client";
// The dawn SHIFT REPORT: what the simulated aftershock did to each building Bob tagged, whether the tag was the one
// that damage calls for, who it kept safe, and Bob's calls from outside. Every number is read from the server's
// `shift_report` tool result (code-computed); this file only lays it out. A game outcome, never an engineering one.

import type { DamageState, ShiftBuilding, ShiftReport as Report, Tag } from "../useGame";
import { TAG_COLOR } from "./DeskView";
import s from "./ShiftReport.module.css";

const STATES: DamageState[] = ["none", "slight", "moderate", "extensive", "complete"];
/** The ATC-20 posting each damage state calls for (mirrors the report's `rule`; used only to colour the odds bands). */
const BAND_TAG: Record<DamageState, Tag> = { none: "green", slight: "green", moderate: "yellow", extensive: "red", complete: "red" };
const TAG_WORDS: Record<Tag, string> = { green: "safe to occupy", yellow: "limited entry", red: "unsafe" };
export const FALLBACK_DISCLAIMER = "Game outcome, not an engineering assessment.";

/** People counts: whole numbers as they are, the HAZUS "hurt" estimate keeps its one decimal. */
const n = (v: number | undefined) => (v == null ? "–" : Number.isInteger(v) ? v.toLocaleString("en-US") : v.toFixed(1));
const pct = (v: number) => `${Math.round(v * 100)}%`;

export function TagChip({ tag, big }: { tag: Tag | null | undefined; big?: boolean }) {
  if (!tag) return <span className={s.chip} data-none="true">no tag</span>;
  return (
    <span className={s.chip} data-big={big} style={{ background: TAG_COLOR[tag] }} title={`Simulated placard: ${TAG_WORDS[tag]}. Game outcome, not an engineering assessment.`}>
      {tag.toUpperCase()} · sim
    </span>
  );
}

/** The aftershock's five damage bands (widths = the report's odds) with the roll marked: a cumulative draw in band order. */
function OddsBar({ odds, roll, damage }: { odds: Partial<Record<DamageState, number>>; roll?: number; damage?: DamageState }) {
  const vals = STATES.map((k) => Math.max(0, odds[k] ?? 0));
  const total = vals.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  // Normalised so the bands fill the bar; the roll scales the same way, so it lands in the band the server picked.
  const at = roll == null ? null : Math.min(0.997, Math.max(0.003, roll / Math.max(total, 1e-9)));
  return (
    <div className={s.odds} aria-label={`Aftershock odds: ${STATES.map((k, i) => `${k} ${pct(vals[i])}`).join(", ")}${roll != null ? `; roll ${roll}` : ""}`}>
      <div className={s.bands}>
        {STATES.map((k, i) => (
          <span key={k} data-band={k} data-hit={k === damage} style={{ flexGrow: vals[i], background: TAG_COLOR[BAND_TAG[k]] }} title={`${k}: ${pct(vals[i])}`} />
        ))}
        {at != null && <i className={s.marker} style={{ left: `${at * 100}%` }} />}
      </div>
      <div className={s.bandLabels} aria-hidden="true">
        {STATES.map((k, i) => (
          <span key={k} data-hit={k === damage} style={{ flexGrow: vals[i] }}>
            {k} <b>{pct(vals[i])}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

/** "On average, each tag would have…": the report's `expected` exposed / displaced per tag, Bob's tag highlighted. */
function ExpectedRow({ expected, tag }: { expected: NonNullable<ShiftBuilding["expected"]>; tag?: Tag | null }) {
  const tags = (["green", "yellow", "red"] as Tag[]).filter((t) => expected[t]);
  if (!tags.length) return null;
  return (
    <div className={s.expected}>
      <span className={s.expHead}>On average, each tag would have…</span>
      <div className={s.expCells}>
        {tags.map((t) => (
          <span key={t} className={s.expCell} data-mine={t === tag} style={{ ["--tag" as string]: TAG_COLOR[t] }}>
            <i>{t}</i>
            <span>
              <b>{n(expected[t]?.exposed)}</b> exposed
            </span>
            <span>
              <b>{n(expected[t]?.displaced)}</b> displaced
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

function BuildingRow({ b, precall, i }: { b: ShiftBuilding; precall?: Tag; i: number }) {
  const called = precall != null && b.tag != null && precall === b.tag;
  return (
    <li className={s.row} style={{ animationDelay: `${0.5 + i * 0.12}s` }}>
      <div className={s.rowTop}>
        <b className={s.name}>{b.label ?? b.pid}</b>
        <span className={s.shockText}>
          aftershock: <b>{b.damage ? `${b.damage} damage` : b.outcome ?? "–"}</b>
          {b.roll != null && <em> · roll {b.roll.toFixed(3)}</em>}
        </span>
      </div>
      {b.odds && <OddsBar odds={b.odds} roll={b.roll} damage={b.damage} />}
      <div className={s.tagLine}>
        <span className={s.posted}>Bob posted</span>
        <TagChip tag={b.tag} />
        {b.right_tag && (
          <>
            <span className={s.posted}>· the damage called for</span>
            <TagChip tag={b.right_tag} />
          </>
        )}
        {b.tag_right != null && (
          <span className={s.verdict} data-ok={b.tag_right}>
            {b.tag_right ? "✓ right tag" : "✗ wrong tag"}
          </span>
        )}
      </div>
      <div className={s.people}>
        <span><b>{n(b.people_safe)}</b> safe</span>
        {b.people_exposed != null && <span data-bad={b.people_exposed > 0}><b>{n(b.people_exposed)}</b> exposed</span>}
        <span data-bad={(b.people_hurt ?? 0) > 0}><b>{n(b.people_hurt)}</b> hurt</span>
        <span data-bad={(b.people_displaced ?? 0) > 0}><b>{n(b.people_displaced)}</b> displaced</span>
        <span className={s.stake}>of {n(b.people_at_stake)} at stake</span>
      </div>
      {b.expected && <ExpectedRow expected={b.expected} tag={b.tag} />}
      {precall && (
        <p className={s.precall} data-hit={called}>
          Your call from outside: <TagChip tag={precall} />{" "}
          {called ? <strong>Called it from outside.</strong> : b.tag ? <>the final tag was {b.tag.toUpperCase()}.</> : <>no final tag.</>}
        </p>
      )}
      {b.why && <p className={s.why}>{b.why}</p>}
    </li>
  );
}

export type ShiftReportProps = {
  report: Report | null | undefined;
  precalls?: Record<string, Tag>;
  loading: boolean;
  score?: { points: number; rank: string } | null; // computed by the game from this report
};

export function ShiftReportView({ report, precalls = {}, loading, score }: ShiftReportProps) {
  const disclaimer = report?.disclaimer || FALLBACK_DISCLAIMER;
  if (!report) {
    return (
      <section className={s.report} aria-label="Shift report" data-empty="true">
        <header className={s.head}>
          <h2>Shift report</h2>
          <span className={s.simNote}>Simulated quake</span>
        </header>
        <p className={s.writing}>
          {loading ? "HQ is writing the shift report…" : "No shift report came back from HQ."}
        </p>
        <p className={s.disclaimer}>{disclaimer}</p>
      </section>
    );
  }
  const rows = report.buildings ?? [];
  const inReport = new Set(rows.map((b) => b.pid));
  const graded = Object.entries(precalls).filter(([pid]) => inReport.has(pid));
  const calledIt = graded.filter(([pid, t]) => rows.find((b) => b.pid === pid)?.tag === t).length;
  const loose = Object.entries(precalls).filter(([pid]) => !inReport.has(pid));
  const records = report.records ?? [];
  return (
    <section className={s.report} aria-label="Shift report">
      <header className={s.head}>
        <h2>Shift report</h2>
        <span className={s.simNote}>Simulated quake and aftershock · game</span>
      </header>

      <div className={s.headline}>
        <div className={s.big}>
          <strong>{n(report.people_safe)}</strong>
          <span>of {n(report.people_at_stake)} people kept safe</span>
        </div>
        <dl className={s.stats}>
          <div data-bad={(report.people_hurt ?? 0) > 0}>
            <dt>people hurt</dt>
            <dd>{n(report.people_hurt)}</dd>
          </div>
          <div data-bad={(report.people_displaced ?? 0) > 0}>
            <dt>displaced</dt>
            <dd>{n(report.people_displaced)}</dd>
          </div>
          <div>
            <dt>tags right</dt>
            <dd>
              {n(report.tags_right)} of {n(report.tags ?? rows.length)}
            </dd>
          </div>
          <div title="Correction drafts a second agent reviewed and agreed with">
            <dt>records fixed</dt>
            <dd>
              {n(report.records_fixed)}
              {records.length > 0 && <small> of {records.length} drafted</small>}
            </dd>
          </div>
          {graded.length > 0 && (
            <div>
              <dt>called it from outside</dt>
              <dd>
                {calledIt} of {graded.length}
              </dd>
            </div>
          )}
        </dl>
        {report.rule && <p className={s.rule}>{report.rule}</p>}
      </div>

      <ol className={s.rows}>
        {rows.map((b, i) => (
          <BuildingRow key={b.pid} b={b} i={i} precall={precalls[b.pid]} />
        ))}
        {!rows.length && <li className={s.empty}>No building was tagged before the aftershock.</li>}
        {loose.map(([pid, t]) => (
          <li key={pid} className={s.loose}>
            You called <TagChip tag={t} /> from outside on a building that was never tagged, so the aftershock didn&apos;t grade it.
          </li>
        ))}
        {records.length > 0 && (
          <li className={s.records}>
            <span>Records drafted tonight</span>
            {records.map((r, i) => (
              <em key={`${i}-${r.label}`}>
                {r.label ?? "a record"}
                {r.verdict ? ` · ${r.verdict}` : ""}
                {r.critic ? ` · ${r.critic === "reviewed" ? "second agent reviewed" : r.critic}` : ""}
              </em>
            ))}
          </li>
        )}
      </ol>

      <footer className={s.foot}>
        {score && (
          <div className={s.score}>
            <span className={s.rank}>
              <small>Rank</small>
              <strong>{score.rank}</strong>
            </span>
            <span className={s.points}>
              <strong>{score.points.toLocaleString("en-US")}</strong> points
            </span>
            <span className={s.from}>
              from {n(report.people_safe)} people kept safe, {n(report.records_fixed)} record{report.records_fixed === 1 ? "" : "s"} fixed
              {graded.length > 0 ? `, ${calledIt} called from outside` : ""} · tags right {n(report.tags_right)} of {n(report.tags ?? rows.length)}
            </span>
          </div>
        )}
        <p className={s.disclaimer}>{disclaimer}</p>
      </footer>
    </section>
  );
}
