import { afterEach } from "bun:test";

// Command tests exercise failure paths in-process, and those set process.exitCode (as the CLI should). Reset
// it after each test, or `bun test` exits 1 even when every test passes.
afterEach(() => {
  process.exitCode = 0;
});
