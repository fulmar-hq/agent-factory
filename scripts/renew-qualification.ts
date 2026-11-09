#!/usr/bin/env bun
import { configAt, root } from "../launcher/config";
import { renewQualification, type RenewalRequest } from "../launcher/renewal";

// No evidence-import, success, phone-waiver or probe-script flags. Installing a
// supported trusted native adapter requires a separately reviewed implementation.
export async function renewalCLI(args: string[], dir = root) {
  try {
    const [provider, owner, repo, tree] = args;
    if (args.length !== 4 || !["codex", "claude"].includes(provider!))
      throw Error("Usage: bun scripts/renew-qualification.ts codex|claude OWNER REPO EXACT_TREE");
    const config = await configAt(`${dir}/config.yaml`);
    const role = config.owners[owner!];
    if (!role || role.harness !== provider) throw Error("configured owner/provider required");
    const request = { provider, model: role.model, effort: role.effort, publisher: { repo, tree } } as RenewalRequest;
    return await renewQualification({ dir, request });
  } catch (error) { return { status: "refused" as const, reason: String(error) }; }
}

if (import.meta.main) {
  const result = await renewalCLI(process.argv.slice(2));
  console.log(JSON.stringify(result));
  if (result.status !== "renewed") process.exitCode = 1;
}
