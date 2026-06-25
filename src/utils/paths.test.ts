import { describe, expect, test } from "bun:test";
import { getGlobalConfigPaths, getHomeDir } from "./paths";

describe("Windows-compatible config paths", () => {
  test("getHomeDir uses USERPROFILE when HOME is missing", () => {
    expect(getHomeDir({ USERPROFILE: "C:\\Users\\Ido" })).toBe("C:\\Users\\Ido");
  });

  test("getHomeDir prefers HOME when both HOME and USERPROFILE exist", () => {
    expect(getHomeDir({ HOME: "/home/ido", USERPROFILE: "C:\\Users\\Ido" })).toBe("/home/ido");
  });

  test("getHomeDir can derive Windows home from HOMEDRIVE and HOMEPATH", () => {
    expect(getHomeDir({ HOMEDRIVE: "D:", HOMEPATH: "\\Users\\Ido" })).toBe("D:\\Users\\Ido");
  });

  test("getHomeDir throws a clear error when no home env var exists", () => {
    expect(() => getHomeDir({})).toThrow("Could not determine user home directory");
  });

  test("getGlobalConfigPaths builds paths under the user home", () => {
    const paths = getGlobalConfigPaths({ USERPROFILE: "C:\\Users\\Ido" });
    expect(paths.configDir).toBe("C:\\Users\\Ido/.make-fixer");
    expect(paths.envPath).toBe("C:\\Users\\Ido/.make-fixer/.env");
    expect(paths.zoneCachePath).toBe("C:\\Users\\Ido/.make-fixer/.zones.json");
  });
});
