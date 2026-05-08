/**
 * Build a token-authenticated clone URL for the given provider.
 * Used by the runners to `git clone --depth 1` directly on the build host.
 */
export function cloneUrlFor(provider: "github" | "gitlab" | "bitbucket", repoFullName: string, accessToken: string): string {
  switch (provider) {
    case "github":
      return `https://x-access-token:${accessToken}@github.com/${repoFullName}.git`;
    case "gitlab":
      return `https://oauth2:${accessToken}@gitlab.com/${repoFullName}.git`;
    case "bitbucket":
      return `https://x-token-auth:${accessToken}@bitbucket.org/${repoFullName}.git`;
  }
}
