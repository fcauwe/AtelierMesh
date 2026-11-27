// Values the build (build.mjs) writes into the bundle with esbuild `define`: the plugin makers' help comes out of docs/ at build time.
/** The quick prompt for a coding agent, taken from docs/prompt-make-a-plugin.md. */
declare const __PLUGIN_PROMPT__: string
declare const __PLUGIN_PROMPT_NO_NPM__: string
/** Where the rendered plugin guide is, relative to the app. */
declare const __PLUGIN_GUIDE_URL__: string
/** The packed example plugin, or '' when it could not be packed. */
declare const __PLUGIN_EXAMPLE_URL__: string
/** The plugin developer kit (a zip), or '' when it could not be made. */
declare const __PLUGIN_KIT_URL__: string
/** The version of the app (apps/standalone/package.json) and the build it came from (the short git commit, or '' outside git). */
declare const __APP_VERSION__: string
declare const __APP_BUILD__: string
