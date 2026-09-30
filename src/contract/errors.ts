export type ContractErrorCode =
  | "invalid_yaml"
  | "invalid_schema"
  | "unsupported_version"
  | "duplicate_id"
  | "missing_contract";

export class ContractError extends Error {
  readonly name = "ContractError";

  constructor(
    readonly code: ContractErrorCode,
    message: string,
    readonly details: string[] = [],
  ) {
    super(
      details.length > 0
        ? `${message}\n${details.map((detail) => `- ${detail}`).join("\n")}`
        : message,
    );
  }
}
