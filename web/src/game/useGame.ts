"use client";

// The game state machine plus data loading.
//   dusk -> (pick a building) -> scout (run 1 "Scout property <pid>")
//   -> night (run 2 "Wave <n> is coming from the <sector>": horde_status, find_fallback, the commit_plan interrupt)
//   -> aftershock (the resolve object) -> dawn (case file; run 3 "Tip: <text>": record_note + weigh_case)
// Real mode talks to /api/game/* and the laststand graph; ?stub=1 uses synthetic JSON and a timer-driven agent.

import { useStream } from "@langchain/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { checksFor, lastHumanIndex, latestResult, type Msg, kind, parse } from "./radio";
import { stubResolve, useStubAgent, type AgentView } from "./stubAgent";
import stubDistrict from "./stub/district.json";
import stubDossiers from "./stub/dossiers.json";
import type {
  CommitPlanArgs, District, Dossier, Fallback, HitlDecision, HitlValue, HordeStatus, Material, PlanAction, ResolveRequest, ResolveResult,
} from "./types";

const API_URL = process.env.NEXT_PUBLIC_LANGGRAPH_URL ?? "http://127.0.0.1:2024";
const FALLBACK_RESOLVE_MS = 20_000;

export type Phase = "dusk" | "scout" | "night" | "aftershock" | "dawn";
export type DossierState = Dossier | "loading" | "error";

const STUB_DISTRICT = stubDistrict as unknown as District;
const STUB_DOSSIERS = stubDossiers as unknown as Record<string, Dossier>;

function errText(e: unknown): string | null {
  if (!e) return null;
  const m = (e as { message?: string })?.message ?? String(e);
  return m.slice(0, 200);
}

/** The live laststand agent, behind the same small surface as the stub. */
function useLiveAgent(): AgentView {
  const stream = useStream({ assistantId: "laststand", apiUrl: API_URL });
  // After "play again" the old thread's messages are hidden until the next run creates a new thread.
  const [stale, setStale] = useState<string | null>(null);
  const hidden = !!stale && stream.threadId === stale;
  const submit = useCallback(async (text: string, fresh: boolean) => {
    const input = { messages: [{ type: "human", content: text }] };
    await (fresh ? stream.submit(input, { threadId: null }) : stream.submit(input));
  }, [stream]);
  const respond = useCallback((d: HitlDecision) => stream.respond({ decisions: [d] }), [stream]);
  const reset = useCallback(() => setStale(stream.threadId), [stream.threadId]);
  return {
    messages: hidden ? [] : stream.messages,
    isLoading: stream.isLoading,
    interruptValue: hidden ? null : ((stream.interrupt?.value as HitlValue | undefined) ?? null),
    interruptKey: stream.interrupt,
    error: hidden ? null : errText(stream.error),
    threadId: hidden ? null : stream.threadId,
    submit, respond, reset,
  };
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

export function useGame(stub: boolean) {
  const live = useLiveAgent();
  const fake = useStubAgent(STUB_DISTRICT, STUB_DOSSIERS);
  const agent = stub ? fake : live;

  // ------------------------------------------------------------ district
  const [fetched, setFetched] = useState<District | null>(null);
  const [districtError, setDistrictError] = useState<string | null>(null);
  const [loadTick, setLoadTick] = useState(0);
  useEffect(() => {
    if (stub) return;
    let alive = true;
    getJson<District>("/api/game/district")
      .then((d) => {
        if (!alive) return;
        if (!Array.isArray(d?.buildings)) throw new Error("bad district payload");
        setFetched(d);
        setDistrictError(null);
      })
      .catch((e: unknown) => alive && setDistrictError(errText(e) ?? "unreachable"));
    return () => { alive = false; };
  }, [stub, loadTick]);
  const district = stub ? STUB_DISTRICT : fetched;
  const retryDistrict = useCallback(() => setLoadTick((t) => t + 1), []);

  // ------------------------------------------------------------ dossiers
  const [dossiers, setDossiers] = useState<Record<string, DossierState>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const loadDossier = useCallback((pid: string) => {
    if (stub) {
      setDossiers((m) => ({ ...m, [pid]: STUB_DOSSIERS[pid] ?? "error" }));
      return;
    }
    setDossiers((m) => (m[pid] && m[pid] !== "error" ? m : { ...m, [pid]: "loading" }));
    getJson<Dossier>(`/api/game/dossier/${encodeURIComponent(pid)}`)
      .then((d) => setDossiers((m) => ({ ...m, [pid]: d?.scores ? d : "error" })))
      .catch(() => setDossiers((m) => ({ ...m, [pid]: "error" })));
  }, [stub]);

  // ------------------------------------------------------------ phase
  const [phase, setPhase] = useState<Phase>("dusk");
  const [fortress, setFortress] = useState<string | null>(null);
  const [waveN, setWaveN] = useState(1);
  const [nightFrom, setNightFrom] = useState<number | null>(null); // message index where the night run starts
  const [decision, setDecision] = useState<{ action: PlanAction | "none"; to_pid?: string } | null>(null);
  const [decideError, setDecideError] = useState<string | null>(null);
  const [fallbackResult, setFallbackResult] = useState<ResolveResult | null>(null);
  const answered = useRef<unknown>(null);
  const fallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (fallbackTimer.current) clearTimeout(fallbackTimer.current); }, []);

  const messages = agent.messages;
  const nightMsgs = useMemo(() => (nightFrom === null ? [] : messages.slice(nightFrom)), [messages, nightFrom]);
  const horde = useMemo(() => latestResult<HordeStatus>(nightMsgs, "horde_status"), [nightMsgs]);
  const fallback = useMemo(() => latestResult<Fallback>(nightMsgs, "find_fallback"), [nightMsgs]);
  const commitResult = useMemo(() => {
    const r = latestResult<ResolveResult>(nightMsgs, "commit_plan");
    return r && typeof r.held === "boolean" ? r : null;
  }, [nightMsgs]);
  const outcome = commitResult ?? fallbackResult;
  const commitRef = useRef<ResolveResult | null>(null);
  useEffect(() => { commitRef.current = commitResult; }, [commitResult]);

  const req = agent.interruptValue?.action_requests?.[0];
  const proposal = useMemo<CommitPlanArgs | null>(() => (phase === "night" && !outcome && req?.name === "commit_plan"
    ? { pid: String(req.args?.pid ?? fortress ?? ""), action: req.args?.action === "run" ? "run" : "hold", to_pid: req.args?.to_pid ? String(req.args.to_pid) : undefined }
    : null), [phase, outcome, req, fortress]);

  const shownPhase: Phase = phase === "night" && outcome ? "aftershock" : phase;

  // ------------------------------------------------------------ actions
  const select = useCallback((pid: string | null) => {
    setSelected(pid);
    if (pid) loadDossier(pid);
  }, [loadDossier]);

  const startScout = useCallback(() => {
    if (!selected || agent.isLoading) return;
    setFortress(selected);
    setPhase("scout");
    agent.submit(`Scout property ${selected}`, true).catch(() => {});
  }, [selected, agent]);

  /** Start wave n; returns the pid the horde comes for (null if it could not start). */
  const startNight = useCallback((n = 1): string | null => {
    const w = district?.waves.find((x) => x.n === n);
    if (!fortress || !w || agent.isLoading) return null;
    // After a RUN, the next wave comes for the building you ended the night in.
    const at = n > 1 && outcome?.pid_final ? outcome.pid_final : fortress;
    if (at !== fortress) setFortress(at);
    setWaveN(n);
    setNightFrom(messages.length);
    setDecision(null);
    setDecideError(null);
    setFallbackResult(null);
    answered.current = null;
    setPhase("night");
    agent.submit(`Wave ${n} is coming from the ${w.sector}`, false).catch(() => {});
    return at;
  }, [fortress, agent, messages.length, district, outcome]);

  const postResolve = useCallback(async (action: PlanAction, to_pid?: string) => {
    if (!fortress || !district) return;
    if (commitRef.current) return; // the agent's commit_plan result already landed
    const body: ResolveRequest = { pid: fortress, wave: waveN, seed: district.seed, action, ...(to_pid ? { to_pid } : {}), checks: checksFor(messages, fortress) };
    try {
      const r = stub
        ? stubResolve(district, STUB_DOSSIERS, { pid: fortress, action, to_pid }, waveN)
        : await getJson<ResolveResult>("/api/game/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!commitRef.current) setFallbackResult(r);
    } catch (e) {
      setDecideError(`Could not resolve the night (${errText(e)}).`);
    }
  }, [fortress, district, waveN, messages, stub]);

  /** HOLD / RUN / no orders. Approve the agent's proposal, edit it to the other action, or reject (= hold). */
  const decide = useCallback((choice: PlanAction | "none") => {
    if (!fortress || outcome) return;
    const runTo = fallback?.to_pid ?? proposal?.to_pid;
    if (choice === "run" && !runTo) {
      setDecideError("No fallback building yet; wait for HQ.");
      return;
    }
    if (proposal) {
      if (answered.current === agent.interruptKey) return; // one answer per interrupt, even on a double click
      answered.current = agent.interruptKey;
      const d: HitlDecision = choice === "none" ? { type: "reject" }
        : choice === proposal.action ? { type: "approve" }
        : { type: "edit", edited_action: { name: "commit_plan", args: choice === "run" ? { pid: proposal.pid, action: "run", to_pid: runTo } : { pid: proposal.pid, action: "hold", to_pid: null } } };
      setDecision({ action: choice, to_pid: choice === "run" ? runTo : undefined });
      setDecideError(null);
      agent.respond(d).catch((e: unknown) => {
        answered.current = null;
        setDecision(null);
        setDecideError(`The answer didn't go through (${errText(e)}). Try again.`);
      });
      if (fallbackTimer.current) clearTimeout(fallbackTimer.current);
      if (choice === "none") {
        // Reject = "no orders, holding": the server writes no commit_plan result, so the page rolls the night.
        void postResolve("hold");
        return;
      }
      fallbackTimer.current = setTimeout(() => {
        void postResolve(choice, choice === "run" ? runTo : undefined);
      }, FALLBACK_RESOLVE_MS);
      return;
    }
    // No interrupt (the agent stopped without proposing): the player's call goes straight to the server roll.
    if (agent.isLoading || decision) return;
    setDecision({ action: choice, to_pid: choice === "run" ? runTo : undefined });
    void postResolve(choice === "run" ? "run" : "hold", choice === "run" ? runTo : undefined);
  }, [fortress, outcome, fallback, proposal, agent, decision, postResolve]);

  const goDawn = useCallback(() => setPhase("dawn"), []);

  const sendTip = useCallback((tip: string) => {
    const t = tip.trim();
    if (!t || agent.isLoading) return;
    agent.submit(`Tip: ${t}`, false).catch(() => {});
  }, [agent]);

  const reset = useCallback(() => {
    if (fallbackTimer.current) clearTimeout(fallbackTimer.current);
    agent.reset();
    setPhase("dusk");
    setFortress(null);
    setSelected(null);
    setNightFrom(null);
    setDecision(null);
    setDecideError(null);
    setFallbackResult(null);
    answered.current = null;
  }, [agent]);

  // ------------------------------------------------------------ derived views
  const conflictMaterials = useMemo(() => {
    // weigh_case for a conflict building: lean to the leading hypothesis's material; unresolved keeps the split.
    const out: Record<string, Material | null> = {};
    if (!district) return out;
    for (const b of district.buildings) {
      if (!b.conflict) continue;
      out[b.pid] = null;
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i] as Msg;
        if (kind(m) !== "tool" || m.name !== "weigh_case") continue;
        const w = parse<{ property_id?: string; verdict?: { hypothesis?: string; label?: string } }>(m);
        if (String(w?.property_id) !== b.pid) continue;
        if (w?.verdict?.label && w.verdict.label !== "unresolved") {
          if (w.verdict.hypothesis === "city_list_current") out[b.pid] = b.conflict.city;
          else if (w.verdict.hypothesis === "costar_current") out[b.pid] = b.conflict.costar;
        }
        break;
      }
    }
    return out;
  }, [district, messages]);

  const streamDossier = useMemo(() => {
    const d = latestResult<Dossier>(messages, "fortress_dossier");
    return d?.scores && d.pid === (fortress ?? selected) ? d : null;
  }, [messages, fortress, selected]);
  const focusPid = fortress ?? selected;
  const dossier: DossierState | null = streamDossier ?? (focusPid ? dossiers[focusPid] ?? null : null);

  // Done once the agent has answered the scout prompt (an AI message after the newest human one), or failed.
  const scoutDone = phase === "scout" && !agent.isLoading && lastHumanIndex(messages) >= 0
    && (!!agent.error || messages.slice(lastHumanIndex(messages) + 1).some((m) => kind(m as Msg) === "ai"));
  const wave = district?.waves.find((w) => w.n === waveN) ?? district?.waves[0] ?? null;

  return {
    stub, district, districtError, retryDistrict,
    phase: shownPhase, selected, fortress, focusPid, dossier, wave, waveN,
    messages, isLoading: agent.isLoading, agentError: agent.error,
    horde, fallback, proposal, decision, decideError, outcome, scoutDone,
    conflictMaterials,
    select, startScout, startNight, decide, goDawn, sendTip, reset,
  };
}

export type Game = ReturnType<typeof useGame>;
