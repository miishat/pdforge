// Small persisted preferences. localStorage can be unavailable or full; never let that break the app.
export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`pdforge.${key}`);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function save<T>(key: string, value: T): void {
  try {
    localStorage.setItem(`pdforge.${key}`, JSON.stringify(value));
  } catch {
    /* storage full or blocked: preferences just won't persist */
  }
}
