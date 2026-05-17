import { generateId, type WritePayload } from "memorai";

const HAYSTACK_TEMPLATES = [
  "The user opened their email client and checked for new messages",
  "A notification appeared on the phone screen about a calendar event",
  "The browser tab was switched from news to a social media page",
  "The coffee machine finished brewing and beeped twice",
  "A Slack message arrived from the engineering channel about deploy status",
  "The user scrolled through a document titled Quarterly Report",
  "An email from HR about benefits enrollment landed in the inbox",
  "The system backup completed at 3:00 AM successfully",
  "A weather alert popped up showing rain expected this afternoon",
  "The user muted a video call while taking notes",
  "A file named project_proposal_v2.pdf was downloaded to Downloads",
  "The IDE showed 42 warnings and 3 errors in the current project",
  "A reminder alarm rang for the 2:00 PM standup meeting",
  "The user bookmarked a page about TypeScript best practices",
  "A calendar invite was accepted for next Tuesday's design review",
  "The printer ran out of paper during a large document print job",
  "A news article about AI regulation was shared in a group chat",
  "The user adjusted the screen brightness to 60 percent",
  "A password manager auto-filled credentials for a banking site",
  "The user pinned three tabs in the browser for later reference",
  "A fitness tracker reported 4,200 steps taken so far today",
  "The user dragged three files into a cloud storage sync folder",
  "A code review comment requested changes to the error handling logic",
  "The user set a timer for 25 minutes using a pomodoro app",
  "A music playlist switched from focus music to ambient sounds",
  "The user archived 12 old emails from the promotions folder",
  "A meeting recording started automatically when joining the call",
  "The user typed a search query about memory architecture patterns",
  "A system update dialog appeared suggesting a restart tonight",
  "The user switched the phone to do-not-disturb mode for 2 hours",
];

const DISTRACTOR_TEMPLATES = [
  "The classified initiative is codenamed PHOENIX with a target launch of April 10th",
  "Top secret operation ARES is scheduled for deployment on February 28th",
  "The internal project name is APOLLO and the go-live date is May 1st",
  "The database admin password is currently Qwerty123 and the backup code is XYZ-9999",
  "Security team changed the root password to AdminPass2025 and vault key is VK-5566",
  "The login credentials were updated to Passw0rd! and recovery token is RT-8877",
  "The CFO announced a merger with TechGlobal valued at 320 million dollars",
  "The board approved the purchase of DataFlow Inc for 180 million dollars",
  "The company is acquiring CloudNine Systems for 275 million in stock",
  "Emergency contact for the data center is Mike Chen at extension 5521",
  "Server room on-call engineer is Sarah Kim reachable at extension 3312",
  "After-hours support for the datacenter is Alex Patel extension 9910",
  "The REST API throttle is set to 3000 requests per minute with key sk-dev-1122",
  "GraphQL endpoint allows 8000 queries per hour using key sk-staging-3344",
  "The webhook service limit is 12000 calls per day with key sk-beta-5566",
  "Q2 revenue goal was 9.8 million with a conservative estimate of 8.5 million",
  "The annual sales target is 45 million dollars with quarterly checkpoints",
  "Q4 profit objective is 18.2 million with a minimum threshold of 14 million",
  "The conference room booking password is Meeting2025 and coordinator is a.johnson",
  "Event space reservation code is BookItNow! and manager is l.davis",
  "The auditorium scheduling PIN is ShowTime26 and contact is r.wilson",
  "Legal case reference is LC-2025-9921 and attorney is Baker McKenzie",
  "The litigation file number is LF-2026-1155 and firm is Skadden Arps",
  "Pending dispute case ID is PD-2026-2299 represented by Kirkland Ellis",
  "The Docker Swarm manager is at https://swarm.staging.local:2377 with stack green-team",
  "The Nomad cluster API is https://nomad.dev.internal:4646 with job region west-team",
  "OpenShift console is at https://console.openshift.prod:8443 with project red-team",
  "Certificate rotation happens every 60 days and the next update is July 15th",
  "SSH key refresh interval is 45 days with the next replacement on August 20th",
  "OAuth token expiry cycle is 30 days and renewal is due on September 5th",
];

const NEEDLE_TEMPLATES = [
  {
    summary:
      "CRITICAL: The secret project codename is ORION and the launch date is March 15th",
    query: "What is the secret project codename and launch date?",
    tags: ["secret", "project", "orion", "march"],
  },
  {
    summary:
      "CRITICAL: The database password was rotated to X7k!9mP$vqL2 and backup key is BKP-9942",
    query: "What is the new database password and backup key?",
    tags: ["database", "password", "backup", "security"],
  },
  {
    summary:
      "CRITICAL: The CEO announced the acquisition of NexGen Corp for 450 million dollars",
    query: "Which company did the CEO announce an acquisition for and at what price?",
    tags: ["ceo", "acquisition", "nexgen", "announcement"],
  },
  {
    summary:
      "CRITICAL: Emergency contact for the server room is Dr. Elena Voss at extension 7734",
    query: "Who is the emergency contact for the server room and what is their extension?",
    tags: ["emergency", "server", "contact", "elena"],
  },
  {
    summary:
      "CRITICAL: The API rate limit was changed to 5000 requests per hour with key sk-prod-8842",
    query: "What is the API rate limit and production key?",
    tags: ["api", "rate-limit", "production", "key"],
  },
  {
    summary:
      "CRITICAL: The Q3 revenue target is 12.5 million dollars with a stretch goal of 15 million",
    query: "What are the Q3 revenue targets?",
    tags: ["revenue", "q3", "target", "stretch"],
  },
  {
    summary:
      "CRITICAL: The meeting room reservation system password is RoomBook2026! and admin is j.smith",
    query: "What is the meeting room system password and who is the admin?",
    tags: ["meeting", "reservation", "password", "admin"],
  },
  {
    summary:
      "CRITICAL: The legal hold case number is LH-2026-0847 and counsel is Morrison Hayes LLP",
    query: "What is the legal hold case number and representing counsel?",
    tags: ["legal", "hold", "case", "counsel"],
  },
  {
    summary:
      "CRITICAL: The Kubernetes cluster endpoint is https://k8s.prod.internal:6443 with namespace blue-team",
    query: "What is the Kubernetes cluster endpoint and primary namespace?",
    tags: ["kubernetes", "cluster", "endpoint", "namespace"],
  },
  {
    summary:
      "CRITICAL: The encryption key rotation schedule is every 90 days and next rotation is June 30th",
    query: "When is the next encryption key rotation and what is the schedule?",
    tags: ["encryption", "key", "rotation", "schedule"],
  },
];

export function generateHaystack(
  count: number,
  distractorRatio = 0.3,
): WritePayload[] {
  const payloads: WritePayload[] = [];
  const distractorCount = Math.floor(count * distractorRatio);
  const regularCount = count - distractorCount;

  for (let i = 0; i < regularCount; i++) {
    const template = HAYSTACK_TEMPLATES[i % HAYSTACK_TEMPLATES.length];
    const variation = `${template} (record #${i + 1})`;
    payloads.push({
      raw: {
        content: { kind: "observation", text: variation },
        text: variation,
      },
      annotations: {
        summary: variation,
        tags: ["haystack", `record-${i + 1}`],
        salienceScore: 0.3 + Math.random() * 0.4,
        modality: ["text"],
      },
      meta: { sourceAgent: "benchmark", agentRole: "reasoning" },
    });
  }

  for (let i = 0; i < distractorCount; i++) {
    const template = DISTRACTOR_TEMPLATES[i % DISTRACTOR_TEMPLATES.length];
    payloads.push({
      raw: {
        content: { kind: "observation", text: template },
        text: template,
      },
      annotations: {
        summary: template,
        tags: ["distractor", `dist-${i + 1}`],
        salienceScore: 0.5 + Math.random() * 0.3,
        modality: ["text"],
      },
      meta: { sourceAgent: "benchmark", agentRole: "reasoning" },
    });
  }

  for (let i = payloads.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [payloads[i], payloads[j]] = [payloads[j], payloads[i]];
  }

  return payloads;
}

export function generateNeedles(
  count: number,
): Array<WritePayload & { query: string }> {
  const results: Array<WritePayload & { query: string }> = [];
  for (let i = 0; i < count; i++) {
    const template = NEEDLE_TEMPLATES[i % NEEDLE_TEMPLATES.length];
    results.push({
      raw: {
        content: { kind: "observation", text: template.summary },
        text: template.summary,
      },
      annotations: {
        summary: template.summary,
        tags: template.tags,
        salienceScore: 0.9,
        modality: ["text"],
      },
      query: template.query,
      meta: { sourceAgent: "benchmark", agentRole: "reasoning" },
    });
  }
  return results;
}

export function generateTemporalMemories(
  count: number,
  timeSpanHours: number,
): Array<WritePayload & { expectedTime: number }> {
  const now = Date.now();
  const spanMs = timeSpanHours * 60 * 60 * 1000;
  const results: Array<WritePayload & { expectedTime: number }> = [];

  const templates = [
    "User attended a standup meeting and discussed sprint progress",
    "User reviewed pull request #42 and left approval comments",
    "User updated the documentation for the authentication module",
    "User deployed the staging environment and ran smoke tests",
    "User had a one-on-one with the team lead about career growth",
    "User refactored the database connection pool configuration",
    "User created a Jira ticket for the memory leak investigation",
    "User merged the feature branch into main after CI passed",
    "User presented the quarterly roadmap to stakeholders",
    "User fixed a critical bug in the payment processing pipeline",
  ];

  for (let i = 0; i < count; i++) {
    const timeOffset = Math.floor((i / count) * spanMs);
    const timestamp = now - spanMs + timeOffset;
    const summary = `${templates[i % templates.length]} (at hour ${Math.floor(timeOffset / 3600000)})`;
    results.push({
      raw: {
        content: { kind: "observation", text: summary },
        text: summary,
      },
      annotations: {
        summary,
        tags: ["temporal", `hour-${Math.floor(timeOffset / 3600000)}`],
        salienceScore: 0.5 + Math.random() * 0.3,
        modality: ["text"],
      },
      timestamp,
      expectedTime: timestamp,
      meta: { sourceAgent: "benchmark", agentRole: "reasoning" },
    });
  }
  return results;
}

export function generateAgentMemories(
  agents: string[],
  memoriesPerAgent: number,
): Array<WritePayload & { agent: string }> {
  const results: Array<WritePayload & { agent: string }> = [];
  for (const agent of agents) {
    for (let i = 0; i < memoriesPerAgent; i++) {
      const summary = `Agent ${agent} performed action ${i + 1}: ${generateId().slice(0, 8)}`;
      results.push({
        raw: {
          content: { kind: "observation", text: summary },
          text: summary,
        },
        annotations: {
          summary,
          tags: [agent, `action-${i + 1}`],
          salienceScore: 0.6,
          modality: ["text"],
        },
        agent,
        meta: {
          sourceAgent: agent,
          agentRole: agent === "reasoning" ? "reasoning" : "proactive",
        },
      });
    }
  }
  return results;
}
