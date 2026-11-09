# notyetbutsoon

A tiny email collector for things that do not exist yet. Send a project name and
an email; nybs saves them with the client IP and signup time. Projects appear
automatically. One Node.js process, one SQLite file, no dependencies.

## Quickstart

Requires Node.js 24.13 or newer. Download the source and run:

```sh
npm start
```

Then submit a signup:

```sh
curl http://127.0.0.1:3080/signup \
  -H 'Content-Type: application/json' \
  -d '{"project":"my-launch","email":"person@example.com"}'
```

Success returns `200 {"ok":true}`. Any project label works without setup. Repeat
submissions of the same email to one project are deduplicated.

## Use it in a form

Send your form's email to your instance's `/signup` endpoint:

```js
const response = await fetch('https://YOUR-SERVICE/signup', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ project: 'my-launch', email: enteredEmail }),
});
const result = await response.json();
if (!response.ok) throw new Error(result.error || 'Please try again.');
```

CORS accepts any origin. No API key is needed. The full API contract, validation
rules, and retry behavior are in [llm.txt](llm.txt), also served at `/llm.txt` and
`/llms.txt`. `GET /healthz` returns `{"ok":true}`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listen address |
| `PORT` | `3080` | Listen port |
| `DB_PATH` | `data/signups.sqlite` | SQLite file; keep it on persistent storage |
| `RATE_LIMIT` | `10` | Signup attempts per IP per window, across projects |
| `RATE_WINDOW_SECONDS` | `600` | Rate-limit window length |
| `TRUSTED_PROXIES` | empty | Trusted forwarding proxy IPs/CIDRs, comma-separated |

Behind a proxy, configure `TRUSTED_PROXIES` for your host so IP collection and
rate limits use the client address. Forwarding headers from other peers are
ignored. Project labels are not access controls; anyone can submit to any label.
Nybs does not verify mailbox ownership or send email.

## View and download signups

Link the CLI once from this checkout:

```sh
npm link
```

Then run it from any directory:

```sh
nybs ls
nybs show my-launch
nybs download my-launch
nybs rm my-launch
```

`ls` lists all projects and counts. `show` displays a table of emails, IPs, and
signup times; use `--limit 100 --offset 100` to page through larger lists.
`download` saves the full CSV to `my-launch.csv`, using file transfer for Ample
exports. Use `--output path.csv` for another filename; existing files are preserved.

`rm` permanently deletes a project's signups after confirmation. Use `--yes` for
scripts. Project labels can be reused by future submissions; shared IP rate
limits are preserved.

Commands use the local `DB_PATH` by default. For Ample, set `NYBS_SERVER` or save
`{"server_id":"YOUR_SERVER_ID"}` in the ignored `.ample/instance.json` file, and
authenticate the Ample CLI. The remote database defaults to
`/data/signups.sqlite`. `--local` overrides saved remote settings.

For raw CSV output or a database backup, run alongside the service with the same
`DB_PATH`:

```sh
node cli.js export 'my-launch' > my-launch.csv
node cli.js backup backup.sqlite
```

There are no public read/export endpoints. Use the backup command rather than
copying a running database's `.sqlite` file, since recent writes can be in its
WAL file. Choose a new backup filename each time.

## Ample example

With an authenticated [Ample CLI](https://ample.computer/llms.txt):

```sh
npm run package:ample
ample up .ample-source
```

[ample.toml](ample.toml) declares a Node 24 service and a persistent volume mounted
at `/data`. Adjust environment values for your instance, including its trusted
proxy address. Run the packaging command before each deployment; it copies only
runtime files and preserves Ample's local deployment state between releases.

## Tests

```sh
npm test
```

Use `npm run test:memory` in environments that prohibit local TCP listeners.
