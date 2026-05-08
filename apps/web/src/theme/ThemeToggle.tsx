import { Button } from "@mobileflow/ui";
import { useTheme } from "./ThemeProvider";

export function ThemeToggle() {
  const { mode, setMode } = useTheme();
  const next = mode === "light" ? "dark" : mode === "dark" ? "system" : "light";
  const label = mode === "light" ? "Light" : mode === "dark" ? "Dark" : "System";
  return (
    <Button variant="ghost" size="sm" onClick={() => setMode(next)} title={`Theme: ${label}`}>
      Theme: {label}
    </Button>
  );
}
