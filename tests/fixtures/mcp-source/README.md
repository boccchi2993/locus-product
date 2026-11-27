# MCP browser fixtures

These directories hold the inputs to the two test-only acceptance archives,
including their manifests. From the Product root after running `npm ci`:

```sh
node tests/fixtures/mcp-source/rebuild.mjs
```

This repacks the inputs with Product's deterministic archive writer and checks
byte equality against the committed archives. Pass `--write` to write the
archives from these inputs.
