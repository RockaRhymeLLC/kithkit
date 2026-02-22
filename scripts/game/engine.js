#!/usr/bin/env node
/**
 * BMO's Dungeon of Forgotten Games — Text Adventure Engine
 *
 * Usage:
 *   node engine.js "command"     Run a game command
 *   node engine.js --new         Start a new game
 *   node engine.js --status      Show current game status
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORLD_PATH = join(__dirname, 'world.json');
const PROJECT_ROOT = join(__dirname, '..', '..');
const STATE_PATH = join(PROJECT_ROOT, '.claude', 'state', 'game-state.json');

const world = JSON.parse(readFileSync(WORLD_PATH, 'utf8'));

const START_ROOM = 'loading-screen';
const CARTRIDGES_NEEDED = 3;

const DIR_ALIASES = {
  n: 'north', s: 'south', e: 'east', w: 'west',
  north: 'north', south: 'south', east: 'east', west: 'west',
  up: 'up', down: 'down', out: 'out', crack: 'crack',
};

// ─── State Management ──────────────────────────────────────────────

function newState() {
  const rooms = {};
  for (const [id, room] of Object.entries(world.rooms)) {
    rooms[id] = {
      items_here: [...(room.items_here || [])],
      bridge_broken: room.bridge_broken ?? false,
      items_blocked: room.items_blocked ?? false,
      boss_alive: room.boss?.alive ?? false,
      searched: {},
    };
  }
  return {
    room: START_ROOM,
    inventory: [],
    cartridges_inserted: 0,
    rooms,
    flags: {},
    moves: 0,
    started: new Date().toISOString(),
    won: false,
  };
}

function loadState() {
  if (!existsSync(STATE_PATH)) return null;
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch { return null; }
}

function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ─── Helpers ───────────────────────────────────────────────────────

function roomDef(roomId) { return world.rooms[roomId]; }
function rs(state) { return state.rooms[state.room]; }
function hasItem(state, id) { return state.inventory.includes(id); }
function itemName(id) { return world.items[id]?.name || id; }

function matchesItem(target, id, item) {
  const name = item.name.toLowerCase();
  if (target === id || target === name) return true;
  if (name.includes(target)) return true;
  const tw = target.split(/\s+/);
  const nw = name.split(/\s+/);
  if (tw.some(t => nw.some(n => n === t || n.startsWith(t)))) return true;
  if (id.replace(/-/g, ' ') === target) return true;
  return false;
}

function canSee(state) {
  return !(state.room === 'code-caves' && !hasItem(state, 'torch') && !state.flags.torch_lit);
}

// ─── Room Description ──────────────────────────────────────────────

function describeRoom(state) {
  const def = roomDef(state.room);
  const room = rs(state);
  const lines = [];

  lines.push(`\n=== ${def.name} ===\n`);

  // Room description variants
  if (state.room === 'code-caves') {
    lines.push(canSee(state) ? def.description_lit : def.description_dark);
  } else if (state.room === 'glitch-zone') {
    lines.push(room.bridge_broken ? def.description_broken : def.description_fixed);
  } else if (state.room === 'boss-room') {
    lines.push(room.boss_alive ? def.description : def.description_defeated);
  } else if (state.room === 'main-menu') {
    lines.push(def.description);
    lines.push('');
    lines.push(def[`slot_message_${state.cartridges_inserted}`] || '');
  } else {
    lines.push(def.description);
  }

  // Visible items
  if (canSee(state)) {
    const visible = room.items_here.filter(() => {
      if (state.room === 'boss-room' && room.items_blocked && room.boss_alive) return false;
      return true;
    });
    if (visible.length > 0) {
      lines.push('');
      lines.push('You can see: ' + visible.map(id => itemName(id)).join(', '));
    }
  }

  // NPC
  if (def.npc && !state.flags[`npc_${def.npc.id}_gone`]) {
    lines.push('');
    lines.push(`${def.npc.name} is here.`);
  }

  // Boss
  if (def.boss && room.boss_alive) {
    lines.push('');
    lines.push(`!! ${def.boss.name} blocks your path !!`);
  }

  // Exits
  const exits = Object.keys(def.exits || {});
  if (def.secret_exit) exits.push(def.secret_exit.direction);
  if (exits.length > 0) {
    lines.push('');
    lines.push('Exits: ' + exits.join(', '));
  }

  return lines.join('\n');
}

// ─── Commands ──────────────────────────────────────────────────────

function cmdLook(state, args) {
  if (!args) return describeRoom(state);

  const target = args.toLowerCase();
  const def = roomDef(state.room);
  const room = rs(state);

  // Features (bush, note, etc.)
  if (def.features?.[target]) {
    const feat = def.features[target];
    if (feat.hidden_item && !room.searched[target]) {
      room.searched[target] = true;
      if (!room.items_here.includes(feat.hidden_item)) {
        room.items_here.push(feat.hidden_item);
      }
      return feat.search_text;
    }
    return feat.description;
  }

  // Items on ground
  for (const id of room.items_here) {
    const item = world.items[id];
    if (item && matchesItem(target, id, item)) return item.description;
  }

  // Items in inventory
  for (const id of state.inventory) {
    const item = world.items[id];
    if (item && matchesItem(target, id, item)) return item.description;
  }

  // NPC
  if (def.npc) {
    const npcName = def.npc.name.toLowerCase();
    if (target.includes('sprite') || target === 'npc' || target === npcName || npcName.includes(target)) {
      return def.npc.description;
    }
  }

  // Boss
  if (def.boss && room.boss_alive) {
    const bossName = def.boss.name.toLowerCase();
    if (target === 'bug' || target === 'boss' || bossName.includes(target)) {
      return def.boss.description;
    }
  }

  return `You don't see any "${args}" here.`;
}

function cmdGo(state, args) {
  if (!args) return 'Go where? Try: go north (or just "n")';

  const dir = DIR_ALIASES[args.toLowerCase()];
  if (!dir) return `"${args}" isn't a direction I understand. Try: north, south, east, west`;

  const def = roomDef(state.room);
  const room = rs(state);

  // Secret exit
  if (def.secret_exit && dir === def.secret_exit.direction) {
    state.room = def.secret_exit.destination;
    state.moves++;
    return def.secret_exit.hint + '\n' + describeRoom(state);
  }

  if (!def.exits?.[dir]) return `You can't go ${dir} from here.`;

  // Blocked bridge
  if (state.room === 'glitch-zone' && dir === 'north' && room.bridge_broken) {
    return "The bridge is too corrupted to cross! Holes of null data gape below. You need some kind of repair code...";
  }

  state.room = def.exits[dir];
  state.moves++;

  // Auto-torch in code caves
  if (state.room === 'code-caves' && hasItem(state, 'torch')) {
    state.flags.torch_lit = true;
  }

  return describeRoom(state);
}

function cmdTake(state, args) {
  if (!args) return 'Take what?';

  const target = args.toLowerCase();
  const room = rs(state);
  const def = roomDef(state.room);

  for (const id of [...room.items_here]) {
    const item = world.items[id];
    if (!item || !matchesItem(target, id, item)) continue;

    if (!canSee(state)) return "It's too dark to find anything! You need a light source.";
    if (state.room === 'boss-room' && room.items_blocked && room.boss_alive) {
      return `The ${def.boss.name} is guarding that! You need to deal with it first.`;
    }
    if (!item.takeable) return `You can't take the ${item.name}.`;

    state.inventory.push(id);
    room.items_here = room.items_here.filter(i => i !== id);
    return `Picked up: ${item.name}`;
  }

  return `You don't see any "${args}" to take.`;
}

function cmdUse(state, args) {
  if (!args) return 'Use what?';
  const target = args.toLowerCase();
  const room = rs(state);

  // Bridge code
  if ((target.includes('bridge') || target.includes('code') || target.includes('repair')) && hasItem(state, 'bridge-code')) {
    if (state.room !== 'glitch-zone') return "There's nothing to use the bridge code on here.";
    if (!room.bridge_broken) return "The bridge is already fixed!";
    room.bridge_broken = false;
    state.inventory = state.inventory.filter(i => i !== 'bridge-code');
    return "You hold up the code fragment. It FLIES from your hand and merges with the bridge! Pixels realign, data structures mend, and the bridge solidifies with a satisfying *click*.\n\nThe bridge is repaired! You can now cross to the north.";
  }

  // Cartridges in main menu
  if (target.includes('cartridge') && state.room === 'main-menu') {
    const carts = state.inventory.filter(id => world.items[id]?.is_cartridge);
    if (carts.length === 0) return "You don't have any cartridges to insert!";
    for (const c of carts) {
      state.inventory = state.inventory.filter(i => i !== c);
      state.cartridges_inserted++;
    }
    if (state.cartridges_inserted >= CARTRIDGES_NEEDED) {
      state.won = true;
      saveState(state);
      return world.win_message;
    }
    return `You insert ${carts.length} cartridge${carts.length > 1 ? 's' : ''} into the console slots.\n\n${state.cartridges_inserted}/${CARTRIDGES_NEEDED} cartridges inserted. Keep searching!`;
  }

  // Torch
  if ((target === 'torch' || target === 'light') && hasItem(state, 'torch')) {
    if (state.room === 'code-caves') {
      state.flags.torch_lit = true;
      return "The torch flares to life, illuminating the cave!\n" + describeRoom(state);
    }
    return "The torch is already lit and ready. It'll be useful in dark places.";
  }

  // Generic item in inventory
  for (const id of state.inventory) {
    const item = world.items[id];
    if (item && matchesItem(target, id, item)) {
      return `You wave the ${item.name} around, but nothing happens here.`;
    }
  }

  return `You don't have any "${args}" to use.`;
}

function cmdTalk(state) {
  const def = roomDef(state.room);
  if (!def.npc) return "There's nobody here to talk to.";

  const npc = def.npc;

  // Memory Sprite trade logic
  if (npc.id === 'memory-sprite') {
    if (state.flags.sprite_traded) {
      return `The Memory Sprite is happily polishing the sword. "Thanks again! The bridge code should help you in the Glitch Zone. Good luck!"`;
    }
    if (hasItem(state, npc.trade_give)) {
      state.inventory = state.inventory.filter(i => i !== npc.trade_give);
      state.inventory.push(npc.trade_receive);
      state.flags.sprite_traded = true;
      return npc.dialogue_has_sword;
    }
    return npc.dialogue_default;
  }

  return `${npc.name} doesn't seem to have anything to say right now.`;
}

function cmdInventory(state) {
  if (state.inventory.length === 0) {
    return "Your pockets are empty. (Just like a real adventure game at the start!)";
  }
  return 'Inventory:\n' + state.inventory.map(id => `  - ${itemName(id)}`).join('\n');
}

function cmdFight(state) {
  const def = roomDef(state.room);
  const room = rs(state);
  if (!def.boss || !room.boss_alive) return "There's nothing to fight here.";

  room.boss_alive = false;
  room.items_blocked = false;
  return def.boss.defeat_text;
}

function cmdSearch(state, args) {
  if (!canSee(state)) return "It's too dark to search! You need a light source.";
  const def = roomDef(state.room);

  if (args && def.features?.[args.toLowerCase()]) {
    return cmdLook(state, args);
  }

  if (def.features) {
    const room = rs(state);
    const unsearched = Object.keys(def.features).filter(k => !room.searched[k] && def.features[k].hidden_item);
    if (unsearched.length > 0) {
      return `You notice something worth examining: ${unsearched.join(', ')}. Try "look ${unsearched[0]}".`;
    }
  }

  return "You search around but don't find anything unusual.";
}

// ─── Parser ────────────────────────────────────────────────────────

function parse(input) {
  const clean = input.trim().toLowerCase();

  if (['n', 's', 'e', 'w'].includes(clean)) return { cmd: 'go', args: clean };
  if (['north', 'south', 'east', 'west', 'up', 'down', 'out', 'crack'].includes(clean)) return { cmd: 'go', args: clean };
  if (['i', 'inv', 'inventory'].includes(clean)) return { cmd: 'inventory', args: null };
  if (clean === 'look' || clean === 'l') return { cmd: 'look', args: null };
  if (clean === 'help' || clean === '?') return { cmd: 'help', args: null };
  if (clean === 'quit' || clean === 'exit') return { cmd: 'quit', args: null };
  if (['fight', 'attack', 'kill', 'debug', 'delete', 'squash'].includes(clean)) return { cmd: 'fight', args: null };
  if (clean === 'status') return { cmd: 'status', args: null };
  if (clean === 'search') return { cmd: 'search', args: null };
  if (['talk', 'speak'].includes(clean)) return { cmd: 'talk', args: null };
  if (/^(insert|use) cartridges?$/i.test(clean)) return { cmd: 'use', args: 'cartridge' };

  const match = clean.match(/^(go|move|walk|look|examine|inspect|search|take|get|grab|pick up|use|talk|talk to|speak|speak to|fight|attack|kill)\s+(.+)$/);
  if (match) {
    let cmd = match[1];
    let args = match[2];
    if (['move', 'walk'].includes(cmd)) cmd = 'go';
    if (['examine', 'inspect'].includes(cmd)) cmd = 'look';
    if (cmd === 'search') cmd = 'search';
    if (['get', 'grab', 'pick up'].includes(cmd)) cmd = 'take';
    if (['speak', 'talk to', 'speak to'].includes(cmd)) cmd = 'talk';
    if (['attack', 'kill'].includes(cmd)) cmd = 'fight';
    args = args.replace(/^(the|a|an|at|to)\s+/i, '');
    return { cmd, args };
  }

  return { cmd: 'unknown', args: input };
}

const HELP_TEXT = `
=== COMMANDS ===

Movement:  go <direction> (or just n/s/e/w)
Look:      look (room) | look <thing> | search <thing>
Take:      take <item>
Use:       use <item>
Talk:      talk (to NPC in room)
Fight:     fight / attack / kill (enemy in room)
Inventory: inventory (or just "i")
Status:    status (game progress)
Help:      help (this screen)
Quit:      quit (saves game)

Tip: Type directions like "north" or just "n".
     Try "search" to look around, and "look bush" to examine things!
`.trim();

function processCommand(state, input) {
  const { cmd, args } = parse(input);

  switch (cmd) {
    case 'look':      return cmdLook(state, args);
    case 'search':    return cmdSearch(state, args);
    case 'go':        return cmdGo(state, args);
    case 'take':      return cmdTake(state, args);
    case 'use':       return cmdUse(state, args);
    case 'talk':      return cmdTalk(state);
    case 'inventory': return cmdInventory(state);
    case 'fight':     return cmdFight(state);
    case 'help':      return HELP_TEXT;
    case 'status': {
      const cartInv = state.inventory.filter(id => world.items[id]?.is_cartridge).length;
      return `Moves: ${state.moves} | Cartridges: ${state.cartridges_inserted + cartInv}/${CARTRIDGES_NEEDED} (${state.cartridges_inserted} inserted, ${cartInv} carrying) | Room: ${roomDef(state.room)?.name || state.room}`;
    }
    case 'quit':
      saveState(state);
      return 'Game saved! Come back soon, friend!';
    default:
      return `I don't understand "${input}". Type 'help' for a list of commands.`;
  }
}

// ─── Main ──────────────────────────────────────────────────────────

const cliArgs = process.argv.slice(2);

if (cliArgs.includes('--new')) {
  const state = newState();
  saveState(state);
  console.log(world.intro + '\n' + describeRoom(state));
  process.exit(0);
}

if (cliArgs.includes('--status')) {
  const state = loadState();
  if (!state) { console.log('No game in progress. Start one with: node engine.js --new'); }
  else if (state.won) { console.log('You already won! Start a new game with: node engine.js --new'); }
  else {
    const c = state.inventory.filter(id => world.items[id]?.is_cartridge).length;
    console.log(`Game in progress: ${state.moves} moves, ${state.cartridges_inserted + c}/${CARTRIDGES_NEEDED} cartridges, at ${roomDef(state.room)?.name || state.room}`);
  }
  process.exit(0);
}

if (cliArgs.length === 0) {
  console.log('Usage: node engine.js "command" | --new | --status');
  process.exit(0);
}

const command = cliArgs.join(' ');

if (/^play(\s+game)?$/i.test(command)) {
  const existing = loadState();
  if (existing && !existing.won) {
    console.log('Resuming your adventure...\n' + describeRoom(existing));
  } else {
    const state = newState();
    saveState(state);
    console.log(world.intro + '\n' + describeRoom(state));
  }
  process.exit(0);
}

const state = loadState();
if (!state) { console.log('No game in progress! Start one with: node engine.js --new'); process.exit(0); }
if (state.won) { console.log('You already won! Start a new game with: node engine.js --new'); process.exit(0); }

const output = processCommand(state, command);
console.log(output);
if (parse(command).cmd !== 'quit') saveState(state);
