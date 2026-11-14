// Mirrors contracts/*.schema.json. Change both together.

export type Verb = "show_building" | "ghost_compare" | "reveal_levels" | "place_solar";

export interface FrontendAction {
  type: "frontend_action";
  id: string;
  verb: Verb;
  args: Record<string, unknown>;
}

export interface Ack {
  id: string;
  ok: boolean;
  screenshot_jpeg_b64?: string;
  error?: string;
}

export interface Hypothesis {
  key: string;
  title: string;
  status: "supported" | "ruled_out" | "untested";
  evidence: string;
}

export interface VerifyResult {
  property_id: string;
  verdict: "consistent" | "verified_inside_and_out" | "explained" | "likely_explained" | "worth_a_look" | "check_link";
  confidence: "high" | "medium" | "low";
  headline: string;
  initial?: { listed_sqft: number; expected_low_sqft: number; expected_high_sqft: number; gap_pct: number; formula: string };
  hypotheses: Hypothesis[];
  synthetic_data: boolean;
  warnings: string[];
  field_check?: string;
}

/** A LangGraph custom event carries our dict either directly or under `payload`. */
export function asFrontendAction(data: unknown): FrontendAction | null {
  const candidates = [data, (data as { payload?: unknown } | null)?.payload];
  for (const c of candidates) {
    const a = c as Partial<FrontendAction> | null;
    if (a && a.type === "frontend_action" && typeof a.id === "string" && typeof a.verb === "string") {
      return a as FrontendAction;
    }
  }
  return null;
}

export interface SeismicStep { step: string; what: string; due: string | null; extended: boolean; done: string | null; state: string }
export interface SeismicStatus {
  property_id: string;
  address?: string;
  status: "unfinished" | "finished" | "not_listed" | "not_applicable";
  year_built?: number;
  costar_material?: string;
  synthetic?: boolean;
  source?: string;
  lists?: { list: string; order_date?: string; steps: SeismicStep[]; overdue_steps: string[] }[];
  permits?: { issued?: string; status?: string; work?: string }[];
  hypotheses?: { key: string; status: string; evidence: string; past_due?: boolean }[];
}
export interface QuakeReplay {
  replay: true;
  label: string;
  unfinished: number;
  unfinished_shaken_mmi_7_plus: number;
  top: { property_id: string; address?: string; status: string; past_due: boolean; shaking?: { mmi: number } | null }[];
}
