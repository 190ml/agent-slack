import type { Command } from "commander";
import type { CliContext } from "./context.ts";
import { pruneEmpty } from "../lib/compact-json.ts";
import {
  collectTranscriptUserIds,
  fetchHuddleTranscript,
  parseHuddleTranscriptRef,
  resolveTranscriptInput,
} from "../slack/transcript.ts";
import { parseSlackCanvasUrl } from "../slack/canvas.ts";
import { resolveUsersById, toReferencedUsers } from "../slack/user-cache.ts";

export function registerTranscriptCommand(input: { program: Command; ctx: CliContext }): void {
  const transcriptCmd = input.program
    .command("transcript")
    .description("Work with Slack huddle transcripts");

  transcriptCmd
    .command("get", { isDefault: true })
    .description("Fetch a Slack huddle transcript as token-efficient JSON")
    .argument("<target>", "Huddle transcript file URL/id, or huddle AI-notes canvas URL/id")
    .option(
      "--workspace <url>",
      "Workspace selector (full URL or unique substring; required if passing an id across multiple workspaces)",
    )
    .option("--max-line-chars <n>", "Max characters per transcript line (default unlimited)", "-1")
    .option("--resolve-users", "Attach resolved user profiles in referenced_users")
    .option("--refresh-users", "Refresh user cache while resolving users")
    .action(async (...args) => {
      const [target, options] = args as [
        string,
        {
          workspace?: string;
          maxLineChars: string;
          resolveUsers?: boolean;
          refreshUsers?: boolean;
        },
      ];

      try {
        const parsed = parseOptionalTranscriptRef(target);
        const workspaceUrl = parsed.workspace_url ?? options.workspace?.trim() ?? undefined;
        const maxLineChars = Number.parseInt(options.maxLineChars, 10);
        const shouldResolveUsers = Boolean(options.resolveUsers || options.refreshUsers);

        const payload = await input.ctx.withAutoRefresh({
          workspaceUrl,
          work: async () => {
            const { client, workspace_url } = await input.ctx.getClientForWorkspace(workspaceUrl);
            const ref = await resolveTranscriptInput(client, target);
            const result = await fetchHuddleTranscript(client, {
              transcriptFileId: ref.file_id,
              maxLineChars: Number.isNaN(maxLineChars) ? -1 : maxLineChars,
            });

            if (!shouldResolveUsers) {
              return result;
            }

            const resolvedWorkspaceUrl = workspace_url ?? ref.workspace_url ?? workspaceUrl ?? "";
            const userIds = collectTranscriptUserIds(result.transcript);
            const usersById = await resolveUsersById({
              client,
              workspaceUrl: resolvedWorkspaceUrl,
              userIds,
              forceRefresh: Boolean(options.refreshUsers),
            });

            return {
              ...result,
              referenced_users: toReferencedUsers(userIds, usersById),
            };
          },
        });

        console.log(JSON.stringify(pruneEmpty(payload), null, 2));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });
}

function parseOptionalTranscriptRef(input: string): { workspace_url?: string } {
  try {
    return parseHuddleTranscriptRef(input);
  } catch {
    try {
      return parseSlackCanvasUrl(input);
    } catch {
      return {};
    }
  }
}
