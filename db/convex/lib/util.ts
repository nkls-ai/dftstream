// Small pure utilities shared across Convex modules. Everything here is
// side-effect free and unit-tested without convex-test (see util.test.ts).

// pick returns a new object with only the given keys of `obj`. Used to derive
// mutation arg validators as subsets of the shared schema column objects
// without re-declaring (and risking drift from) any field validator.
export function pick<T extends Record<string, unknown>, const K extends keyof T>(
  obj: T,
  keys: readonly K[],
): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) out[key] = obj[key];
  return out;
}

// stripUndefined drops undefined-valued entries so the result is safe to pass
// to ctx.db.patch (Convex rejects `undefined` as a document value; omitting a
// key leaves the stored field untouched).
export function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

// requireNonEmptyName trims `name` and throws when nothing remains. `label`
// keeps each call site's exact user-facing message (e.g. "batch name cannot
// be empty").
export function requireNonEmptyName(name: string, label = "name"): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} cannot be empty`);
  }
  return trimmed;
}
