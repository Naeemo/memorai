import { MemoraiProvider } from "./providers/memorai.js";
import { loadLoCoMo } from "./benchmarks/locomo/dataset.js";

async function main() {
  console.log("Loading dataset...");
  const convs = await loadLoCoMo();
  console.log(`Loaded ${convs.length} conversations`);

  const conv = convs[0];
  console.log(`Processing ${conv.id}: ${conv.sessions.length} sessions, ${conv.qas.length} QAs`);

  const provider = new MemoraiProvider({
    ingestMode: "wrap",
    embedder: "ollama",
  });

  console.log("Init provider...");
  await provider.init();
  console.log("Reset user...");
  await provider.resetUser(conv.id);

  for (let i = 0; i < Math.min(conv.sessions.length, 3); i++) {
    console.log(`  Ingesting session ${i} (${conv.sessions[i].length} turns)...`);
    await provider.ingestTurns(conv.sessions[i], {
      userId: conv.id,
      sessionId: String(i),
      evolve: false,
    });
    console.log(`  Session ${i} done.`);
  }

  console.log("Querying first QA...");
  const hits = await provider.query(conv.qas[0].question, {
    userId: conv.id,
    topK: 5,
  });
  console.log(`Got ${hits.length} hits.`);

  await provider.close();
  console.log("Done.");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
