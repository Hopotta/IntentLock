import { spawn } from "node:child_process";
import { platform } from "node:os";
import type { CommandRunner } from "../engine/context.js";

export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

function retainTail(current: Buffer, chunk: Buffer, limit: number): Buffer {
  if (limit <= 0) return Buffer.alloc(0);
  if (chunk.length >= limit) return chunk.subarray(chunk.length - limit);
  const overflow = current.length + chunk.length - limit;
  if (overflow <= 0) return Buffer.concat([current, chunk]);
  return Buffer.concat([current.subarray(overflow), chunk]);
}

/** Execute a configured command through the host platform shell with bounded output. */
export function createCommandRunner(repoRoot: string): CommandRunner {
  return (command, options = {}) =>
    new Promise((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
      const outputLimit = Math.min(
        MAX_COMMAND_OUTPUT_BYTES,
        Math.max(0, options.maxOutputBytes ?? MAX_COMMAND_OUTPUT_BYTES),
      );
      const startedAt = performance.now();
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let settled = false;

      let child;
      try {
        child = spawn(command, {
          cwd: options.cwd ?? repoRoot,
          shell: true,
          detached: platform() !== "win32",
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        reject(error);
        return;
      }

      const timeout = setTimeout(() => {
        timedOut = true;
        if (platform() === "win32" && child.pid !== undefined) {
          const terminator = spawn(
            "taskkill",
            ["/pid", String(child.pid), "/T", "/F"],
            { windowsHide: true, stdio: "ignore" },
          );
          terminator.once("close", () => child.kill());
          terminator.once("error", () => child.kill());
        } else if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        } else {
          child.kill("SIGKILL");
        }
      }, timeoutMs);
      child.stdout?.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutTruncated ||= stdout.length + bytes.length > outputLimit;
        stdout = retainTail(stdout, bytes, outputLimit);
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderrTruncated ||= stderr.length + bytes.length > outputLimit;
        stderr = retainTail(stderr, bytes, outputLimit);
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({
          exitCode,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          stdoutTruncated,
          stderrTruncated,
          timedOut,
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        });
      });
    });
}
