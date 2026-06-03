import { MemoraiProvider } from "./providers/memorai.js";
import { loadLoCoMo } from "./benchmarks/locomo/dataset.js";

async function main() {
  console.log("Loading dataset...");
  const convs = await loadLoCoMo();
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

  for (let i = 0; i < conv.sessions.length; i++) {
    const start = Date.now();
    process.stdout.write(`  Ingesting session ${i} (${conv.sessions[i].length} turns)... `);
    await provider.ingestTurns(conv.sessions[i], {
      userId: conv.id,
      sessionId: String(i),
      evolve: true,
    });
    console.log(`done in ${Date.now() - start}ms`);
  }

  console.log("All sessions ingested.");
  await provider.close();
  console.log("Done.");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
