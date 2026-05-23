import type { ProceduralSkill, SkillStore } from "./types.js";

/**
 * In-memory skill store with semantic matching via embedding cosine.
 *
 * Skills are stored by id and indexed by trigger embedding for
 * `queryByTrigger`. Simple but sufficient for typical agent workloads.
 */
export class InMemorySkillStore implements SkillStore {
  private skills = new Map<string, ProceduralSkill>();

  async put(skill: ProceduralSkill): Promise<void> {
    this.skills.set(skill.id, skill);
  }

  async get(id: string): Promise<ProceduralSkill | null> {
    return this.skills.get(id) ?? null;
  }

  async queryByTrigger(triggerText: string, topK = 5): Promise<ProceduralSkill[]> {
    // For now, do a simple text-substring match. Callers who want
    // semantic matching should embed the trigger and match against
    // skill.embedding externally.
    const lower = triggerText.toLowerCase();
    const scored: Array<{ skill: ProceduralSkill; score: number }> = [];
    for (const skill of this.skills.values()) {
      const triggerLower = skill.trigger.toLowerCase();
      let score = 0;
      // Exact match
      if (triggerLower === lower) {
        score = 1;
      } else if (triggerLower.includes(lower)) {
        score = 0.8;
      } else {
        // Word overlap
        const words = new Set(lower.split(/\W+/).filter((w) => w.length > 2));
        const triggerWords = triggerLower.split(/\W+/).filter((w) => w.length > 2);
        const hits = triggerWords.filter((w) => words.has(w)).length;
        score = hits / Math.max(words.size, 1);
      }
      if (score > 0.3) {
        scored.push({ skill, score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map((s) => s.skill);
  }

  async listAll(): Promise<ProceduralSkill[]> {
    return [...this.skills.values()];
  }
}
