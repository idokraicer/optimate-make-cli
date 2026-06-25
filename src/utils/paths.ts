import path from "node:path";

type Env = Record<string, string | undefined>;

export function getHomeDir(env: Env = process.env): string {
  if (env.HOME) return env.HOME;
  if (env.USERPROFILE) return env.USERPROFILE;
  if (env.HOMEDRIVE && env.HOMEPATH) return `${env.HOMEDRIVE}${env.HOMEPATH}`;

  throw new Error(
    "Could not determine user home directory. Set HOME or USERPROFILE before running make-fixer.",
  );
}

export function getGlobalConfigPaths(env: Env = process.env): {
  configDir: string;
  envPath: string;
  zoneCachePath: string;
} {
  const configDir = path.join(getHomeDir(env), ".make-fixer");
  return {
    configDir,
    envPath: path.join(configDir, ".env"),
    zoneCachePath: path.join(configDir, ".zones.json"),
  };
}
