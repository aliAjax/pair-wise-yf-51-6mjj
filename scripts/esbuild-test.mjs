import { build } from "esbuild";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const root = process.cwd();
const entry = process.argv[2];
const outfile = process.argv[3];

function resolveLib(spec) {
  const rel = spec.slice("$lib/".length);
  const candidates = [resolve(root, "src/lib", rel), resolve(root, "src/lib", rel + ".ts"), resolve(root, "src/lib", rel, "index.ts")];
  return candidates.find((p) => existsSync(p));
}

await build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile,
  logLevel: "warning",
  plugins: [{
    name: "alias",
    setup(b) {
      b.onResolve({ filter: /^\$lib\// }, (args) => ({ path: resolveLib(args.path) }));
      b.onResolve({ filter: /^\$app\/environment$/ }, () => ({ path: resolve(root, "scripts/stubs/environment.js") }));
    }
  }]
});
