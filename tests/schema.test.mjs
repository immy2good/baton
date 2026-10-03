import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadJson(rel) {
  return JSON.parse(readFileSync(join(root, rel), "utf8"));
}

/**
 * Strict schema validator checking types, required, enums, const, and additionalProperties: false
 */
function validateSchema(obj, schema) {
  assert.equal(typeof obj, "object", "Target must be an object");
  assert.ok(obj !== null, "Target must not be null");

  // Check required
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      assert.ok(key in obj, `Missing required field: ${key}`);
    }
  }

  // Check additionalProperties
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(obj)) {
      assert.ok(
        key in schema.properties,
        `Disallowed additional property: ${key}`
      );
    }
  }

  // Check properties
  for (const [key, propSchema] of Object.entries(schema.properties)) {
    if (!(key in obj)) continue;
    const val = obj[key];

    // const
    if ("const" in propSchema) {
      assert.equal(val, propSchema.const, `Field ${key} must equal const ${propSchema.const}`);
    }

    // enum
    if (Array.isArray(propSchema.enum)) {
      assert.ok(
        propSchema.enum.includes(val),
        `Field ${key} value "${val}" not in enum [${propSchema.enum.join(", ")}]`
      );
    }

    // type checks
    if (propSchema.type === "integer") {
      assert.ok(Number.isInteger(val), `Field ${key} must be an integer`);
    } else if (propSchema.type === "string") {
      assert.equal(typeof val, "string", `Field ${key} must be a string`);
      if (propSchema.minLength) {
        assert.ok(val.trim().length >= propSchema.minLength, `Field ${key} must have minLength ${propSchema.minLength}`);
      }
    } else if (propSchema.type === "array") {
      assert.ok(Array.isArray(val), `Field ${key} must be an array`);
      if (propSchema.items?.type === "string") {
        for (const item of val) {
          assert.equal(typeof item, "string", `Array ${key} items must be strings`);
        }
      }
    }
  }
}

test("valid checkpoint matches schema strictly", () => {
  const schema = loadJson("docs/schemas/checkpoint.schema.json");
  const example = loadJson("docs/schemas/examples/checkpoint.valid.json");
  validateSchema(example, schema);
});

test("checkpoint rejects unknown fields, missing fields, or bad enum (negative control)", () => {
  const schema = loadJson("docs/schemas/checkpoint.schema.json");
  const example = loadJson("docs/schemas/examples/checkpoint.valid.json");

  // Unknown property
  assert.throws(() => {
    validateSchema({ ...example, unexpected_key: "disallowed" }, schema);
  }, /Disallowed additional property/);

  // Missing required field
  const missingGoal = { ...example };
  delete missingGoal.goal;
  assert.throws(() => {
    validateSchema(missingGoal, schema);
  }, /Missing required field: goal/);

  // Bad node enum
  assert.throws(() => {
    validateSchema({ ...example, node: "unregistered_node" }, schema);
  }, /not in enum/);
});

test("valid receipt matches schema strictly", () => {
  const schema = loadJson("docs/schemas/receipt.schema.json");
  const example = loadJson("docs/schemas/examples/receipt.valid.json");
  validateSchema(example, schema);
});

test("receipt rejects missing capture, whitespace capture, string verified, or unknown property (negative control)", () => {
  const schema = loadJson("docs/schemas/receipt.schema.json");
  const example = loadJson("docs/schemas/examples/receipt.valid.json");

  // Missing capture
  const noCapture = { ...example };
  delete noCapture.capture;
  assert.throws(() => {
    validateSchema(noCapture, schema);
  }, /Missing required field: capture/);

  // Whitespace-only capture
  assert.throws(() => {
    validateSchema({ ...example, capture: "   " }, schema);
  }, /minLength/);

  // Verified as string instead of array
  assert.throws(() => {
    validateSchema({ ...example, verified: "not an array" }, schema);
  }, /must be an array/);

  // Additional unknown property
  assert.throws(() => {
    validateSchema({ ...example, bogus_field: true }, schema);
  }, /Disallowed additional property/);
});

test("review-diamond recipe specifies orchestrator, writer, reviewer, and apex_reviewer with high thinking", () => {
  const yml = readFileSync(join(root, "docs/recipes/review-diamond.yml"), "utf8");
  assert.match(yml, /orchestrator:\r?\n\s+kind: claude/);
  assert.match(yml, /writer:\r?\n\s+kind: claude/);
  assert.match(yml, /reviewer:\r?\n\s+kind: opencode/);
  assert.match(yml, /apex_reviewer:\r?\n\s+kind: codex\r?\n\s+model: gpt-6-astra/);
  assert.match(yml, /thinking:\s*high/);
  assert.match(yml, /task\.risk in \[HIGH, CRITICAL\]/);
  assert.match(yml, /self_claim_ticket/);
  assert.match(yml, /claude_reviews_own_wip/);
  assert.match(yml, /singleton_deploy_cms_signing_licenses/);
});

test("governance docs exist and enforce corrected boundaries", () => {
  const principles = readFileSync(join(root, "docs/PRINCIPLES.md"), "utf8");
  assert.match(principles, /NOT human-held singletons/);
  assert.match(principles, /Frontier does not review frontier/);
  assert.match(principles, /Unavailable models never block work/);

  const preflight = readFileSync(join(root, "docs/STARTUP-PREFLIGHT.md"), "utf8");
  assert.match(preflight, /Runtime Binding/);
  assert.match(preflight, /Apex Review/);

  const completion = readFileSync(join(root, "docs/COMPLETION-GATE.md"), "utf8");
  assert.match(completion, /Mandatory Apex Review/);
  assert.match(completion, /reviewed commit SHA/);

  const risk = readFileSync(join(root, "docs/RISK-CLASSIFICATION.md"), "utf8");
  assert.match(risk, /CRITICAL/);
  assert.match(risk, /Apex Review mandatory/);

  const taskPacket = readFileSync(join(root, "docs/templates/TASK-PACKET.md"), "utf8");
  assert.match(taskPacket, /Tier 1: Dispatcher Brief/);
  assert.match(taskPacket, /Tier 2: Runtime Binding/);
});
