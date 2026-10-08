# Seed

The `seed` compose service generates the dataset before every repetition (BR-3).

Contract:
- Read the seed from the `BENCH_SEED` environment variable and generate the **same data for the same seed**
  (use a seeded random generator, never `Math.random()` or the current time).
- Write directly to the dependencies (the kit has already recreated their volumes).
- Print, as the last line of stdout, `BENCH_DATASET_SHA256=<hex>`: a SHA-256 over the generated data in a
  stable order. The kit checks it is identical across repetitions.
- Exit 0 on success, non-zero on failure.
