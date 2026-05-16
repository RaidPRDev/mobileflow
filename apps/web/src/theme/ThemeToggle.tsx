import { Moon, Sun } from "lucide-react";
import { useTheme } from "./ThemeProvider";

export function ThemeToggle() {
  const { mode, resolved, setMode } = useTheme();
  const next = mode === "light" ? "dark" : mode === "dark" ? "system" : "light";
  const label = mode === "light" ? "Light" : mode === "dark" ? "Dark" : "System";
  return (
    <button
      type="button"
      className="theme-toggle tooltip-wrap"
      onClick={() => setMode(next)}
      aria-label={`Theme: ${label}`}
    >
      {resolved === "dark" ? <Moon size={16} /> : <Sun size={16} />}
      <span className="tooltip-bubble tooltip-bubble--end" role="tooltip">
        {`Theme: ${label}`}
      </span>
    </button>
  );
}
