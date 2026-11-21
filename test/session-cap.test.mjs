import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "../session-cap.middleware.js";

const U = (t) => ({ type: "message", role: "user", content: [{ type: "input_text", text: t }] });
const A = (t) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text: t }] });
const DEV = (t) => ({ type: "message", role: "developer", content: [{ type: "input_text", text: t }] });
const FC = (i) => ({ type: "function_call", call_id: "c" + i, name: "shell", arguments: '{"cmd":"ls"}' });
const FO = (i, o) => ({ type: "function_call_output", call_id: "c" + i, output: o });

// history builds a conversation the way Codex sends one: a preamble, then turns
// of user message plus assistant reply plus tool round trips.
function history(turns, opts = {}) {
  const outSize = opts.outSize || 40;
  const items = [DEV("INSTRUCTIONS")];
  for (let i = 1; i <= turns; i++) {
    if (i > 1) items.push(A("ack" + i));
    items.push(U(i === 2 ? "the staging database is dlhcbqwoq-9" : "task " + i));
    if (opts.tools !== false) {
      items.push(FC(i));
      items.push(FO(i, "z".repeat(outSize) + (i === 7 ? " MARKER7" : "") + (i === turns ? " RECENT" : "")));
    }
  }
  items.push(A("ok"));
  items.push(U(opts.question || "final question"));
  return items;
}

function ctx(options = {}, over = {}) {
  return {
    model: "xingchiapi/gpt-6.1-sol",
    protocol: "responses",
    agent: "codex",
    path: "/backend-api/codex/responses",
    stream: false,
    options: { providers: ["xingchiapi"], ...options },
    state: {},
    ...over,
  };
}

const users = (items) => items.filter((i) => i.type === "message" && i.role === "user").length;
const orphans = (items) => {
  const calls = new Set();
  const outs = new Set();
  for (const i of items) {
    if (i.type === "function_call") calls.add(i.call_id);
    if (i.type === "function_call_output") outs.add(i.call_id);
  }
  return [...calls].filter((x) => !outs.has(x)).length + [...outs].filter((x) => !calls.has(x)).length;
};

test("only role=user message items count as turns", () => {
  const items = history(3);
  assert.equal(users(items), 4);
  assert.equal(items.filter((i) => i.type === "function_call").length, 3);
});

test("a request under the turn cap keeps its history but gets a rolled key", () => {
  const body = { model: "xingchiapi/gpt-6.1-sol", prompt_cache_key: "th", input: history(4) };
  const out = onRequest(body, ctx({ keepTurns: 9 }));
  assert.equal(out.input, body.input, "no folding under the cap");
  assert.match(out.prompt_cache_key, /^[0-9a-f-]{36}$/, "the key is still rolled onto a bucket");
});

test("folding keeps user messages at or under keepTurns", () => {
  for (const keep of [5, 9, 10]) {
    const out = onRequest({ model: "m", prompt_cache_key: "th", input: history(40) }, ctx({ keepTurns: keep }));
    assert.ok(out, "expected a rewritten body");
    assert.equal(users(out.input), keep, "keepTurns=" + keep);
  }
});

test("the digest rides in a developer message by default, costing no turn", () => {
  const out = onRequest({ model: "m", prompt_cache_key: "th", input: history(30) }, ctx({ keepTurns: 9 }));
  assert.equal(out.input[1].role, "developer");
  assert.equal(out.input[1].type, "message");
});

test("foldTarget moves the digest between developer, system, user and file", () => {
  for (const [target, role] of [["developer", "developer"], ["system", "system"], ["user", "user"], ["file", "developer"]]) {
    const out = onRequest({ model: "m", prompt_cache_key: "th", input: history(30) }, ctx({ keepTurns: 9, foldTarget: target }));
    assert.equal(out.input[1].role, role, target);
    const part = out.input[1].content[0];
    assert.ok(users(out.input) <= 10, target + " must stay under the relay turn cap");
    if (target === "file") {
      assert.equal(part.type, "input_file");
      assert.equal(part.filename, "folded-history.txt");
      const back = Buffer.from(part.file_data.split(",")[1], "base64").toString("utf8");
      assert.match(back, /dlhcbqwoq-9/, target + " base64 must round-trip");
    } else {
      assert.equal(part.type, "input_text", target);
    }
  }
});

test("no function_call is ever split from its output", () => {
  for (const turns of [12, 40, 120]) {
    const out = onRequest({ model: "m", prompt_cache_key: "th", input: history(turns) }, ctx({ keepTurns: 9 }));
    assert.equal(orphans(out.input), 0, "turns=" + turns);
  }
});

test("the preamble before the first user message survives intact", () => {
  const out = onRequest({ model: "m", prompt_cache_key: "th", input: history(40) }, ctx({ keepTurns: 9 }));
  assert.equal(out.input[0].role, "developer");
  assert.match(JSON.stringify(out.input[0]), /INSTRUCTIONS/);
});

test("folding keeps early facts, and fold=false really loses them", () => {
  const folded = onRequest({ model: "m", prompt_cache_key: "th", input: history(60) }, ctx({ keepTurns: 9 }));
  assert.match(JSON.stringify(folded.input), /dlhcbqwoq-9/, "folded must still carry turn 2");

  const dropped = onRequest({ model: "m", prompt_cache_key: "th", input: history(60) }, ctx({ keepTurns: 9, fold: false }));
  assert.doesNotMatch(JSON.stringify(dropped.input), /dlhcbqwoq-9/, "fold:false must lose it — that is the point");
});

test("an over-long item keeps both its head and its tail", () => {
  // turn 7 carries MARKER7 at the end of a long tool output
  const out = onRequest({ model: "m", prompt_cache_key: "th", input: history(40, { outSize: 40000 }) }, ctx({ keepTurns: 9, itemChars: 2000 }));
  const digest = JSON.stringify(out.input[1]);
  assert.match(digest, /MARKER7/, "tail of a clipped item must survive");
  assert.match(digest, /chars cut/, "the gap must be marked");
});

test("the digest cut keeps the oldest fifth and the newest rest", () => {
  const out = onRequest({ model: "m", prompt_cache_key: "th", input: history(400, { outSize: 20000 }) }, ctx({ keepTurns: 9, foldChars: 400000 }));
  const digest = JSON.stringify(out.input[1]);
  assert.match(digest, /dlhcbqwoq-9/, "the opening turns must survive the cut");
  assert.match(digest, /middle .* dropped/, "the cut must be marked");
});

test("maxBodyChars bounds the whole request whatever the session length", () => {
  const sizes = [40, 120, 400].map((turns) => {
    const out = onRequest({ model: "m", prompt_cache_key: "th", input: history(turns, { outSize: 20000 }) }, ctx({ keepTurns: 9, maxBodyChars: 300000 }));
    return JSON.stringify(out.input).length;
  });
  for (const s of sizes) assert.ok(s < 420000, "sizes=" + sizes.join(","));
  assert.ok(Math.max(...sizes) - Math.min(...sizes) < 60000, "sizes should plateau, got " + sizes.join(","));
});

test("the rolled key is stable inside a bucket and moves as the session grows", () => {
  const seen = [];
  for (const turns of [1, 2, 3, 4]) {
    const out = onRequest({ model: "m", prompt_cache_key: "thread-1", input: history(turns) }, ctx({ keepTurns: 9 }));
    seen.push(out.prompt_cache_key);
  }
  assert.equal(new Set(seen).size, 1, "small steps must not churn the key: " + seen.join(","));

  const grown = [10, 20, 40, 90].map((turns) =>
    onRequest({ model: "m", prompt_cache_key: "thread-1", input: history(turns) }, ctx({ keepTurns: 9 })).prompt_cache_key);
  assert.equal(new Set(grown).size, grown.length, "the key must advance with the session");
  for (const k of grown) assert.match(k, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "must look like a uuid");
});

test("a different thread id gets a different key", () => {
  const a = onRequest({ model: "m", prompt_cache_key: "thread-a", input: history(20) }, ctx({ keepTurns: 9 }));
  const b = onRequest({ model: "m", prompt_cache_key: "thread-b", input: history(20) }, ctx({ keepTurns: 9 }));
  assert.notEqual(a.prompt_cache_key, b.prompt_cache_key);
});

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

test("rotateAlways gives every request its own key", () => {
  const body = { model: "m", prompt_cache_key: "thread-1", input: history(3) };
  const keys = [];
  for (let i = 0; i < 5; i++) {
    keys.push(onRequest(body, ctx({ rotateAlways: true })).prompt_cache_key);
    sleepSync(2);
  }
  assert.equal(new Set(keys).size, 5, keys.join(","));
});

test("scoping reads the model magpie routes on, not the body's own", () => {
  const body = { model: "other/gpt-x", prompt_cache_key: "th", input: history(30) };
  // ctx.model is what magpie resolved the request to; that is what filters see.
  assert.equal(onRequest(body, ctx({ keepTurns: 9 }, { model: "other/gpt-x" })), undefined, "provider not listed");
  assert.notEqual(onRequest(body, ctx({ keepTurns: 9, providers: undefined }, { model: "other/gpt-x" })), undefined, "no filter means all");
  assert.equal(onRequest(body, ctx({ keepTurns: 9, providers: undefined, protocols: ["chat"] }, { model: "other/gpt-x" })), undefined, "protocol filter");
  assert.equal(onRequest(body, ctx({ keepTurns: 9, providers: undefined, models: ["claude"] }, { model: "other/gpt-x" })), undefined, "model filter");
  assert.notEqual(onRequest(body, ctx({ keepTurns: 9, providers: ["xingchiapi"] }, { model: "xingchiapi/gpt-6.1-sol" })), undefined, "xingchi routes on the resolved model");
});

test("requests with nothing to fold or no key to roll are returned untouched", () => {
  assert.equal(onRequest({ model: "m", input: "a plain string" }, ctx()), undefined, "no prompt_cache_key");
  assert.equal(onRequest({ model: "m", prompt_cache_key: "th" }, ctx()), undefined, "no input array");
  assert.equal(onRequest({ model: "m", prompt_cache_key: "th", input: [] }, ctx()), undefined, "empty input");
  assert.equal(onRequest({ model: "m", prompt_cache_key: "th", input: history(30) }, ctx({ keepTurns: 9, dryRun: true })), undefined, "dryRun");
});

test("file mode round-trips Unicode including astral characters", () => {
  const input = history(30);
  input[2] = U("The marker is rocket 🚀 and brain 🧠 and staging database dlhcbqwoq-9");
  const out = onRequest({ model: "m", prompt_cache_key: "th", input }, ctx({ keepTurns: 9, foldTarget: "file" }));
  const part = out.input[1].content[0];
  const decoded = Buffer.from(part.file_data.split(",")[1], "base64").toString("utf8");
  assert.match(decoded, /🚀/);
  assert.match(decoded, /🧠/);
  assert.match(decoded, /dlhcbqwoq-9/);
});

test("non-Responses protocols pass through unchanged", () => {
  for (const protocol of ["chat", "anthropic", "gemini", "unknown"]) {
    const body = { model: "xingchiapi/gpt-6.1-sol", prompt_cache_key: "th", input: history(30) };
    assert.equal(onRequest(body, ctx({}, { protocol })), undefined, protocol);
  }
});

test("the original body object is never mutated", () => {
  const input = history(30);
  const before = JSON.stringify(input);
  onRequest({ model: "m", prompt_cache_key: "th", input }, ctx({ keepTurns: 9 }));
  assert.equal(JSON.stringify(input), before, "the client's own body must be left alone");
});
