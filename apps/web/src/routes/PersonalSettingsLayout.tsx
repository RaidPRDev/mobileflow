import { NavLink, Outlet } from "react-router-dom";
import { cn } from "@mobileflow/ui";

const TABS = [{ to: "/settings/account", label: "Account" }];

export function PersonalSettingsLayout() {
  return (
    <div className="page personal-settings">
      <h1 className="page-title">Personal Settings</h1>
      <nav className="personal-settings-tabs" aria-label="Personal settings sections">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end
            className={({ isActive }) =>
              cn("personal-settings-tab", isActive && "is-active")
            }
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
