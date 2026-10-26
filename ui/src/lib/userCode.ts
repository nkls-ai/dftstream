// The short `dftstream login` user code, in the one canonical form the
// backend stores ("BCDF-GHJK"). Mirrors db/convex's normalizeUserCode so a
// code typed in lowercase, without the dash, or with stray spaces still
// matches: uppercase, keep only [A-Z0-9], and re-insert the dash after the
// 4th character when the result has the canonical 8 characters.

const USER_CODE_LENGTH = 8;
const USER_CODE_GROUP = USER_CODE_LENGTH / 2;

export function normalizeUserCode(raw: string): string {
  const compact = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compact.length !== USER_CODE_LENGTH) return compact;
  return `${compact.slice(0, USER_CODE_GROUP)}-${compact.slice(USER_CODE_GROUP)}`;
}
