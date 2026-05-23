import { generateId } from "../utils.js";
import type { MemoryNode } from "../types.js";
import type { ProceduralSkill, SkillStep } from "./types.js";

export interface SkillExtractionOptions {
  /** Minimum observations before extracting a skill. Default 3. */
  minObservations?: number;
  /** Minimum success rate (0-1). Default 0.8. */
  minSuccessRate?: number;
  /** Time window in ms. Default 7 days. */
  since?: number;
}

export interface SkillExtractionResult {
  skills: ProceduralSkill[];
  /** Nodes that were consumed by the extraction. */
  processedNodeIds: string[];
}

/**
 * Skill extractor (S2).
 *
 * Scans tool_call memory nodes, clusters by tool name + arg similarity,
 * and extracts reusable ProceduralSkills from high-frequency, high-success
 * patterns.
 */
export class SkillExtractor {
  constructor() {}

  extract(nodes: MemoryNode[], opts: SkillExtractionOptions = {}): SkillExtractionResult {
    const minObservations = opts.minObservations ?? 3;
    const minSuccessRate = opts.minSuccessRate ?? 0.8;
    const since = opts.since ?? Date.now() - 7 * 24 * 60 * 60 * 1000;

    // Filter to tool_call nodes within window.
    const toolNodes = nodes.filter(
      (n) =>
        n.raw.content.kind === "tool_call" &&
        n.timestamp >= since &&
        typeof n.raw.content.tool === "string",
    );

    if (toolNodes.length === 0) {
      return { skills: [], processedNodeIds: [] };
    }

    // Cluster by tool name.
    const byTool = new Map<string, MemoryNode[]>();
    for (const node of toolNodes) {
      const tool = (node.raw.content as { tool: string }).tool;
      if (!byTool.has(tool)) byTool.set(tool, []);
      byTool.get(tool)!.push(node);
    }

    const skills: ProceduralSkill[] = [];
    const processed = new Set<string>();

    for (const [tool, cluster] of byTool) {
      if (cluster.length < minObservations) continue;

      const successCount = cluster.filter(
        (n) => (n.raw.content as { success: boolean }).success,
      ).length;
      const successRate = successCount / cluster.length;
      if (successRate < minSuccessRate) continue;

      // Extract common arg keys.
      const argKeys = this.extractCommonArgKeys(cluster);

      // Derive preconditions from failures.
      const failures = cluster.filter(
        (n) => !(n.raw.content as { success: boolean }).success,
      );
      const preconditions = this.derivePreconditions(failures);

      // Build trigger from most common plan_step that preceded these calls.
      const trigger = this.inferTrigger(cluster);

      const steps: SkillStep[] = [
        {
          tool,
          argsTemplate: argKeys,
          expectedResult: successRate > 0.95 ? "success" : "partial",
        },
      ];

      const skill: ProceduralSkill = {
        id: generateId(),
        trigger,
        steps,
        preconditions,
        successRate,
        observationCount: cluster.length,
        lastObservedAt: Math.max(...cluster.map((n) => n.timestamp)),
      };

      skills.push(skill);
      for (const n of cluster) processed.add(n.id);
    }

    return { skills, processedNodeIds: [...processed] };
  }

  private extractCommonArgKeys(nodes: MemoryNode[]): Record<string, string> {
    // Count key frequency across all arg objects.
    const keyValues = new Map<string, Map<string, number>>();
    for (const node of nodes) {
      const args = (node.raw.content as { args?: Record<string, unknown> }).args;
      if (!args || typeof args !== "object") continue;
      for (const [k, v] of Object.entries(args)) {
        if (!keyValues.has(k)) keyValues.set(k, new Map());
        const valStr = typeof v === "string" ? v : JSON.stringify(v);
        const m = keyValues.get(k)!;
        m.set(valStr, (m.get(valStr) ?? 0) + 1);
      }
    }

    const template: Record<string, string> = {};
    for (const [key, values] of keyValues) {
      // Pick the most frequent value as the default template.
      let bestVal = "";
      let bestCount = 0;
      for (const [val, count] of values) {
        if (count > bestCount) {
          bestCount = count;
          bestVal = val;
        }
      }
      // If there are many distinct values, mark as a slot.
      if (values.size > 1) {
        template[key] = `{{${key}}}`;
      } else {
        template[key] = bestVal;
      }
    }
    return template;
  }

  private derivePreconditions(failures: MemoryNode[]): string[] {
    const preconditions: string[] = [];
    for (const node of failures) {
      const error = (node.raw.content as { errorClass?: string }).errorClass;
      const note = (node.raw.content as { note?: string }).note;
      if (error === "Timeout") {
        preconditions.push("Network connection must be stable");
      }
      if (error === "InvalidArgs" || error === "NotFound") {
        preconditions.push("Required files/resources must exist");
      }
      if (note?.toLowerCase().includes("permission") || note?.toLowerCase().includes("auth")) {
        preconditions.push("Valid authentication credentials required");
      }
    }
    return [...new Set(preconditions)];
  }

  private inferTrigger(cluster: MemoryNode[]): string {
    // Look for plan_step nodes that are parents or temporally near the tool calls.
    // For now, use a generic trigger based on the tool name.
    const tool = (cluster[0].raw.content as { tool: string }).tool;
    return `Execute ${tool}`;
  }
}
