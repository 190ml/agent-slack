import { describe, expect, test } from "bun:test";
import {
  fetchHuddleTranscript,
  parseHuddleTranscriptRef,
  resolveHuddleTranscriptFileId,
} from "../src/slack/transcript.ts";
import type { SlackApiClient } from "../src/slack/client.ts";

function createClient(responses: Record<string, unknown>[]) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const client = {
    api: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      const response = responses.shift();
      if (!response) {
        throw new Error("No mock response queued");
      }
      return response;
    },
  } as unknown as SlackApiClient;
  return { client, calls };
}

describe("huddle transcript helpers", () => {
  test("parses transcript file ids and Slack file URLs", () => {
    expect(parseHuddleTranscriptRef("F0B0R238BB8")).toEqual({
      file_id: "F0B0R238BB8",
      raw: "F0B0R238BB8",
    });

    expect(
      parseHuddleTranscriptRef(
        "https://example.slack.com/files/USLACKBOT/F0B0R238BB8/huddle_transcript",
      ),
    ).toEqual({
      workspace_url: "https://example.slack.com",
      file_id: "F0B0R238BB8",
      raw: "https://example.slack.com/files/USLACKBOT/F0B0R238BB8/huddle_transcript",
    });
  });

  test("resolves huddle AI-notes canvas ids to transcript file ids", async () => {
    const { client, calls } = createClient([
      {
        file: {
          id: "F0B160MQ1J5",
          huddle_transcript_file_id: "F0B0R238BB8",
        },
      },
    ]);

    await expect(resolveHuddleTranscriptFileId(client, { id: "F0B160MQ1J5" })).resolves.toBe(
      "F0B0R238BB8",
    );

    expect(calls).toEqual([{ method: "files.info", params: { file: "F0B160MQ1J5" } }]);
  });

  test("fetches transcript lines with Slack's include_transcription flag", async () => {
    const { client, calls } = createClient([
      {
        file: {
          id: "F0B0R238BB8",
          title: "Huddle transcript",
          huddle_transcription: {
            channel_id: "C08NUKNG8NR",
            date_start: 1777523782,
            date_end: 1777524796,
            transcription_time_ranges: [{ start_ts: "1777523782.000000" }],
            lines: [
              {
                line_id: "line-1",
                user_id: "U123456789",
                start_time_ms: 17000,
                contents: "Hello transcript",
              },
            ],
          },
        },
      },
    ]);

    const result = await fetchHuddleTranscript(client, {
      transcriptFileId: "F0B0R238BB8",
      maxLineChars: 8,
    });

    expect(calls).toEqual([
      {
        method: "files.info",
        params: {
          file: "F0B0R238BB8",
          include_transcription: true,
          reason: "slack-ai-fetch-huddle-transcript",
        },
      },
    ]);
    expect(result.transcript.line_count).toBe(1);
    expect(result.transcript.lines[0]).toEqual({
      line_id: "line-1",
      user_id: "U123456789",
      start_time_ms: 17000,
      start_time: "00:17",
      contents: "Hello tr...",
    });
  });
});
