"use client";
// OWNER: builder D (intro, inside, HUD). PLACEHOLDER from the coding lead. Keep the props type.
// The director flies the camera over the district while this shows; onStart hands control to the player.

export type IntroProps = {
  heroLabel: string;
  ready: boolean; // district loaded
  stub: boolean;
  replay: string | null;
  attribution: string | null; // show in the intro credits when present
  onStart(): void; // must be called from a user gesture (click or Enter) so pointer lock can engage
};

export function IntroOverlay({ heroLabel, ready, onStart }: IntroProps) {
  return (
    <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: "rgba(5,7,13,.6)", color: "#fff" }}>
      <div style={{ textAlign: "center" }}>
        <h1>LAST STAND LA</h1>
        <p>The zombies are fake. The weak spots are real.</p>
        <p>Reach {heroLabel || "the building"} before dark.</p>
        <button type="button" disabled={!ready} onClick={onStart}>Start (Enter)</button>
      </div>
    </div>
  );
}
