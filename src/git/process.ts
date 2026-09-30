import { execFileSync } from "node:child_process";

export function runGit(
  args: string[],
  cwd: string,
  encoding: "utf8" | "buffer" = "utf8",
): string | Buffer {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args[0] ?? ""} failed: ${detail}`, { cause: error });
  }
}

export function gitText(args: string[], cwd: string): string {
  return runGit(args, cwd, "utf8") as string;
}

export function gitBytes(args: string[], cwd: string): Buffer {
  return runGit(args, cwd, "buffer") as Buffer;
}
