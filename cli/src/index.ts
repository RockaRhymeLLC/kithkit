#!/usr/bin/env node
/**
 * Kithkit CLI — Entry point.
 *
 * Commands:
 *   kithkit init      — Interactive setup wizard
 *   kithkit search    — Search the skill catalog
 *   kithkit install   — Install a skill
 *   kithkit update    — Update installed skills
 *   kithkit --version — Print version
 *   kithkit --help    — Print help
 */

export const VERSION = '0.1.0';

const args = process.argv.slice(2);
const command = args[0];

async function main(): Promise<void> {
  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === '--version' || command === '-v') {
    console.log(`kithkit v${VERSION}`);
    return;
  }

  switch (command) {
    case 'init': {
      const { runInit } = await import('./init.js');
      const result = await runInit();
      if (!result.success) {
        process.exitCode = 1;
      }
      break;
    }

    case 'search': {
      const query = args[1];
      if (!query) {
        console.error('Usage: kithkit search <query>');
        process.exitCode = 1;
        break;
      }
      const { runSearch } = await import('./search.js');
      await runSearch({ query });
      break;
    }

    case 'install': {
      const skillName = args[1];
      if (!skillName) {
        console.error('Usage: kithkit install <skill-name>');
        process.exitCode = 1;
        break;
      }
      const { runInstall } = await import('./install.js');
      await runInstall({ skillName });
      break;
    }

    case 'update': {
      const skillName = args[1]; // Optional — if omitted, checks all
      const { runUpdate } = await import('./update.js');
      await runUpdate({ skillName });
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
}

function printHelp(): void {
  console.log(`
kithkit v${VERSION} — Personal AI assistant framework

Commands:
  init              Set up a new kithkit project
  search <query>    Search the skill catalog
  install <name>    Install a skill from the catalog
  update [name]     Update installed skill(s)

Options:
  --version, -v     Print version
  --help, -h        Print this help
`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
