# Changelog

## v1.0.0 (2026-10-26)

First public release.

- Live tracking of ORCA runs: status, SCF and optimization convergence,
  geometries, frequencies, thermochemistry, hardware use and output files, in a
  web UI that updates while the job runs. ORCA's own files are never modified.
- Views per job type: SP, Opt, Freq, OptTS, NEB/NEB-TS, IRC, 1D to 3D scans,
  GOAT, MECP, TD-DFT and NMR.
- Phase-aware verdicts, including "Max opt cycles" for optimizations that ran
  out of cycles, and an error class for every failed run.
- `dftstream restart` writes corrected inputs for mechanical failures;
  `dftstream next` writes each step of the transition-state workflow and links
  the runs into a chain.
- Input builder in the UI: SMILES or structure to a validated ORCA input.
- Energies table and cross-experiment comparison with CSV export.
- `dftstream lint` checks inputs before they are queued.
- SLURM support: `dftstream submit` (single jobs and arrays), `dftstream queue`
  and offline journals with `dftstream sync` for compute nodes without network.
- Import of existing outputs, and `dftstream reimport` to re-parse stored
  outputs after an upgrade.
- Optional multi-user mode with organizations, roles, CLI login and machine
  tokens. Off by default.
- Local, Docker and Convex cloud backends; backup and restore script.
- Setup guide for coding agents: `docs/setup-with-agent.md`.
