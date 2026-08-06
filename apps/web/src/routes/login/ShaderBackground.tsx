import { useEffect, useRef } from "react";

// Fullscreen gradient-wave shader behind the login scene. Renders at reduced
// resolution — the output is smooth low-frequency color, so upscaling is free
// sharpness-wise and keeps fill-rate cost trivial.
const RESOLUTION_SCALE = 0.5;

const VERT = `
attribute vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAG = `
precision highp float;

uniform vec2 u_res;
uniform float u_time;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec2(17.0, 9.2);
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = uv;
  p.x *= u_res.x / u_res.y;

  float t = u_time * 0.045;

  // Domain-warped fbm: each layer flows through the previous one, which is
  // what turns static noise into slow liquid color waves.
  float w1 = fbm(p * 1.3 + vec2(t * 0.9, -t * 0.55));
  float w2 = fbm(p * 2.1 + vec2(-t * 0.5, t * 0.35) + w1 * 1.7);
  float w3 = fbm(p * 0.8 + vec2(t * 0.22, t * 0.5) + w2 * 1.2);

  vec3 base = vec3(0.012, 0.016, 0.035);
  vec3 indigo = vec3(0.055, 0.085, 0.220);
  vec3 blue = vec3(0.085, 0.150, 0.360);
  vec3 violet = vec3(0.130, 0.075, 0.250);
  vec3 teal = vec3(0.030, 0.140, 0.200);

  vec3 col = base;
  col = mix(col, indigo, smoothstep(0.25, 0.85, w1));
  col = mix(col, blue, smoothstep(0.45, 0.95, w2) * 0.75);
  col = mix(col, violet, smoothstep(0.55, 1.0, w3) * 0.55);
  col = mix(col, teal, smoothstep(0.60, 1.0, fbm(p * 1.1 - vec2(t * 0.3, t * 0.15))) * 0.35);

  // Vignette so the edges fall away and the scene feels lit from within.
  float vig = smoothstep(1.30, 0.35, distance(uv, vec2(0.5, 0.45)));
  col *= mix(0.50, 1.0, vig);

  // Volumetric light shaft under the particle glyph: a cone rising from
  // below the floor, its density modulated by two layers of drifting fbm so
  // it reads as fog caught in the light rather than a flat gradient.
  float aspect = u_res.x / u_res.y;
  vec2 beamOrigin = vec2(0.27 * aspect, -0.14);
  vec2 rel = vec2(p.x, uv.y) - beamOrigin;
  float ang = atan(rel.x, rel.y);
  float dist = length(rel);

  float cone = smoothstep(0.48, 0.05, abs(ang));
  float fall = exp(-dist * 0.95);

  // Fog: coarse billows rising slowly, warped by a finer, faster layer.
  float billow = fbm(vec2(rel.x * 2.2, rel.y * 1.7 - u_time * 0.10));
  float wisp = fbm(vec2(rel.x * 4.5 + billow * 1.5, rel.y * 3.6 - u_time * 0.22));
  float fog = 0.30 + 0.70 * smoothstep(0.10, 0.85, billow * 0.6 + wisp * 0.55);

  // Soft ray striations sweeping across the cone's angle.
  float rays = 0.75 + 0.25 * noise(vec2(ang * 7.0 + u_time * 0.06, dist * 2.0 - u_time * 0.05));

  float pulse = 0.88 + 0.12 * sin(u_time * 0.55);
  float beam = cone * fall * fog * rays * pulse;
  // Extinction with height: the shaft dissolves into the haze as it climbs.
  beam *= mix(1.0, 0.3, smoothstep(0.5, 1.0, uv.y));
  col += vec3(0.34, 0.46, 0.92) * beam * 1.55;

  // Hot core where the light meets the floor, breathing with the same fog.
  float core = exp(-pow(length((vec2(p.x, uv.y) - vec2(beamOrigin.x, 0.0)) * vec2(2.8, 4.5)), 2.0) * 2.2);
  col += vec3(0.42, 0.55, 1.0) * core * (0.65 + 0.4 * billow);

  // Ordered-ish grain to break banding in the dark gradients.
  col += (hash(gl_FragCoord.xy + fract(u_time)) - 0.5) * 0.012;

  gl_FragColor = vec4(col, 1.0);
}
`;

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export function ShaderBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "low-power",
    });
    // No WebGL → the CSS gradient on .login-page stands in.
    if (!gl) return;

    const vert = compile(gl, gl.VERTEX_SHADER, VERT);
    const frag = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vert || !frag) return;
    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(program, "u_res");
    const uTime = gl.getUniformLocation(program, "u_time");

    const resize = () => {
      const w = Math.max(1, Math.round(canvas.clientWidth * RESOLUTION_SCALE));
      const h = Math.max(1, Math.round(canvas.clientHeight * RESOLUTION_SCALE));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const start = performance.now();
    let raf = 0;

    const render = () => {
      resize();
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, (performance.now() - start) / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const loop = () => {
      render();
      raf = requestAnimationFrame(loop);
    };

    if (reducedMotion.matches) {
      // One static frame — the gradient still sets the mood without motion.
      render();
    } else {
      raf = requestAnimationFrame(loop);
    }

    // No loseContext() here: under StrictMode's dev double-mount the remount
    // gets the same canvas back, and getContext() would return the dead
    // context. Stopping the loop is enough; the context dies with the canvas.
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className="login-shader" aria-hidden />;
}
