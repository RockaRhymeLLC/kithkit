# Bridget Teams App Package

## Contents

- `manifest.json` — Teams app manifest (schema v1.17)
- `icon-color.png` — 192×192 full-color icon (**you must add this**)
- `icon-outline.png` — 32×32 transparent outline icon (**you must add this**)

## Bot configuration

| Field | Value |
|---|---|
| Bot App ID (`botId`) | `70db3bc8-52fd-4270-9247-61d53b2ea019` |
| Messaging endpoint | `https://bridget.servos.bot/api/teams/messages` |
| Scopes | personal, team, groupChat |

## Sideloading

Teams app sideloading requires tenant admin permission (or
"Allow users to upload custom apps" enabled for the org).

1. Add `icon-color.png` (192×192 PNG) and `icon-outline.png` (32×32 PNG) to this directory.
2. Zip the three files: `manifest.json`, `icon-color.png`, `icon-outline.png`.
3. In Teams: **Apps → Manage your apps → Upload an app → Upload a custom app** → select the zip.
4. Install the app to yourself (personal scope) to test.

## Notes

- The messaging endpoint (`https://bridget.servos.bot/api/teams/messages`) must be reachable from
  the Microsoft Teams service. Ensure the Cloudflare tunnel is active.
- The bot app registration in Azure (app id `70db3bc8-52fd-4270-9247-61d53b2ea019`) must have the
  Teams channel configured in Azure Bot Service.
- Do NOT attempt to sideload without tenant admin or custom app upload permission.
