import { BlueprintSchema, type Blueprint, type Note } from "./types";

export interface MakeApiConfig {
  token: string;
  baseUrl: string;
}

export class MakeApiClient {
  private token: string;
  private baseUrl: string;

  constructor(config: MakeApiConfig) {
    this.token = config.token;
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
  }

  getBlueprintUrl(scenarioId: number): string {
    return `${this.baseUrl}/api/v2/scenarios/${scenarioId}/blueprint`;
  }

  getScenarioUrl(scenarioId: number): string {
    return `${this.baseUrl}/api/v2/scenarios/${scenarioId}`;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Token ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  async fetchBlueprint(scenarioId: number): Promise<{ blueprint: Blueprint; raw: any }> {
    const res = await fetch(this.getBlueprintUrl(scenarioId), {
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`Make API error ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();

    let blueprintData: any;
    if (data.response?.blueprint) {
      blueprintData = data.response.blueprint;
    } else if (data.blueprint) {
      blueprintData =
        typeof data.blueprint === "string" ? JSON.parse(data.blueprint) : data.blueprint;
    } else {
      blueprintData = data;
    }

    const blueprint = BlueprintSchema.parse(blueprintData);
    return { blueprint, raw: data };
  }

  async pushBlueprint(scenarioId: number, blueprint: Blueprint): Promise<void> {
    const body = JSON.stringify({
      blueprint: JSON.stringify(blueprint),
    });

    const res = await fetch(this.getScenarioUrl(scenarioId), {
      method: "PATCH",
      headers: this.headers(),
      body,
    });

    if (!res.ok) {
      throw new Error(`Make API PATCH error ${res.status}: ${await res.text()}`);
    }
  }

  async createNote(scenarioId: number, moduleIds: number[], content: string): Promise<Note> {
    const res = await fetch(`${this.baseUrl}/api/v2/scenarios/${scenarioId}/notes`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ moduleIds, content }),
    });

    if (!res.ok) {
      throw new Error(`Make API create note error ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    return data.note;
  }

  async fetchNotes(scenarioId: number): Promise<Note[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v2/scenarios/${scenarioId}/notes`, {
        headers: this.headers(),
      });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data.notes) ? data.notes : [];
    } catch {
      return [];
    }
  }
}
