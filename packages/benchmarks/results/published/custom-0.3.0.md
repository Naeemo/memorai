# Benchmark Results: Memorai Custom Suite

**Run at:** 2026-05-17T03:41:10.687Z
**Overall Score:** 95.5%
**Total Latency:** 161ms

| Benchmark | Score | Latency | Details |
|-----------|-------|---------|---------|
| Needle-in-a-Haystack | 95.5% | 24ms | n=10=score=1.00, rank=0, sim=1.000, n=50=score=1.00, rank=0, sim=1.000, n=100=score=0.82, rank=1, sim=0.589, n=250=score=1.00, rank=0, sim=0.768 |
| Multi-Needle Retrieval | 88.9% | 22ms | needles=1=recall=1.00, avg_rank=9.0, avg_sim=0.759, needles=3=recall=0.67, avg_rank=1.7, avg_sim=0.746, needles=5=recall=1.00, avg_rank=4.4, avg_sim=0.780 |
| Hierarchical Evolution Preservation | 100.0% | 23ms | baseline_score=1.000, evolved_score=1.000, preservation_ratio=1.000, evolve_ms=3.140, baseline_latency_ms=22.581 |
| Temporal Retrieval | 100.0% | 25ms | memory_count=60.000, queries=5.000, avg_recall=1.000 |
| Scalability | 100.0% | 25ms | n=50_seq_write_ms/item=22.494, n=50_batch_write_ms/item=10.130, n=50_retrieve_ms=16.834, n=50_speedup=2.22x, n=100_seq_write_ms/item=20.185, n=100_batch_write_ms/item=9.859, n=100_retrieve_ms=20.014, n=100_speedup=2.05x, n=250_seq_write_ms/item=24.245, n=250_batch_write_ms/item=9.567, n=250_retrieve_ms=26.365, n=250_speedup=2.53x, n=500_seq_write_ms/item=21.381, n=500_batch_write_ms/item=9.535, n=500_retrieve_ms=35.057, n=500_speedup=2.24x, n=1000_seq_write_ms/item=21.519, n=1000_batch_write_ms/item=10.047, n=1000_retrieve_ms=27.800, n=1000_speedup=2.14x, avg_batch_speedup=2.237 |
| Cross-Agent Isolation | 100.0% | 16ms | agents=3.000, memories_per_agent=30.000, isolation_scores=1.00, 1.00, 1.00 |
| Multimodal Recall | 80.0% | 25ms | samples=5.000, hits=4.000, kinds=image,video,audio,image,file, failed=file:blob:security-audit-q2.pdf |
| Time-Window Recall | 100.0% | 1ms | events=60.000, windows=8.000, span_hours=24.000, avg_recall=1.000, avg_precision=1.000 |
