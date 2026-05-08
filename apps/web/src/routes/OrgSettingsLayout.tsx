import { Outlet } from "react-router-dom";

export function OrgSettingsLayout() {
  return (
    <div className="max-w-4xl">
      <Outlet />
    </div>
  );
}
