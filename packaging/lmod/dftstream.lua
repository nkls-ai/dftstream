-- Example Lmod modulefile for DFTStream on an HPC cluster.
--
-- Install layout this file assumes (adjust `root` to your site):
--   /opt/sw/dftstream/<version>/bin/dftstream
-- e.g. unpack the release tarball's `dftstream` binary into that bin/.
--
-- Site install:
--   1. Copy this file to your modulefiles tree as
--      dftstream/<version>.lua  (e.g. /opt/sw/modulefiles/dftstream/1.0.0.lua)
--   2. Edit `root` and the DFTSTREAM_* hints below.
--   3. `module load dftstream/<version>`
--
-- The wrapper needs to find ORCA and the tracker backend. Both can be
-- baked into the module so users only ever type
-- `dftstream run input.inp --exp name`.

local version = myModuleVersion()
local root    = pathJoin("/opt/sw/dftstream", version)

help([[
DFTStream — run wrapper and live tracker for ORCA.

Usage:
    dftstream run input.inp --exp my-experiment > input.out

The module puts `dftstream` on PATH. ORCA itself is NOT part of this
module; load your site's ORCA module first (or set DFTSTREAM_ORCA).
]])

whatis("Name        : DFTStream")
whatis("Version     : " .. version)
whatis("Description : Run wrapper and live tracker for ORCA quantum chemistry jobs")
whatis("URL         : https://github.com/nkls-ai/dftstream")

-- ORCA runs under MPI; most sites make the orca module a prerequisite.
-- Uncomment and adapt:
-- depends_on("orca/6.0.1")

prepend_path("PATH", pathJoin(root, "bin"))

-- ---------------------------------------------------------------------
-- Environment hints (site-specific — edit before deploying)
-- ---------------------------------------------------------------------

-- Full path to the ORCA binary dftstream should exec. If the orca
-- module already puts `orca` on PATH this is optional, but pinning it
-- avoids surprises when several ORCA versions are installed.
-- setenv("DFTSTREAM_ORCA", "/opt/sw/orca/6.0.1/orca")

-- Tracker backend for the whole group. Point at your group's Convex
-- deployment (self-hosted docker: convex+http://server:16767).
-- setenv("DFTSTREAM_TRACKER_URL", "convex+http://tracker.example.edu:3210")

-- Machine token for non-interactive auth from batch jobs, if your
-- deployment requires auth. Prefer per-user tokens over a shared one;
-- users can also set this themselves in the job script.
-- setenv("DFTSTREAM_TOKEN", "…")
