"use client";
// OWNER: builder F (HQ panel). PLACEHOLDER from the coding lead. Keep the props type.
// "The agent at work": its own todo list, the four squads, the evidence it chose, the case odds. All from the stream.

export type HqProps = {
  messages: readonly unknown[]; // the laststand thread (LangChain messages, as in useGame)
  busy: boolean; // a run is in progress
  heroPid: string | null; // the building being scouted
  compact: boolean; // true while walking (small), false when there's room (inside, night decision)
};

export function HqPanel({ messages, busy }: HqProps) {
  return (
    <div style={{ background: "rgba(5,7,13,.7)", color: "#cbd5e1", padding: 8, font: "12px system-ui" }}>
      HQ {busy ? "· working" : ""} · {messages.length} messages
    </div>
  );
}
