import esbuild from "esbuild";
import process from "node:process";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
const defaultServerUrl = process.env.WECHAT_LINK_SYNC_SERVER_URL || "https://api.bigpro.cn";
const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  target: "es2022",
  platform: "browser",
  outfile: "main.js",
  loader: { ".png": "dataurl" },
  sourcemap: production ? false : "inline",
  minify: production,
  define: {
    __WECHAT_LINK_SYNC_DEFAULT_SERVER_URL__: JSON.stringify(defaultServerUrl)
  },
  logLevel: "info"
});

if (watch) await context.watch();
else { await context.rebuild(); await context.dispose(); }
