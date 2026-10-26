import { NavLink } from "react-router-dom";
import { useSettings } from "../lib/settings";
import { routes } from "../lib/routes";
import { NotificationBell } from "./NotificationBell";
import { useOrg } from "../auth/OrgContext";
import { useAuthSession } from "../auth/AuthSession";
import { useDataSource } from "../data/DataSource";
import { usePrompt, useAlert } from "./Confirm";
import { reportError, userErrorMessage } from "../lib/errorReporting";
import logoUrl from "../../../assets/logo.png";

const NEW_ORG = "__new__";

// Organization switcher + sign-out, shown only when auth is enabled. Lets the
// user pick their active org (which scopes every list query) or create one.
function OrgControls({ collapsed }: { collapsed: boolean }) {
  const org = useOrg();
  const ds = useDataSource();
  const { signOut } = useAuthSession();
  const prompt = usePrompt();
  const alert = useAlert();
  if (!org.authEnabled) return null;

  async function onChange(value: string) {
    if (value === NEW_ORG) {
      const name = await prompt({
        title: "New organization",
        message: "Name your organization",
        placeholder: "Acme Lab",
      });
      if (!name) return;
      try {
        const { organizationId } = await ds.createOrg(name);
        org.setActiveOrg(organizationId);
      } catch (err) {
        await alert({ title: "Could not create organization", message: userErrorMessage(err, "create organization") });
      }
      return;
    }
    org.setActiveOrg(value);
  }

  if (collapsed) return null;
  return (
    <div className="org-controls">
      <select
        className="org-select"
        value={org.activeOrgId ?? ""}
        onChange={(e) => void onChange(e.target.value)}
        aria-label="Active organization"
      >
        {org.orgs.length === 0 && <option value="">No organizations</option>}
        {org.orgs.map((o) => (
          <option key={o.organizationId} value={o.organizationId}>
            {o.name} · {o.role}
          </option>
        ))}
        <option value={NEW_ORG}>+ New organization…</option>
      </select>
      <button
        type="button"
        className="org-signout"
        onClick={() => {
          signOut().catch(async (err: unknown) => {
            // Still signed in: tell the user instead of leaving a dead button.
            reportError(err, { source: "sidebar", action: "sign out" });
            await alert({ title: "Could not sign out", message: userErrorMessage(err, "sign out") });
          });
        }}
        title="Sign out"
      >
        Sign out
      </button>
    </div>
  );
}

function FlaskIcon() {
  return (
    <svg
      className="nav-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 3h6M10 3v7.4L4 18a1 1 0 0 0 .87 1.5h14.26A1 1 0 0 0 20 18l-6-7.6V3" />
    </svg>
  );
}

function ToolsIcon() {
  return (
    <svg
      className="nav-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  );
}

function NewInputIcon() {
  return (
    <svg
      className="nav-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9" />
      <polyline points="14 3 14 10 20 10" />
      <line x1="12" y1="12" x2="12" y2="18" />
      <line x1="9" y1="15" x2="15" y2="15" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg
      className="nav-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}

function getVersion(): string {
  return window.__DFTSTREAM_VERSION__ ?? "dev";
}

function ThemeToggle() {
  const [settings, update] = useSettings();
  const dark = settings.theme === "dark";
  return (
    <label className="theme-switch" aria-label="Toggle dark / light mode">
      <MoonIcon />
      <input
        type="checkbox"
        checked={!dark}
        onChange={(e) => update({ theme: e.target.checked ? "light" : "dark" })}
      />
      <span className="theme-switch-track">
        <span className="theme-switch-thumb" />
      </span>
      <SunIcon />
    </label>
  );
}

function CollapseIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ width: 16, height: 16, transition: "transform 0.2s" }}
    >
      {collapsed ? (
        <polyline points="9 18 15 12 9 6" />
      ) : (
        <polyline points="15 18 9 12 15 6" />
      )}
    </svg>
  );
}

export function Sidebar() {
  const [settings, update] = useSettings();
  const collapsed = settings.sidebarCollapsed;

  const toggle = () => update({ sidebarCollapsed: !collapsed });

  return (
    <aside className={"sidebar" + (collapsed ? " collapsed" : "")}>
      <NavLink to={routes.experiments} className="brand" title="Experiments">
        <img src={logoUrl} alt="" className="brand-logo" />
        {!collapsed && <span>DFTStream</span>}
      </NavLink>
      <NavLink
        to={routes.experiments}
        className={({ isActive }) =>
          "nav-item" + (isActive ? " active" : "")
        }
        title="Experiments"
      >
        <FlaskIcon />
        {!collapsed && <span>Experiments</span>}
      </NavLink>
      <NavLink
        to={routes.newInput}
        className={({ isActive }) =>
          "nav-item" + (isActive ? " active" : "")
        }
        title="New input"
      >
        <NewInputIcon />
        {!collapsed && <span>New input</span>}
      </NavLink>
      <NavLink
        to={routes.tools}
        className={({ isActive }) =>
          "nav-item" + (isActive ? " active" : "")
        }
        title="Tools"
      >
        <ToolsIcon />
        {!collapsed && <span>Tools</span>}
      </NavLink>
      <OrgControls collapsed={collapsed} />
      <div className="sidebar-bottom">
        <NotificationBell collapsed={collapsed} />
        <NavLink
          to={routes.settings}
          className={({ isActive }) =>
            "nav-item" + (isActive ? " active" : "")
          }
          title="Settings"
        >
          <GearIcon />
          {!collapsed && <span>Settings</span>}
        </NavLink>
        {!collapsed && <ThemeToggle />}
        {!collapsed && <div className="sidebar-version">{getVersion()}</div>}
      </div>
      <button type="button"
        className="sidebar-edge-toggle"
        onClick={toggle}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        <CollapseIcon collapsed={collapsed} />
      </button>
    </aside>
  );
}
