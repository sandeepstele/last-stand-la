# Plan audit: why Last Stand LA exists (Sat Nov 14, 1:35 pm)

The user asked for an audit before going further: the game must serve a purpose, stay grounded in the CoStar data, be agentic, and still be fun.

## 1. The purpose (unchanged since the original plan)

CoStar's records are only true if someone checks them. Today a researcher checks one building at a time: permits, photos, tours. Retrofit Radar is a deep agent that does the researcher's job:
- it finds where CoStar disagrees with the city, the aerials or the interior;
- it decides which evidence to check, including looking at the images itself;
- code weighs the evidence;
- it drafts a correction a person approves.

The queue holds **328 open cases:** 273 ghost tenants, 37 material conflicts and 18 stale entries.

**The one thing the agent can't do from data is see the building with human eyes.** Human reports are already a first-class kind of evidence (`record_note`, then `human_report`, capped at 0.35).

## 2. Why a game (the answer)

**The game turns the researcher's hardest step, ground truth, into play.**
- The agent works the real queue and **dispatches the player** to the open cases it can't settle from data.
- The player goes there, through a zombie night that makes every record matter ("is this building's concrete real? are people still in that suite?"), and **reports what they see**.
- The report becomes capped evidence in the **real case**. At dawn the player's night has produced **real draft corrections**, and the same agent is shown working the other cases as the auditor.

**Fun:** survival pressure, choices with stakes, a walk-in reveal.
**Purpose:** every objective is a real open case, and every report is real evidence.

## 3. What the data actually supports in the play area

From `/cases/queue` and `/game/district`, verified at 1:30 pm:

| Queue # | Case | Building | Data and evidence on hand | In the game today? |
|---|---|---|---|---|
| **6** | material_conflict | 6375735 (the hero) | CoStar masonry vs the city's non-ductile concrete list; unfinished order; MMI; vision read "exposed concrete frame" (cached); **its own Matterport twin** (top-floor loft) | ✅ the fortress and the walls question |
| **7** | **ghost_tenant, suite 1100** | 254167 (the "safe room") | CoStar records **a 3-person office**; the suite is listed for lease; **the Matterport tour we show IS suite 1100**; 51 tenancies in the building | ❌ shown only as scenery |
| 5, 21, 25 | material_conflict + 2 ghost tenants | 256390 | In the district (900 m), outside the play area; outline unreliable | ❌ |
| 24 | ghost_tenant, suite 200 | 52227 | In the district, outside the play area; "a 50-person office" | ❌ |

**Not supported by data** (keep only as labelled game items, or cut):
- supplies and crates (tenant industries are all "office");
- survivors' identities;
- stairs, exits, parking, tuck-under.

## 4. Audit of the current build

| Element | Serves the purpose? | Verdict |
|---|---|---|
| Walk, zombies, flashlight, sound | Fun wrapper; makes "which record is true" feel urgent | **Keep** |
| Hero material conflict + walls report inside the real twin | Real case #6; the player's report is real evidence | **Keep (core)** |
| Agent HOLD/RUN, fallback, code rolls against walls and quake | The agent decides; code computes from the case posterior and city data | **Keep** |
| Aftershock debris near unfinished retrofit orders (labelled) | City list + Northridge MMI | **Keep** |
| HQ panel (todos, squads, evidence, odds) | Shows the agent working | **Keep** |
| Fictional survivors at random spots | Not grounded | **Change:** make them the **people on record** in case #7's suite. Whether anyone's there is the case question |
| Crates (boards, medkits) | No data | **Shrink:** boards only, labelled game item, for the barricade. Drop medkits if time is short |
| Score (survivors, crates, health, time) | Not the purpose | **Change:** score = **records verified** (cases moved, corrections filed) + survival |
| Dawn "File the report" → auditor | Two doors: the product | **Keep** (built: `/?check=<pid>&from=laststand`) |
| Missions chosen by the director | The agent should choose | **Change:** the agent briefs the night from the real queue (below) |

## 5. Who decides what ("the agent decides every decision")

An LLM call takes 4-20 s, so it can't steer 60 frames a second. The honest, buildable split:

| Layer | Decides | Examples |
|---|---|---|
| **The deep agent** (laststand graph) | **Every strategic decision:** tonight's plan, which evidence to check, what to ask the player to look at, the fortress, HOLD or RUN, the fallback, which corrections to draft | The briefing picks cases #6 and #7 and writes the todos; it chooses look_from_above + compliance_filings; it proposes RUN to 9629605 |
| **Code (tools the agent calls)** | **Every number:** odds, caps, scores, rolls, wave sizes, routes | `weigh_case`, `fortress.resolve`, A* route |
| **Game engine** | Real-time execution: movement, zombie steering, collisions, effects | 60 fps |

The pitch line: "**The agent makes the calls, code does the maths, the engine runs the night.**"

## 6. Recommended plan: "The Night Shift" (two cases, two doors)

1. **Briefing** (new agent message, about 10 s, during the intro): "Brief the night shift." The agent pulls the open cases inside the play area (a new code tool, `cases_nearby`), picks tonight's two (#6 and #7), and writes the plan as todos. The HQ panel shows them as **missions**.
2. **Case #6, the fortress:** scout 737 Broadway, go in, report the walls. Unchanged.
3. **Case #7, people on record:** "CoStar says 3 people work in suite 1100 at 122 7th St, but the suite is listed for lease. Are they still there?"
   - The player crosses to 254167 and walks into **suite 1100's real tour**: empty, people working, or can't tell.
   - The agent weighs it with listing_timeline, lease_terms and suite_tour.
   - If it leans "still there", the player brings the office on record to the fortress (escort). If it leans "gone", nobody's at risk, and the record is likely stale: a correction.
4. **Night:** the agent's HOLD/RUN as now; debris; the code roll.
5. **Dawn:** "Tonight you moved 2 of 328 cases."
   - The two draft corrections appear for approval (**File the report**).
   - Then the flip to the auditor: the queue, the other 326 cases, the overnight sweep, a texted correction.

**Costs and risks:**

| Area | What it takes |
|---|---|
| Backend (primary) | A `cases_nearby` tool; two more message types in the game prompt ("Brief the night shift", "Check suite 1100 at property 254167", plus 3 suite-tip strings); re-record about 12 replay variants (the script exists). About 2 h |
| Director (lead) | The mission order and the second building; the score as records verified. About 1 h |
| Builders | Nothing thrown away. E's survivors become the office on record; crates shrink; F's HQ panel shows the briefing |
| Timeline | The 4:30 check stays for case #6 plus the night. Case #7 lands by about 6:30. Strict replay rehearsal by 8:00 |
| Fallback | If case #7 isn't stable by 7:00, ship case #6 only (today's flow) plus the auditor flip |

## 7. Not doing

- More objectives without data.
- An LLM steering zombies or movement.
- Companies' names or real people.
- Saying a record is "wrong" (always "the records disagree").
