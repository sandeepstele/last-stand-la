"use client";

import { useStream } from "@langchain/react";
import { useRef, useState } from "react";
import { ApprovalBar, PlanPanel, QuakeBanner, SeismicCard, VerifierCard, finalAnswer, latestTool, latestVerify } from "@/components/Panels";
import type { QuakeReplay, SeismicStatus } from "@/lib/contracts";
import { WorldPane, type WorldHandle } from "@/components/WorldPane";
import { useSceneActions } from "@/lib/useSceneActions";
import styles from "./page.module.css";

// Local: `langgraph dev` on :2024 needs no key. Deployed: put a server-side proxy in front
// (never expose LANGSMITH_API_KEY through a NEXT_PUBLIC_ variable).
const API_URL = process.env.NEXT_PUBLIC_LANGGRAPH_URL ?? "http://127.0.0.1:2024";

export default function LiveRun() {
  const stream = useStream({ assistantId: "radar", apiUrl: API_URL });
  const world = useRef<WorldHandle>(null);
  const [question, setQuestion] = useState("Check building 247337.");
  const ask = (q: string) => void stream.submit({ messages: [{ type: "human", content: q }] });

  useSceneActions(stream, async (action) =>
    world.current ? world.current.perform(action) : { id: action.id, ok: false, error: "world pane not mounted" },
  );

  const answer = finalAnswer(stream.messages);
  return (
    <main className={styles.main}>
      <div className={styles.worldPane}>
        <WorldPane ref={world} />
      </div>
      <aside className={styles.agentPane}>
        <form
          className={styles.ask}
          onSubmit={(e) => {
            e.preventDefault();
            ask(question);
          }}
        >
          <input value={question} onChange={(e) => setQuestion(e.target.value)} aria-label="Question" />
          <button disabled={stream.isLoading}>{stream.isLoading ? "Working…" : "Ask"}</button>
          <button type="button" disabled={stream.isLoading}
                  onClick={() => ask("Replay the 1994 Northridge earthquake against our Los Angeles buildings.")}>
            Replay Northridge 1994
          </button>
        </form>
        <QuakeBanner result={latestTool<QuakeReplay>(stream.messages, "quake_replay")} />
        <PlanPanel stream={stream} />
        <SeismicCard result={latestTool<SeismicStatus>(stream.messages, "seismic_status")} />
        <VerifierCard result={latestVerify(stream.messages)} />
        {answer && (
          <section className={styles.card}>
            <h2>Answer</h2>
            <p>{answer}</p>
          </section>
        )}
      </aside>
      <footer className={styles.strip}>
        <span>Retrofit Radar · city retrofit orders vs CoStar records vs measured buildings</span>
        <ApprovalBar stream={stream} />
      </footer>
    </main>
  );
}
