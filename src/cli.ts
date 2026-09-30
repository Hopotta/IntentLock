import { Command } from "commander";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ContractError } from "./contract/errors.js";
import { checkRepository, EnvironmentError } from "./check.js";
import { discoverRepository } from "./git/repository.js";
import {
  createJsonError,
  createJsonReport,
  TOOL_VERSION,
} from "./reporters/json.js";
import { renderTerminalReport } from "./reporters/terminal.js";
import { initializeRepository } from "./initialize.js";
import { diagnoseRepository } from "./doctor.js";

export const program = new Command()
  .name("intentlock")
  .description("Verify that a patch stays within its authorized change scope.")
  .version(TOOL_VERSION, "--version", "Show the installed version")
  .showHelpAfterError();

program.addHelpText(
  "after",
  "\nRun intentlock <command> --help for details about a command.\n",
);

program
  .command("init")
  .description("Create a starter change contract in this Git repository.")
  .option("--force", "Replace an existing .intentlock.yml")
  .option("--yes", "Accept defaults without prompting")
  .option("--repo <path>", "Repository path", process.cwd())
  .action(async (options: { force?: boolean; yes?: boolean; repo: string }) => {
    try {
      const result = await initializeRepository({
        cwd: resolve(options.repo),
        force: options.force,
      });
      if (result.created) {
        console.log(`Created ${result.contractPath}`);
        console.log(
          "Add invariants to define the boundaries IntentLock should enforce.",
        );
      } else {
        console.error(
          `${result.contractPath} already exists. Use --force to replace it.`,
        );
        process.exitCode = 2;
      }
      // --yes is intentionally accepted for scripted initialization; init has no prompts.
      void options.yes;
    } catch (error) {
      console.error(
        `IntentLock ERROR\n${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 2;
    }
  });

program
  .command("doctor")
  .description(
    "Check repository, contract, baseline, and verifier prerequisites without running verifier commands.",
  )
  .option("--base <ref>", "Git ref to check")
  .option("--contract <path>", "Contract path relative to the repository root")
  .option("--repo <path>", "Repository path", process.cwd())
  .action(
    async (options: { base?: string; contract?: string; repo: string }) => {
      try {
        const result = await diagnoseRepository({
          cwd: resolve(options.repo),
          base: options.base,
          contract: options.contract,
        });
        for (const diagnostic of result.diagnostics) {
          console.log(
            `${diagnostic.status.toUpperCase()}  ${diagnostic.id}\n      ${diagnostic.message}`,
          );
        }
        process.exitCode = result.exitCode;
      } catch (error) {
        console.error(
          `IntentLock ERROR\n${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 2;
      }
    },
  );

program
  .command("check")
  .description("Check the current patch against a trusted change contract.")
  .option("--base <ref>", "Git ref to compare against")
  .option("--contract <path>", "Contract path relative to the repository root")
  .option("--format <format>", "Report format", "terminal")
  .option("--output <path>", "Write the report to a file")
  .option("--repo <path>", "Repository path", process.cwd())
  .option("--fail-on-warn", "Return exit code 1 when warning checks fail")
  .option(
    "--policy-source <source>",
    "Policy source: auto, baseline, or worktree",
    "auto",
  )
  .option("--verbose", "Include baseline, changed files, and timing details")
  .action(
    async (options: {
      base?: string;
      contract?: string;
      format: string;
      output?: string;
      repo: string;
      failOnWarn?: boolean;
      policySource: string;
      verbose?: boolean;
    }) => {
      const cwd = resolve(options.repo);
      const startedAt = performance.now();
      try {
        if (options.format !== "terminal" && options.format !== "json") {
          throw new ContractError(
            "invalid_schema",
            `Unsupported report format "${options.format}".`,
            ["Use terminal or json."],
          );
        }
        if (
          !new Set(["auto", "baseline", "worktree"]).has(options.policySource)
        ) {
          throw new ContractError(
            "invalid_schema",
            `Unsupported policy source "${options.policySource}".`,
            ["Use auto, baseline, or worktree."],
          );
        }

        const { report, policy, snapshot } = await checkRepository({
          cwd,
          base: options.base,
          contract: options.contract,
          policySource: options.policySource as
            "auto" | "baseline" | "worktree",
          failOnWarn: options.failOnWarn,
        });
        const totalDurationMs = Math.max(
          0,
          Math.round(performance.now() - startedAt),
        );
        const output =
          options.format === "json"
            ? JSON.stringify(
                createJsonReport(report, policy, snapshot, {
                  verbose: options.verbose,
                  totalDurationMs,
                }),
                null,
                2,
              )
            : renderTerminalReport(report, policy, snapshot, {
                verbose: options.verbose,
                toolVersion: TOOL_VERSION,
                color:
                  !options.output &&
                  process.stdout.isTTY &&
                  process.env.NO_COLOR === undefined &&
                  process.env.TERM !== "dumb" &&
                  process.env.FORCE_COLOR !== "0",
              });

        if (options.output) {
          const outputPath = resolve(snapshot.repositoryRoot, options.output);
          try {
            await writeFile(outputPath, `${output}\n`, "utf8");
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            throw new EnvironmentError(
              `Could not write report to ${outputPath}: ${message}`,
              { cause: error },
            );
          }
          if (options.format === "terminal")
            console.log(`Report written to ${outputPath}`);
        } else {
          console.log(output);
        }
        process.exitCode = report.exitCode;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code =
          error instanceof ContractError || error instanceof EnvironmentError
            ? 2
            : 3;
        const output =
          options.format === "json"
            ? JSON.stringify(createJsonError(error), null, 2)
            : `IntentLock ${code === 3 ? "INTERNAL ERROR" : "ERROR"}\n${message}${options.verbose && error instanceof Error && error.stack ? `\n${error.stack}` : ""}`;
        if (options.output) {
          try {
            let outputRoot = cwd;
            try {
              outputRoot = discoverRepository(cwd).root;
            } catch {
              // Preserve the useful error report when repository discovery
              // itself is what failed.
            }
            await writeFile(
              resolve(outputRoot, options.output),
              `${output}\n`,
              "utf8",
            );
          } catch (writeError) {
            console.error(
              `IntentLock ERROR\nCould not write error report: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
            );
            process.exitCode = 2;
            return;
          }
        } else if (options.format === "json") {
          console.log(output);
        } else {
          console.error(output);
        }
        process.exitCode = code;
      }
    },
  );

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  program.parse();
}
