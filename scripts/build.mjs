import { build } from "esbuild";
await build({
  entryPoints: ["public/app.mjs"],
  outfile: "dist/app.js",
  bundle: true,
  format: "esm",
  target: "es2022",
  sourcemap: true,
});
console.log("前端已构建：dist/app.js");
