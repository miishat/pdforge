import { useEffect, useRef, useState } from "react";
import { engine } from "../../core/client";
import type { DocInfo } from "../../core/types";
import { setFullscreen } from "../../platform";

/** Full-screen, one page at a time. Arrows/Space/click to move, Esc to leave. */
export function Presentation({ info, start, onExit }: { info: DocInfo; start: number; onExit: (page: number) => void }) {
  const [page, setPage] = useState(start);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [hint, setHint] = useState(true);
  const canvas = useRef<HTMLCanvasElement>(null);
  const pageRef = useRef(page);
  pageRef.current = page;

  useEffect(() => {
    void setFullscreen(true);
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      void setFullscreen(false);
    };
  }, []);

  useEffect(() => {
    const go = (d: number) => setPage((p) => Math.max(0, Math.min(info.pageCount - 1, p + d)));
    const onKey = (e: KeyboardEvent) => {
      const keys: Record<string, () => void> = {
        ArrowRight: () => go(1),
        ArrowDown: () => go(1),
        PageDown: () => go(1),
        " ": () => go(e.shiftKey ? -1 : 1),
        Enter: () => go(1),
        ArrowLeft: () => go(-1),
        ArrowUp: () => go(-1),
        PageUp: () => go(-1),
        Backspace: () => go(-1),
        Home: () => setPage(0),
        End: () => setPage(info.pageCount - 1),
        Escape: () => onExit(pageRef.current),
      };
      const fn = keys[e.key];
      if (fn) {
        e.preventDefault();
        e.stopImmediatePropagation();
        fn();
      }
    };
    window.addEventListener("keydown", onKey, true);
    // Safari's engine leaves full screen on Esc without passing the key on, so leaving full screen ends the
    // presentation too.
    let entered = false;
    const onFullscreen = () => {
      if (document.fullscreenElement) entered = true;
      else if (entered) onExit(pageRef.current);
    };
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("fullscreenchange", onFullscreen);
    };
  }, [info.pageCount, onExit]);

  // Show the page counter briefly after each change.
  useEffect(() => {
    setHint(true);
    const t = setTimeout(() => setHint(false), 1600);
    return () => clearTimeout(t);
  }, [page]);

  const p = info.pages[page];
  const fit = Math.min(size.w / p.width, size.h / p.height);
  const dpr = window.devicePixelRatio || 1;

  useEffect(() => {
    const ctrl = new AbortController();
    engine()
      .render({ docId: info.docId, pageIndex: page, scale: fit * dpr, rotation: 0 }, -2, ctrl.signal)
      .then(({ bitmap }) => {
        const c = canvas.current;
        if (!c) return bitmap.close();
        c.width = bitmap.width;
        c.height = bitmap.height;
        c.getContext("2d")?.drawImage(bitmap, 0, 0);
        bitmap.close();
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [info.docId, page, fit, dpr]);

  return (
    <div
      className="presentation"
      role="dialog"
      aria-label="Presentation"
      onClick={(e) => setPage((cur) => Math.max(0, Math.min(info.pageCount - 1, cur + (e.clientX < window.innerWidth / 3 ? -1 : 1))))}
      onContextMenu={(e) => {
        e.preventDefault();
        setPage((cur) => Math.max(0, cur - 1));
      }}
    >
      <canvas ref={canvas} style={{ width: p.width * fit, height: p.height * fit }} />
      <div className="presentation__hint" data-visible={hint}>
        {page + 1} / {info.pageCount} · Esc to exit
      </div>
    </div>
  );
}
