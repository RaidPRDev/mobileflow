import { usePageTOC } from "@/hooks/usePageTOC";

export function TableOfContents() {
  const { headings, activeId } = usePageTOC();

  if (headings.length === 0) return null;

  return (
    <nav className="toc">
      <p className="toc-title">On this page</p>
      <ul className="toc-list">
        {headings.map((h) => (
          <li key={h.id} className={h.level === 3 ? "toc-item indented" : "toc-item"}>
            <a
              href={`#${h.id}`}
              className={h.id === activeId ? "toc-link active" : "toc-link"}
              onClick={(e) => {
                e.preventDefault();
                const el = document.getElementById(h.id);
                if (el) {
                  const y = el.getBoundingClientRect().top + window.scrollY - 80;
                  window.scrollTo({ top: y, behavior: "smooth" });
                }
              }}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
