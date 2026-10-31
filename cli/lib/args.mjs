// Argument parsing for every herdr-draw group, with cac. cac has no nested commands, so the router matches the group
// by its first word and each group parses the rest with its own cac program. Help stays hand-written (each group's
// HELP, which agents read); test/cli.test.ts checks that every option a program declares is in it.

/**
 * Parses argv against a fresh cac program. Throws a CACError (the router exits 2) for an unknown option, a missing
 * option value or a wrong number of arguments; not under -h/--help, which the group answers with its help.
 * @param {import("cac").CAC} cli
 * @param {string[]} argv
 * @returns {{ cmd: string | undefined, args: string[], options: Record<string, any> }}
 */
export function parse(cli, argv) {
  const { args, options } = cli.parse(["", "", ...argv], { run: false });
  // shortcut: cac doesn't tell mri which options take text, so `--title 2024` arrives as a number; turn it back
  // (exact for plain numbers; "007" or "1e3" come back as "7", "1000"). No option here is numeric.
  for (const [k, v] of Object.entries(options)) if (typeof v === "number") options[k] = String(v);
  const cmd = cli.matchedCommand;
  if (cmd && !options.help) {
    cmd.checkUnknownOptions();
    cmd.checkOptionValue();
    cmd.checkRequiredArgs();
    cmd.checkUnusedArgs();
  }
  return { cmd: cli.matchedCommandName, args: [...args], options };
}
