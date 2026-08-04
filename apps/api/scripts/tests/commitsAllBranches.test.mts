// Verify GET /apps/:appId/commits merges every branch when no `branch` query
// param is given:
//   - commits from all branches appear, newest first
//   - each commit carries the branch it was found on
//   - a sha on several branches appears once, labelled with the default branch
//   - an explicit ?branch= still narrows to that single ref
//
// GitHub is stubbed at globalThis.fetch, so nothing leaves the process.

process.env.TOKEN_ENC_KEY ??= "1f".repeat(32);

import { assert, makeApp, run, test, uniqEmail, getDb, getSchema, cookieValue } from "./_harness.mjs";
import { eq } from "drizzle-orm";

const REPO = "acme/widget";

// sha → branches it lives on. `dup` is reachable from both refs.
const BRANCH_COMMITS: Record<string, { sha: string; date: string; message: string }[]> = {
  main: [
    { sha: "aaa1", date: "2026-07-20T10:00:00Z", message: "main newest" },
    { sha: "dup0", date: "2026-07-10T10:00:00Z", message: "shared base" },
  ],
  updates: [
    { sha: "bbb1", date: "2026-07-30T10:00:00Z", message: "updates newest" },
    { sha: "bbb2", date: "2026-07-25T10:00:00Z", message: "updates older" },
    { sha: "dup0", date: "2026-07-10T10:00:00Z", message: "shared base" },
  ],
};

interface Stub {
  restore: () => void;
  calls: string[];
}

function stubGithub(): Stub {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url.pathname + (url.search || ""));
    const json = (body: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json", ...headers },
      });

    // Repo metadata — used to resolve the default branch.
    if (url.pathname === `/repos/${REPO}`) return json({ default_branch: "main" });

    // Branch listing: everything on page 1 so the pager stops there.
    if (url.pathname === `/repos/${REPO}/branches`) {
      const page = Number(url.searchParams.get("page") ?? 1);
      return json(page === 1 ? [{ name: "main" }, { name: "updates" }] : []);
    }

    // Commit listing for one ref.
    if (url.pathname === `/repos/${REPO}/commits`) {
      const ref = url.searchParams.get("sha") ?? "main";
      const page = Number(url.searchParams.get("page") ?? 1);
      const perPage = Number(url.searchParams.get("per_page") ?? 30);
      const all = BRANCH_COMMITS[ref] ?? [];
      const slice = all.slice((page - 1) * perPage, page * perPage);
      return json(
        slice.map((c) => ({
          sha: c.sha,
          commit: { message: c.message, author: { name: "Test Author", date: c.date } },
          author: { login: "tester", avatar_url: "https://example.test/a.png" },
          html_url: `https://github.com/${REPO}/commit/${c.sha}`,
        })),
        // No Link header ⇒ no further pages, which is what lets the route
        // report an exact totalCount.
      );
    }

    // Anything else (profile lookups, etc.) falls through to the real fetch so
    // an unexpected call is loud rather than silently mocked.
    return real(input as never, init);
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = real; }, calls };
}

interface Ctx {
  app: Awaited<ReturnType<typeof makeApp>>;
  cookie: string;
  appId: string;
  email: string;
}

async function setup(): Promise<Ctx> {
  const app = await makeApp();
  const db = await getDb();
  const { apps, gitConnections, organizations, users } = await getSchema();
  const { encryptString } = await import("../../src/lib/crypto.js");
  const email = uniqEmail("commits");
  const password = "password-1234";
  await app.inject({ method: "POST", url: "/api/auth/signup", payload: { email, password }, remoteAddress: "10.41.0.1" });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password }, remoteAddress: "10.41.0.1" });
  assert.equal(login.statusCode, 200, `login failed: ${login.body}`);
  const cookie = `mf_session=${cookieValue(login, "mf_session")}; mf_csrf=${cookieValue(login, "mf_csrf")}`;

  const [u] = await db.select().from(users).where(eq(users.email, email));
  const [org] = await db.select().from(organizations).where(eq(organizations.ownerUserId, u!.id));
  const [conn] = await db
    .insert(gitConnections)
    .values({
      orgId: org!.id,
      provider: "github",
      accountLogin: "tester",
      accountAvatarUrl: "https://example.test/a.png",
      accessTokenEnc: encryptString("gh-token"),
    })
    .returning();
  const appId = `t${Math.random().toString(36).slice(2, 9)}`;
  await db.insert(apps).values({
    id: appId,
    orgId: org!.id,
    name: "commits test",
    runtime: "capacitor",
    gitConnectionId: conn!.id,
    gitRepoFullName: REPO,
    gitDefaultBranch: "main",
  });
  return { app, cookie, appId, email };
}

async function teardown(ctx: Ctx): Promise<void> {
  const db = await getDb();
  const { apps, gitConnections, organizations, orgMembers, subscriptions, users } = await getSchema();
  const [u] = await db.select().from(users).where(eq(users.email, ctx.email));
  if (u) {
    const orgs = await db.select().from(organizations).where(eq(organizations.ownerUserId, u.id));
    for (const o of orgs) {
      await db.delete(apps).where(eq(apps.orgId, o.id));
      await db.delete(gitConnections).where(eq(gitConnections.orgId, o.id));
      await db.delete(subscriptions).where(eq(subscriptions.orgId, o.id));
      await db.delete(orgMembers).where(eq(orgMembers.orgId, o.id));
      await db.delete(organizations).where(eq(organizations.id, o.id));
    }
    await db.delete(users).where(eq(users.id, u.id));
  }
  await ctx.app.close();
}

interface CommitsBody {
  items: { sha: string; branch: string | null; date: string }[];
  totalCount: number | null;
  hasNext: boolean;
}

test("no branch param merges every branch, newest first, deduped", async () => {
  const stub = stubGithub();
  const ctx = await setup();
  try {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/apps/${ctx.appId}/commits?per_page=10`,
      headers: { cookie: ctx.cookie },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as CommitsBody;
    assert.deepEqual(
      body.items.map((c) => [c.sha, c.branch]),
      [
        ["bbb1", "updates"],
        ["bbb2", "updates"],
        ["aaa1", "main"],
        // Reachable from both refs: listed once, attributed to the default branch.
        ["dup0", "main"],
      ],
      "merged, date-descending, one row per sha",
    );
    assert.equal(body.hasNext, false, "both branches were read to their root");
    assert.equal(body.totalCount, 4, "count is exact once every branch is exhausted");
  } finally {
    await teardown(ctx);
    stub.restore();
  }
});

test("explicit ?branch= narrows to that single ref", async () => {
  const stub = stubGithub();
  const ctx = await setup();
  try {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/apps/${ctx.appId}/commits?per_page=10&branch=updates`,
      headers: { cookie: ctx.cookie },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as CommitsBody;
    assert.deepEqual(body.items.map((c) => c.sha), ["bbb1", "bbb2", "dup0"]);
    assert.ok(
      body.items.every((c) => c.branch === "updates"),
      "single-ref listing labels every commit with the requested branch",
    );
    assert.ok(
      !stub.calls.some((c) => c.startsWith(`/repos/${REPO}/branches`)),
      "single-ref listing must not enumerate branches",
    );
  } finally {
    await teardown(ctx);
    stub.restore();
  }
});

test("paging walks the merged list without repeating commits", async () => {
  const stub = stubGithub();
  const ctx = await setup();
  try {
    const seen: string[] = [];
    for (const page of [1, 2]) {
      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/apps/${ctx.appId}/commits?per_page=2&page=${page}`,
        headers: { cookie: ctx.cookie },
      });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json() as CommitsBody;
      assert.equal(body.items.length, 2, `page ${page} should be full`);
      seen.push(...body.items.map((c) => c.sha));
    }
    assert.deepEqual(seen, ["bbb1", "bbb2", "aaa1", "dup0"], "pages tile the merged list");
    assert.equal(new Set(seen).size, seen.length, "no commit appears on two pages");
  } finally {
    await teardown(ctx);
    stub.restore();
  }
});

await run("commits-all-branches");
