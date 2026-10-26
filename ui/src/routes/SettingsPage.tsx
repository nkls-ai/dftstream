import { useSettings, type Settings } from "../lib/settings";
import { ENERGY_UNIT_OPTIONS } from "../lib/energyUnits";
import { STORAGE_KEYS } from "../lib/storageKeys";
import {
  SettingsSection,
  SettingsSelectRow,
  SettingsToggleRow,
} from "../components/SettingsControls";
import { IRScaleFactorEditor } from "../components/IRScaleFactorEditor";
import { OrgSettings } from "./OrgSettings";

export function SettingsPage() {
  const [s, update] = useSettings();

  const onDesktopNotificationsChange = (enabled: boolean) => {
    if (enabled && "Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().then(
        (perm) => { update({ desktopNotifications: perm === "granted" }); },
        () => { /* browser blocked the permission request */ },
      );
    } else {
      update({ desktopNotifications: enabled });
    }
  };

  return (
    <>
      <div className="page-header">
        <h1>Settings</h1>
      </div>

      <div className="settings-layout">
        <OrgSettings />
        <SettingsSection title="Theme">
          <div className="settings-rows">
            <div className="settings-row">
              <div className="settings-row-label">Appearance</div>
              <div className="theme-switcher">
                <button type="button"
                  className={"theme-btn" + (s.theme === "dark" ? " active" : "")}
                  onClick={() => update({ theme: "dark" })}
                >
                  Dark
                </button>
                <button type="button"
                  className={"theme-btn" + (s.theme === "light" ? " active" : "")}
                  onClick={() => update({ theme: "light" })}
                >
                  Light
                </button>
              </div>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection title="Interface">
          <div className="settings-rows">
            <SettingsToggleRow
              label="Simple mode"
              desc="Hide SCF tab, collapse thermochemistry and IR sections"
              checked={s.simpleMode}
              onChange={(checked) => update({ simpleMode: checked })}
            />
            <SettingsSelectRow
              label="Experiments per page"
              desc="Controls how many experiment summaries load at once. Use 10 for quick development checks."
              value={s.experimentPageSize}
              options={[
                { value: 10, label: "10 (dev)" },
                { value: 50, label: "50 (default)" },
                { value: 100, label: "100" },
              ]}
              onChange={(raw) => update({ experimentPageSize: Number(raw) as Settings["experimentPageSize"] })}
            />
          </div>
        </SettingsSection>

        <SettingsSection title="Display">
          <div className="settings-rows">
            <SettingsSelectRow
              label="Energy precision"
              value={s.energyDecimals}
              options={[
                { value: 6, label: "6 decimals" },
                { value: 8, label: "8 decimals" },
                { value: 10, label: "10 decimals" },
                { value: 12, label: "12 decimals" },
              ]}
              onChange={(raw) => update({ energyDecimals: Number(raw) as Settings["energyDecimals"] })}
            />
            <SettingsSelectRow
              label="Relative energy unit"
              desc="Unit for ΔE / ΔG columns and exports. Absolute energies always stay in Hartree."
              value={s.energyUnit}
              options={ENERGY_UNIT_OPTIONS}
              onChange={(raw) => update({ energyUnit: raw as Settings["energyUnit"] })}
            />
            <SettingsSelectRow
              label="Time format"
              value={s.timeFormat}
              options={[
                { value: "locale", label: "System locale" },
                { value: "24h", label: "24-hour" },
              ]}
              onChange={(raw) => update({ timeFormat: raw as Settings["timeFormat"] })}
            />
          </div>
        </SettingsSection>

        <SettingsSection title="Notifications">
          <div className="settings-rows">
            <SettingsToggleRow
              label="Desktop notifications"
              desc="Show system notifications when a job finishes or fails (browser tab can be in background)"
              checked={s.desktopNotifications}
              onChange={onDesktopNotificationsChange}
            />
          </div>
        </SettingsSection>

        <SettingsSection title="3D Viewer">
          <div className="settings-rows">
            <SettingsSelectRow
              label="Molecule style"
              value={s.viewerStyle}
              options={[
                { value: "ball-stick", label: "Ball & stick" },
                { value: "stick", label: "Stick" },
                { value: "line", label: "Line" },
                { value: "spacefill", label: "Spacefill" },
              ]}
              onChange={(raw) => update({ viewerStyle: raw as Settings["viewerStyle"] })}
            />
            <SettingsToggleRow
              label="Auto-rotate"
              checked={s.viewerSpin}
              onChange={(checked) => update({ viewerSpin: checked })}
            />
          </div>
        </SettingsSection>

        <SettingsSection title="IR Scaling Factors">
          <div className="settings-row-desc" style={{ marginBottom: 8 }}>
            Custom frequency scaling factors per method/basis. Applied to IR and frequency spectra before plotting.
          </div>
          <IRScaleFactorEditor
            factors={s.irScaleFactors}
            onChange={(factors) => update({ irScaleFactors: factors })}
          />
        </SettingsSection>

        <div className="settings-footer">
          <button
            type="button"
            className="settings-reset-link"
            onClick={() => {
              try {
                localStorage.removeItem(STORAGE_KEYS.settings);
              } catch {
                // storage disabled (private browsing) — reload still re-reads defaults
              }
              window.location.reload();
            }}
          >
            Reset to defaults
          </button>
          <span className="settings-version">{window.__DFTSTREAM_VERSION__ ?? "dev"}</span>
        </div>
      </div>
    </>
  );
}
