// OWNER: builder B (horde + feeds). PLACEHOLDER from the coding lead: no live feeds yet.
// createFeeds renders the DRONE and CCTV picture-in-picture views into FEED_RECTS (engine.ts) after the main render.
// `override` lets the director replace a live feed with a real photo (the DOM draws it; the feed skips rendering).

import type { FootCtx, System } from "./engine";

export type FeedSlot = "drone" | "cctv";
export type Feeds = System & {
  /** true = the DOM shows a photo in this slot; skip the live render. */
  setOverride(slot: FeedSlot, on: boolean): void;
  /** Short caption for the live view in each slot, e.g. "CCTV 3 · Building A, NE corner". */
  caption(slot: FeedSlot): string;
};

export function createFeeds(ctx: FootCtx): Feeds {
  void ctx;
  return {
    update() {},
    render() {},
    dispose() {},
    setOverride() {},
    caption: (slot) => (slot === "drone" ? "DRONE · offline" : "CCTV · offline"),
  };
}
