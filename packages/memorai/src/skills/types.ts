// Procedural Skill Extraction (S2)
//
// Scans tool_call history, clusters similar invocations, and extracts
// reusable skill templates when a pattern is observed ≥N times with
// high success rate.

export interface ProceduralSkill {
  id: string;
  /** Natural-language trigger pattern — "deploy node.js app to AWS" */
  trigger: string;
  /** Parameterized step templates. */
  steps: SkillStep[];
  /** Preconditions that must hold before applying. */
  preconditions: string[];
  /** Success rate across observed executions [0,1]. */
  successRate: number;
  /** How many times this skill has been observed. */
  observationCount: number;
  /** Unix ms of last observation. */
  lastObservedAt: number;
  /** Embedding of trigger+steps for semantic matching. */
  embedding?: number[];
}

export interface SkillStep {
  tool: string;
  /** Parameter template with slots: "{{region}}", "{{appName}}" */
  argsTemplate: Record<string, string>;
  /** Expected result shape or type. */
  expectedResult?: string;
}

export interface SkillStore {
  put(skill: ProceduralSkill): Promise<void>;
  get(id: string): Promise<ProceduralSkill | null>;
  queryByTrigger(triggerText: string, topK?: number): Promise<ProceduralSkill[]>;
  listAll(): Promise<ProceduralSkill[]>;
}
