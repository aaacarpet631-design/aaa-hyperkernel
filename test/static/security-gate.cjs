/* Consume CodeQL's SARIF output: block all endpoint security findings and
 * high/critical findings anywhere. Empty/missing analysis must fail closed. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) throw new Error('CodeQL results missing');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sarif'));
if (!files.length) throw new Error('CodeQL did not produce SARIF');
let total = 0, blocking = 0;
for (const file of files) {
  const report = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  if (!Array.isArray(report.runs) || !report.runs.length) throw new Error('Invalid CodeQL report');
  for (const run of report.runs) {
    const rules = run.tool.driver.rules || [];
    for (const finding of run.results || []) {
      const rule = rules.find(r => r.id === finding.ruleId) || rules[finding.ruleIndex] || {};
      const properties = rule.properties || {};
      if (!(properties.tags || []).includes('security')) continue;
      total++;
      const locations = (finding.locations || []).map(l => l.physicalLocation?.artifactLocation?.uri || '');
      const endpoint = locations.some(l => /^(netlify\/(functions|lib)|functions|backend-python)\//.test(l));
      const severity = Number(properties['security-severity'] || 0);
      if (endpoint || severity >= 7) blocking++;
      console.log(finding.ruleId + ' severity=' + severity + ' ' + locations.join(', '));
    }
  }
}
console.log('CodeQL: ' + total + ' security findings; ' + blocking + ' blocking endpoint/high severity findings.');
if (blocking) process.exit(1);
