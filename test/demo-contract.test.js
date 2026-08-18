import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const docsPath = new URL('../docs/PARTNER_API.md', import.meta.url);
const htmlPath = new URL('../public/index.html', import.meta.url);

test('partner docs route income results to the terminal group webhook, not the GET group response', async () => {
  const docs = await readFile(docsPath, 'utf8');

  assert.match(
    docs,
    /GET \/api\/v1\/application-groups\/\{id\}[\s\S]*deliberately returns \*\*no regulated\s+data\*\*/,
  );
  assert.doesNotMatch(docs, /per-applicant income\*\* live on `GET \/application-groups\/\{id\}`/);
  assert.doesNotMatch(docs, /per-applicant income, decision, and status/);
  assert.match(docs, /application_group\.completed[\s\S]*combined_annual_income/);
  assert.match(docs, /application_group\.completed[\s\S]*required_annual_income/);
  assert.match(docs, /application_group\.completed[\s\S]*annual_income/);
});

test('demo keeps income as the bank-backed component and summarizes group income webhook payloads', async () => {
  const html = await readFile(htmlPath, 'utf8');

  assert.match(html, /value="income" checked/);
  assert.doesNotMatch(html, /value="assets"/);
  assert.match(html, /function webhookSummary/);
  assert.match(html, /combined_annual_income/);
  assert.match(html, /required_annual_income/);
  assert.match(html, /annual_income/);
});

test('demo inline script is syntactically valid', async () => {
  const html = await readFile(htmlPath, 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);

  assert.ok(scripts.length > 0);
  for (const script of scripts) {
    assert.doesNotThrow(() => new Function(script));
  }
});
