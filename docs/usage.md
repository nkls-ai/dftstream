# Using DFTStream

How runs are organized, what the UI shows for each job type, and the
transition-state workflow.

## Experiments and runs

A run is one ORCA invocation. It holds the job type, method, basis, charge,
multiplicity, solvent, status, energies, thermochemistry, geometries,
frequencies, hardware samples, log lines and the files the run produced.

An experiment groups runs that belong together, usually one study or one
substrate. `dftstream run job.inp --exp name` puts the run in that experiment
and creates it if needed. Without `--exp`, the experiment is the input's
directory name.

Each run page has notes and tags. Both are searchable from the runs table.

Existing outputs can be imported. The importer expects
`<root>/<experiment>/<run>/*.out`:

```bash
dftstream import-experiments ~/calculations
```

## Your files are never modified

Every `.gbw`, `.hess`, `.out` or `.xyz` written under DFTStream is identical,
byte for byte, to what a plain `orca job.inp` would write. The wrapper starts
ORCA from the input's directory, exactly as you would by hand. Tools that
re-save what they open, such as `orca_plot` and `orca_pltvib`, only ever run on
copies in a scratch directory.

## Job types

DFTStream reads the job type from the input and shows the matching views.

| Type | What you get |
| --- | --- |
| `SP` | SCF convergence, electronic properties, orbitals, dipole |
| `Opt` | trajectory playback, energy and gradient per cycle |
| `Freq` | IR spectrum, mode animation, thermochemistry with every correction term |
| `OptTS` | TS verdict, imaginary-mode animation, spectrum, thermochemistry |
| `NEB`, `NEB-CI`, `NEB-TS` | band energy profile, initial path, per-image table |
| `IRC` | energy profile in both directions with structure playback |
| `Scan` (1D, 2D, 3D) | scan table, energy curve, surface plot |
| `GOAT` | conformer ensemble with relative energies and populations |
| `MECP` | energies of both states and the gap per cycle |
| `TD-DFT` | excited states, oscillator strengths, UV-Vis spectrum |
| `NMR` | shielding table and simulated spectrum |

## Verdicts

ORCA prints `ORCA TERMINATED NORMALLY` even when an optimization ran out of
cycles, so DFTStream judges a run by what happened in each phase, not by that
line.

- An optimization that hit its cycle limit shows **Max opt cycles**.
  `dftstream restart` writes the continuation from the last geometry.
- Frequencies computed before an optimization converged never count as the
  run's imaginary modes or thermochemistry.
- A NEB-TS counts as converged only when its final TS optimization converged.
- A failed run carries an error class (SCF not converged, out of memory,
  impossible charge/multiplicity and so on), so a failed batch groups by cause.

## Comparing energies

The Energies tab lists every run of an experiment with electronic energy, Gibbs
energy, ΔE and ΔG against the lowest run, and a triage column (OK, Imag, Freq
broke, Opt broke). Filter, select and export to CSV. Relative energies default
to kcal/mol; Settings switches to Hartree, kJ/mol or eV.

Runs from different experiments can be compared too: add them to the compare
basket (⇄ on a run row) and open it.

## Transition-state workflow

`dftstream next` writes the input for each step of the usual chain from the run
before it, reusing that run's method, resources, charge and multiplicity.

```bash
dftstream next neb-ts reactant.out product.out   # NEB-TS between two minima
dftstream next irc ts.out                        # IRC from a validated TS
dftstream next opt-endpoints irc.out             # Opt Freq for both IRC endpoints
dftstream next sp min.out -method "! DLPNO-CCSD(T) cc-pVTZ cc-pVTZ/C TightSCF"
```

Each generator refuses to write an input it knows is wrong. NEB endpoints must
match in atom count, element order, charge and multiplicity. An IRC needs a
source with exactly one imaginary mode, and it reuses that run's `.hess`.

Generated inputs start with a comment that names their parent run. ORCA ignores
it; DFTStream uses it to link the new run to its parent. The experiment page
shows each chain as a tree, and any selection of runs from it becomes a
reaction profile with barriers and reaction energies. The same generators are
available from the chain button on every run page.

## Restarting failed runs

```bash
dftstream restart run.out          # write run_restart.inp next to the output
dftstream restart -dry-run run.out # show the change, write nothing
```

`restart` classifies the failure and, when the fix is mechanical, writes a
corrected input. The table of what it does per failure is in
[cli.md](cli.md#restart). Failures that need a person, such as an impossible
charge/multiplicity, are explained instead.

## Common ORCA failures

| Symptom | Usual cause | Fix |
| --- | --- | --- |
| Run dies in a module with no clear error | memory, scratch or disk | raise `%maxcore`, check scratch space, keep scratch off network drives |
| "Not enough memory" | `%maxcore` × processes too high or too low | stay under about 75% of RAM; `dftstream lint` checks this |
| Imaginary modes of 10 to 100 cm⁻¹ | numerical noise | finer grid (`DefGrid3`), tighter optimization thresholds |
| Several large imaginary modes | a saddle point, not a minimum | displace the start geometry and reoptimize |
| SCF does not converge | wrong charge or multiplicity, linear dependence | check charge/multiplicity, add solvation, change guess or converger |
| Energy rises during an optimization | grid noise in the gradient | finer integration and COSX grids |
| "UNSTABLE HF/KS wave function" | saddle point in orbital space | switch to an unrestricted reference and reconverge |

`dftstream lint job.inp` catches impossible charge/multiplicity, memory past the
machine's RAM, missing `xyzfile`s, keyword typos and stray non-ASCII characters
before you queue anything. `dftstream run` runs the same checks and prints
warnings, but never blocks the run.
