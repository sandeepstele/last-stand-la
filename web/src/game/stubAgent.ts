// ?stub=1: a timer-driven stand-in for the laststand agent. It emits SYNTHETIC messages in the same shapes
// the stream carries (tool calls, tool results, the commit_plan interrupt), so the radio, the HUD and the
// case file run on exactly the code paths of real mode. Nothing here is real data.

import { useCallback, useEffect, useRef, useState } from "react";
import { hash32, mulberry32 } from "./prng";
import type { Msg } from "./radio";
import type { CommitPlanArgs, District, Dossier, HitlDecision, HitlValue, ResolveResult } from "./types";

export type AgentView = {
  messages: readonly unknown[];
  isLoading: boolean;
  interruptValue: HitlValue | null;
  /** Identity of the pending interrupt (one answer per interrupt). */
  interruptKey: unknown;
  error: string | null;
  threadId: string | null;
  /** Reattach a saved thread (its history reloads; nothing is re-sent). Live agent only. */
  resume?(threadId: string): void;
  submit(text: string, fresh: boolean): Promise<void>;
  respond(decision: HitlDecision): Promise<void>;
  reset(): void;
};

type Step = { at: number; msg?: Msg; interrupt?: HitlValue };

const SAFE_ROOM = "syn-h";

/** Synthetic roll, shaped like the server's resolve object. */
export function stubResolve(district: District, dossiers: Record<string, Dossier>, args: CommitPlanArgs, wave: number): ResolveResult {
  const pid_final = args.action === "run" && args.to_pid ? args.to_pid : args.pid;
  const d = dossiers[pid_final];
  const walls = d?.scores.walls.value ?? 55;
  const quake = d?.scores.quake.value ?? 50;
  const rng = mulberry32(district.seed ^ hash32(pid_final) ^ (wave * 977));
  const walls_roll = Math.floor(rng() * 100);
  const quake_roll = Math.floor(rng() * 100);
  const held = walls_roll < walls + 15 && quake_roll < quake + 30;
  return {
    held, walls, quake, walls_roll, quake_roll, pid_final,
    why: `Stub roll: walls ${walls} vs ${walls_roll}, quake ${quake} vs ${quake_roll}.`,
  };
}

let seq = 0;
const nid = () => `stub-${++seq}`;
const call = (name: string, args: Record<string, unknown>): Msg => ({ id: nid(), type: "ai", content: "", tool_calls: [{ id: nid(), name, args }] });
const result = (name: string, content: unknown, tool_call_id?: string): Msg => ({
  id: nid(), type: "tool", name, tool_call_id, content: typeof content === "string" ? content : JSON.stringify(content),
});
const say = (content: string): Msg => ({ id: nid(), type: "ai", content, tool_calls: [] });

function scoutScript(district: District, dossiers: Record<string, Dossier>, pid: string): Step[] {
  const b = district.buildings.find((x) => x.pid === pid);
  const d = dossiers[pid];
  const tasks: Msg = {
    id: nid(), type: "ai", content: "",
    tool_calls: [
      { id: "t-records", name: "task", args: { subagent_type: "records", description: `Read the record for ${pid}` } },
      { id: "t-aerial", name: "task", args: { subagent_type: "aerial", description: `Read the aerial for ${pid}` } },
      { id: "t-civic", name: "task", args: { subagent_type: "civic", description: `Read the city lists for ${pid}` } },
    ],
  };
  const steps: Step[] = [
    { at: 300, msg: call("write_todos", { todos: [{ content: "Records" }, { content: "Aerial" }, { content: "City lists" }, { content: "Weigh the walls" }] }) },
    { at: 900, msg: tasks },
    { at: 2000, msg: result("task", `The listing records ${b?.material ?? "an unknown material"}${b?.year_built ? `, built ${b.year_built}` : ""}, ${b?.stories ?? "?"} stories.`, "t-records") },
    { at: 2700, msg: result("task", b?.list ? `The city's ${b.list === "soft_story" ? "soft-story" : "concrete"} list includes it; the order looks ${b.unfinished ? "unfinished" : "finished"}.` : "Not on a city retrofit list.", "t-civic") },
    { at: 3300, msg: result("task", "Flat roof; the frame is hard to read from above.", "t-aerial") },
  ];
  if (d) steps.push({ at: 3800, msg: result("fortress_dossier", d) });
  if (d?.case) {
    const c = d.case;
    const lead = c.hypotheses[0]?.key ?? "city_list_current";
    steps.push(
      { at: 4300, msg: result("open_case", { property_id: pid, cases: [c] }) },
      { at: 4600, msg: call("check_evidence", { property_id: pid, case: c.case, check: "compliance_filings" }) },
      { at: 5400, msg: result("check_evidence", {
        property_id: pid, case: c.case, check: "compliance_filings",
        finding: "A retrofit filing mentions a concrete frame.", why: "Filings describe the structure the city inspected.",
        effects: [{ hypothesis: lead, delta: 0.08 }],
      }) },
      { at: 6400, msg: result("check_evidence", {
        property_id: pid, case: c.case, check: "look_from_above",
        finding: "From above, the facade could be a concrete frame; the read is not conclusive.", why: "A vision read of a cached oblique image.",
        effects: [{ hypothesis: lead, delta: 0.02 }],
      }) },
      { at: 7300, msg: result("weigh_case", {
        property_id: pid, case: c.case, posterior: { [lead]: 0.55, [c.hypotheses[1]?.key ?? "other"]: 0.45 },
        verdict: { hypothesis: lead, claim: c.hypotheses[0]?.claim ?? "", confidence: 0.55, label: "unresolved" },
        next_check: "permit_text", correction_draft: null,
      }) },
    );
  }
  steps.push({ at: 8200, msg: say(d?.case
    ? "Scouting done. The walls are a gamble until the records agree; the city's order here looks unfinished."
    : "Scouting done. The records mostly agree on this one.") });
  return steps;
}

function nightScript(district: District, dossiers: Record<string, Dossier>, pid: string, n: number): Step[] {
  const wave = district.waves.find((w) => w.n === n) ?? district.waves[0];
  const safe = pid === SAFE_ROOM ? district.buildings.find((b) => b.hero && b.pid !== pid) : district.buildings.find((b) => b.pid === SAFE_ROOM);
  const walls = dossiers[pid]?.scores.walls.value ?? 50;
  const args: CommitPlanArgs = walls < 60 && safe ? { pid, action: "run", to_pid: safe.pid } : { pid, action: "hold" };
  return [
    { at: 500, msg: call("horde_status", { wave: n }) },
    { at: 1200, msg: result("horde_status", {
      wave: n, sector: wave?.sector ?? "N", eta_band: "30-60s",
      size_band: (wave?.size ?? 0) > 700 ? "huge" : (wave?.size ?? 0) > 400 ? "large" : "small",
    }) },
    { at: 1700, msg: call("find_fallback", { pid, away_from: wave?.sector }) },
    { at: 2500, msg: result("find_fallback", {
      from_pid: pid, to_pid: safe?.pid ?? pid, to_label: safe?.label ?? "nowhere", distance_band: "2 blocks",
      reason: "Its records agree on the frame, and it has an interior scan.",
    }) },
    { at: 3200, msg: call("commit_plan", args as unknown as Record<string, unknown>) },
    { at: 3300, interrupt: { action_requests: [{ name: "commit_plan", args: args as unknown as Record<string, unknown> }] } },
  ];
}

function tipScript(dossiers: Record<string, Dossier>, pid: string | null): Step[] {
  const c = pid ? dossiers[pid]?.case : null;
  const steps: Step[] = [
    { at: 400, msg: call("record_note", { property_id: pid, note: "tip" }) },
    { at: 900, msg: result("record_note", { status: "saved" }) },
  ];
  if (pid && c) {
    const lead = c.hypotheses[0]?.key ?? "city_list_current";
    steps.push({ at: 1800, msg: result("weigh_case", {
      property_id: pid, case: c.case, posterior: { [lead]: 0.72, [c.hypotheses[1]?.key ?? "other"]: 0.28 },
      verdict: { hypothesis: lead, claim: c.hypotheses[0]?.claim ?? "", confidence: 0.72, label: "leaning" },
      next_check: "permit_text",
      correction_draft: `Draft for a researcher: the recorded material for ${dossiers[pid]?.label ?? pid} may be out of date; a tip and the city's list point to a concrete frame.`,
    }) });
  }
  steps.push({ at: 2500, msg: say(c ? "Tip logged. The walls now lean toward the city's concrete list." : "Tip logged.") });
  return steps;
}

export function useStubAgent(district: District, dossiers: Record<string, Dossier>): AgentView {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [isLoading, setLoading] = useState(false);
  const [interrupt, setInterrupt] = useState<HitlValue | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const ctx = useRef<{ pid: string | null; wave: number }>({ pid: null, wave: 1 });

  const clear = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };
  useEffect(() => clear, []);

  const play = useCallback((steps: Step[]) => {
    clear();
    setLoading(true);
    const end = steps.reduce((t, s) => Math.max(t, s.at), 0);
    for (const s of steps) {
      timers.current.push(setTimeout(() => {
        if (s.msg) setMessages((ms) => [...ms, s.msg!]);
        if (s.interrupt) setInterrupt(s.interrupt);
      }, s.at));
    }
    timers.current.push(setTimeout(() => setLoading(false), end + 50));
  }, []);

  const submit = useCallback(async (textIn: string, fresh: boolean) => {
    const human: Msg = { id: nid(), type: "human", content: textIn };
    setInterrupt(null);
    setMessages((ms) => (fresh ? [human] : [...ms, human]));
    const scout = textIn.match(/^Scout property (\S+)/);
    const night = textIn.match(/^Wave (\d+) is coming/);
    if (scout) {
      ctx.current = { pid: scout[1], wave: 1 };
      play(scoutScript(district, dossiers, scout[1]));
    } else if (night && ctx.current.pid) {
      const pid = ctx.current.pid;
      ctx.current = { pid, wave: Number(night[1]) };
      play(nightScript(district, dossiers, pid, Number(night[1])));
    } else {
      play(tipScript(dossiers, ctx.current.pid));
    }
  }, [district, dossiers, play]);

  const respond = useCallback(async (decision: HitlDecision) => {
    const req = interrupt?.action_requests?.[0];
    if (!req) throw new Error("nothing to answer");
    const proposed = req.args as unknown as CommitPlanArgs;
    const args: CommitPlanArgs = decision.type === "approve" ? proposed
      : decision.type === "edit" ? (decision.edited_action.args as unknown as CommitPlanArgs)
      : { pid: proposed.pid, action: "hold" };
    setInterrupt(null);
    if (decision.type === "reject") {
      // Like the server: no commit_plan result; the page posts /game/resolve with action "hold".
      play([{ at: 600, msg: say("No orders. Holding.") }]);
      return;
    }
    if (args.action === "run" && args.to_pid) ctx.current = { ...ctx.current, pid: args.to_pid };
    const r = stubResolve(district, dossiers, args, ctx.current.wave);
    play([
      { at: 700, msg: result("commit_plan", r) },
      { at: 1500, msg: say(r.held ? "Dawn is close. The walls held through the aftershock." : "The walls gave way in the aftershock. Everyone got out.") },
    ]);
  }, [interrupt, district, dossiers, play]);

  const reset = useCallback(() => {
    clear();
    setMessages([]);
    setInterrupt(null);
    setLoading(false);
  }, []);

  return {
    messages, isLoading, interruptValue: interrupt, interruptKey: interrupt, error: null, threadId: messages.length ? "stub" : null,
    submit, respond, reset,
  };
}
