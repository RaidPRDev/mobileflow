import { useQuery } from "@tanstack/react-query";
import { api, type GitProvider } from "../api/client";

/**
 * Builds the provider's web URL for a commit.
 *
 * The commits API returns each provider's own `html_url`/`web_url`, but the
 * deployments and builds payloads only carry a SHA — and fetching a commit per
 * row just to populate a context menu would mean one external API call each, so
 * these are assembled from the repo path instead. Paths are stable public URL
 * shapes for the three hosted providers.
 */
const COMMIT_PATH: Record<GitProvider, (repo: string, sha: string) => string> = {
  github: (repo, sha) => `https://github.com/${repo}/commit/${sha}`,
  gitlab: (repo, sha) => `https://gitlab.com/${repo}/-/commit/${sha}`,
  bitbucket: (repo, sha) => `https://bitbucket.org/${repo}/commits/${sha}`,
};

/**
 * Returns a `(sha) => url | null` for the app's repo, or a function that always
 * returns null while the lookups are in flight or the app has no repo connected.
 *
 * Both queries underneath are shared cache entries other pages already populate,
 * and the result is synchronous — callers can `window.open` straight out of a
 * click handler without tripping popup blockers.
 */
export function useCommitUrl(appId: string | undefined): (sha: string) => string | null {
  const appQ = useQuery({
    queryKey: ["app", appId],
    queryFn: () => api.getApp(appId!),
    enabled: !!appId,
    staleTime: 60_000,
  });

  const orgId = appQ.data?.orgId;
  // The provider lives on the git connection, not the app, so it takes a second
  // hop. Org-scoped and cached, so this is usually already warm.
  const connectionsQ = useQuery({
    queryKey: ["git-connections", orgId],
    queryFn: () => api.listGitConnections(orgId!),
    enabled: !!orgId,
    staleTime: 60_000,
  });

  const repo = appQ.data?.gitRepoFullName ?? null;
  const provider =
    connectionsQ.data?.find((c) => c.id === appQ.data?.gitConnectionId)?.provider ?? null;

  return (sha: string) => {
    if (!repo || !provider || !sha) return null;
    return COMMIT_PATH[provider](repo, sha);
  };
}
