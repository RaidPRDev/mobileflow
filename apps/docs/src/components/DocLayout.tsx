import { useState } from "react";
import { Outlet } from "react-router-dom";
import { TopNav } from "./TopNav";
import { Sidebar } from "./Sidebar";
import { TableOfContents } from "./TableOfContents";

export function DocLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="doc-layout">
      <TopNav onMenuToggle={() => setMobileOpen((s) => !s)} />
      <div className="doc-body">
        <Sidebar mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} />
        <main className="doc-main">
          <article className="doc-article">
            <Outlet />
          </article>
        </main>
        <aside className="doc-toc">
          <TableOfContents />
        </aside>
      </div>
    </div>
  );
}
