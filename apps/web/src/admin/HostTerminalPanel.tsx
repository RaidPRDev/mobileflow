import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { IconButton } from "@mobileflow/ui";
import { X } from "lucide-react";
import "@xterm/xterm/css/xterm.css";

// Slide-in SSH terminal anchored to the bottom of the viewport. Mounts an
// xterm instance, opens a WS to /api/admin/hosts/:id/terminal, and pipes
// keystrokes/output. Closing the panel (or the X button) closes the WS,
// which tears down the ssh2 channel — SIGHUP propagates to the remote
// shell so any foreground process group is killed.
export function HostTerminalPanel({
  open,
  onClose,
  hostId,
  hostName,
}: {
  open: boolean;
  onClose: () => void;
  hostId: string;
  hostName: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Plays the slide-down animation before we actually unmount + close the WS.
  // Cleared each time `open` flips true so a reopen doesn't start mid-close.
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (open) setClosing(false);
  }, [open]);

  const handleClose = () => {
    if (closing) return;
    setClosing(true);
  };
  const handleAnimationEnd = (e: React.AnimationEvent<HTMLDivElement>) => {
    // Only the slide-down animation should trigger unmount — ignore the
    // initial slide-up that plays when the panel first appears.
    if (closing && e.animationName === "host-terminal-slide-down") {
      onClose();
    }
  };

  useEffect(() => {
    if (!open || !containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      theme: {
        background: "#0b0d10",
        foreground: "#e6e6e6",
        cursor: "#e6e6e6",
        selectionBackground: "rgba(255,255,255,0.18)",
      },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/api/admin/hosts/${encodeURIComponent(hostId)}/terminal`);
    wsRef.current = ws;

    const sendResize = () => {
      try {
        fit.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      } catch { /* ignore */ }
    };

    ws.addEventListener("open", () => {
      term.writeln(`\x1b[2;37mConnecting to ${hostName}…\x1b[0m`);
      sendResize();
    });
    ws.addEventListener("message", (ev) => {
      let msg: { type?: string; data?: string; message?: string; code?: number; signal?: string };
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      if (msg.type === "data" && typeof msg.data === "string") {
        term.write(msg.data);
      } else if (msg.type === "error") {
        term.writeln(`\r\n\x1b[31m[error] ${msg.message ?? "connection error"}\x1b[0m`);
      } else if (msg.type === "exit") {
        term.writeln(`\r\n\x1b[2;37m[session closed${msg.code != null ? ` (exit ${msg.code})` : ""}]\x1b[0m`);
      } else if (msg.type === "ready") {
        term.clear();
      }
    });
    ws.addEventListener("close", () => {
      term.writeln(`\r\n\x1b[2;37m[disconnected]\x1b[0m`);
    });
    ws.addEventListener("error", () => {
      term.writeln(`\r\n\x1b[31m[websocket error]\x1b[0m`);
    });

    const inputSub = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });

    const onWinResize = () => sendResize();
    window.addEventListener("resize", onWinResize);

    return () => {
      window.removeEventListener("resize", onWinResize);
      inputSub.dispose();
      try { ws.close(); } catch { /* ignore */ }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      wsRef.current = null;
    };
  }, [open, hostId, hostName]);

  if (!open) return null;

  // Render at document.body so the fixed-position panel isn't trapped inside
  // an ancestor that creates a containing block (transform/filter/etc.) —
  // that was making the panel shrink to its grid cell instead of spanning
  // the viewport. Also avoids any z-index/stacking-context surprises.
  return createPortal(
    <div
      className={`host-terminal-panel${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-label={`Terminal: ${hostName}`}
      onAnimationEnd={handleAnimationEnd}
    >
      <header className="host-terminal-panel__header">
        <div className="host-terminal-panel__title">Terminal: {hostName}</div>
        <IconButton aria-label="Close terminal" onClick={handleClose}>
          <X size={16} aria-hidden />
        </IconButton>
      </header>
      <div className="host-terminal-panel__body" ref={containerRef} />
    </div>,
    document.body,
  );
}
