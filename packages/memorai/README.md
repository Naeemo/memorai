# Memorai [![npm](https://img.shields.io/npm/v/memorai.svg)](https://npmjs.com/package/memorai)

The core package of [Memorai](https://github.com/Naeemo/memorai) — the memory layer for AI agents.

For full documentation, see the [root README](https://github.com/Naeemo/memorai#readme) and [design docs](../../docs/design/).

**Note:** As of v0.5.0+, `memory.recall()` automatically resolves temporal expressions like `"yesterday"` or `"last week"` into time-range filters. Set `defaultResolveTime: false` in `MemoraiConfig` to keep the previous opt-in behavior.

## License

[MIT](./LICENSE) License © 2025 [Naeemo](https://github.com/Naeemo)
