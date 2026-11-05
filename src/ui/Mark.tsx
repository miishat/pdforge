// The PDForge mark: a folded page with an ember spark at the fold.
export function Mark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="brand-mark">
      <path d="M8 3h11l7 7v17a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill="var(--text)" />
      <path d="M19 3v5a2 2 0 0 0 2 2h5z" fill="var(--accent)" />
      <path d="M11 17h10M11 21h10M11 25h6" stroke="var(--bg-window)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
