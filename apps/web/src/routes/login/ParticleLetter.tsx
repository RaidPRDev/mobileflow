import { useEffect, useRef } from "react";

// Particles that assemble into a glyph. Targets come from rasterizing the
// glyph offscreen and sampling filled pixels; each particle springs toward
// its sampled pixel while drifting, so the letter breathes instead of
// freezing into a stencil.

const SAMPLE_GAP = 4; // logical px between sampled glyph pixels
const MAX_PARTICLES = 2400;
const DUST_COUNT = 70;
const MOUSE_RADIUS = 80;

const PALETTE = ["#8fb0ff", "#6d8dff", "#3b82f6", "#b9c6ff", "#7ea2ff"];

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  tx: number;
  ty: number;
  size: number;
  sprite: HTMLCanvasElement;
  phase: number;
  flicker: number;
}

interface Dust {
  x: number;
  y: number;
  speed: number;
  size: number;
  drift: number;
  phase: number;
  alpha: number;
}

// Pre-rendered radial glow sprites: drawImage per particle is much cheaper
// than a canvas gradient or shadowBlur per frame.
function makeSprite(color: string): HTMLCanvasElement {
  const s = document.createElement("canvas");
  s.width = 32;
  s.height = 32;
  const ctx = s.getContext("2d")!;
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, "rgba(255,255,255,0.9)");
  g.addColorStop(0.25, color);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  return s;
}

function sampleGlyph(text: string, width: number, height: number): Array<{ x: number; y: number }> {
  const off = document.createElement("canvas");
  off.width = width;
  off.height = height;
  const ctx = off.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [];

  const fontFamily = getComputedStyle(document.body).fontFamily || "system-ui, sans-serif";
  const fontSize = Math.floor(Math.min(width, height) * 0.62);
  ctx.font = `700 ${fontSize}px ${fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#fff";
  ctx.fillText(text, width / 2, height / 2);

  const data = ctx.getImageData(0, 0, width, height).data;
  const points: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < height; y += SAMPLE_GAP) {
    for (let x = 0; x < width; x += SAMPLE_GAP) {
      if ((data[(y * width + x) * 4 + 3] ?? 0) > 128) {
        points.push({ x, y });
      }
    }
  }
  if (points.length > MAX_PARTICLES) {
    // Thin uniformly rather than truncating so the glyph stays evenly dense.
    const keep = MAX_PARTICLES / points.length;
    return points.filter(() => Math.random() < keep);
  }
  return points;
}

export function ParticleLetter({ text = "M" }: { text?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const sprites = PALETTE.map(makeSprite);
    const dustSprite = sprites[0] ?? makeSprite("#8fb0ff");
    const randomSprite = () => sprites[Math.floor(Math.random() * sprites.length)] ?? dustSprite;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let particles: Particle[] = [];
    let dust: Dust[] = [];
    let width = 0;
    let height = 0;
    const mouse = { x: -9999, y: -9999 };
    let raf = 0;

    const rebuild = () => {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      if (width === 0 || height === 0) return;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const targets = sampleGlyph(text, width, height);
      const prev = particles;
      particles = targets.map((t, i) => {
        // Reuse live particles across resizes so the glyph morphs instead of
        // re-exploding; newcomers rise out of the beam at the bottom.
        const old = prev[i];
        return {
          x: old ? old.x : width / 2 + (Math.random() - 0.5) * width * 0.5,
          y: old ? old.y : height + 20 + Math.random() * 80,
          vx: old ? old.vx : 0,
          vy: old ? old.vy : -(0.5 + Math.random() * 1.5),
          tx: t.x,
          ty: t.y,
          size: 1.6 + Math.random() * 2.6,
          sprite: randomSprite(),
          phase: Math.random() * Math.PI * 2,
          flicker: 0.5 + Math.random() * 1.2,
        };
      });

      if (dust.length === 0) {
        dust = Array.from({ length: DUST_COUNT }, () => ({
          x: Math.random() * width,
          y: Math.random() * height,
          speed: 0.1 + Math.random() * 0.35,
          size: 0.8 + Math.random() * 1.8,
          drift: (Math.random() - 0.5) * 0.2,
          phase: Math.random() * Math.PI * 2,
          alpha: 0.08 + Math.random() * 0.22,
        }));
      }

      if (reducedMotion) {
        // No animation loop runs, so settle instantly and paint one frame.
        for (const p of particles) {
          p.x = p.tx;
          p.y = p.ty;
        }
        step(0);
      }
    };

    const step = (time: number) => {
      const t = time / 1000;
      ctx.clearRect(0, 0, width, height);
      ctx.globalCompositeOperation = "lighter";

      for (const d of dust) {
        d.y -= d.speed;
        d.x += d.drift + Math.sin(t * 0.5 + d.phase) * 0.15;
        if (d.y < -4) {
          d.y = height + 4;
          d.x = Math.random() * width;
        }
        ctx.globalAlpha = d.alpha * (0.7 + 0.3 * Math.sin(t * 1.3 + d.phase));
        ctx.drawImage(dustSprite, d.x - d.size, d.y - d.size, d.size * 2, d.size * 2);
      }

      for (const p of particles) {
        // Spring toward target with wander; damping keeps it from ringing.
        p.vx += (p.tx - p.x) * 0.014 + Math.sin(t * p.flicker + p.phase) * 0.012;
        p.vy += (p.ty - p.y) * 0.014 + Math.cos(t * p.flicker * 0.8 + p.phase) * 0.012;

        const dx = p.x - mouse.x;
        const dy = p.y - mouse.y;
        const distSq = dx * dx + dy * dy;
        if (distSq < MOUSE_RADIUS * MOUSE_RADIUS && distSq > 0.01) {
          const dist = Math.sqrt(distSq);
          const force = ((MOUSE_RADIUS - dist) / MOUSE_RADIUS) * 1.4;
          p.vx += (dx / dist) * force;
          p.vy += (dy / dist) * force;
        }

        p.vx *= 0.88;
        p.vy *= 0.88;
        p.x += p.vx;
        p.y += p.vy;

        ctx.globalAlpha = 0.55 + 0.45 * Math.sin(t * p.flicker * 2 + p.phase);
        const s = p.size;
        ctx.drawImage(p.sprite, p.x - s, p.y - s, s * 2, s * 2);
      }

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    };

    const loop = (time: number) => {
      step(time);
      raf = requestAnimationFrame(loop);
    };

    const observer = new ResizeObserver(rebuild);
    observer.observe(canvas);
    rebuild();

    if (!reducedMotion) {
      raf = requestAnimationFrame(loop);
    }

    const onPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
    };
    const onPointerLeave = () => {
      mouse.x = -9999;
      mouse.y = -9999;
    };
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerleave", onPointerLeave);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
    };
  }, [text]);

  return <canvas ref={canvasRef} className="login-particles" aria-hidden />;
}
