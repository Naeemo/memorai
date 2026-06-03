import { MemoraiProvider } from "./providers/memorai.js";
import { loadLoCoMo } from "./benchmarks/locomo/dataset.js";
import { generateAnswer } from "./core/llm/answerer.js";
import { judgeBinary } from "./core/llm/judge.js";
import { pickAnswererBackend, pickJudgeBackend } from "./core/llm/pick.js";

async function main() {
  console.log("Loading dataset...");
  const convs = await loadLoCoMo();
  const conv = convs[0];
  console.log(`Processing ${conv.id}: ${conv.sessions.length} sessions, ${conv.qas.length} QAs`);

  const provider = new MemoraiProvider({
    ingestMode: "wrap",
    embedder: "ollama",
    answererModel: "kimi-k2.6",
    judgeModel: "kimi-k2.6",
    resolveTime: true,
  });

  const answererBackend = pickAnswererBackend("kimi-k2.6");
  const judgeBackend = pickJudgeBackend("kimi-k2.6");

  console.log("Init provider...");
  await provider.init();
  console.log("Reset user...");
  await provider.resetUser(conv.id);

  for (let i = 0; i < conv.sessions.length; i++) {
    await provider.ingestTurns(conv.sessions[i], {
      userId: conv.id,
      sessionId: String(i),
      evolve: true,
    });
  }
  console.log("All sessions ingested.");

  const qa = conv.qas[0];
  console.log(`Querying: ${qa.question}`);
  const hits = await provider.query(qa.question, { userId: conv.id, topK: 30 });
  console.log(`Got ${hits.length} hits.`);

  console.log("Generating answer...");
  const predicted = await generateAnswer(answererBackend, qa.question, hits);
  console.log(`Predicted: ${predicted}`);

  console.log("Judging...");
  const label = await judgeBinary(judgeBackend, qa.question, qa.gold, predicted);
  console.log(`Label: ${label}`);

  await provider.close();
  console.log("Done.");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
