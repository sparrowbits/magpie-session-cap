# Changelog

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
- Digest rides in a `developer` message by default, so folding costs no turn; `foldTarget` also offers `system`, `user` and `file`.
- Head-and-tail clipping for items, oldest-fifth-plus-newest-rest clipping for the digest, so early decisions and recent work both survive.
- `maxBodyChars` budget guard keeps the request inside the model's window; measured ceiling on 星驰 `gpt-6.1-sol` is 584k input tokens.
- Stateless bucketing from the sent history, since magpie gives each middleware call a fresh JavaScript isolate with no `fetch`, timer or crypto.
- 17 test cases via `node --test`.
