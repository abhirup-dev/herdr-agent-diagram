// Links types/herdr-app to the Herdr app home so the mod type-checks against the app's own
// gpui-kit.d.ts and herdr.d.ts (rewritten by the app on every start; never copied into the repo).
import { existsSync, lstatSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const appHome = process.env.HERDR_APP_HOME ?? join(homedir(), ".config", "herdr-app");
const link = join(import.meta.dir, "..", "types", "herdr-app");
if (!existsSync(join(appHome, "gpui-kit.d.ts"))) {
  console.error(`no gpui-kit.d.ts in ${appHome}: start the Herdr app once, or set HERDR_APP_HOME`);
  process.exit(1);
}
if (lstatSync(link, { throwIfNoEntry: false })) unlinkSync(link);
symlinkSync(appHome, link);
console.log(`types/herdr-app -> ${appHome}`);
