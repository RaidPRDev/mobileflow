/**
 * Build and deploy hosts run under a real user account, so absolute paths in
 * the log expose the operator's home directory:
 *
 *   Creating remote cert dirs: /Users/rafael/RaidX/Clients/<app>/<build>/certs/ios
 *
 * Nothing downstream parses these paths, and the part users care about starts
 * at the RaidX work root, so the home prefix is dropped on the way into the
 * log:
 *
 *   Creating remote cert dirs: RaidX/Clients/<app>/<build>/certs/ios
 *
 * Covers macOS (/Users/<name>/), Linux (/home/<name>/ — the Android/Docker
 * hosts) and Windows (C:\Users\<name>\).
 */
const HOME_PREFIX_RE =
  /\/(?:Users|home)\/[^/\s"':]+\/|[A-Za-z]:\\Users\\[^\\\s"':]+\\/g;

/**
 * SSH targets in echoed commands (`scp file rafael@10.0.0.189:/tmp/…`) carry
 * the operator's account name; the host itself stays so the line still says
 * which machine ran the step. The lookahead anchors on an IPv4 address so real
 * addresses — an Apple ID like `someone@example.com` — are left alone.
 */
const SSH_USER_RE = /\b[A-Za-z0-9._-]+@(?=(?:\d{1,3}\.){3}\d{1,3}\b)/g;

export function maskLogLine(line: string): string {
  return line.replace(HOME_PREFIX_RE, "").replace(SSH_USER_RE, "");
}
