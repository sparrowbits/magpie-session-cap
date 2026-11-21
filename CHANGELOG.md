# Changelog

## 1.0.2

- Defaults folded history to a labelled `user` message instead of developer priority.
- Reserves one user-turn slot for the digest, including file and media paths.
- Preserves image/file parts while folding and sizes serialized requests by UTF-8 bytes.
- Leaves oversized fixed context unchanged instead of silently discarding the folded transcript.
- Documents that cache-key rotation is best-effort because middleware calls are stateless.
- Handles malformed numeric options with bounded defaults and code-point-safe clipping.
- Adds regression coverage for attachments, UTF-8 budgets, turn caps and malformed options.

## 1.0.1

- Restricts processing to the Responses API; other protocols pass through unchanged.
- Fixes UTF-8/base64 encoding for supplementary Unicode characters in file mode.
- Clamps kept user turns to the channel's measured cap.
- Labels folded history as quoted context rather than fresh instructions.
- Fixes the npm test script for Node.js 18+ test discovery.

## 1.0.0

First release.

- Rolls `prompt_cache_key` past a channel's per-key request cap (`session_request_limit_exceeded`, measured at 100 on 星驰).
- Folds turns past `keepTurns` into one digest message, beating the per-request turn cap (`session_turn_limit_exceeded`, measured at 10 user messages) without deleting history.
- Digest originally rode in a `developer` message by default; review versions now default to a quoted `user` message to preserve instruction priority, reserving one of the ten user-message slots.
- Head-and-tail clipping for items, oldest-fifth-plus-newest-rest clipping for the digest, so early decisions and recent work both survive.
- `maxBodyChars` budget guard keeps the request inside the model's window; measured ceiling on 星驰 `gpt-6.1-sol` is 584k input tokens.
- Stateless bucketing from the sent history, since magpie gives each middleware call a fresh JavaScript isolate with no `fetch`, timer or crypto.
- 17 test cases via `node --test`.
