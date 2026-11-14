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

// ---------------------------------------------------------------- the night shift: two cases from the queue

const GHOST_HYPS = [
  { key: "still_there", claim: "Still there: the suite is being marketed ahead of the lease ending", prior: 0.3 },
  { key: "gone_dark", claim: "Gone: the tenant has left and CoStar's occupancy record is out of date", prior: 0.25 },
  { key: "subleasing", claim: "Subleasing: the tenant is offering its own space", prior: 0.1 },
  { key: "moved_within", claim: "Moved within the building to another suite", prior: 0.1 },
  { key: "listing_stale", claim: "The listing is stale: the suite was leased and the listing never came down", prior: 0.25 },
];
const GHOST = {
  case: "ghost_tenant",
  question: "CoStar records a tenant in this suite, and the suite is listed for lease right now. Is the tenant still there?",
  hypotheses: GHOST_HYPS,
  checks: ["listing_timeline", "lease_terms", "tenancy_trail", "lot_activity", "suite_tour"].map((check) => ({ check, looks_at: check })),
};
const GHOST_PID = "syn-k";
const SUITE = "1100";
// A planted company name: the panel must never show it (it says "a tenant").
const TENANT = "Synthetic Widgets LLC";

export function nightFixture(): { name: string; busy: boolean; messages: Msg[] }[] {
  n = 0;
  const out: { name: string; busy: boolean; messages: Msg[] }[] = [];
  const ms: Msg[] = [];
  const snap = (name: string, busy: boolean) => out.push({ name, busy, messages: [...ms] });
  const PLAN = (s: ("pending" | "in_progress" | "completed")[]) => ({
    todos: [
      { content: "Case #6: settle what Building A's walls are made of", status: s[0] },
      { content: "Case #7: is the office in suite 1100 still there?", status: s[1] },
      { content: "Log the field reports and re-weigh", status: s[2] },
    ],
  });
  const walls = (check: string, finding: string, effects: { hypothesis: string; delta: number }[]) =>
    ({ property_id: PID, case: "material_conflict", check, looks_at: check, finding, effects, why: "synthetic" });
  const office = (check: string, finding: string, effects: { hypothesis: string; delta: number }[]) =>
    ({ property_id: GHOST_PID, suite: SUITE, case: "ghost_tenant", check, looks_at: check, finding, effects, why: "synthetic" });

  snap("standby", false);
  ms.push(human("Brief the night shift"));
  ms.push(ai("", [{ id: "n-q", name: "night_cases", args: {} }]));
  snap("reading the queue", true);
  ms.push(tool("night_cases", "n-q", {
    total: 328,
    cases: [
      { n: 6, case: "material_conflict", property_id: PID, suite: null, label: "Building A",
        question: "The city lists this building as concrete; the listing records another material. Which is current?", stakes: "12 stories, built 1926" },
      { n: 7, case: "ghost_tenant", property_id: GHOST_PID, suite: SUITE, label: "Building K",
        question: "A tenant is on record in this suite, and the suite is listed for lease. Is the tenant still there?", stakes: "a 3-person office on record" },
    ],
  }));
  ms.push(ai("Two cases tonight. Starting with the walls at Building A.", [
    { id: "n-t1", name: "write_todos", args: PLAN(["in_progress", "pending", "pending"]) },
    { id: "n-o1", name: "open_case", args: { property_id: PID } },
  ]));
  ms.push(tool("write_todos", "n-t1", "Updated todo list"));
  ms.push(tool("open_case", "n-o1", { property_id: PID, cases: [CASE], note: "Pick the checks most likely to separate the hypotheses." }));
  ms.push(ai("", [
    { id: "n-c1", name: "check_evidence", args: { property_id: PID, case: "material_conflict", check: "compliance_filings" } },
    { id: "n-c2", name: "check_evidence", args: { property_id: PID, case: "material_conflict", check: "look_from_above" } },
  ]));
  ms.push(tool("check_evidence", "n-c1", walls("compliance_filings", "filed: screening checklist (2019-06-12); structural plans not yet filed",
    [{ hypothesis: "city_list_current", delta: 0.12 }, { hypothesis: "costar_current", delta: -0.05 }])));
  snap("checking the walls", true);
  ms.push(tool("check_evidence", "n-c2", walls("look_from_above", "concrete frame: regular column grid and cast spandrels; a second pass agreed",
    [{ hypothesis: "city_list_current", delta: 0.08 }])));
  ms.push(ai("", [{ id: "n-w1", name: "weigh_case", args: { property_id: PID, case: "material_conflict", checks: ["compliance_filings", "look_from_above"] } }]));
  ms.push(tool("weigh_case", "n-w1", {
    property_id: PID, case: "material_conflict", checks_used: ["compliance_filings", "look_from_above"], trail: [],
    posterior: { city_list_current: 0.57, costar_current: 0.26, different_structure: 0.17 },
    verdict: { hypothesis: "city_list_current", claim: HYPS[0].claim, confidence: 0.57, label: "leaning",
      text: "Leaning: the building may be concrete, as the city lists it; CoStar's material is worth a look (57%)" },
    next_check: "permit_text", correction_draft: null,
  }));
  ms.push(ai("Case #6 is leaning concrete, 57%. Go look at the walls."));
  snap("walls weighed", false);

  ms.push(human("Tip: I'm inside the building. The walls and columns look like concrete."));
  ms.push(ai("", [{ id: "n-n1", name: "record_note", args: { property_id: PID, note: "Walls and columns look like concrete.", source: "the player", supports: "city_list_current" } }]));
  ms.push(tool("record_note", "n-n1", "Saved as a team note; later investigations will show it as a claim to verify."));
  ms.push(ai("", [{ id: "n-w2", name: "weigh_case", args: { property_id: PID, case: "material_conflict", checks: ["compliance_filings", "look_from_above", "human_report"] } }]));
  ms.push(tool("weigh_case", "n-w2", {
    property_id: PID, case: "material_conflict", checks_used: ["compliance_filings", "look_from_above", "human_report"],
    trail: [{ check: "human_report", finding: "the player reported: walls and columns look like concrete", effects: [{ hypothesis: "city_list_current", delta: 0.25 }] }],
    posterior: { city_list_current: 0.64, costar_current: 0.21, different_structure: 0.14 },
    verdict: { hypothesis: "city_list_current", claim: HYPS[0].claim, confidence: 0.64, label: "likely" },
    next_check: null, correction_draft: "DRAFT ...",
  }));
  ms.push(ai("Your report moved Case #6 to likely concrete, 64%. On to Case #7."));
  snap("walls after your report", false);

  ms.push(ai("", [
    { id: "n-t2", name: "write_todos", args: PLAN(["completed", "in_progress", "pending"]) },
    { id: "n-o2", name: "open_case", args: { property_id: GHOST_PID, suite: SUITE } },
  ]));
  ms.push(tool("write_todos", "n-t2", "Updated todo list"));
  ms.push(tool("open_case", "n-o2", { property_id: GHOST_PID, suite: SUITE, tenant: TENANT, cases: [GHOST], tour: { available: true } }));
  ms.push(ai("", [
    { id: "n-c3", name: "check_evidence", args: { property_id: GHOST_PID, suite: SUITE, case: "ghost_tenant", check: "listing_timeline" } },
    { id: "n-c4", name: "check_evidence", args: { property_id: GHOST_PID, suite: SUITE, case: "ghost_tenant", check: "lease_terms" } },
    { id: "n-c5", name: "check_evidence", args: { property_id: GHOST_PID, suite: SUITE, case: "ghost_tenant", check: "suite_tour" } },
  ]));
  ms.push(tool("check_evidence", "n-c3", office("listing_timeline",
    `listed since 2025-03-01 (20 months, direct listing); CoStar records ${TENANT} here since 2015-04-01`,
    [{ hypothesis: "gone_dark", delta: 0.1 }, { hypothesis: "still_there", delta: 0.05 }])));
  ms.push(tool("check_evidence", "n-c4", office("lease_terms", "lease expired 2025-06-30, tenancy still marked current",
    [{ hypothesis: "gone_dark", delta: 0.15 }, { hypothesis: "still_there", delta: -0.1 }])));
  snap("checking the office", true);
  ms.push(tool("check_evidence", "n-c5", office("suite_tour", "empty: bare floor, no desks or screens in the leasing tour (2025-09); a second pass agreed",
    [{ hypothesis: "gone_dark", delta: 0.15 }, { hypothesis: "listing_stale", delta: 0.05 }])));
  ms.push(ai("", [{ id: "n-w3", name: "weigh_case", args: { property_id: GHOST_PID, suite: SUITE, case: "ghost_tenant", checks: ["listing_timeline", "lease_terms", "suite_tour"] } }]));
  ms.push(tool("weigh_case", "n-w3", {
    property_id: GHOST_PID, suite: SUITE, case: "ghost_tenant", checks_used: ["listing_timeline", "lease_terms", "suite_tour"], trail: [],
    posterior: { still_there: 0.18, gone_dark: 0.46, subleasing: 0.07, moved_within: 0.07, listing_stale: 0.21 },
    verdict: { hypothesis: "gone_dark", claim: GHOST_HYPS[1].claim, confidence: 0.46, label: "leaning",
      text: "Leaning: the tenant may have left; CoStar's occupancy record is worth a look (46%)" },
    next_check: "tenancy_trail", correction_draft: null,
  }));
  ms.push(ai("Case #7 is leaning gone, 46%. Check suite 1100 on your way."));
  snap("office weighed", false);

  ms.push(human("Tip: I'm inside suite 1100. It's empty: no desks, no people, the phones are unplugged."));
  ms.push(ai("", [{ id: "n-n2", name: "record_note", args: { property_id: GHOST_PID, suite: SUITE, note: "Suite is empty.", source: "the player", supports: "gone_dark" } }]));
  snap("logging the suite report", true);
  ms.push(tool("record_note", "n-n2", "Saved as a team note; later investigations will show it as a claim to verify."));
  ms.push(ai("", [{ id: "n-w4", name: "weigh_case", args: { property_id: GHOST_PID, suite: SUITE, case: "ghost_tenant", checks: ["listing_timeline", "lease_terms", "suite_tour", "human_report"] } }]));
  ms.push(tool("weigh_case", "n-w4", {
    property_id: GHOST_PID, suite: SUITE, case: "ghost_tenant", checks_used: ["listing_timeline", "lease_terms", "suite_tour", "human_report"],
    trail: [{ check: "human_report", finding: "the player reported: suite is empty", effects: [{ hypothesis: "gone_dark", delta: 0.25 }] }],
    posterior: { still_there: 0.15, gone_dark: 0.55, subleasing: 0.06, moved_within: 0.06, listing_stale: 0.18 },
    verdict: { hypothesis: "gone_dark", claim: GHOST_HYPS[1].claim, confidence: 0.55, label: "likely" },
    next_check: null, correction_draft: "DRAFT ...",
  }));
  ms.push(ai("Your report moved Case #7 to likely gone, 55%. A person's report is strong but capped, never final."));
  snap("office after your report", false);

  // Dawn: the debrief. One draft_correction per case worked, then at most 3 lines.
  ms.push(human("Debrief the night shift"));
  ms.push(ai("", [
    { id: "n-d1", name: "draft_correction", args: { property_id: PID } },
    { id: "n-d2", name: "draft_correction", args: { property_id: GHOST_PID, suite: SUITE } },
  ]));
  snap("drafting", true);
  ms.push(tool("draft_correction", "n-d1", {
    n: 6, case: "material_conflict", property_id: PID, suite: null, label: "Building A",
    hypothesis: "city_list_current", label_verdict: "likely", confidence: 0.64,
    text: "DRAFT for a researcher: Building A is recorded as masonry; the city's non-ductile concrete program lists it, a screening checklist is filed, and a vision read of the aerial shows a concrete frame. A field report agrees. Please review the construction type.",
    evidence: [
      { check: "compliance_filings", finding: "filed: screening checklist (2019-06-12)" },
      { check: "look_from_above", finding: "concrete frame: regular column grid" },
      { check: "human_report", finding: "the player reported: walls and columns look like concrete" },
    ],
    your_report: "I'm inside the building. The walls and columns look like concrete.",
  }));
  snap("one drafted", true);
  ms.push(tool("draft_correction", "n-d2", {
    n: 7, case: "ghost_tenant", property_id: GHOST_PID, suite: SUITE, label: "Building K",
    hypothesis: "gone_dark", label_verdict: "likely", confidence: 0.55,
    text: `DRAFT for a researcher: suite ${SUITE} at Building K is recorded as occupied by ${TENANT} since 2015-04-01, and it has been listed for lease since 2025-03-01. The lease expired 2025-06-30 and the leasing tour shows an empty suite. Please re-verify occupancy; the tenant record may be out of date.`,
    evidence: [
      { check: "listing_timeline", finding: `listed since 2025-03-01; CoStar records ${TENANT} here since 2015-04-01` },
      { check: "lease_terms", finding: "lease expired 2025-06-30" },
      { check: "suite_tour", finding: "empty: bare floor" },
      { check: "human_report", finding: "the player reported: suite is empty" },
    ],
    your_report: "I'm inside suite 1100. It's empty: no desks, no people, the phones are unplugged.",
  }));
  ms.push(ai("Two drafts for a researcher. Both cite your reports. Nothing is sent until a person approves."));
  snap("debrief done", false);
  return out;
}
