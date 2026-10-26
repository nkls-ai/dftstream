// Compatibility barrel: the scan and NEB tabs were decomposed into
// RunScanTab.tsx / RunNebTab.tsx (with colocated hooks in scanTabData.ts /
// nebTabData.ts and pure logic in scanSurface.ts / nebPath.ts). Existing
// imports of ScanTab / NEBTab from this module keep working.
export { ScanTab } from "./RunScanTab";
export { NEBTab } from "./RunNebTab";
