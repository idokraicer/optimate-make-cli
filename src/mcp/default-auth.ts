import { GrantStore } from "./grant-store";
import { McpAuth, identifyGrantedOrganizations } from "./mcp-auth";
import { discoverOAuthServer, refreshTokenSet, runConsent, type OAuthServerMetadata } from "./oauth";

export interface DefaultMcpAuthOptions {
  /** False when no person can complete a consent (CI, --no-consent). */
  allowConsent: boolean;
  log?: (message: string) => void;
  store?: GrantStore;
}

export function createMcpAuth(options: DefaultMcpAuthOptions): McpAuth {
  const log = options.log ?? ((message: string) => console.error(message));
  let server: Promise<OAuthServerMetadata> | null = null;
  const discover = () => (server ??= discoverOAuthServer());
  return new McpAuth({
    store: options.store ?? new GrantStore(),
    allowConsent: options.allowConsent,
    log,
    consent: () => runConsent({ openUrl: openInBrowser, log }),
    refresh: async (grant) => refreshTokenSet(grant, { server: await discover() }),
    identify: identifyGrantedOrganizations,
  });
}

/** Opens a URL in the default browser. Failures are ignored: the URL is also printed. */
export function openInBrowser(url: string): void {
  const command = process.platform === "darwin"
    ? ["open", url]
    : process.platform === "win32"
      // `start` would split the URL at "&"; the URL protocol handler takes it verbatim.
      ? ["rundll32", "url.dll,FileProtocolHandler", url]
      : ["xdg-open", url];
  try {
    Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // Headless environment: the person can open the printed URL.
  }
}
