// Physical unit conversions (CODATA). Every energy conversion in the UI must
// import these — never restate the literals, so precision can't drift.
export const HARTREE_TO_KCAL = 627.5094740631;
export const HARTREE_TO_EV = 27.211386245988;
export const HARTREE_TO_KJ = 2625.4996394799;

// Common shorthand alias for HARTREE_TO_KCAL used by the energy/stats libs.
export const EH_TO_KCAL = HARTREE_TO_KCAL;
