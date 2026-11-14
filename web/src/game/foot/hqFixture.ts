// OWNER: builder F (HQ panel). SYNTHETIC laststand messages for previewing the HQ panel: the same shapes the
// stream carries (AI tool_calls, tool results as JSON strings with tool_call_id), synthetic pids and labels.
// Nothing here is real data; the numbers follow app/evidence.py's arithmetic so the story is self-consistent.

import type { Msg } from "../radio";

export const FIXTURE_PID = "syn-a";
const PID = FIXTURE_PID;

let n = 0;
const id = (p: string) => `${p}-${++n}`;
const human = (content: string): Msg => ({ id: id("h"), type: "human", content });
const ai = (content: string, calls: { id: string; name: string; args: Record<string, unknown> }[] = []): Msg => ({
  id: id("ai"), type: "ai", content, tool_calls: calls,
});
const tool = (name: string, callId: string, content: unknown): Msg => ({
  id: id("t"), type: "tool", name, tool_call_id: callId, content: typeof content === "string" ? content : JSON.stringify(content),
});

const TODO = (s: ("pending" | "in_progress" | "completed")[]) => ({
  todos: [
    { content: "Read the records, aerial, interior and city lists", status: s[0] },
    { content: "Settle what the walls are made of", status: s[1] },
    { content: "Weigh the case and brief the squad", status: s[2] },
    { content: "Pick a fallback before nightfall", status: s[3] },
  ],
});

const HYPS = [
  { key: "city_list_current", claim: "It is concrete: the city's list is right and CoStar's material is out of date", prior: 0.45 },
  { key: "costar_current", claim: "It is the material CoStar records: the list entry is a screening false positive", prior: 0.35 },
  { key: "different_structure", claim: "The two sources describe different structures at the same address", prior: 0.2 },
];
const CHECKS = ["compliance_filings", "permit_text", "replacement_permits", "era_and_height", "site_structures", "look_from_above", "compare_captures"];
const CASE = {
  case: "material_conflict",
  question: "The city lists this building as non-ductile concrete; CoStar records another material. Which is current?",
  hypotheses: HYPS,
  checks: CHECKS.map((check) => ({ check, looks_at: check })),
};

const FILINGS = {
  property_id: PID, case: "material_conflict", check: "compliance_filings", looks_at: "What the owner has filed",
  finding: "filed: screening checklist (2019-06-12); structural plans not yet filed",
  effects: [{ hypothesis: "city_list_current", delta: 0.12 }, { hypothesis: "costar_current", delta: -0.05 }],
  why: "the screening checklist was filed and the building stayed on the list (weak)",
};
const ABOVE = {
  property_id: PID, case: "material_conflict", check: "look_from_above", looks_at: "A vision read of the oblique and top-down images",
  finding: "concrete frame: regular column grid and cast spandrels on the street face; a second pass agreed",
  effects: [{ hypothesis: "city_list_current", delta: 0.08 }],
  why: "a confirmed vision read, capped at 0.2", images: ["syn-a-oblique.jpg"],
};

/** Phases of one synthetic night, cumulative. busy = a run was in progress at that moment. */
export function hqFixture(): { name: string; busy: boolean; messages: Msg[] }[] {
  n = 0;
  const out: { name: string; busy: boolean; messages: Msg[] }[] = [];
  const ms: Msg[] = [];
  const snap = (name: string, busy: boolean) => out.push({ name, busy, messages: [...ms] });

  snap("standby", false);

  // 1. Scout: plan, four squads in parallel, the dossier and the case, all in one message.
  ms.push(human(`Scout property ${PID}`));
  ms.push(ai("", [
    { id: "c-todo1", name: "write_todos", args: TODO(["in_progress", "pending", "pending", "pending"]) },
    { id: "c-rec", name: "task", args: { subagent_type: "records", description: `Pull the building record for ${PID}` } },
    { id: "c-air", name: "task", args: { subagent_type: "aerial", description: `Read the aerial attributes for ${PID}` } },
    { id: "c-int", name: "task", args: { subagent_type: "interior", description: `Read the interior scan for ${PID}` } },
    { id: "c-civ", name: "task", args: { subagent_type: "civic", description: `Read the city's retrofit records for ${PID}` } },
    { id: "c-dos", name: "fortress_dossier", args: { pid: PID } },
    { id: "c-open", name: "open_case", args: { property_id: PID } },
  ]));
  ms.push(tool("write_todos", "c-todo1", "Updated todo list"));
  ms.push(tool("fortress_dossier", "c-dos", { pid: PID, label: "Building A", scores: {}, unknowns: [], images: { drone: [], cctv: [] }, case: CASE, disclaimer: "" }));
  ms.push(tool("open_case", "c-open", { property_id: PID, cases: [CASE], note: "Pick the checks most likely to separate the hypotheses." }));
  ms.push(tool("task", "c-rec", `Property ${PID} is a 12-story office built in 1926, recorded as masonry, about 180,000 sq ft. Last roof work 2011.`));
  ms.push(tool("task", "c-civ", "On the city's non-ductile concrete list since 2018; the screening checklist is filed and structural plans are overdue."));
  snap("squads out", true);

  ms.push(tool("task", "c-air", "**Aerial:** flat roof, 47 m tall (about 3.9 m per floor), rooftop equipment, no solar."));
  ms.push(tool("task", "c-int", "The interior scan covers 3 levels; floor-to-floor about 3.8 m, exposed columns on level 2."));
  // 2. The agent chooses which checks separate the hypotheses.
  ms.push(ai("Records disagree on the walls. Checking the filings and taking a look from above.", [
    { id: "c-todo2", name: "write_todos", args: TODO(["completed", "in_progress", "pending", "pending"]) },
    { id: "c-ck1", name: "check_evidence", args: { property_id: PID, case: "material_conflict", check: "compliance_filings" } },
    { id: "c-ck2", name: "check_evidence", args: { property_id: PID, case: "material_conflict", check: "look_from_above" } },
  ]));
  ms.push(tool("write_todos", "c-todo2", "Updated todo list"));
  ms.push(tool("check_evidence", "c-ck1", FILINGS));
  snap("choosing evidence", true);

  ms.push(tool("check_evidence", "c-ck2", ABOVE));
  ms.push(ai("", [
    { id: "c-todo3", name: "write_todos", args: TODO(["completed", "completed", "completed", "pending"]) },
    { id: "c-w1", name: "weigh_case", args: { property_id: PID, case: "material_conflict", checks: ["compliance_filings", "look_from_above"] } },
  ]));
  ms.push(tool("write_todos", "c-todo3", "Updated todo list"));
  ms.push(tool("weigh_case", "c-w1", {
    property_id: PID, case: "material_conflict", checks_used: ["compliance_filings", "look_from_above"],
    trail: [FILINGS, ABOVE].map(({ check, finding, effects, why }) => ({ check, finding, effects, why })),
    priors: { city_list_current: 0.45, costar_current: 0.35, different_structure: 0.2 },
    posterior: { city_list_current: 0.57, costar_current: 0.26, different_structure: 0.17 },
    verdict: { hypothesis: "city_list_current", claim: HYPS[0].claim, confidence: 0.57, label: "leaning",
      text: "Leaning: the building may be concrete, as the city lists it; CoStar's material is worth a look (57%)" },
    next_check: "permit_text", report_conflicts_with_records: false, correction_draft: null, draft_needs_approval: false,
  }));
  ms.push(ai("Building A: records squad has it as masonry, the city lists it as concrete. Leaning: the building may be concrete, as the city lists it; CoStar's material is worth a look (57%)."));
  snap("scouted", false);

  // 3. The player's report from inside.
  ms.push(human("Tip: I'm inside the building. The walls and columns look like concrete."));
  ms.push(ai("", [{ id: "c-note", name: "record_note", args: { property_id: PID, note: "The walls and columns look like concrete.", source: "the player", supports: "city_list_current" } }]));
  ms.push(tool("record_note", "c-note", `Saved as a team note on ${PID}; later investigations will show it as a claim to verify.`));
  ms.push(ai("", [{ id: "c-w2", name: "weigh_case", args: { property_id: PID, case: "material_conflict", checks: ["compliance_filings", "look_from_above", "human_report"] } }]));
  snap("weighing your report", true);
  ms.push(tool("weigh_case", "c-w2", {
    property_id: PID, case: "material_conflict", checks_used: ["compliance_filings", "look_from_above", "human_report"],
    trail: [
      ...[FILINGS, ABOVE].map(({ check, finding, effects, why }) => ({ check, finding, effects, why })),
      { check: "human_report", finding: "the player reported on 2026-11-14: The walls and columns look like concrete.",
        effects: [{ hypothesis: "city_list_current", delta: 0.25 }], why: "first-hand report: strong but not final, capped at +0.35" },
    ],
    priors: { city_list_current: 0.45, costar_current: 0.35, different_structure: 0.2 },
    posterior: { city_list_current: 0.64, costar_current: 0.21, different_structure: 0.14 },
    verdict: { hypothesis: "city_list_current", claim: HYPS[0].claim, confidence: 0.64, label: "likely",
      text: "Likely: the building may be concrete, as the city lists it; CoStar's material is worth a look (64%)" },
    next_check: null, report_conflicts_with_records: false, correction_draft: "DRAFT ...", draft_needs_approval: true,
  }));
  ms.push(ai("Your report moved it: likely concrete now, 64%. A person's report is strong but capped, never final."));
  snap("after your report", false);

  // 4. Night: the horde, a fallback, and the plan that waits for HOLD or RUN.
  ms.push(human("Wave 1 is coming from the W"));
  ms.push(ai("", [
    { id: "c-horde", name: "horde_status", args: { wave: 1 } },
    { id: "c-fall", name: "find_fallback", args: { pid: PID, away_from: "W" } },
  ]));
  ms.push(tool("horde_status", "c-horde", { wave: 1, sector: "W", eta_band: "30-60s", size_band: "large" }));
  ms.push(tool("find_fallback", "c-fall", { from_pid: PID, to_pid: "syn-h", to_label: "Building H", distance_band: "2 blocks", reason: "Its records agree on the frame." }));
  ms.push(ai("Large wave from the west. Walls lean concrete here; I'd hold.", [{ id: "c-plan", name: "commit_plan", args: { pid: PID, action: "hold" } }]));
  snap("waiting for you", false);

  ms.push(tool("commit_plan", "c-plan", { held: true, walls: 62, quake: 55, walls_roll: 40, quake_roll: 71, why: "Synthetic roll.", pid_final: PID }));
  ms.push(ai("The walls held. Dawn is close."));
  snap("resolved", false);
  return out;
}
