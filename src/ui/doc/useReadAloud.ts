import { useCallback, useEffect, useRef, useState } from "react";
import type { DocData } from "./docData";

export type ReadAloudStatus = "idle" | "playing" | "paused";

/** Splits text into sentence-sized chunks; long utterances get cut off by some speech engines. */
export function chunkText(text: string, max = 220): string[] {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return [];
  const sentences = flat.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [flat];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + s).length > max && cur) {
      out.push(cur.trim());
      cur = "";
    }
    if (s.length > max) {
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max).trim());
    } else cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export const speechAvailable = typeof window !== "undefined" && "speechSynthesis" in window;

/** Reads pages aloud with the system voices, moving on page by page. */
export function useReadAloud(data: DocData, pageCount: number, onPage: (page: number) => void) {
  const [status, setStatus] = useState<ReadAloudStatus>("idle");
  const [page, setPage] = useState(0);
  const [rate, setRate] = useState(1);
  const run = useRef(0);
  const rateRef = useRef(rate);
  rateRef.current = rate;

  const stop = useCallback(() => {
    run.current++;
    if (speechAvailable) speechSynthesis.cancel();
    setStatus("idle");
  }, []);

  const start = useCallback(
    async (from: number) => {
      if (!speechAvailable) return;
      const my = ++run.current;
      speechSynthesis.cancel();
      setStatus("playing");
      for (let p = from; p < pageCount; p++) {
        if (run.current !== my) return;
        setPage(p);
        onPage(p);
        const text = (await data.textLayer(p)).text;
        for (const chunk of chunkText(text)) {
          if (run.current !== my) return;
          await new Promise<void>((resolve) => {
            const u = new SpeechSynthesisUtterance(chunk);
            u.rate = rateRef.current;
            u.onend = () => resolve();
            u.onerror = () => resolve();
            speechSynthesis.speak(u);
          });
        }
      }
      if (run.current === my) setStatus("idle");
    },
    [data, pageCount, onPage],
  );

  const pause = useCallback(() => {
    speechSynthesis.pause();
    setStatus("paused");
  }, []);
  const resume = useCallback(() => {
    speechSynthesis.resume();
    setStatus("playing");
  }, []);

  useEffect(() => stop, [stop]);

  return { status, page, rate, setRate, start, pause, resume, stop };
}
