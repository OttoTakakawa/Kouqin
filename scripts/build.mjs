import fs from "node:fs/promises";
import { build } from "esbuild";
await build({
  entryPoints: ["public/app.mjs"],
  outfile: "dist/app.js",
  bundle: true,
  format: "esm",
  target: "es2022",
  sourcemap: true,
  plugins: [
    {
      name: "local-soundfont-text",
      setup(build) {
        build.onLoad(
          {
            filter:
              /(?:musyngkite|generaluser|vcsl-normal|vcsl-soft|vcsl-vib)-harmonica-mp3\.js$/,
          },
          async ({ path }) => ({
            contents: await fs.readFile(path, "utf8"),
            loader: "text",
          }),
        );
      },
    },
  ],
});
console.log("前端已构建：dist/app.js");
