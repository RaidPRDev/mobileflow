import { useEffect, useRef, useState } from "react";
import { ThemeToggle } from "./ThemeToggle";

interface TopNavProps {
  onMenuToggle: () => void;
}

export function TopNav({ onMenuToggle }: TopNavProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const searchWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen((s) => !s);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (!searchOpen) return;
    const handler = (e: MouseEvent) => {
      if (!searchWrapRef.current?.contains(e.target as Node)) {
        setSearchOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [searchOpen]);

  return (
    <header className="topnav">
      <div className="topnav-inner">
        <div className="topnav-left">
          <button
            type="button"
            className="topnav-menu-btn"
            onClick={onMenuToggle}
            aria-label="Toggle menu"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <a href="/" className="topnav-brand">
            <span className="topnav-logo">MobileFlow</span>
            <span className="topnav-badge">Docs</span>
          </a>
        </div>

        <div className="topnav-search-wrap" ref={searchWrapRef}>
          <button
            type="button"
            className="topnav-search-trigger"
            onClick={() => setSearchOpen((s) => !s)}
            aria-label="Search"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <span>Search docs...</span>
            <kbd className="search-kbd">Ctrl K</kbd>
          </button>
          {searchOpen && <SearchDropdown onClose={() => setSearchOpen(false)} />}
        </div>

        <div className="topnav-right">
          <a
            href="https://github.com"
            target="_blank"
            rel="noopener noreferrer"
            className="topnav-link"
            aria-label="GitHub"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
          </a>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

interface PageResult {
  path: string;
  title: string;
}

const pages: PageResult[] = [
  { path: "/", title: "Introduction" },
  { path: "/installation", title: "Installation" },
  { path: "/getting-started", title: "Getting Started" },
  { path: "/architecture", title: "Architecture" },
  { path: "/features", title: "Features" },
  { path: "/build-pipeline", title: "Build Pipeline" },
  { path: "/deployment", title: "Deployment" },
  { path: "/plans", title: "Subscription Plans" },
  { path: "/data-model", title: "Data Model" },
];

function SearchDropdown({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const filtered = pages.filter((p) =>
    p.title.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div className="search-dropdown">
      <div className="search-input-wrap">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          autoFocus
          placeholder="Search documentation..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
          }}
        />
        <kbd className="search-kbd mini">Esc</kbd>
      </div>
      <ul className="search-results">
        {filtered.map((p) => (
          <li key={p.path}>
            <a href={p.path} className="search-result" onClick={onClose}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
                <polyline points="10 9 9 9 8 9" />
              </svg>
              <span>{p.title}</span>
            </a>
          </li>
        ))}
        {filtered.length === 0 && (
          <li className="search-no-results">No results found</li>
        )}
      </ul>
    </div>
  );
}
