const test = require("node:test");
const assert = require("node:assert");
const add = require("../src/add");

test("add is a function", () => {
  assert.strictEqual(typeof add, "function");
});
