import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

export function buildModuleNamePrompt(moduleType: string, mapper: any): string {
  const mapperSummary = mapper ? JSON.stringify(mapper).slice(0, 300) : "no mapper";
  return `You are naming a Make.com automation module. The module type is "${moduleType}" and its mapper configuration is: ${mapperSummary}

Generate a short, descriptive name (2-5 words) in English that explains what this module does in the context of the automation. Just output the name, nothing else. No quotes.

Examples:
- powerlink:plquery with phone query → "Query Contact by Phone"
- gmail:sendEmail to admin → "Notify Admin via Email"
- http:ActionSendData to webhook → "Send Data to CRM API"`;
}

export function buildScenarioNamePrompt(currentName: string, moduleTypes: string[]): string {
  return `You are renaming a Make.com automation scenario. The current name is "${currentName}" and the modules in the scenario are: ${moduleTypes.join(", ")}

Generate a descriptive scenario name that explains: what triggers it, what data flows through it, and where it goes. Use the format: "[Source/Trigger]: [Action] [Data] -> [Target]"

Just output the name, nothing else. No quotes. Keep it under 80 characters.`;
}

export function parseAiName(raw: string): string {
  return raw.replace(/^["']|["']$/g, "").trim();
}

export async function generateModuleName(moduleType: string, mapper: any): Promise<string> {
  const anthropic = getClient();
  const prompt = buildModuleNamePrompt(moduleType, mapper);

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 50,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  return parseAiName(text);
}

export async function generateScenarioName(
  currentName: string,
  moduleTypes: string[]
): Promise<string> {
  const anthropic = getClient();
  const prompt = buildScenarioNamePrompt(currentName, moduleTypes);

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 100,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  return parseAiName(text);
}
