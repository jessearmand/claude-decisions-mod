/**
 * The judge's view of the conversation, read through `$.session.messages()`:
 * the latest prompt the user typed and the Bash commands the agent ran.
 *
 * The Python hook read the transcript JSONL file from `transcript_path`;
 * inside Claude Code the engine hands the same rows back as
 * `{ role, text, toolUses }`, for the main conversation or, with the call's
 * `agentId`, for the subagent whose loop made the call.
 */

import type { EngineInterface, SessionMessage } from "claude-code";
import type { HookInput } from "../decision.ts";
import type { Transcript, TranscriptReader } from "../guards/guard.ts";

/** Rows the engine injects rather than the person typing (judge_context._NOT_TYPED). */
const NOT_TYPED = ["[Request interrupted", "<command-", "<local-command", "<system-reminder", "Caveat:"];

export function transcriptOf(messages: readonly SessionMessage[]): Transcript {
    let latestPrompt: string | undefined;
    const recentBashCommands: string[] = [];
    for (const message of messages) {
        if (message.role === "user") {
            const text = message.text;
            if (text && !NOT_TYPED.some((prefix) => text.trimStart().startsWith(prefix))) latestPrompt = text;
            continue;
        }
        for (const use of message.toolUses) {
            const command = use.input.command;
            if (use.tool === "Bash" && typeof command === "string") recentBashCommands.push(command);
        }
    }
    return { latestPrompt, recentBashCommands };
}

async function readTranscript($: EngineInterface, input: HookInput): Promise<Transcript | undefined> {
    try {
        const messages = input.agentId
            ? await $.session.messages({ agentId: input.agentId })
            : await $.session.messages();
        if ("deny" in messages) return undefined;
        return transcriptOf(messages);
    } catch {
        return undefined;
    }
}

/** A reader over the engine's session; never rejects (the judge then has no context). */
export function engineTranscriptReader($: EngineInterface): TranscriptReader {
    return (input: HookInput) => readTranscript($, input);
}
