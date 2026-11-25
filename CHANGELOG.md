# Changelog

## 1.0.3

- The channel's turn cap is now an option, `userTurnLimit`, instead of the constant 10.
- Defaults follow the re-measured cap: 20 user messages, so `keepTurns` is 19 plus the digest.
- Re-measured on 星驰 2026-11-25: 20 user messages pass, 21 returns `session_turn_limit_exceeded`.
- The old 100-requests-per-key ceiling is no longer enforced at 100 on the same channel:
  120 requests sharing one `prompt_cache_key` all returned 200. Key rotation stays as a cheap safeguard.
- Adds tests that the cap follows `userTurnLimit` (10, 20, 30) and that defaults fill it exactly.

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
