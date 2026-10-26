# Input presets

Defaults for the input builder. The UI imports these files directly, so a
preset change needs no code change.

| File | Contents |
| --- | --- |
| `jobs.v1.yaml` | job types and the `!` keywords each one adds |
| `methods.v1.yaml` | method, basis and accuracy presets |
| `solvents.v1.yaml` | implicit solvation models and their solvents |

The version is in the file name and in the `version:` field. New entries go
into the existing file. A change to the shape of an entry needs a new `v2`
file, so older clients keep reading the version they understand.

Method presets are the keyword lines most often used in about 1,600 real ORCA
inputs. The `observed` field on each preset holds that count; update it when
the corpus is measured again.

`ui/src/lib/inputBuilder/presets.ts` loads and validates these files. Job ids
must match `JobType` in `wrapper/internal/inputbuild`, so add both together.
