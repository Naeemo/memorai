#!/usr/bin/env tsx
// Dataset downloader. No SHA verification yet — upstream datasets do not
// publish stable hashes for these files, and pinning to a snapshot would
// silently lag behind dataset corrections.
import { mkdir, writeFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type Dataset = "locomo" | "longmemeval" | "all";

interface FetchTarget {
  url: string;
  out: string;
  licenseUrl: string;
  licenseName: string;
}

const TARGETS: Record<Exclude<Dataset, "all">, FetchTarget[]> = {
  locomo: [
    {
      url: "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json",
      out: "datasets/locomo/locomo10.json",
      licenseName: "CC-BY-4.0",
      licenseUrl: "https://github.com/snap-research/locomo/blob/main/LICENSE",
    },
  ],
  longmemeval: [
    {
      url: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json",
      out: "datasets/longmemeval/longmemeval_oracle.json",
      licenseName: "MIT",
      licenseUrl:
        "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned",
    },
    {
      url: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json",
      out: "datasets/longmemeval/longmemeval_s.json",
      licenseName: "MIT",
      licenseUrl:
        "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned",
    },
  ],
};

async function fetchOne(target: FetchTarget): Promise<void> {
  const abs = resolve(process.cwd(), target.out);
  try {
    await access(abs);
    console.log(`skip  ${target.out} (already exists)`);
    return;
  } catch {
    // not present — fetch
  }

  console.log(`fetch ${target.url}`);
  console.log(`      → ${target.out}`);
  console.log(`      license: ${target.licenseName} (${target.licenseUrl})`);

  const res = await fetch(target.url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} from ${target.url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, buf);
  console.log(`      ok (${(buf.byteLength / 1024).toFixed(1)} KiB)`);
}

async function fetchAll(name: Dataset): Promise<void> {
  if (name === "all") {
    for (const key of Object.keys(TARGETS) as (keyof typeof TARGETS)[]) {
      await fetchAll(key);
    }
    return;
  }
  const list = TARGETS[name];
  if (!list) {
    console.error(`Unknown dataset: ${name}`);
    process.exit(2);
  }
  for (const t of list) {
    await fetchOne(t);
  }
}

async function main(): Promise<void> {
  const arg = process.argv[2] as Dataset | undefined;
  if (!arg) {
    console.log("Usage: bench:fetch <locomo|longmemeval|all>");
    process.exit(0);
  }
  await fetchAll(arg);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
