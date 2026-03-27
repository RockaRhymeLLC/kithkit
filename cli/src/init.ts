/**
 * kithkit init — interactive setup wizard.
 *
 * Steps:
 * 1. Check prerequisites (Node.js 22+, npm, Claude Code CLI)
 * 2. Ask for agent name
 * 3. Select personality template
 * 4. Create kithkit.config.yaml
 * 5. Copy identity template
 * 6. Create .claude/agents/ with built-in profiles
 * 7. Start daemon and boot comms agent
 * 8. Agent introduces itself
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import yaml from 'js-yaml';
import {
  checkPrerequisites,
  formatPrereqReport,
  type PrereqReport,
} from './prerequisites.js';

// ── Types ───────────────────────────────────────────────────

export interface InitOptions {
  /** Directory to initialize in. Defaults to cwd. */
  dir?: string;
  /** Skip prerequisites check (for testing). */
  skipPrereqs?: boolean;
  /** Pre-set agent name (skip prompt). */
  name?: string;
  /** Pre-set template choice (skip prompt). */
  template?: string;
  /** Custom readline interface (for testing). */
  rl?: readline.Interface;
  /** Run only a specific sub-step instead of the full wizard. */
  subcommand?: 'prereqs' | 'identity' | 'verify';
}

export interface InitResult {
  success: boolean;
  projectDir: string;
  agentName: string;
  template: string;
  configPath: string;
  identityPath: string;
  profilesDir: string;
  errors: string[];
}

// ── Helpers ─────────────────────────────────────────────────

function findKithkitRoot(): string | null {
  // Walk up from this file to find the kithkit root (has kithkit.defaults.yaml).
  // Works in monorepo (cli/dist/init.js → cli → kithkit root) and when
  // installed globally (walks up from node_modules/.../cli/dist/).
  let dir = path.resolve(new URL('.', import.meta.url).pathname);
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'kithkit.defaults.yaml'))) return dir;
    // Also check if templates are co-located in the package (npm install case)
    if (fs.existsSync(path.join(dir, 'templates', 'identities'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: check if kithkit is installed as a dependency in the target project
  const cwdKithkit = path.join(process.cwd(), 'node_modules', 'kithkit');
  if (fs.existsSync(path.join(cwdKithkit, 'kithkit.defaults.yaml'))) return cwdKithkit;
  if (fs.existsSync(path.join(cwdKithkit, 'templates', 'identities'))) return cwdKithkit;
  return null;
}

async function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer: string) => resolve(answer.trim()));
  });
}

// ── Init Flow ───────────────────────────────────────────────

/**
 * Run the kithkit init wizard.
 */
export async function runInit(opts: InitOptions = {}): Promise<InitResult> {
  const projectDir = path.resolve(opts.dir ?? process.cwd());
  const errors: string[] = [];

  // Create readline interface for user prompts
  const rl = opts.rl ?? readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const closeRl = !opts.rl; // Only close if we created it

  try {
    // Sub-command: prereqs — run prerequisite check and exit
    if (opts.subcommand === 'prereqs') {
      const prereqs = await checkPrerequisites();
      console.log(formatPrereqReport(prereqs));
      return {
        success: prereqs.allPassed,
        projectDir,
        agentName: '',
        template: '',
        configPath: '',
        identityPath: '',
        profilesDir: '',
        errors: [],
      };
    }

    // Sub-command: verify — post-setup health check
    if (opts.subcommand === 'verify') {
      const results: string[] = [];

      // Check daemon running
      try {
        const resp = await fetch(`http://localhost:${3847}/health`);
        results.push(resp.ok ? '[ok] Daemon healthy' : '[!!] Daemon unhealthy');
      } catch {
        results.push('[!!] Daemon not running');
      }

      // Check config exists
      const configPath = path.join(projectDir, 'kithkit.config.yaml');
      results.push(fs.existsSync(configPath) ? '[ok] Config file exists' : '[!!] Config file missing');

      // Check identity exists
      const identityPath = path.join(projectDir, 'identity.md');
      results.push(fs.existsSync(identityPath) ? '[ok] Identity file exists' : '[!!] Identity file missing');

      console.log('\nVerification:\n' + results.join('\n'));
      return {
        success: !results.some(r => r.includes('[!!]')),
        projectDir,
        agentName: '',
        template: '',
        configPath,
        identityPath,
        profilesDir: '',
        errors: [],
      };
    }

    console.log('\nkithkit init — Setting up your AI assistant\n');

    // Step 1: Prerequisites
    if (!opts.skipPrereqs) {
      console.log('Checking prerequisites...');
      const prereqs = await checkPrerequisites();
      console.log(formatPrereqReport(prereqs));

      if (!prereqs.allPassed) {
        const criticalFails = prereqs.results.filter(r => !r.ok && !r.optional && r.name !== 'Claude Code');
        if (criticalFails.length > 0) {
          return {
            success: false,
            projectDir,
            agentName: '',
            template: '',
            configPath: '',
            identityPath: '',
            profilesDir: '',
            errors: criticalFails.map(r => r.error!),
          };
        }
        // Claude Code missing is a warning, not fatal
        console.log('\n  Note: Claude Code CLI not found. Install it to use agent features.');
        console.log('  npm install -g @anthropic-ai/claude-code\n');
      }
      console.log('');
    }

    // Step 2: Agent name
    let agentName = opts.name ?? '';
    if (!agentName) {
      agentName = await prompt(rl, 'What would you like to name your agent? ');
      if (!agentName) agentName = 'Assistant';
    }

    // Step 3: Personality template
    const kithkitRoot = findKithkitRoot();
    const templatesDir = kithkitRoot
      ? path.join(kithkitRoot, 'templates', 'identities')
      : null;

    let availableTemplates: string[] = [];
    if (templatesDir && fs.existsSync(templatesDir)) {
      availableTemplates = fs.readdirSync(templatesDir)
        .filter(f => f.endsWith('.md'))
        .map(f => path.basename(f, '.md'))
        .sort();
    }

    let templateChoice = opts.template ?? '';
    if (!templateChoice && availableTemplates.length > 0) {
      console.log('\nPersonality templates:');
      availableTemplates.forEach((t, i) => {
        console.log(`  ${i + 1}. ${t}`);
      });
      const answer = await prompt(rl, `\nSelect a template (1-${availableTemplates.length}): `);
      const idx = parseInt(answer, 10) - 1;
      if (idx >= 0 && idx < availableTemplates.length) {
        templateChoice = availableTemplates[idx]!;
      } else {
        templateChoice = availableTemplates[0]!;
      }
    }
    if (!templateChoice) templateChoice = 'professional';

    console.log(`\nSetting up "${agentName}" with ${templateChoice} personality...\n`);

    // Step 4: Create kithkit.config.yaml
    const configPath = path.join(projectDir, 'kithkit.config.yaml');
    if (!fs.existsSync(configPath)) {
      const configData = {
        agent: {
          name: agentName,
          identity_file: `identity.md`,
        },
        daemon: {
          port: 3847,
          log_level: 'info',
        },
      };
      fs.writeFileSync(configPath, yaml.dump(configData, { lineWidth: -1 }));
      console.log('  Created kithkit.config.yaml');
    } else {
      console.log('  kithkit.config.yaml already exists, skipping');
    }

    // Step 5: Copy identity template
    const identityPath = path.join(projectDir, 'identity.md');
    if (!fs.existsSync(identityPath) && templatesDir) {
      const templateFile = path.join(templatesDir, `${templateChoice}.md`);
      if (fs.existsSync(templateFile)) {
        let content = fs.readFileSync(templateFile, 'utf8');
        // Replace the name in frontmatter
        content = content.replace(/^name:\s*.+$/m, `name: ${agentName}`);
        fs.writeFileSync(identityPath, content);
        console.log(`  Created identity.md from ${templateChoice} template`);
      } else {
        errors.push(`Template file not found: ${templateFile}`);
      }
    } else if (fs.existsSync(identityPath)) {
      console.log('  identity.md already exists, skipping');
    }

    // Step 5b: Set default autonomy mode
    const autonomyPath = path.join(projectDir, '.kithkit', 'state', 'autonomy.json');
    if (!fs.existsSync(autonomyPath)) {
      fs.mkdirSync(path.join(projectDir, '.kithkit', 'state'), { recursive: true });
      fs.writeFileSync(autonomyPath, JSON.stringify({ mode: 'confident' }, null, 2));
      console.log('  Set default autonomy mode: confident');
    }

    // Step 6: Create .kithkit/agents/ with built-in profiles
    const profilesDir = path.join(projectDir, '.kithkit', 'agents');
    if (!fs.existsSync(profilesDir)) {
      fs.mkdirSync(profilesDir, { recursive: true });
    }

    const profilesSrc = kithkitRoot
      ? path.join(kithkitRoot, 'profiles')
      : null;

    if (profilesSrc && fs.existsSync(profilesSrc)) {
      const profiles = fs.readdirSync(profilesSrc).filter(f => f.endsWith('.md'));
      let copied = 0;
      for (const profile of profiles) {
        const dest = path.join(profilesDir, profile);
        if (!fs.existsSync(dest)) {
          fs.copyFileSync(path.join(profilesSrc, profile), dest);
          copied++;
        }
      }
      console.log(`  Copied ${copied} agent profiles to .kithkit/agents/`);
    }

    // Step 7 + 8: Daemon start and agent intro are handled by the caller
    // (the CLI entry point starts the daemon after init completes)
    console.log('\n  Init complete!\n');

    return {
      success: true,
      projectDir,
      agentName,
      template: templateChoice,
      configPath,
      identityPath,
      profilesDir,
      errors,
    };
  } finally {
    if (closeRl) rl.close();
  }
}
