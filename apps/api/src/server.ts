import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import websocket from "@fastify/websocket";
import { ZodError } from "zod";
import { env } from "./env.js";
import { authRoutes } from "./routes/auth.js";
import { oauthRoutes } from "./routes/oauth.js";
import { appsRoutes } from "./routes/apps.js";
import { orgsRoutes } from "./routes/orgs.js";
import { gitConnectionRoutes } from "./routes/gitConnections.js";
import { commitsRoutes } from "./routes/commits.js";
import { buildsRoutes } from "./routes/builds.js";
import { environmentRoutes } from "./routes/environments.js";
import { certificateRoutes } from "./routes/certificates.js";
import { adminRoutes } from "./routes/admin.js";
import { stackRoutes } from "./routes/stacks.js";
import { billingRoutes, billingWebhookRoutes } from "./routes/billing.js";
import { startWorker } from "./worker/worker.js";
import { startDeployWorker } from "./worker/deployWorker.js";
import { deploymentRoutes } from "./routes/deployments.js";
import { csrfGuard } from "./auth/csrf.js";

export async function buildServer() {
  const app = Fastify({
    logger: { level: env.isProd ? "info" : "debug" },
    trustProxy: true,
    bodyLimit: 10 * 1024 * 1024, // accommodate keystore/.p12 base64 uploads
  });

  await app.register(sensible);
  await app.register(websocket);
  await app.register(cookie, { secret: env.COOKIE_SECRET });
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // same-origin / curl
      cb(null, env.WEB_ORIGINS.includes(origin));
    },
    credentials: true,
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: "ValidationError", issues: err.flatten() });
    }
    if ((err as { statusCode?: number }).statusCode) {
      return reply.send(err);
    }
    app.log.error(err);
    return reply.status(500).send({ error: "InternalServerError" });
  });

  app.get("/health", async () => ({ ok: true, env: env.NODE_ENV }));

  await app.register(async (api) => {
    // CSRF guard runs before route handlers in this scope. The Stripe webhook
    // is registered in a separate scope below so it bypasses this hook (Stripe
    // verifies its own signature header instead).
    api.addHook("onRequest", csrfGuard);
    await api.register(authRoutes);
    await api.register(oauthRoutes);
    await api.register(orgsRoutes);
    await api.register(appsRoutes);
    await api.register(gitConnectionRoutes);
    await api.register(commitsRoutes);
    await api.register(buildsRoutes);
    await api.register(stackRoutes);
    await api.register(environmentRoutes);
    await api.register(certificateRoutes);
    await api.register(adminRoutes);
    await api.register(billingRoutes);
    await api.register(deploymentRoutes);
  }, { prefix: "/api" });

  // Stripe webhook is registered separately so its content-type parser keeps
  // the raw bytes intact for signature verification.
  await app.register(
    async (api) => {
      await api.register(billingWebhookRoutes);
    },
    { prefix: "/api" },
  );

  return app;
}

import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
const isMain =
  process.argv[1] != null &&
  resolvePath(fileURLToPath(import.meta.url)) === resolvePath(process.argv[1]);
if (isMain) {
  buildServer()
    .then((app) =>
      app.listen({ port: env.PORT, host: env.HOST }).then(() => {
        app.log.info(`MobileFlow API listening on http://${env.HOST}:${env.PORT}`);
        startWorker();
        startDeployWorker();
        app.log.info("Build + deploy workers started");
      }),
    )
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
