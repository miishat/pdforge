import { memo, useEffect, useRef } from "react";
import { engine } from "../core/client";
import type { PageSize } from "../core/types";

interface Props {
  docId: number;
  index: number;
  size: PageSize;
  cssScale: number;
  dpr: number;
  /** Whether the page is near the viewport and should hold a rendered bitmap. */
  active: boolean;
}

export const PageView = memo(function PageView({ docId, index, size, cssScale, dpr, active }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderedScale = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!active) {
      canvas.width = 0;
      canvas.height = 0;
      renderedScale.current = null;
      return;
    }
    const target = cssScale * dpr;
    if (renderedScale.current === target) return;
    let cancelled = false;
    // While zooming, the old bitmap stays on screen (stretched) until the sharp one arrives.
    const delay = renderedScale.current === null ? 0 : 140;
    const timer = setTimeout(async () => {
      try {
        const { bitmap } = await engine().call({ op: "render", docId, pageIndex: index, scale: target });
        if (cancelled) return bitmap.close();
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
        bitmap.close();
        renderedScale.current = target;
        canvas.dataset.rendered = "true";
      } catch {
        if (!cancelled) canvas.dataset.rendered = "error";
      }
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, cssScale, dpr, docId, index]);

  return (
    <div
      className="page"
      data-index={index}
      role="img"
      aria-label={`Page ${index + 1}`}
      style={{ width: size.width * cssScale, height: size.height * cssScale }}
    >
      <canvas ref={canvasRef} className="page__canvas" />
    </div>
  );
});
