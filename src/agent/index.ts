import Anthropic from "@anthropic-ai/sdk";
import type { Blueprint, Note } from "../make-api/types";
import type { MakeApiClient } from "../make-api/client";
import { analyze, type AnalysisResult } from "../analyzer/index";
import { buildSystemPrompt } from "./system-prompt";
import { toolDefinitions, executeTool, createAgentState } from "./tools";
import { getMaxModuleId } from "../utils/module-helpers";

const MODEL = "claude-haiku-4-5-20251001";

export interface AgentConfig {
  client: MakeApiClient;
  scenarioId: number;
  blueprint: Blueprint;
  notes: Note[];
}

interface ToolCall {
  id: string;
  name: string;
  input: any;
}

export function processAssistantResponse(content: any[]): {
  textParts: string[];
  toolCalls: ToolCall[];
} {
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const block of content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }
  }

  return { textParts, toolCalls };
}

export function buildInitialMessages(
  blueprint: Blueprint,
  analysis: AnalysisResult,
  nextId: number
): { systemPrompt: string; messages: any[] } {
  const systemPrompt = buildSystemPrompt(blueprint, analysis, nextId);
  return { systemPrompt, messages: [] };
}

function readLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    process.stdin.resume();
    process.stdin.once("data", (data) => {
      resolve(data.toString().trim());
    });
    process.stdin.once("end", () => resolve("exit"));
  });
}

export async function runAgent(config: AgentConfig): Promise<void> {
  const anthropic = new Anthropic();
  const analysis = analyze(config.blueprint, config.notes);
  const nextId = getMaxModuleId(config.blueprint.flow) + 1;
  const state = createAgentState(config.blueprint, config.notes, config.client, config.scenarioId);

  const { systemPrompt, messages } = buildInitialMessages(config.blueprint, analysis, nextId);

  // Print welcome
  const moduleCount = analysis.classified.length;
  const issueCount = analysis.issues.length;
  console.log("");
  console.log("══════════════════════════════════════");
  console.log(`  Make Fixer Agent — "${config.blueprint.name}"`);
  console.log(`  Modules: ${moduleCount} | Issues: ${issueCount}`);
  console.log("══════════════════════════════════════");

  if (issueCount > 0) {
    console.log("");
    const critical = analysis.issues.filter((i) => i.severity === "critical");
    const warnings = analysis.issues.filter((i) => i.severity === "warning");
    const info = analysis.issues.filter((i) => i.severity === "info");
    if (critical.length > 0) console.log(`  ${critical.length} critical issue(s)`);
    if (warnings.length > 0) console.log(`  ${warnings.length} warning(s)`);
    if (info.length > 0) console.log(`  ${info.length} info`);
  }
  console.log("");

  // Conversation loop
  while (true) {
    const userInput = await readLine("> ");

    if (!userInput || userInput.toLowerCase() === "exit" || userInput.toLowerCase() === "quit") {
      console.log("Goodbye!");
      break;
    }

    messages.push({ role: "user", content: userInput });

    // Agent turn loop (may need multiple rounds for tool calls)
    let continueLoop = true;
    while (continueLoop) {
      let response;
      try {
        response = await anthropic.messages.create({
          model: MODEL,
          max_tokens: 4096,
          system: systemPrompt,
          tools: toolDefinitions,
          messages,
        });
      } catch (err: any) {
        console.error(`\nAPI error: ${err.message}`);
        // Remove the last user message so the conversation can continue
        messages.pop();
        break;
      }

      const { textParts, toolCalls } = processAssistantResponse(response.content);

      // Add assistant response to history
      messages.push({ role: "assistant", content: response.content });

      // Execute any tool calls
      if (toolCalls.length > 0) {
        const toolResults: any[] = [];

        for (const call of toolCalls) {
          // Special handling for push_blueprint — require user confirmation
          if (call.name === "push_blueprint") {
            const confirm = await readLine("Push changes to Make.com? [y/N] ");
            if (confirm.toLowerCase() !== "y") {
              toolResults.push({
                type: "tool_result",
                tool_use_id: call.id,
                content: JSON.stringify({ success: false, error: "User declined to push" }),
              });
              continue;
            }
          }

          const result = await executeTool(state, call.name, call.input);
          toolResults.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: result,
          });
        }

        messages.push({ role: "user", content: toolResults });
      }

      // Print text parts
      if (textParts.length > 0) {
        console.log("");
        console.log(textParts.join("\n"));
        console.log("");
      }

      // Continue loop if there were tool calls and stop_reason is tool_use
      continueLoop = response.stop_reason === "tool_use";
    }
  }

  process.stdin.pause();
}
