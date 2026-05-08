import { NavLink } from "react-router-dom";

interface NavItem {
  label: string;
  path: string;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const navGroups: NavGroup[] = [
  {
    title: "Overview",
    items: [
      { label: "Introduction", path: "/" },
      { label: "Installation", path: "/installation" },
      { label: "Getting Started", path: "/getting-started" },
    ],
  },
  {
    title: "Core Concepts",
    items: [
      { label: "Architecture", path: "/architecture" },
      { label: "Features", path: "/features" },
      { label: "Build Pipeline", path: "/build-pipeline" },
      { label: "Deployment", path: "/deployment" },
    ],
  },
  {
    title: "Reference",
    items: [
      { label: "Subscription Plans", path: "/plans" },
      { label: "Data Model", path: "/data-model" },
    ],
  },
];

interface SidebarProps {
  mobileOpen: boolean;
  onClose: () => void;
}

export function Sidebar({ mobileOpen, onClose }: SidebarProps) {
  return (
    <>
      {mobileOpen && (
        <div className="sidebar-backdrop" onClick={onClose} aria-hidden="true" />
      )}
      <aside className={mobileOpen ? "sidebar open" : "sidebar"}>
        <nav className="sidebar-nav">
          {navGroups.map((group) => (
            <div key={group.title} className="sidebar-group">
              <h4 className="sidebar-group-title">{group.title}</h4>
              <ul className="sidebar-list">
                {group.items.map((item) => (
                  <li key={item.path}>
                    <NavLink
                      to={item.path}
                      end={item.path === "/"}
                      className={({ isActive }) =>
                        isActive ? "sidebar-link active" : "sidebar-link"
                      }
                      onClick={onClose}
                    >
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>
    </>
  );
}
