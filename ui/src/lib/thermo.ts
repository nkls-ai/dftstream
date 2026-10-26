// Derived thermochemistry values shared by the energy table, batch exports
// and the reaction profile.

/**
 * G − E(el) in Eh: the total thermal correction ORCA prints as "G-E(el)".
 * Stored runs carry it only when the tracker recorded that line; otherwise
 * it is the Gibbs energy minus the run's final electronic energy, which is
 * the same number whenever the frequencies were computed at the final
 * geometry (Opt+Freq, Freq): ORCA's thermochemistry "Electronic energy" is
 * that run's FINAL SINGLE POINT ENERGY.
 */
export function gMinusElectronicEh(run: {
  gMinusEEh?: number;
  gibbsEh?: number;
  lastEnergy?: number;
}): number | undefined {
  if (run.gMinusEEh != null) return run.gMinusEEh;
  if (run.gibbsEh == null || run.lastEnergy == null) return undefined;
  return run.gibbsEh - run.lastEnergy;
}
