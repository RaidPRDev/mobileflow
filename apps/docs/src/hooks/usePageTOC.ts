import { useEffect, useState } from "react";

export interface HeadingItem {
  id: string;
  text: string;
  level: number;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

const ANCHOR_SVG = `
<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
</svg>
`;

export function usePageTOC() {
  const [headings, setHeadings] = useState<HeadingItem[]>([]);
  const [activeId, setActiveId] = useState<string>("");

  useEffect(() => {
    const article = document.querySelector(".doc-article");
    if (!article) return;

    const elements = Array.from(article.querySelectorAll("h2, h3"));
    const items: HeadingItem[] = [];

    elements.forEach((el) => {
      const text = el.textContent || "";
      const id = slugify(text);
      el.id = id;

      // Inject anchor link if not already present
      if (!el.querySelector(".anchor-link")) {
        const anchor = document.createElement("a");
        anchor.href = `#${id}`;
        anchor.className = "anchor-link";
        anchor.innerHTML = ANCHOR_SVG;
        anchor.setAttribute("aria-label", `Anchor to ${text}`);
        anchor.addEventListener("click", (e) => {
          e.preventDefault();
          window.history.pushState(null, "", `#${id}`);
          const y = el.getBoundingClientRect().top + window.scrollY - 80;
          window.scrollTo({ top: y, behavior: "smooth" });
        });
        el.appendChild(anchor);
      }

      items.push({ id, text, level: el.tagName === "H2" ? 2 : 3 });
    });

    setHeadings(items);
    if (items.length > 0) {
      const first = items[0];
      if (first) setActiveId(first.id);
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const first = visible[0];
        if (first) {
          const id = (first.target as HTMLElement).id;
          if (id) setActiveId(id);
        }
      },
      {
        rootMargin: "-80px 0px -60% 0px",
        threshold: 0,
      }
    );

    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  return { headings, activeId };
}
