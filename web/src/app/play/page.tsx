"use client";

// Last Stand LA: /play (live agent) and /play?stub=1 (synthetic data, timer-driven agent).
// dusk -> scout -> night -> aftershock -> dawn, then play again without a reload.

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaseFile } from "@/components/Cases";
import { District3D, type DistrictHandle } from "@/game/District3D";
import { FortressCard, Footer, PhaseBanner, PipFeeds, RadioLog, ThreatPips, hudStyles as styles } from "@/game/Hud";
import { Pano } from "@/game/Pano";
import { SECTOR_NAME, radioLines } from "@/game/radio";
import type { Building } from "@/game/types";
import { useGame } from "@/game/useGame";
import { useReplayMode } from "@/game/useReplayMode";
import { FootGame } from "@/game/foot/FootGame";
import page from "./page.module.css";

const GREEN = "#4cc38a";
const RED = "#e5484d";
// A tip the backend's strict replay covers: sent verbatim (as "Tip: <this>"). No address in source code.
const TIP_PRESET = "I'm inside the building. The walls and columns look like concrete.";

export default function PlayPage() {
  return (
    <Suspense fallback={<main className={page.main} />}>
      <Mode />
    </Suspense>
  );
}

/** ?mode=foot: Last Stand on foot (third person). Default: the commander's map. Both take &stub=1. */
function Mode() {
  const params = useSearchParams();
  return params.get("mode") === "foot" ? <Foot /> : <Play />;
}

function Foot() {
  const params = useSearchParams();
  const game = useGame(params.get("stub") === "1");
  const replay = useReplayMode(!game.stub, game.isLoading);
  return <FootGame game={game} replay={replay} />;
}

function Play() {
  const params = useSearchParams();
  const stub = params.get("stub") === "1";
  const game = useGame(stub);
  const world = useRef<DistrictHandle>(null);
  const [panoOpen, setPanoOpen] = useState(false);
  const [tip, setTip] = useState("");
  const replay = useReplayMode(!stub, game.isLoading);
  const lines = useMemo(() => radioLines(game.messages), [game.messages]);
  const { district, phase, dossier, fortress, outcome, fallback, proposal, decision } = game;

  const byPid = useMemo(() => new Map<string, Building>((district?.buildings ?? []).map((b) => [b.pid, b])), [district]);
  const labelOf = useCallback(
    (pid?: string | null) => (!pid ? "" : byPid.get(pid)?.label ?? (fallback?.to_pid === pid ? fallback.to_label : pid)),
    [byPid, fallback],
  );

  // ---------------------------------------------------------------- 3D side effects keyed on stable strings
  useEffect(() => {
    world.current?.setRoute(fortress, fallback?.to_pid ?? null);
  }, [fortress, fallback?.to_pid]);

  const shockKey = outcome
    ? [outcome.pid_final || fortress || "", byPid.get(outcome.pid_final)?.mmi ?? byPid.get(fortress ?? "")?.mmi ?? 7, outcome.held ? 1 : 0, game.waveN, outcome.walls_roll, outcome.quake_roll].join("|")
    : "";
  useEffect(() => {
    if (!shockKey) return;
    const [pid, mmi, held] = shockKey.split("|");
    const w = world.current;
    if (!w || !pid) return;
    w.shake(Number(mmi));
    w.flash(pid, held === "1" ? GREEN : RED);
    w.setTarget(pid);
    w.focus(pid, 420);
  }, [shockKey]);

  // ---------------------------------------------------------------- actions
  const onSelect = useCallback((pid: string) => {
    world.current?.focus(pid);
    if (phase === "dusk") game.select(pid);
  }, [phase, game]);

  const scout = () => {
    if (!game.selected) return;
    world.current?.setTarget(game.selected);
    game.startScout();
  };

  const night = (n: number) => {
    const w = district?.waves.find((x) => x.n === n);
    const at = game.startNight(n);
    if (!at || !w) return;
    world.current?.clearHorde();
    world.current?.spawnWave(w, at);
    world.current?.setTarget(at);
    world.current?.focus(at, 620); // wide enough to see the horde come in
  };

  const playAgain = () => {
    game.reset();
    setTip("");
    setPanoOpen(false);
    world.current?.clearHorde();
    world.current?.setTarget(null);
    world.current?.setRoute(null, null);
  };

  // ---------------------------------------------------------------- banner, threat
  const wave = game.wave;
  const fortressB = byPid.get(fortress ?? "");
  const mmi = byPid.get(outcome?.pid_final ?? "")?.mmi ?? fortressB?.mmi ?? null;
  let title = "Dusk";
  let sub = game.selected ? "Scout it, or pick another building." : "Pick tonight's fortress: click a labelled building.";
  if (phase === "scout") {
    title = "Scouting";
    sub = game.isLoading ? `Your squads are reading the records on ${labelOf(fortress)}.` : "Scouting done. Night is coming.";
  } else if (phase === "night") {
    title = `Night ${game.waveN}`;
    sub = game.horde
      ? `Horde from the ${SECTOR_NAME[game.horde.sector] ?? game.horde.sector}, ${game.horde.size_band}, ETA ${game.horde.eta_band}.`
      : wave ? `Wave ${wave.n} is coming from the ${SECTOR_NAME[wave.sector] ?? wave.sector}.` : "The horde is coming.";
  } else if (phase === "aftershock") {
    title = "Aftershock";
    sub = mmi != null ? `Shaking at MMI ${mmi} (1994 Northridge replay).` : "The ground moves.";
  } else if (phase === "dawn") {
    title = "Dawn";
    sub = "The records disagreed. A person approves the correction.";
  }
  const sizeLevel = game.horde ? ({ small: 1, large: 2, huge: 3 } as const)[game.horde.size_band] ?? 2 : 2;
  const threat = phase === "night" ? sizeLevel : phase === "aftershock" ? (outcome?.held ? 1 : 3) : phase === "scout" ? 1 : 0;

  const badges = (
    <>
      {stub && <span className={styles.badge}>SYNTHETIC STUB</span>}
      {replay && !replay.startsWith("recording") && <span className={styles.badge}>REPLAY</span>}
    </>
  );

  // ---------------------------------------------------------------- full-screen notices
  if (!district) {
    return (
      <main className={page.main}>
        <div className={styles.notice}>
          <section className={styles.card}>
            {game.districtError ? (
              <>
                <h2 className={styles.head}>Backend not reachable</h2>
                <p>The agent server didn&apos;t answer ({game.districtError}). Start it, or <a href="/play?stub=1">try ?stub=1</a> for synthetic data.</p>
                <button type="button" className={styles.ghostBtn} onClick={game.retryDistrict}>Retry</button>
              </>
            ) : (
              <p className={styles.muted}>Loading the district…</p>
            )}
          </section>
        </div>
      </main>
    );
  }

  // ---------------------------------------------------------------- tips
  // Strict replay covers exactly one tip text, so free text is hidden while the server replays.
  const inReplay = !!replay && !replay.startsWith("recording");
  const tipRow = (
    <div className={styles.tipBox}>
      <button type="button" className={styles.chip2} disabled={game.isLoading} onClick={() => game.sendTip(TIP_PRESET)}>
        Tip: “the walls are poured concrete, with concrete columns”
      </button>
      {!inReplay && (
        <form
          className={styles.tip}
          onSubmit={(e) => {
            e.preventDefault();
            game.sendTip(tip);
            setTip("");
          }}
        >
          <input value={tip} onChange={(e) => setTip(e.target.value)} placeholder="Or type your own tip about this building" aria-label="Tip" />
          <button type="submit" className={styles.ghostBtn} disabled={!tip.trim() || game.isLoading}>Send tip</button>
        </form>
      )}
    </div>
  );

  // ---------------------------------------------------------------- action bar
  const runTo = fallback?.to_pid ?? proposal?.to_pid;
  const dossierObj = dossier && typeof dossier === "object" ? dossier : null;
  let actions: React.ReactNode = null;
  if (phase === "dusk") {
    actions = (
      <>
        <p>{game.selected ? `${labelOf(game.selected)}${dossierObj ? "" : " (no dossier yet)"}` : "Hover a building for its facts on record. Click to pick."}</p>
        <div className={styles.btnRow}>
          <button type="button" className={styles.btn} disabled={!dossierObj || game.isLoading} onClick={scout}>
            {game.selected ? `Scout ${labelOf(game.selected)}` : "Scout"}
          </button>
        </div>
      </>
    );
  } else if (phase === "scout") {
    actions = (
      <>
        <p>{game.isLoading ? "Squads are out. Listen to the radio." : "The squads are back."}</p>
        <div className={styles.btnRow}>
          <button type="button" className={styles.btn} disabled={!game.scoutDone || !district.waves.length} onClick={() => night(district.waves[0]?.n ?? 1)}>
            Night falls
          </button>
        </div>
      </>
    );
  } else if (phase === "night") {
    const proposed = proposal?.action;
    const canAnswer = !decision && (!!proposal || !game.isLoading);
    actions = (
      <>
        <p>
          {decision
            ? `Orders sent: ${decision.action === "run" ? `RUN to ${labelOf(decision.to_pid)}` : decision.action === "hold" ? "HOLD" : "no orders, holding"}. Waiting for the roll…`
            : proposal
              ? `HQ proposes: ${proposal.action === "run" ? `RUN to ${labelOf(proposal.to_pid ?? runTo)}` : `HOLD ${labelOf(proposal.pid)}`}. Your call.`
              : game.isLoading ? "HQ is weighing HOLD or RUN…" : "HQ didn't call it. Your call."}
        </p>
        <div className={styles.btnRow}>
          <button type="button" className={styles.btn} data-proposed={proposed === "hold"} disabled={!canAnswer} onClick={() => game.decide("hold")}>Hold</button>
          <button type="button" className={styles.btn} data-proposed={proposed === "run"} disabled={!canAnswer || !runTo} onClick={() => game.decide("run")}>
            Run{runTo ? ` to ${labelOf(runTo)}` : ""}
          </button>
          {proposal && <button type="button" className={styles.ghostBtn} disabled={!canAnswer} onClick={() => game.decide("none")}>No orders</button>}
        </div>
      </>
    );
  } else if (phase === "aftershock" && outcome) {
    const next = district.waves.find((w) => w.n === game.waveN + 1);
    actions = (
      <>
        <p className={`${styles.outcome} ${styles.head}`} data-held={outcome.held}>{outcome.held ? "The walls held" : "The walls gave way"}</p>
        <p className={styles.muted}>
          {labelOf(outcome.pid_final)} · walls {outcome.walls} vs roll {outcome.walls_roll} · quake {outcome.quake} vs roll {outcome.quake_roll}
        </p>
        {outcome.why && <p>{outcome.why}</p>}
        {tipRow}
        <div className={styles.btnRow}>
          {next && <button type="button" className={`${styles.btn} ${styles.btnAlt}`} disabled={game.isLoading} onClick={() => night(next.n)}>Next wave</button>}
          <button type="button" className={styles.btn} onClick={game.goDawn}>Dawn</button>
        </div>
      </>
    );
  } else if (phase === "dawn") {
    actions = (
      <>
        {tipRow}
        <div className={styles.btnRow}>
          <button type="button" className={styles.btn} disabled={game.isLoading} onClick={playAgain}>Play again</button>
        </div>
      </>
    );
  }

  const pano = dossierObj?.images?.pano ?? [];
  const caseShown = game.messages.length > 0;
  return (
    <main className={page.main}>
      <District3D
        ref={world}
        district={district}
        selected={game.selected}
        fortress={fortress}
        conflictMaterials={game.conflictMaterials}
        onSelect={onSelect}
      />
      <div className={styles.hud}>
        <PhaseBanner title={title} sub={sub} badges={badges} />
        <div className={styles.left}>
          <FortressCard
            dossier={dossier}
            label={labelOf(game.focusPid)}
            onStepInside={pano.length ? () => setPanoOpen(true) : undefined}
          />
        </div>
        <div className={styles.right}>
          <ThreatPips level={threat} />
          <RadioLog lines={lines} busy={game.isLoading} />
          {phase === "dawn" ? (
            <div className={styles.caseWrap}>
              {caseShown && <CaseFile messages={game.messages} loading={game.isLoading} />}
            </div>
          ) : (
            <PipFeeds dossier={dossier} />
          )}
        </div>
        {actions && (
          <div className={styles.actions}>
            {actions}
            {game.decideError && <p className={styles.error}>{game.decideError}</p>}
            {game.agentError && !game.isLoading && (
              <p className={styles.error}>The run stopped with an error ({game.agentError}). Try again{stub ? "" : ", or use ?stub=1"}.</p>
            )}
          </div>
        )}
        <Footer />
      </div>
      {panoOpen && pano.length > 0 && <Pano faces={pano} title={dossierObj?.label ?? ""} onClose={() => setPanoOpen(false)} />}
    </main>
  );
}
