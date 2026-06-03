import { MemoraiProvider } from "./providers/memorai.js";

async function main() {
  console.log("Starting test...");
  const provider = new MemoraiProvider({
    ingestMode: "wrap",
    embedder: "ollama",
  });
  console.log("Initializing provider...");
  await provider.init();
  console.log("Provider initialized.");

  const turns = [
    { role: "user", content: "Hello, how are you?" },
    { role: "assistant", content: "I'm doing well, thanks!" },
  ];

  console.log("Ingesting turns...");
  await provider.ingestTurns(turns, { userId: "test", sessionId: "0", evolve: false });
  console.log("Turns ingested.");

  console.log("Querying...");
  const hits = await provider.query("how are you", { userId: "test", topK: 5 });
  console.log(`Got ${hits.length} hits.`);

  await provider.close();
  console.log("Done.");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
