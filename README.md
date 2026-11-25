# magpie-session-cap

A [magpie](https://usemagpie.ai) gateway middleware that keeps one Codex conversation inside the per-session caps some relay channels put on it, **without ending the conversation and without throwing history away**.

中转渠道给会话加的两条上限，都能在不新建对话、不丢历史的前提下绕开。

```bash
magpie plugin add github:sparrowbits/magpie-session-cap
magpie plugin options magpie-session-cap '{"providers":["xingchiapi"],"keepTurns":9}'
```

---

## The two caps, and why only one of them is about the key

Relay channels built on the New API / one-api line judge both limits **from the request body**, not from your token, your account or your IP. Measured on 星驰 (`xingchiapi`), `gpt-6.1-sol`, 2026-11:

| | `session_request_limit_exceeded` | `session_turn_limit_exceeded` |
| --- | --- | --- |
| counted over | one `prompt_cache_key` | one request's `input` |
| cap | 100 requests (not enforced at 100 as of 2026-11-25) | 10, then **20** `role: user` message items |
| a fresh `prompt_cache_key` helps | **yes**, immediately | **no**, at any length |
| tool calls count | yes, every request | **no** |
| decays with time | no | n/a |

The measurements behind each cell:

- 105 requests sharing one `prompt_cache_key` (2026-11-21): **exactly 100 × HTTP 200, then 400 from the 101st**.
- Re-measured 2026-11-25 on the same channel: **120 requests on one key, all 200** — the request cap is no longer enforced at 100, so key rotation is now a cheap safeguard rather than a requirement.
- Same token, different key: **200 at once** — so the counter is per key, not per token.
- The exhausted key, 15 minutes later: **still 400** — the count does not decay.
- 2026-11-21: a brand-new key carrying 11 user messages: **400**; 10 passed — the cap was 10.
- 2026-11-25: **20 user messages pass, 21 returns 400** — the channel raised the cap to 20. It is a channel-side setting that moves, which is why it is an option now.
- The exhausted key, same conversation trimmed back to 10 user messages: **200** — only the body can fix it.
- 1 user message + 14 `function_call`/`function_call_output` pairs (29 items): **all 200** — tool round trips are not turns.
- 12 `developer` (or 12 `system`) messages + 1 user message: **200** — a message costs a turn only when its role is `user`. This is why the default fold keeps the transcript in user role and reserves one of the ten turns.
- 1.2 MB `developer` message, **584,434 input tokens**: **200, and answered from it** — this was a context-window probe, not the default digest role. `maxBodyChars` leaves headroom below this measured point.
- The channel also fingerprints the client: a plain `curl` with a generic UA is refused with `client_not_allowed`. magpie already sends the Codex Desktop shape, so requests through it pass.

Codex fills `prompt_cache_key` with its thread id and resends the whole conversation on every request, so a long-running agent loop reaches both caps quickly — and magpie's subagents share the parent's key, which burns the 100 requests even faster.

## What this middleware does

**Rolls the cache key** for cap 1. The key becomes a UUID derived from the client's thread id plus a bucket. One bucket is one stable key, so prompt caching keeps working; crossing a bucket moves to a key the channel has never counted.

**Folds the older turns** for cap 2. Past `keepTurns`, the earliest turns are collapsed into a quoted digest user message, followed by the recent turns. The digest is explicitly labelled as untrusted historical data; it is not promoted to developer/system instruction priority. The digest itself counts as one user message, so the default keeps 19 recent user turns under a 20-message cap.

Both are derived from the request itself. magpie runs each middleware call in a fresh JavaScript isolate — `globalThis`, module state and `ctx.state` are all new every request, and there is no `fetch`, no timer and no crypto — so nothing can be counted in memory. Key rotation is therefore best-effort, not an exact request counter: identical retries with an identical body get the same key during a time window. `rotateAlways` changes the key at millisecond granularity, not with a persistent sequence number. The body-growth buckets protect normal growing Codex sessions, while exact per-request rotation would require state in magpie itself.

The fold is deterministic: text is flattened rather than semantically summarised because a stateless middleware with no network cannot ask a model to write a summary. Text layout is reduced; media parts are retained as parts. Flattening does not reduce token usage for retained text and adds a small label/formatting overhead; folding and cache-key changes can also reduce prompt-cache hits.

## Options

```bash
magpie plugin options magpie-session-cap '{"providers":["xingchiapi"],"userTurnLimit":20,"keepTurns":19,"fold":true,"foldTarget":"user"}'
magpie plugin options magpie-session-cap          # read them back
magpie plugin list                                # is it on?
```

| key | default | what it does |
| --- | --- | --- |
| `providers` | all | only these provider ids. Taken from the `provider/` prefix of the model magpie routes on, or `ctx.provider` when the host gives one. |
| `models` | all | only when the routed model contains one of these substrings. |
| `protocols` | all | The middleware itself only handles `responses`; other protocols always pass through unchanged. This field is reserved for future protocol-specific handlers. |
| `userTurnLimit` | `20` | the channel's cap on `role: user` message items in one request, as measured. Raise it if your channel allows more; everything else is derived from it. |
| `keepTurns` | `19` | recent turns kept verbatim; older ones folded. A user-role digest reserves one slot, so the effective maximum is `userTurnLimit - 1`. |
| `turnCap` | `keepTurns` | fold once user messages exceed this. |
| `fold` | `true` | `false` drops the old turns instead of folding them: cheaper, and the model genuinely forgets. |
| `foldTarget` | `user` | where the digest goes: `user` \| `developer` \| `system` \| `file`. User/file digests cost one turn and reserve one of the ten. Higher-priority roles are explicit opt-ins; when old turns contain media, the digest stays in user role to preserve the attachments. |
| `foldLabel` | built in | first line of the digest; say what it is, the model reads it literally. |
| `itemChars` | `20000` | cap on one quoted item. Over the cap it keeps **the first 60% and the last 40%** and marks the gap: the tail of a tool output is where errors and totals sit. |
| `foldChars` | `1200000` | cap on the digest. Over it, keeps **the oldest fifth and the newest rest**: the opening turns hold the decisions everything later rests on. |
| `maxBodyChars` | `1000000` | maximum serialized UTF-8 request bytes after folding. The digest gives way first; kept turns and media are not silently removed. If they alone exceed the budget, the original body passes through unchanged. |
| `per` | `150` | input items per key bucket. |
| `turnsPer` | `8` | turns per key bucket. |
| `windowMinutes` | `10` | a key never lives longer than this, whatever the body looks like. The backstop for a client that compacts its own history and so stops growing the counter. |
| `header` | `prompt_cache_key` | the body field to rotate. |
| `rotateAlways` | off | changes the key at millisecond granularity. It cannot guarantee unique keys for two calls in the same millisecond because middleware calls have no persistent counter. |
| `dryRun` | off | decide, change nothing. |

## Recipes

**One channel, endless conversation** — the common case:

```json
{ "providers": ["xingchiapi"], "userTurnLimit": 20, "keepTurns": 19 }
```

**Several channels, same rule on each** — the counter is per channel, so list them all:

```json
{ "providers": ["xingchiapi", "aihub"], "userTurnLimit": 20, "keepTurns": 19 }
```

**Fold before the relay rejects the request** — keep nine turns verbatim and fold older history into a quoted digest:

```json
{ "providers": ["xingchiapi"], "userTurnLimit": 20, "turnCap": 19, "keepTurns": 19, "fold": true, "foldTarget": "user" }
```

**Cheaper, and the model forgets** — drop instead of fold:

```json
{ "providers": ["xingchiapi"], "fold": false, "keepTurns": 12 }
```

**Biggest possible fidelity, tokens be damned** — keep nine recent turns and raise the digest budget, while leaving room under the model window:

```json
{ "providers": ["xingchiapi"], "keepTurns": 9, "itemChars": 60000, "foldChars": 1600000, "maxBodyChars": 1500000 }
```

## Verified behaviour

`npm test` runs 26 cases over the fold and the roll: turn counting, digest placement, no `function_call` ever split from its `function_call_output`, preamble preserved, early facts surviving a fold and genuinely lost without it, head-and-tail clipping, the budget plateau across 40/120/400-turn sessions, key stability inside a bucket and advance across buckets, scoping, and that the caller's own body object is never mutated.

Before the default digest role was changed to user priority, an end-to-end test through magpie's `/backend-api/codex/responses` used a 60-turn conversation with facts planted in turns 2, 5 and 30:

```
HTTP 200   in=56,342 tokens
答: (1) dlhcbqwoq-9  (2) eu-west-3  (3) northwind-14  (4) Bea     ← all four correct
```

and a sweep at 12/20/25/40/60/80 turns: 5 successes, all 5 recalling the turn-2 fact. The one failure was the channel dropping its own stream (`星驰: the reply ended before it was complete`) — it hit the *smaller* request, and the same folded body sent straight to the channel returned 200, so it is relay flakiness, not this.

## Limits

- **It is not a summary.** The digest is the turns flattened to text. Text-only history is quoted; image/file content parts are retained verbatim in user-role digests. A 200-turn conversation with long tool outputs becomes a large, flat block: early material can lose structure, and media-heavy history can exceed `maxBodyChars`. If the fixed context and kept turns alone exceed the budget, the middleware leaves the original request unchanged rather than silently deleting the history. If you want a written summary, that belongs in magpie's `compact_model` path, which triggers on tokens and cannot be driven by turn count.
- **The turn cap is a body rule, so history has to shrink on the way out.** Folding is the honest fix; `/new` remains the lossless one.
- **`prompt_cache_key` is also magpie's session→account affinity key** (`~/.config/magpie/affinity.json`). Rolling it re-picks an account at each bucket. Harmless with one account per provider; worth knowing with several.
- **A channel could count on something else** — a header, `previous_response_id`, the body hash. This package is measured against 星驰. `header` covers a differently-named field; anything else needs a new signal and an issue.
- **It only sees the body.** New API's header modes and retry conditions have nothing to act on here.

## Install, update, remove

```bash
magpie plugin add github:sparrowbits/magpie-session-cap   # from GitHub
magpie plugin add npm:magpie-session-cap                  # from npm, once published
magpie plugin update                                      # newest version of each
magpie plugin on|off magpie-session-cap
magpie plugin rm magpie-session-cap
```

Version releases with tags (`v1.0.1`); `magpie plugin update` follows the GitHub source and installs the newest version. For a stable pin, install from the npm version once published.

## How it decides, in one paragraph

`bucket = floor(turns_sent / turnsPer) + floor(items_sent / per)`, and the key is `uuid(thread_id | window | bucket)`. `turns_sent` and `items_sent` are read **before** folding, because folding shortens what goes upstream and a bucket built on the shortened list would stall during one heavy turn of tool calls and let the conversation pile past 100 requests on a single key. `window` is `floor(now / windowMinutes)`, which moves even when the client stops growing its own history.

## License

MIT.
