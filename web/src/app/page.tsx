"use client";

import { useStream } from "@langchain/react";
import { useEffect, useRef, useState } from "react";
import { ApprovalBar, PlanPanel, QuakeBanner, SeismicCard, VerifierCard, finalAnswer, latestTool, latestVerify } from "@/components/Panels";
import type { QuakeReplay, SeismicStatus } from "@/lib/contracts";
import { CaseFile, CaseQueue } from "@/components/Cases";
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
  const t0 = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  useEffect(() => {
    if (!stream.isLoading) {
      if (t0.current !== null) setElapsed((Date.now() - t0.current) / 1000);
      t0.current = null;
      return;
    }
    t0.current = t0.current ?? Date.now();
    const id = setInterval(() => t0.current !== null && setElapsed((Date.now() - t0.current) / 1000), 250);
    return () => clearInterval(id);
  }, [stream.isLoading]);
  const open = (pid: string, suite?: string) => {
    const q = suite ? `Check suite ${suite} at building ${pid}: is the tenant on record still there?` : `Check building ${pid}.`;
    setQuestion(q);
    ask(q);
  };
  return (
    <main className={styles.main}>
      <aside className={styles.queuePane}>
        <CaseQueue onOpen={open} busy={stream.isLoading} />
      </aside>
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
        {elapsed !== null && (
          <p className={styles.muted}>{stream.isLoading ? `Investigating… ${elapsed.toFixed(0)} s` : `Answered in ${elapsed.toFixed(0)} s`}</p>
        )}
        <CaseFile messages={stream.messages} loading={stream.isLoading} />
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
        <span>Retrofit Radar · the AI auditor for CoStar&apos;s records: city records, aerial imagery and the inside of the building</span>
        <ApprovalBar stream={stream} />
      </footer>
    </main>
  );
}
