import type { SlackApiClient } from "./client.ts";
import { parseSlackCanvasUrl } from "./canvas.ts";
import { asArray, getNumber, getString, isRecord } from "../lib/object-type-guards.ts";

const FILE_ID_PATTERN = /^F[A-Z0-9]{8,}$/;
const HUDDLE_TRANSCRIPT_REASON = "slack-ai-fetch-huddle-transcript";

export type SlackHuddleTranscriptRef = {
  workspace_url?: string;
  file_id: string;
  raw: string;
};

export type HuddleTranscriptLine = {
  line_id: string;
  contents: string;
  start_time_ms?: number;
  start_time?: string;
  user_id?: string;
};

export type HuddleTranscript = {
  file_id: string;
  title?: string;
  channel_id?: string;
  date_start?: number;
  date_end?: number;
  transcription_time_ranges?: unknown[];
  line_count: number;
  lines: HuddleTranscriptLine[];
};

export function parseHuddleTranscriptRef(input: string): SlackHuddleTranscriptRef {
  const trimmed = input.trim();
  if (FILE_ID_PATTERN.test(trimmed)) {
    return { file_id: trimmed, raw: input };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      `Unsupported transcript input: ${input} (expected Slack file/canvas URL or F...)`,
    );
  }

  if (!/\.slack\.com$/i.test(url.hostname)) {
    throw new Error(`Not a Slack workspace URL: ${url.hostname}`);
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const fileId = parts.find((part) => FILE_ID_PATTERN.test(part));
  if (!fileId) {
    throw new Error(`Could not find Slack file id in: ${url.pathname}`);
  }

  return {
    workspace_url: `${url.protocol}//${url.host}`,
    file_id: fileId,
    raw: input,
  };
}

export async function resolveHuddleTranscriptFileId(
  client: SlackApiClient,
  input: { id: string },
): Promise<string> {
  const info = await client.api("files.info", { file: input.id });
  const file = isRecord(info.file) ? info.file : null;
  if (!file) {
    throw new Error("Slack file not found (files.info returned no file)");
  }

  const transcriptFileId = getString(file.huddle_transcript_file_id);
  if (transcriptFileId && FILE_ID_PATTERN.test(transcriptFileId)) {
    return transcriptFileId;
  }

  return input.id;
}

export async function fetchHuddleTranscript(
  client: SlackApiClient,
  input: { transcriptFileId: string; maxLineChars?: number },
): Promise<{ transcript: HuddleTranscript }> {
  const info = await client.api("files.info", {
    file: input.transcriptFileId,
    include_transcription: true,
    reason: HUDDLE_TRANSCRIPT_REASON,
  });
  const file = isRecord(info.file) ? info.file : null;
  if (!file) {
    throw new Error("Slack transcript file not found (files.info returned no file)");
  }

  const huddleTranscription = isRecord(file.huddle_transcription)
    ? file.huddle_transcription
    : null;
  const rawLines = huddleTranscription ? asArray(huddleTranscription.lines) : [];
  if (!huddleTranscription || rawLines.length === 0) {
    throw new Error(
      "Slack did not return huddle transcript lines. This usually means the file is not a huddle transcript, the workspace has no access, or the transcript is not ready.",
    );
  }

  const maxLineChars = input.maxLineChars ?? -1;
  const lines = rawLines.filter(isRecord).map((line): HuddleTranscriptLine => {
    const startTimeMs = getNumber(line.start_time_ms);
    return {
      line_id: getString(line.line_id) ?? "",
      user_id: getString(line.user_id),
      start_time_ms: startTimeMs,
      start_time: startTimeMs === undefined ? undefined : formatOffset(startTimeMs),
      contents: truncateLine(getString(line.contents) ?? "", maxLineChars),
    };
  });

  return {
    transcript: {
      file_id: getString(file.id) ?? input.transcriptFileId,
      title: getString(file.title) ?? getString(file.name),
      channel_id: getString(huddleTranscription.channel_id),
      date_start: getNumber(huddleTranscription.date_start),
      date_end: getNumber(huddleTranscription.date_end),
      transcription_time_ranges: asArray(huddleTranscription.transcription_time_ranges),
      line_count: lines.length,
      lines,
    },
  };
}

export async function resolveTranscriptInput(
  client: SlackApiClient,
  value: string,
): Promise<SlackHuddleTranscriptRef> {
  try {
    const canvasRef = parseSlackCanvasUrl(value);
    const transcriptFileId = await resolveHuddleTranscriptFileId(client, {
      id: canvasRef.canvas_id,
    });
    return {
      workspace_url: canvasRef.workspace_url,
      file_id: transcriptFileId,
      raw: value,
    };
  } catch {
    const ref = parseHuddleTranscriptRef(value);
    const transcriptFileId = await resolveHuddleTranscriptFileId(client, { id: ref.file_id });
    return {
      ...ref,
      file_id: transcriptFileId,
    };
  }
}

export function collectTranscriptUserIds(transcript: HuddleTranscript): string[] {
  return Array.from(
    new Set(transcript.lines.map((line) => line.user_id).filter((id): id is string => Boolean(id))),
  );
}

function truncateLine(value: string, maxChars: number): string {
  if (maxChars < 0 || value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...`;
}

function formatOffset(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
